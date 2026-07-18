"""M3a Task 4 E2E：真实全链 RTMP 推流验证（自建 node-media-server 收流端）。

链路（全真组件，翻译 Provider 用 --translate-stub 测试脚手架）：
  feeder(d14.mp4 @5fps) → /ingest → LivePortraitPipeline 渲染 → /stream.mjpeg
  /audio ← 中文 fixture（真 whisper ASR）→ stub 翻译(ok) → 真 edge-tts(en)
  → AudioMixer（静音打底 + 语音拼接）→ /stream.wav
  每信道受监督 ffmpeg 拉两路 → libx264+aac → flv → rtmp://127.0.0.1:1935/live/ch0
  → node-media-server → HTTP-FLV http://127.0.0.1:8000/live/ch0.flv（验证面）

本脚本自起 sink（node）+ 服务（端口 8917）+ feeder，收尾必杀。断言：
  ① ffprobe HTTP-FLV：h264 + aac、512x512、sample_rate 16000；
  ② 拉 10s FLV 存盘（-c copy），解帧 PNG（1fps 全存，目检数字人）+ 抽音轨
     wav：250ms 窗 RMS，语音窗 >> 静音窗（数值断言 + 全窗如实打印）；
  ③ /status：streams.0.running=true、稳态窗口 restarts 不增长（绝对值如实
     报告——服务起后到 feeder 首帧渲染前 mjpeg 无字节，-rw_timeout 看门狗
     可能吃掉一次早期重启，属正常）、translation 计数 >0、errors==0；
  ④ 弹性：杀 sink → restarts 增长（退避重启观测）→ 重启 sink → running
     恢复（NMS ghost session 缓冲：留 60s 重试窗，实际恢复时间如实记录）。

用法（engine/ 目录）：
  <m0-venv-python> -m e2e.rtmp_e2e [--port 8917]
输出：engine/out/rtmp_e2e/ 下 PNG + wav + flv + 各类 log/json + timeline。
"""

import argparse
import asyncio
import json
import os
import socket
import struct
import subprocess
import sys
import time
import wave
from pathlib import Path

import numpy as np

ENGINE_ROOT = Path(__file__).resolve().parents[1]
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))

from service.streamer import resolve_ffmpeg  # noqa: E402

VENV_PY = sys.executable
FIXTURES = ENGINE_ROOT / "tests" / "fixtures"
# 驱动 fixture 住在 v2-m0-spike worktree（未入库）；该 worktree 被清理时用
# ONELIVE_D14 指向任意等价驱动视频。入库/下载脚本见 m3a-results backlog。
D14 = Path(os.environ.get(
    "ONELIVE_D14",
    r"C:\Users\76475\Documents\OneLive\.worktrees\v2-m0-spike\engine"
    r"\FasterLivePortrait\assets\examples\driving\d14.mp4"))
OUT_DIR = ENGINE_ROOT / "out" / "rtmp_e2e"
SINK_DIR = ENGINE_ROOT / "rtmp-sink"
FLV_URL = "http://127.0.0.1:8000/live/ch0.flv"
RTMP_TEMPLATE = "rtmp://127.0.0.1:1935/live/ch{ch}"
CHUNK_S = 0.25   # /audio 实时喂送节奏（同 lip_e2e）
GAP_S = 1.0      # 句间静音（>0.6s 静音确认阈值）
TAIL_S = 1.6     # 尾部静音闭合第二段

FFMPEG = resolve_ffmpeg()
FFPROBE = str(Path(FFMPEG).with_name("ffprobe.exe"))

_T0 = time.monotonic()
TIMELINE: list[str] = []


def mark(msg: str) -> None:
    line = f"[t+{time.monotonic() - _T0:7.2f}s] {msg}"
    TIMELINE.append(line)
    print(line, flush=True)


def _read_wav(path: Path) -> tuple[int, bytes]:
    with wave.open(str(path), "rb") as w:
        assert w.getnchannels() == 1 and w.getsampwidth() == 2, path
        return w.getframerate(), w.readframes(w.getnframes())


