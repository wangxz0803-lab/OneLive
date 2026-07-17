"""M2b Task 5 E2E：真实服务的"数字人开口说英语"全链路验证。

链路（全真组件，唯一例外是翻译 Provider 用 --translate-stub 测试脚手架）：
  feeder(d14.mp4 @5fps) → /ingest → LivePortraitPipeline 渲染 → /out
  /audio ← 中文 fixture（真 whisper ASR）→ stub 翻译(ok) → 真 edge-tts(en)
  → tee：口型曲线 → SpeechSchedule → 渲染嘴型；音频 → /speech 广播

本脚本自起服务（端口 8915）与 feeder 子进程，收尾必杀。断言：
  1) /events 事件链完整：subtitle → translation ok（stub 自我声明）→
     tts_ready（channel=0），逐段以 segment_id 关联；
  2) /speech 收到二进制帧：头部字段正确、pcm 非空；
  3) /status 计数一致：translation.segments/translated_ok/tts_ok >= 2、
     errors == 0；channels.0.errors == 0；speech.played >= 1（播放窗结束后）；
  4) 嘴型证据：播放窗内 /out 帧的嘴部区域帧间差 vs 空闲基线——软断言
     （渲染 ~1.7fps 对 25fps 曲线欠采样，数值可能偏弱，结果如实报告）；
     窗内 >=3 张、空闲 >=2 张 PNG 存档供目检。

用法（engine/ 目录）：
  <m0-venv-python> -m e2e.lip_e2e [--port 8915] [--keep-service]
输出：engine/out/lip_e2e/ 下 PNG + events.jsonl + status.json + 子进程日志。
"""

import argparse
import asyncio
import json
import struct
import subprocess
import sys
import time
import wave
from pathlib import Path

import cv2
import numpy as np

ENGINE_ROOT = Path(__file__).resolve().parents[1]
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))

from service.protocol import unpack_frame  # noqa: E402

VENV_PY = sys.executable
FIXTURES = ENGINE_ROOT / "tests" / "fixtures"
D14 = Path(r"C:\Users\76475\Documents\OneLive\.worktrees\v2-m0-spike\engine"
           r"\FasterLivePortrait\assets\examples\driving\d14.mp4")
OUT_DIR = ENGINE_ROOT / "out" / "lip_e2e"
CHUNK_S = 0.25   # 实时节奏（同 translate_e2e）
GAP_S = 1.0      # 句间静音（>0.6s 静音确认阈值）
TAIL_S = 1.6     # 尾部静音闭合第二段


def _read_wav(path: Path) -> tuple[int, bytes]:
    with wave.open(str(path), "rb") as w:
        assert w.getnchannels() == 1 and w.getsampwidth() == 2, path
        return w.getframerate(), w.readframes(w.getnframes())


