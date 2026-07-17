"""M2a Task 7 E2E：真实服务 + 真实组件的翻译链路验证。用法（engine/ 目录）：

  # 前置：另一终端已起真实服务
  #   <m0-venv-python> -m service.run_local --port 8912 --translate
  <m0-venv-python> -m e2e.translate_e2e --leg server   # 服务链路（诚实无 key 版）
  <m0-venv-python> -m e2e.translate_e2e --leg stub     # stub Provider + 真实 TTS 腿
  <m0-venv-python> -m e2e.translate_e2e --leg all      # 两者都跑（先 stub 后 server）

server 腿（对着 8912 真服务，全真组件，AI_API_KEY 未配置——诚实链路）：
  /audio 实时节奏喂 2 句中文 fixture（250ms 块 + 句间 1s 静音 + 尾部 1.6s 静音），
  /events 收事件，喂音频期间往 /ingest 发 casting 控制帧（真 prepare_source）。
  断言：≥2 条真实中文字幕（欢迎/产品模糊匹配）、每字幕一条 status=unavailable
  的翻译事件、无 tts_ready、/status.translation 计数一致、casting ack ok。

stub 腿（进程内，不需要服务）：真 whisper ASR + stub Provider（返回英文文本）
  + 真 edge-tts synthesize——证明 key 一到位全链路（含配音）立即可用。
  断言：subtitle → translation ok → tts_ready（真实音频 + 嘴型曲线），打印 synth_ms。
"""

import argparse
import asyncio
import json
import struct
import sys
import time
import wave
from pathlib import Path

ENGINE_ROOT = Path(__file__).resolve().parents[1]
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))

FIXTURES = ENGINE_ROOT / "tests" / "fixtures"
CHUNK_S = 0.25          # 250ms/块，实时节奏（模拟采集页 ScriptProcessor 累积发送）
GAP_S = 1.0             # 句间静音（>0.6s 静音确认阈值，保证分段闭合）
TAIL_S = 1.6            # 尾部静音（闭合第二段，不依赖 close() 的 flush）


def _read_wav(path: Path) -> tuple[int, bytes]:
    with wave.open(str(path), "rb") as w:
        assert w.getnchannels() == 1 and w.getsampwidth() == 2, path
        return w.getframerate(), w.readframes(w.getnframes())


def _chunks(pcm: bytes, sr: int):
    step = int(sr * CHUNK_S) * 2
    for i in range(0, len(pcm), step):
        yield pcm[i : i + step]


async def _feed_audio(ws, log: dict) -> None:
    """实时节奏喂 2 句 fixture + 静音；记录每句语音喂完的墙钟（延迟测量基准）。"""
    sr1, pcm1 = _read_wav(FIXTURES / "zh_sentence1.wav")
    sr2, pcm2 = _read_wav(FIXTURES / "zh_sentence2.wav")
    assert sr1 == sr2, "fixtures 采样率必须一致（/audio 会话内 sr 恒定契约）"
    sr = sr1
    silence_gap = b"\x00\x00" * int(sr * GAP_S)
    silence_tail = b"\x00\x00" * int(sr * TAIL_S)
    plan = [("speech1", pcm1), ("gap", silence_gap),
            ("speech2", pcm2), ("tail", silence_tail)]
    for name, pcm in plan:
        for chunk in _chunks(pcm, sr):
            await ws.send(struct.pack("<I", sr) + chunk)
            await asyncio.sleep(CHUNK_S)  # 实时节奏（喂快了延迟测量失真）
        log[f"{name}_end"] = time.monotonic()
        print(f"[feed] {name} sent ({len(pcm)/2/sr:.2f}s audio)")


async def _collect_events(ws, events: list, timeout_s: float) -> None:
    """收 /events 的 wire JSON，带到达墙钟；timeout_s 内静默即停。"""
    while True:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout_s)
        except (asyncio.TimeoutError, Exception) as e:
            if not isinstance(e, asyncio.TimeoutError):
                print(f"[events] connection ended: {e!r}")
            return
        ev = json.loads(raw)
        events.append((time.monotonic(), ev))
        print(f"[event] {json.dumps(ev, ensure_ascii=False)}")


async def _casting(url: str, source: str) -> dict:
    """喂音频期间往 /ingest 发 casting 控制帧，等 ack（真 prepare_source 1-2s）。"""
    import websockets

    async with websockets.connect(url, max_size=None) as ws:
        await ws.send(json.dumps({"type": "casting", "channel": 0, "source": source}))
        ack = json.loads(await asyncio.wait_for(ws.recv(), 90))
        print(f"[casting] ack: {json.dumps(ack, ensure_ascii=False)}")
        return ack


