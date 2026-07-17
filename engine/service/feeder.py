"""驱动源 feeder：视频文件或摄像头 → JPEG → /ingest。用法：
  python -m service.feeder --url ws://127.0.0.1:8900/ingest --video <path> [--fps 15]
  python -m service.feeder --url ... --camera 0 --fps 15
按目标 fps 节拍发送（绝对时钟防漂移）；服务端 latest-wins 自然适配慢推理。

--log-sends <path>：把每帧 "seq,ts_ms"（发送时刻 epoch 毫秒，与帧头 ts_ms 同值）
写入文件。当前 /out 帧头 ts_ms 尚未透传（M1b 待办），外部探针按 seq 匹配此日志
即可诚实测出端到端延迟（同机时钟直接相减）。
"""

import argparse
import asyncio
import time
from typing import IO, Optional

import cv2
import websockets

from service.protocol import FrameHeader, pack_frame


async def run(url: str, cap: cv2.VideoCapture, fps: float,
              max_frames: int | None, log_file: Optional[IO[str]] = None) -> None:
    async with websockets.connect(url, max_size=None) as ws:
        seq = 0
        t0 = time.perf_counter()
        while max_frames is None or seq < max_frames:
            ok, frame = cap.read()
            if not ok:
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)  # 视频文件循环播放
                continue
            ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
            if ok:
                ts_ms = int(time.time() * 1000)
                header = FrameHeader(seq=seq, ts_ms=ts_ms)
                await ws.send(pack_frame(header, jpg.tobytes()))
                if log_file is not None:
                    log_file.write(f"{seq},{ts_ms}\n")
                    log_file.flush()
            seq += 1
            await asyncio.sleep(max(0.0, t0 + seq / fps - time.perf_counter()))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--video")
    ap.add_argument("--camera", type=int)
    ap.add_argument("--fps", type=float, default=15)
    ap.add_argument("--max-frames", type=int, default=None)
    ap.add_argument("--log-sends", default=None,
                    help="把每帧 seq,发送时刻(epoch ms) 写入此文件供延迟测量")
    args = ap.parse_args()
    assert (args.video is None) != (args.camera is None), "指定 --video 或 --camera 之一"
    cap = cv2.VideoCapture(args.video if args.video else args.camera)
    assert cap.isOpened(), "驱动源打开失败"
    log_file = open(args.log_sends, "w", encoding="utf-8") if args.log_sends else None
    try:
        asyncio.run(run(args.url, cap, args.fps, args.max_frames, log_file))
    finally:
        if log_file is not None:
            log_file.close()
        cap.release()


if __name__ == "__main__":
    main()