async def _wait_status(base: str, cond, desc: str, timeout_s: float,
                       interval: float = 0.5) -> dict:
    import httpx
    deadline = time.monotonic() + timeout_s
    last = None
    async with httpx.AsyncClient() as client:
        while time.monotonic() < deadline:
            try:
                r = await client.get(f"{base}/status", timeout=5)
                if r.status_code == 200:
                    last = r.json()
                    if cond(last):
                        return last
            except (httpx.HTTPError, ValueError):
                # ValueError 覆盖 warmup 期非 JSON 响应（json.JSONDecodeError
                # 是其子类）——照常重试而不是让整个 E2E 炸掉。
                pass
            await asyncio.sleep(interval)
    raise RuntimeError(f"timeout waiting for {desc}; last status: {last}")


def _wait_port(port: int, timeout_s: float, desc: str) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                mark(f"{desc}: port {port} accepting")
                return
        except OSError:
            time.sleep(0.25)
    raise RuntimeError(f"{desc}: port {port} not accepting within {timeout_s}s")


def _ffprobe_streams(url: str, timeout_s: float = 30) -> dict:
    """ffprobe -show_streams（json）。live FLV：探测要等 GOP，rw_timeout 兜底。"""
    r = subprocess.run(
        [FFPROBE, "-v", "error", "-rw_timeout", "10000000",
         "-print_format", "json", "-show_streams", url],
        capture_output=True, text=True, timeout=timeout_s)
    if r.returncode != 0:
        raise RuntimeError(f"ffprobe rc={r.returncode}: {r.stderr[-2000:]}")
    return json.loads(r.stdout)


async def _feed_audio(ws) -> None:
    sr1, pcm1 = _read_wav(FIXTURES / "zh_sentence1.wav")
    sr2, pcm2 = _read_wav(FIXTURES / "zh_sentence2.wav")
    assert sr1 == sr2
    sr = sr1
    plan = [("speech1", pcm1), ("gap", b"\x00\x00" * int(sr * GAP_S)),
            ("speech2", pcm2), ("tail", b"\x00\x00" * int(sr * TAIL_S))]
    step = int(sr * CHUNK_S) * 2
    for name, pcm in plan:
        for i in range(0, len(pcm), step):
            await ws.send(struct.pack("<I", sr) + pcm[i:i + step])
            await asyncio.sleep(CHUNK_S)
        mark(f"[feed] {name} sent ({len(pcm) / 2 / sr:.2f}s audio)")


async def _collect_events(ws, events: list, stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            raw = await asyncio.wait_for(ws.recv(), 1.0)
        except asyncio.TimeoutError:
            continue
        except Exception as e:
            print(f"[events] connection ended: {e!r}")
            return
        ev = json.loads(raw)
        events.append((time.monotonic(), ev))
        mark(f"[event] {json.dumps(ev, ensure_ascii=False)}")


def _start_sink(log_f):
    """起 sink（node）。log_f 由调用方持有——重启复用同一句柄，不泄漏。"""
    return subprocess.Popen(["node", "server.mjs"], cwd=str(SINK_DIR),
                            stdout=log_f, stderr=subprocess.STDOUT)


def _stop_procs(procs: list[tuple[str, object]]) -> None:
    for name, proc in procs:
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=10)
            mark(f"[teardown] {name} stopped")


def _rms_windows(wav_path: Path, win_s: float = 0.25) -> tuple[int, list[float]]:
    with wave.open(str(wav_path), "rb") as w:
        sr = w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    n = int(sr * win_s)
    wins = [float(np.sqrt(np.mean(pcm[i:i + n].astype(np.float64) ** 2)))
            for i in range(0, len(pcm) - n + 1, n)]
    return sr, wins