async def leg_server(base: str) -> None:
    import httpx
    import websockets

    ws_base = base.replace("http://", "ws://")
    feed_log: dict = {}
    events: list = []
    async with websockets.connect(f"{ws_base}/events") as ev_ws, \
            websockets.connect(f"{ws_base}/audio", max_size=None) as au_ws:
        collector = asyncio.create_task(_collect_events(ev_ws, events, timeout_s=25))
        feeder = asyncio.create_task(_feed_audio(au_ws, feed_log))
        await asyncio.sleep(2)  # 音频已在流动时发 casting——三路复用共存
        cast_ack = await _casting(f"{ws_base}/ingest", "s1.jpg")
        await feeder
        # 尾段静音已送达；等转写（~2.6s/段）+ 翻译事件收尾，静默 25s 判停
        await collector

    async with httpx.AsyncClient() as client:
        status = (await client.get(f"{base}/status")).json()
    print(f"[status] {json.dumps(status, ensure_ascii=False)}")

    # ---- 断言：诚实无 key 链路 ----
    subs = [(t, e) for t, e in events if e["type"] == "subtitle"]
    trans = [e for _, e in events if e["type"] == "translation"]
    tts = [e for _, e in events if e["type"] == "tts_ready"]
    errors = [e for _, e in events if e["type"] == "pipeline_error"]
    assert len(subs) >= 2, f"期望 ≥2 条字幕，实得 {len(subs)}: {subs}"
    all_text = "".join(e["text"] for _, e in subs)
    assert "欢迎" in all_text, f"字幕未命中'欢迎': {all_text}"
    assert "产品" in all_text, f"字幕未命中'产品': {all_text}"
    for _, s in subs:
        matching = [t for t in trans if t["segment_id"] == s["segment_id"]]
        assert matching, f"字幕段 {s['segment_id']} 缺翻译事件"
        assert all(t["status"] == "unavailable" for t in matching), matching
    assert not tts, f"无 key 不得有 tts_ready: {tts}"
    assert not errors, f"不得有 pipeline_error: {errors}"
    ts = status["translation"]
    assert ts["segments"] >= 2 and ts["translations_unavailable"] >= 2, ts
    assert ts["errors"] == 0 and ts["tts_ok"] == 0, ts
    assert cast_ack["ok"] is True, cast_ack

    # ---- 延迟：语音喂完（含静音确认前）→ 字幕事件到达 ----
    for key, (t_sub, sub) in zip(("speech1_end", "speech2_end"), subs):
        lag = t_sub - feed_log[key]
        print(f"[latency] {key} → subtitle(seg={sub['segment_id']}): {lag:.2f}s "
              f"(含 {GAP_S if key == 'speech1_end' else TAIL_S:.1f}s 静音确认等待)")
    print("[leg_server] PASS")


class StubProvider:
    """固定返回英文文本的 stub（demo TTS 腿用；status=ok 走真实 synthesize）。"""

    available = True

    def __init__(self, text: str):
        self._text = text

    async def translate(self, text: str, target_lang: str):
        from translate.providers import TranslateResult
        return TranslateResult(ok=True, text=self._text, status="ok",
                               detail="stub provider (e2e tts leg)")


async def leg_stub() -> None:
    from translate.asr import SegmentTranscriber
    from translate.pipeline import TranslationPipeline, TTSReadyEvent

    sr, pcm = _read_wav(FIXTURES / "zh_sentence1.wav")
    tp = TranslationPipeline(
        transcriber=SegmentTranscriber(),
        provider=StubProvider("Hello everyone, welcome to my live stream."),
        tts_langs=("en",))
    await tp.start()
    tp.feed_audio(pcm + b"\x00\x00" * sr, sr)  # 尾加 1s 静音闭合段
    await tp.close()  # close() 等 whisper 转写完 + 全部翻译/TTS 任务收尾
    events = []
    async for ev in tp.events():
        events.append(ev)
        print(f"[stub-event] {type(ev).__name__}: "
              f"{ {k: v for k, v in vars(ev).items() if k != 'result'} }")
    tts = [e for e in events if isinstance(e, TTSReadyEvent)]
    assert len(tts) == 1, f"期望 1 条 tts_ready，实得 {events}"
    r = tts[0].result
    assert len(r.audio_pcm16) > 0 and r.sr == 16000 and len(r.lip_curve) > 0
    print(f"[stub-tts] REAL edge-tts audio: {r.duration_s:.2f}s pcm16, "
          f"lip_curve {len(r.lip_curve)} frames (max={float(r.lip_curve.max()):.3f}), "
          f"synth_ms={tts[0].synth_ms}")
    print(f"[stub-stats] {tp.stats()}")
    assert tp.stats() == {"segments": 1, "translated_ok": 1,
                          "translations_unavailable": 0, "tts_ok": 1, "errors": 0}
    print("[leg_stub] PASS")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--leg", choices=("server", "stub", "all"), default="all")
    ap.add_argument("--base", default="http://127.0.0.1:8912")
    args = ap.parse_args()
    if args.leg in ("stub", "all"):
        asyncio.run(leg_stub())
    if args.leg in ("server", "all"):
        asyncio.run(leg_server(args.base))
    print("E2E OK")
