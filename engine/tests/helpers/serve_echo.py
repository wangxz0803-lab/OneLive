"""测试专用启动器：EchoPipeline app + 自喂合成帧，供真 ffmpeg 拉流冒烟
（test_streamer.py 的 demuxer E2E）。必须是真 uvicorn 起在真端口——
ffmpeg 需要真 TCP，手驱 ASGI 够不着它。以 ~15fps 向频道 0 连续喂
320x240 灰色 JPEG（EchoPipeline 原样回吐 → /stream.mjpeg 有持续帧流，
AudioMixer 静音打底 → /stream.wav 有持续音轨）。"""

import argparse
import threading
import time

import cv2
import numpy as np
import uvicorn

from service.app import create_app


class EchoPipeline:
    def infer(self, frame_bgr, seq, lip_ratio=None):
        return frame_bgr


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    args = ap.parse_args()

    app = create_app(lambda ch: EchoPipeline())
    ok, jpg = cv2.imencode(".jpg", np.full((240, 320, 3), 128, np.uint8))
    assert ok
    jpeg = jpg.tobytes()
    worker = app.state.workers[0]

    def feed() -> None:  # worker.submit 线程安全（slot 锁），直接后台线程喂
        seq = 0
        while True:
            worker.submit(jpeg, seq=seq, ts_ms=int(time.time() * 1000))
            seq += 1
            time.sleep(1 / 15)

    threading.Thread(target=feed, daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