def mouth_crop(img: np.ndarray) -> np.ndarray:
    """嘴部区域裁剪：下 1/3、水平中段（与 verify_live_injection 同口径）。"""
    h, w = img.shape[:2]
    return img[2 * h // 3:, w // 4: 3 * w // 4]


def mean_abs_diff(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.mean(np.abs(a.astype(np.float32) - b.astype(np.float32))))


async def _wait_status(base: str, cond, desc: str, timeout_s: float) -> dict:
    """轮询 GET /status 直到 cond(body) 为真；超时抛 RuntimeError。"""
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
            except httpx.HTTPError:
                pass
            await asyncio.sleep(1.0)
    raise RuntimeError(f"timeout waiting for {desc}; last status: {last}")


async def _collect_out_frames(ws_base: str, duration_s: float, tag: str,
                              stop: asyncio.Event | None = None,
                              sink: list | None = None) -> list:
    """订阅 /out 收渲染帧，返回 [(t, seq, bgr)]。duration_s 到时或 stop 置位即止；
    sink 给出时边收边存（供并发任务实时读取）。"""
    import websockets
    frames = sink if sink is not None else []
    t_end = time.monotonic() + duration_s
    async with websockets.connect(f"{ws_base}/out?channel=0", max_size=None) as ws:
        while time.monotonic() < t_end and not (stop is not None and stop.is_set()):
            try:
                blob = await asyncio.wait_for(ws.recv(), 1.0)
            except asyncio.TimeoutError:
                continue
            header, jpeg = unpack_frame(blob)
            img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
            if img is not None:
                frames.append((time.monotonic(), header.seq, img))
    print(f"[{tag}] collected {len(frames)} /out frames")
    return frames


async def _feed_audio(ws, feed_log: dict) -> None:
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
        feed_log[f"{name}_end"] = time.monotonic()
        print(f"[feed] {name} sent ({len(pcm) / 2 / sr:.2f}s audio)")


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
        print(f"[event] {json.dumps(ev, ensure_ascii=False)}")


async def _collect_speech(ws, frames: list, stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            blob = await asyncio.wait_for(ws.recv(), 1.0)
        except asyncio.TimeoutError:
            continue
        except Exception as e:
            print(f"[speech] connection ended: {e!r}")
            return
        ch, seg, sr = struct.unpack_from("<BII", blob)
        frames.append((time.monotonic(), ch, seg, sr, blob[9:]))
        print(f"[speech] frame: channel={ch} segment={seg} sr={sr} pcm={len(blob) - 9}B "
              f"({(len(blob) - 9) / 2 / max(sr, 1):.2f}s)")


def _stop_procs(procs: list[tuple[str, object]]) -> None:
    """幂等停子进程：terminate → 超时 kill；已退出的跳过。"""
    for name, proc in procs:
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=10)
            print(f"[teardown] {name} stopped")


def _successive_mouth_diffs(frames: list, max_seq_gap: int = 6) -> list[float]:
    """连续帧（按 seq 去重后）嘴部区域平均绝对差序列。seq 间隔超过
    max_seq_gap 的相邻对跳过——两个播放窗之间的大跳会混入纯头动差。"""
    uniq = []
    for _, seq, img in frames:
        if not uniq or uniq[-1][0] != seq:
            uniq.append((seq, mouth_crop(img)))
    return [mean_abs_diff(uniq[i][1], uniq[i + 1][1])
            for i in range(len(uniq) - 1)
            if uniq[i + 1][0] - uniq[i][0] <= max_seq_gap]


async def run(port: int, keep_service: bool) -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for stale in OUT_DIR.glob("*.png"):  # 上一轮的 PNG 按 seq 命名，先清场
        stale.unlink()
    base = f"http://127.0.0.1:{port}"
    ws_base = f"ws://127.0.0.1:{port}"
    assert D14.is_file(), f"driving video missing: {D14}"

    service_log = open(OUT_DIR / "service.log", "w", encoding="utf-8")
    feeder_log = open(OUT_DIR / "feeder.log", "w", encoding="utf-8")
    service = subprocess.Popen(
        [VENV_PY, "-m", "service.run_local", "--port", str(port), "--translate-stub"],
        cwd=str(ENGINE_ROOT), stdout=service_log, stderr=subprocess.STDOUT)
    feeder = None
    ok = False
    try:
        print(f"[setup] service pid={service.pid}, waiting for /status ...")
        await _wait_status(base, lambda s: s.get("engine") == "ok",
                           "service ready", timeout_s=300)
        feeder = subprocess.Popen(
            [VENV_PY, "-m", "service.feeder", "--url", f"{ws_base}/ingest",
             "--video", str(D14), "--fps", "5"],
            cwd=str(ENGINE_ROOT), stdout=feeder_log, stderr=subprocess.STDOUT)
        print(f"[setup] feeder pid={feeder.pid} (d14 @5fps), warming pipeline ...")
        await _wait_status(base, lambda s: s["channels"]["0"]["processed"] >= 3,
                           "pipeline warm (processed>=3)", timeout_s=120)

        # ---- 空闲基线：无语音时的 /out 帧（enable_lip=True、lip_ratio=None）----
        idle_frames = await _collect_out_frames(ws_base, 6.0, "idle")
        assert len(idle_frames) >= 3, f"idle window too few frames: {len(idle_frames)}"
        for i, (_, seq, img) in enumerate(idle_frames[:2]):
            cv2.imwrite(str(OUT_DIR / f"idle_{i}_seq{seq}.png"), img)
        # M1a 基线语义对比用（m2b-results 待办）：留一张空闲帧
        cv2.imwrite(str(OUT_DIR / "idle_for_m1a_compare.png"), idle_frames[-1][2])

        # ---- 订阅 /events /speech + 连续 /out 采样（必须先于喂音频）----
        # 采样从喂音频前就开始连续进行：clip 在 tts_ready 到达那一刻 enqueue、
        # 下一次渲染轮询（≤0.6s）就开播——1.4s 的短音频只有 2-3 个渲染帧，
        # 事后按 tts_ready 到达时刻 + duration 把帧分类为 active/idle。
        import websockets
        events: list = []
        speech_frames: list = []
        live_frames: list = []
        feed_log: dict = {}
        stop = asyncio.Event()
        out_stop = asyncio.Event()
        async with websockets.connect(f"{ws_base}/events") as ev_ws, \
                websockets.connect(f"{ws_base}/speech?channel=0", max_size=None) as sp_ws, \
                websockets.connect(f"{ws_base}/audio", max_size=None) as au_ws:
            ev_task = asyncio.create_task(_collect_events(ev_ws, events, stop))
            sp_task = asyncio.create_task(_collect_speech(sp_ws, speech_frames, stop))
            out_task = asyncio.create_task(_collect_out_frames(
                ws_base, 300.0, "live", stop=out_stop, sink=live_frames))
            await _feed_audio(au_ws, feed_log)

            # 等两条 tts_ready（转写 ~2.6s/段 + stub 翻译即时 + edge-tts 数秒）
            def tts_events():
                return [(t, e) for t, e in events if e["type"] == "tts_ready"]
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline and len(tts_events()) < 2:
                await asyncio.sleep(0.25)
            assert len(tts_events()) >= 2, \
                f"expected 2 tts_ready within 60s, got {len(tts_events())}: {events}"

            # 最后一段的播放窗走完再多等 3s（含下一渲染轮询 + played 收尾）
            t_last, e_last = tts_events()[-1]
            tail = max(0.0, t_last + e_last["duration_s"] + 3.0 - time.monotonic())
            await asyncio.sleep(tail)
            stop.set()
            out_stop.set()
            await asyncio.gather(ev_task, sp_task, out_task, return_exceptions=True)

        # ---- 帧分类：clip enqueue（=tts_ready 到达）→ 下次轮询开播（≤0.6s）
        # → 渲染 0.6s 后帧到达。active = 到达时刻 ∈ [t_i+0.4, t_i+d_i+1.2]；
        # 边界带 [t_i-1.0, t_i+d_i+2.0] 内的其余帧不参与 idle（时钟毛刺缓冲）。
        active_frames, live_idle = [], []
        for t_f, seq, img in live_frames:
            in_active = any(t_i + 0.4 <= t_f <= t_i + e["duration_s"] + 1.2
                            for t_i, e in tts_events())
            near = any(t_i - 1.0 <= t_f <= t_i + e["duration_s"] + 2.0
                       for t_i, e in tts_events())
            if in_active:
                active_frames.append((t_f, seq, img))
            elif not near:
                live_idle.append((t_f, seq, img))
        print(f"[classify] live frames: {len(live_frames)} total, "
              f"{len(active_frames)} active (lip playing), {len(live_idle)} idle")
        assert len(active_frames) >= 3, \
            f"too few frames during playback windows: {len(active_frames)}"
        for i, (_, seq, img) in enumerate(active_frames[:8]):
            cv2.imwrite(str(OUT_DIR / f"inwin_{i}_seq{seq}.png"), img)
        inwin_frames = active_frames

        # ---- 收尾状态 + 存证 ----
        status = await _wait_status(
            base, lambda s: s["channels"]["0"]["speech"]["played"] >= 1,
            "speech.played >= 1", timeout_s=30)
        (OUT_DIR / "events.jsonl").write_text(
            "\n".join(json.dumps(e, ensure_ascii=False) for _, e in events),
            encoding="utf-8")
        (OUT_DIR / "status.json").write_text(
            json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[status] {json.dumps(status, ensure_ascii=False)}")

        # ---- 断言 1：事件链完整（逐段 segment_id 关联）----
        subs = [e for _, e in events if e["type"] == "subtitle"]
        trans = [e for _, e in events if e["type"] == "translation"]
        tts = [e for _, e in events if e["type"] == "tts_ready"]
        errs = [e for _, e in events if e["type"] == "pipeline_error"]
        assert len(subs) >= 2, f"expected >=2 subtitles, got {subs}"
        all_text = "".join(e["text"] for e in subs)
        assert "欢迎" in all_text and "产品" in all_text, f"ASR text unexpected: {all_text}"
        for s in subs:
            m_tr = [t for t in trans if t["segment_id"] == s["segment_id"]]
            assert m_tr and all(t["status"] == "ok" for t in m_tr), (s, m_tr)
            assert all(t["text"].startswith("EN: ") for t in m_tr), m_tr  # stub 自我声明
            m_tts = [t for t in tts if t["segment_id"] == s["segment_id"]]
            assert m_tts, f"segment {s['segment_id']} missing tts_ready"
            assert all(t["lang"] == "en" and t["channel"] == 0 and t["has_audio"]
                       for t in m_tts), m_tts
        assert not errs, f"pipeline_error events: {errs}"

        # ---- 断言 2：/speech 二进制帧 ----
        assert speech_frames, "no /speech frames received"
        for _, ch, seg, sr, pcm in speech_frames:
            assert ch == 0 and sr == 16000 and len(pcm) > 0, (ch, seg, sr, len(pcm))
        assert {f[2] for f in speech_frames} == {t["segment_id"] for t in tts}

        # ---- 断言 3：/status 计数链一致 ----
        ts = status["translation"]
        assert ts["segments"] >= 2 and ts["translated_ok"] >= 2 and ts["tts_ok"] >= 2, ts
        assert ts["errors"] == 0, ts
        ch0 = status["channels"]["0"]
        assert ch0["errors"] == 0 and ch0["processed"] > 0, ch0
        assert ch0["speech"]["played"] >= 1, ch0["speech"]

        # ---- 延迟：语音喂完 → tts_ready 到达 ----
        for key, (t_tts, e) in zip(("speech1_end", "speech2_end"), tts_events()):
            lag = t_tts - feed_log[key]
            print(f"[latency] {key} → tts_ready(seg={e['segment_id']}): {lag:.2f}s "
                  f"(含静音确认等待 + whisper + edge-tts)")

        # ---- 断言 4（软）：嘴型数值证据 ----
        idle_diffs = _successive_mouth_diffs(idle_frames)
        inwin_diffs = _successive_mouth_diffs(inwin_frames)
        idle_mean, idle_var = float(np.mean(idle_diffs)), float(np.var(idle_diffs))
        in_mean, in_var = float(np.mean(inwin_diffs)), float(np.var(inwin_diffs))
        print(f"[mouth] idle   successive diffs: {['%.2f' % d for d in idle_diffs]} "
              f"mean={idle_mean:.2f} var={idle_var:.2f}")
        print(f"[mouth] inwin  successive diffs: {['%.2f' % d for d in inwin_diffs]} "
              f"mean={in_mean:.2f} var={in_var:.2f}")
        soft_ok = in_var > idle_var
        verdict = ("PASS" if soft_ok else
                   "WEAK (undersampling ~1.7fps vs 25fps curve; d14 head motion "
                   "confounds — judge by PNGs)")
        print(f"[mouth] SOFT assert in-window var > idle var: {verdict}")

        # ---- 断言 5（硬）：渲染线程确实以非 None lip_ratio 渲染过 ----
        # worker 在语音期逐帧打 "speech lip=<v> on seq=<n>"（INFO）——先停服务
        # 保证日志落盘，再解析出 seq→lip 对照表，与存档 PNG 的 seq 相互印证。
        _stop_procs([("feeder", feeder)]
                    + ([] if keep_service else [("service", service)]))
        lip_lines = [ln for ln in
                     (OUT_DIR / "service.log").read_text(encoding="utf-8",
                                                         errors="replace").splitlines()
                     if "speech lip=" in ln]
        lip_by_seq = {}
        for ln in lip_lines:
            m = ln.split("speech lip=")[1]
            v, seq_s = m.split(" on seq=")
            lip_by_seq[int(seq_s.strip())] = float(v)
        print(f"[lip-log] {len(lip_lines)} frames rendered with non-None lip_ratio: "
              f"{lip_by_seq}")
        assert len(lip_by_seq) >= 2, \
            "no/too few frames rendered with speech lip — injection did not reach renderer"
        saved = {seq for _, seq, _ in active_frames[:8]}
        overlap = sorted(saved & set(lip_by_seq))
        print(f"[lip-log] saved active PNG seqs {sorted(saved)} ∩ lip-log seqs = {overlap} "
              f"(values: { {s: lip_by_seq[s] for s in overlap} })")

        print("[lip_e2e] PASS")
        ok = True
        return 0
    finally:
        procs = [("feeder", feeder)]
        if keep_service:
            print(f"[teardown] --keep-service: service pid={service.pid} left running")
        else:
            procs.append(("service", service))
        _stop_procs(procs)
        service_log.close()
        feeder_log.close()
        if not ok:
            print("[lip_e2e] FAIL (see logs in engine/out/lip_e2e/)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8915)
    ap.add_argument("--keep-service", action="store_true",
                    help="调试用：结束后不杀服务（默认必杀，端口必须归还）")
    args = ap.parse_args()
    sys.exit(asyncio.run(run(args.port, args.keep_service)))
