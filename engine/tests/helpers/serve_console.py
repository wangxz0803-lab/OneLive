"""测试专用启动器（M3b Task 4，console E2E 用）：给导播控制台喂"活数据"。

serve_echo.py 只喂视频帧、不带翻译/推流/uplink——console 的字幕流 / casting /
HUD 上行 / 推流徽标全都无从断言。本启动器补齐这些，全部走服务真实路径
（真 EchoPipeline worker + 真 /events 广播消费者 + 真 UplinkStore + 真
StreamerManager.status() 形态），只把"数据源"替换为确定性桩：

- 频道 0 真 EchoPipeline：后台线程以 ~15fps 喂灰度 JPEG（灰阶随 seq 变化，
  console 预览 canvas 每帧像素不同 → 可断言帧在推进）。EchoPipeline.set_source
  是 recorder（存路径、不抛）——casting 走 /ingest → worker.post_command →
  ack ok=true 全链路真实。
- 假翻译管线：events() 循环发 subtitle → translation(status=ok，桩自证 "EN: …")
  → tts_ready（lang=en → 频道 0，真 tee 进 SpeechSchedule + /speech 广播 +
  混音器）。不喂 /audio、直接注入事件——确定性、不依赖 whisper/edge-tts。
- 假 uplink：feeder 线程每 ~1.5s 记一条新鲜 uplink_stats（rtt_ms 固定），
  /status 的 age 始终 < stale 阈值 → HUD 链路RTT(ws) 显示且不置灰。
- 假 streamer：status() 报频道 0 running=true → console 推流徽标"推流中"。

用法（engine/ 目录，PYTHONPATH=engine）：
  <m0-venv-python> tests/helpers/serve_console.py --port 8920
必须真 uvicorn 起在真端口——Playwright 驱真 chromium，手驱 ASGI 够不着。
"""

import argparse
import asyncio
import os
import threading
import time

import cv2
import numpy as np
import uvicorn

# 字幕探针常量：console_e2e.mjs 断言字幕面板含此串（两端唯一出处，改这里要同步 mjs）
SUBTITLE_PROBE = "OneLive-E2E-字幕探针"

# casting 底图目录：默认引用 M0 资产（真 jpg，/avatars 枚举 + set_source is_file 都需真文件）。
# 显式 ONELIVE_AVATAR_DIR 优先（CI/别机可覆盖）。启动器早设 env，create_app 内 _avatar_dir 取用。
_DEFAULT_AVATAR_DIR = (
    r"C:\Users\76475\Documents\OneLive\.worktrees\v2-m0-spike\engine"
    r"\FasterLivePortrait\assets\examples\source")
os.environ.setdefault("ONELIVE_AVATAR_DIR", _DEFAULT_AVATAR_DIR)

from service.app import create_app  # noqa: E402  (env 必须先设)
from translate.pipeline import (  # noqa: E402
    SubtitleEvent, TranslationEvent, TTSReadyEvent)
from translate.tts import TTSResult  # noqa: E402


class EchoPipeline:
    """原样回吐驱动帧；set_source 为 recorder（casting ack 走真链路，值不参与渲染）。"""

    def __init__(self) -> None:
        self.source_path: str | None = None

    def infer(self, frame_bgr, seq, lip_ratio=None):
        return frame_bgr

    def set_source(self, path: str) -> None:
        self.source_path = path  # 只记不抛 → on_done(None) → casting_ack ok=true