async def run(port: int) -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for stale in list(OUT_DIR.glob("*.png")) + list(OUT_DIR.glob("*.flv")) \
            + list(OUT_DIR.glob("*.wav")) + list(OUT_DIR.glob("*.log")):
        stale.unlink()
    base = f"http://127.0.0.1:{port}"
    ws_base = f"ws://127.0.0.1:{port}"
    assert D14.is_file(), f"driving video missing: {D14}"
    assert Path(FFMPEG).is_file() and Path(FFPROBE).is_file(), (FFMPEG, FFPROBE)

    service_log = open(OUT_DIR / "service.log", "w", encoding="utf-8")
    feeder_log = open(OUT_DIR / "feeder.log", "w", encoding="utf-8")
    sink = service = feeder = None
    sink_log_f = None
    status_snaps: dict[str, dict] = {}
    ok = False
    try:
        # ---- sink ----
        sink_log_f = open(OUT_DIR / "sink.log", "a", encoding="utf-8")
        sink = _start_sink(sink_log_f)
        mark(f"[setup] sink pid={sink.pid} (node-media-server)")
        _wait_port(1935, 20, "sink rtmp")
        _wait_port(8000, 20, "sink http-flv")

        # ---- service（真管线 + stub 翻译 + rtmp 推流）----
        service = subprocess.Popen(
            [VENV_PY, "-m", "service.run_local", "--port", str(port),
             "--translate-stub", "--rtmp", RTMP_TEMPLATE],
            cwd=str(ENGINE_ROOT), stdout=service_log, stderr=subprocess.STDOUT)
        mark(f"[setup] service pid={service.pid}, waiting for /status ...")
        await _wait_status(base, lambda s: s.get("engine") == "ok",
                           "service ready", timeout_s=300)
        mark("[setup] service ready (models loaded, serving)")

        # ---- feeder 立即跟上：mjpeg 端点有首帧前 ffmpeg 的 -rw_timeout
        # 看门狗在倒数（10s），首帧渲染越早、越少吃早期重启 ----
        feeder = subprocess.Popen(
            [VENV_PY, "-m", "service.feeder", "--url", f"{ws_base}/ingest",
             "--video", str(D14), "--fps", "5"],
            cwd=str(ENGINE_ROOT), stdout=feeder_log, stderr=subprocess.STDOUT)
        mark(f"[setup] feeder pid={feeder.pid} (d14 @5fps), warming pipeline ...")
        await _wait_status(base, lambda s: s["channels"]["0"]["processed"] >= 3,
                           "pipeline warm (processed>=3)", timeout_s=120)
        st = await _wait_status(
            base, lambda s: s.get("streams", {}).get("0", {}).get("running") is True,
            "streams.0.running", timeout_s=60)
        warmup_restarts = st["streams"]["0"]["restarts"]
        mark(f"[steady] streams.0 running=True pid={st['streams']['0']['pid']} "
             f"restarts(warmup)={warmup_restarts}")

        # ---- 稳态窗口：8s 内 restarts 不得增长 ----
        await asyncio.sleep(8.0)
        st = await _wait_status(base, lambda s: True, "status", 10)
        status_snaps["steady"] = st
        s0 = st["streams"]["0"]
        mark(f"[steady] after 8s: running={s0['running']} restarts={s0['restarts']} "
             f"stderr_tail={json.dumps(s0['stderr_tail'], ensure_ascii=False)}")
        assert s0["running"] is True, s0
        assert s0["restarts"] == warmup_restarts, \
            f"restarts grew during steady window: {warmup_restarts} -> {s0['restarts']}"
        if warmup_restarts:
            mark(f"[steady] NOTE: {warmup_restarts} warmup restart(s) before first "
                 "rendered frame (mjpeg had no bytes yet, -rw_timeout watchdog) — "
                 "recorded honestly, steady window is clean")

        # ---- 断言 ①：ffprobe HTTP-FLV 流参数 ----
        probe = _ffprobe_streams(FLV_URL)
        (OUT_DIR / "ffprobe_streams.json").write_text(
            json.dumps(probe, indent=2), encoding="utf-8")
        v = [s for s in probe["streams"] if s["codec_type"] == "video"]
        a = [s for s in probe["streams"] if s["codec_type"] == "audio"]
        assert v and a, probe
        v, a = v[0], a[0]
        mark(f"[probe] video: codec={v['codec_name']} {v['width']}x{v['height']} "
             f"r_frame_rate={v['r_frame_rate']} pix_fmt={v.get('pix_fmt')}")
        mark(f"[probe] audio: codec={a['codec_name']} sr={a['sample_rate']} "
             f"channels={a['channels']}")
        assert v["codec_name"] == "h264" and (v["width"], v["height"]) == (512, 512), v
        assert a["codec_name"] == "aac" and a["sample_rate"] == "16000", a

        # ---- 喂中文语音 + 断言 ②：拉 10s FLV（语音窗落在拉流窗内）----
        import websockets
        events: list = []
        stop = asyncio.Event()
        async with websockets.connect(f"{ws_base}/events") as ev_ws, \
                websockets.connect(f"{ws_base}/audio", max_size=None) as au_ws:
            ev_task = asyncio.create_task(_collect_events(ev_ws, events, stop))
            feed_task = asyncio.create_task(_feed_audio(au_ws))

            def tts_events():
                return [e for _, e in events if e["type"] == "tts_ready"]

            deadline = time.monotonic() + 90
            while time.monotonic() < deadline and not tts_events():
                await asyncio.sleep(0.25)
            assert tts_events(), f"no tts_ready within 90s: {events}"
            mark("[pull] first tts_ready arrived — starting 10s FLV pull "
                 "(speech splices into the live track on arrival)")
            pull_path = OUT_DIR / "pull_10s.flv"
            pull = await asyncio.create_subprocess_exec(
                FFMPEG, "-hide_banner", "-loglevel", "warning",
                "-rw_timeout", "10000000", "-i", FLV_URL,
                "-t", "10", "-c", "copy", "-y", str(pull_path),
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
            _, pull_err = await asyncio.wait_for(pull.communicate(), timeout=60)
            mark(f"[pull] ffmpeg rc={pull.returncode} size={pull_path.stat().st_size}B "
                 f"stderr: {pull_err.decode('utf-8', 'replace').strip() or '<empty>'}")
            assert pull.returncode == 0 and pull_path.stat().st_size > 10_000

            await asyncio.wait_for(feed_task, timeout=60)
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline and len(tts_events()) < 2:
                await asyncio.sleep(0.25)
            mark(f"[events] tts_ready total: {len(tts_events())} (expected 2)")
            assert len(tts_events()) >= 2, events
            stop.set()
            await asyncio.gather(ev_task, return_exceptions=True)
        (OUT_DIR / "events.jsonl").write_text(
            "\n".join(json.dumps(e, ensure_ascii=False) for _, e in events),
            encoding="utf-8")

        # ---- 拉流文件解剖：帧 PNG（1fps 全存）+ 音轨 wav ----
        r = subprocess.run(
            [FFMPEG, "-hide_banner", "-loglevel", "error", "-i", str(pull_path),
             "-vf", "fps=1", "-y", str(OUT_DIR / "frame_%02d.png")],
            capture_output=True, text=True, timeout=60)
        assert r.returncode == 0, r.stderr
        frames = sorted(OUT_DIR.glob("frame_*.png"))
        mark(f"[frames] extracted {len(frames)} PNG @1fps from 10s pull")
        assert len(frames) >= 3, frames
        import cv2
        means = {}
        for f in frames:
            img = cv2.imread(str(f))
            assert img is not None, f"frame not decodable: {f}"
            means[f.name] = round(float(np.mean(img)), 1)
            assert np.mean(img) > 10, f"frame blank: {f} mean={np.mean(img)}"
        mark(f"[frames] decode ok, nonblank (mean>10): {means}")

        wav_path = OUT_DIR / "pull_audio.wav"
        r = subprocess.run(
            [FFMPEG, "-hide_banner", "-loglevel", "error", "-i", str(pull_path),
             "-vn", "-ac", "1", "-ar", "16000", "-y", str(wav_path)],
            capture_output=True, text=True, timeout=60)
        assert r.returncode == 0, r.stderr
        sr, wins = _rms_windows(wav_path)
        mark(f"[audio] extracted wav sr={sr} windows(250ms) RMS: "
             f"{['%.0f' % w for w in wins]}")
        speech_rms = max(wins)
        silence_rms = float(np.percentile(wins, 10))
        ratio = speech_rms / max(silence_rms, 1.0)
        mark(f"[audio] speech(max)={speech_rms:.0f} silence(p10)={silence_rms:.0f} "
             f"ratio={ratio:.0f}x")
        assert sr == 16000
        # 语音窗必须显著响于静音窗；阈值保守（int16 语音 RMS 通常 >1000）。
        # 若失败如实带上全部窗值——判断材料都在上面那行 mark 里。
        assert speech_rms > 300 and ratio > 5, \
            f"speech/silence separation weak: max={speech_rms:.0f} " \
            f"p10={silence_rms:.0f} ratio={ratio:.1f} windows={wins}"

        # ---- 断言 ③：/status 全链计数 ----
        st = await _wait_status(base, lambda s: True, "status", 10)
        status_snaps["after_pull"] = st
        ts, ch0, s0 = st["translation"], st["channels"]["0"], st["streams"]["0"]
        mark(f"[status] translation={json.dumps(ts)}")
        mark(f"[status] channels.0: processed={ch0['processed']} errors={ch0['errors']} "
             f"speech={json.dumps(ch0['speech'])}")
        mark(f"[status] streams.0: running={s0['running']} restarts={s0['restarts']} "
             f"stderr_tail={json.dumps(s0['stderr_tail'], ensure_ascii=False)}")
        assert ts["segments"] >= 2 and ts["translated_ok"] >= 2 and ts["tts_ok"] >= 2, ts
        assert ts["errors"] == 0, ts
        assert ch0["errors"] == 0 and ch0["processed"] > 0, ch0
        assert s0["running"] is True, s0
        assert s0["restarts"] == warmup_restarts, \
            f"restarts grew during streaming: {warmup_restarts} -> {s0['restarts']}"

        # ---- 断言 ④：弹性——杀 sink → restarts 增长 → 重启 sink → 恢复 ----
        restarts_before = s0["restarts"]
        t_kill = time.monotonic()
        sink.kill()
        sink.wait(timeout=10)
        mark(f"[resilience] sink KILLED (pid was {sink.pid})")
        st = await _wait_status(
            base, lambda s: s["streams"]["0"]["restarts"] > restarts_before,
            "streams.0.restarts growth after sink kill", timeout_s=30)
        t_detect = time.monotonic() - t_kill
        status_snaps["after_sink_kill"] = st
        s0 = st["streams"]["0"]
        mark(f"[resilience] restarts {restarts_before} -> {s0['restarts']} "
             f"in {t_detect:.1f}s after kill; running={s0['running']} "
             f"last_exit_code={s0['last_exit_code']} "
             f"stderr_tail={json.dumps(s0['stderr_tail'], ensure_ascii=False)}")

        # 退避期间再观察 3s：sink 不在，重启只会继续失败（计数还会涨）
        await asyncio.sleep(3.0)
        sink = _start_sink(sink_log_f)
        t_restart = time.monotonic()
        mark(f"[resilience] sink RESTARTED pid={sink.pid}")
        _wait_port(1935, 20, "sink rtmp (restarted)")
        # 恢复 = running 回 true 且 HTTP-FLV 能再次探出 h264（ghost session
        # 理论上不该出现——旧 NMS 进程整个死了——但仍留 60s 重试窗）
        st = await _wait_status(
            base, lambda s: s["streams"]["0"]["running"] is True,
            "streams.0.running recovery", timeout_s=60)
        recovered = None
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            try:
                probe2 = _ffprobe_streams(FLV_URL, timeout_s=20)
                if any(s["codec_type"] == "video" and s["codec_name"] == "h264"
                       for s in probe2["streams"]):
                    recovered = time.monotonic() - t_restart
                    break
            except (RuntimeError, subprocess.TimeoutExpired, json.JSONDecodeError) as e:
                mark(f"[resilience] probe retry ({type(e).__name__}): {str(e)[:200]}")
            await asyncio.sleep(2.0)
        assert recovered is not None, "stream did not recover within 60s of sink restart"
        status_snaps["recovered"] = await _wait_status(base, lambda s: True, "status", 10)
        s0 = status_snaps["recovered"]["streams"]["0"]
        mark(f"[resilience] RECOVERED: h264 probe ok {recovered:.1f}s after sink "
             f"restart ({time.monotonic() - t_kill:.1f}s after kill); "
             f"restarts={s0['restarts']} running={s0['running']}")

        (OUT_DIR / "status_snapshots.json").write_text(
            json.dumps(status_snaps, ensure_ascii=False, indent=2), encoding="utf-8")
        mark("[rtmp_e2e] PASS")
        ok = True
        return 0
    finally:
        _stop_procs([("feeder", feeder), ("service", service), ("sink", sink)])
        service_log.close()
        feeder_log.close()
        if sink_log_f is not None:
            sink_log_f.close()
        (OUT_DIR / "timeline.txt").write_text("\n".join(TIMELINE), encoding="utf-8")
        if not ok:
            print("[rtmp_e2e] FAIL (see logs in engine/out/rtmp_e2e/)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8917)
    args = ap.parse_args()
    sys.exit(asyncio.run(run(args.port)))
