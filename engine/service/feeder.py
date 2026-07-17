"""驱动源 feeder：视频文件或摄像头 → JPEG → /ingest。用法：
  python -m service.feeder --url ws://127.0.0.1:8900/ingest --video <path> [--fps 15]
  python -m service.feeder --url ... --camera 0 --fps 15
按目标 fps 节拍发送（绝对时钟防漂移）；服务端 latest-wins 自然适配慢推理。

--log-sends <path>：把每帧 "seq,ts_ms"（发送时刻 epoch 毫秒，与帧头 ts_ms 同值）
写入文件。/out 帧头已原样透传 /ingest 的 ts_ms，端到端延迟的主路径是
`out_probe --latency-from-header`（直接用帧头时间戳相减）；--log-sends 保留
作为交叉验证手段（探针按 seq 匹配此日志，独立复核帧头口径）。
"""

import argparse
import asyncio
import time
from pathlib import Path
from typing import IO, Optional

import cv2
import websockets

from service.protocol import FrameHeader, pack_frame


async def run(url: str, cap: cv2.VideoCapture, fps: float,
              max_frames: int | None, log_file: Optional[IO[str]] = None,
              save_raw: Optional[str] = None) -> None:
    async with websockets.connect(url, max_size=None) as ws:
        seq = 0
        fails = 0  # 连续读取失败计数：摄像头拔出/占用时干净退出而非 100% CPU 空转
        t0 = time.perf_counter()
        while max_frames is None or seq < max_frames:
            ok, frame = cap.read()
            if not ok:
                fails += 1
                if fails >= 50:
                    raise SystemExit("driving source read failed repeatedly "
                                     f"({fails} consecutive failures) — 摄像头断开或视频源损坏")
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)  # 视频文件循环播放（摄像头为 no-op）
                await asyncio.sleep(0.1)
                continue
            fails = 0
            if save_raw is not None and seq % 200 == 0:  # 每 200 帧存一张输入证据
                Path(save_raw).mkdir(parents=True, exist_ok=True)
                cv2.imwrite(str(Path(save_raw) / f"raw_seq{seq}.png"), frame)
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
    ap.add_argument("--save-raw", default=None,
                    help="每 200 帧把原始驱动帧 PNG 存入此目录（输入侧目检证据）")
    args = ap.parse_args()
    assert (args.video is None) != (args.camera is None), "指定 --video 或 --camera 之一"
    cap = cv2.VideoCapture(args.video if args.video else args.camera)
    assert cap.isOpened(), "驱动源打开失败"
    log_file = open(args.log_sends, "w", encoding="utf-8") if args.log_sends else None
    try:
        asyncio.run(run(args.url, cap, args.fps, args.max_frames, log_file, args.save_raw))
    finally:
        if log_file is not None:
            log_file.close()
        cap.release()


if __name__ == "__main__":
    main()