class FakeTranslationPipeline:
    """确定性事件源：循环发 subtitle → translation(ok) → tts_ready，喂 console /events。
    直接注入事件（不经 /audio + whisper + edge-tts），桩自证、可复现。接口鸭子对齐
    真 TranslationPipeline（start/events/feed_audio/close/stats）。"""

    def __init__(self) -> None:
        self._q: asyncio.Queue = asyncio.Queue()
        self._emitter: asyncio.Task | None = None
        self._stats = {"segments": 0, "translated_ok": 0,
                       "translations_unavailable": 0, "tts_ok": 0, "errors": 0}

    async def start(self) -> None:
        self._emitter = asyncio.create_task(self._emit())

    async def _emit(self) -> None:
        # 1s 静音 pcm16 + 25 帧（1.0s @25fps）平嘴曲线：SpeechClip 一致性校验通过
        pcm = b"\x00\x00" * 16000
        curve = np.zeros(25, dtype=np.float32)
        seg = 0
        try:
            while True:
                seg += 1
                self._stats["segments"] += 1
                self._q.put_nowait(SubtitleEvent(
                    segment_id=seg, text=f"{SUBTITLE_PROBE} seg{seg}", t0=0.0, t1=1.0))
                await asyncio.sleep(0.3)
                self._stats["translated_ok"] += 1
                self._q.put_nowait(TranslationEvent(
                    segment_id=seg, lang="en", status="ok",
                    text=f"EN: OneLive E2E probe seg{seg}", detail=None))
                await asyncio.sleep(0.3)
                self._stats["tts_ok"] += 1
                self._q.put_nowait(TTSReadyEvent(
                    segment_id=seg, lang="en", voice="en-US-JennyNeural",
                    duration_s=1.0, synth_ms=100,
                    result=TTSResult(audio_pcm16=pcm, sr=16000, lip_curve=curve,
                                     duration_s=1.0, synth_ms=100)))
                await asyncio.sleep(2.4)
        except asyncio.CancelledError:
            pass

    async def events(self):
        while True:
            item = await self._q.get()
            if item is None:
                return
            yield item

    def feed_audio(self, pcm16: bytes, sr: int) -> None:
        pass  # 本启动器直接注入事件，不走音频上行

    async def close(self) -> None:
        if self._emitter is not None:
            self._emitter.cancel()
        self._q.put_nowait(None)  # events() 消费者终结

    def stats(self) -> dict:
        return dict(self._stats)


class _FakeChannelState:
    def __init__(self) -> None:
        self.running = True
        self.pid = 4321
        self.restarts = 0
        self.last_exit_code = None
        self.stderr_tail: list[str] = []


class FakeStreamer:
    """假推流监督：status() 报频道 0 running=true（console 徽标"推流中"）。
    start_all/stop_all 为 async no-op（不真起 ffmpeg）。"""

    def __init__(self) -> None:
        self._states = {0: _FakeChannelState()}

    async def start_all(self) -> None:
        pass

    async def stop_all(self) -> None:
        pass

    def status(self) -> dict:
        return {str(ch): {
            "running": st.running, "pid": st.pid, "restarts": st.restarts,
            "last_exit_code": st.last_exit_code, "stderr_tail": list(st.stderr_tail),
        } for ch, st in self._states.items()}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    args = ap.parse_args()

    avatar_dir = os.environ["ONELIVE_AVATAR_DIR"]
    if not os.path.isdir(avatar_dir):
        raise SystemExit(
            f"avatar dir missing: {avatar_dir}\n"
            "set ONELIVE_AVATAR_DIR to a dir with whitelisted jpg/png for casting")

    app = create_app(lambda ch: EchoPipeline(), channels=(0,),
                     translation_pipeline=FakeTranslationPipeline(),
                     lang_channels={"en": 0}, streamer=FakeStreamer())
    worker = app.state.workers[0]
    uplink = app.state.uplink

    def feed() -> None:
        """~15fps 灰度帧（灰阶随 seq 变，预览 canvas 逐帧不同）+ 每 ~1.5s 一条新鲜 uplink。"""
        seq = 0
        while True:
            level = 30 + (seq % 8) * 25  # 30..205，帧间可见差异 → 可断言帧推进
            ok, jpg = cv2.imencode(".jpg", np.full((240, 320, 3), level, np.uint8))
            if ok:
                worker.submit(jpg.tobytes(), seq=seq, ts_ms=int(time.time() * 1000))
            if seq % 22 == 0:  # ~1.5s：喂新鲜 uplink，age 恒 < stale 阈值
                uplink.record(0, {"fps_sent": 14.7, "skipped": 3, "rtt_ms": 8},
                              time.monotonic())
            seq += 1
            time.sleep(1 / 15)

    threading.Thread(target=feed, daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
