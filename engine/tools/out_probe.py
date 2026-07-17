"""/out 探针：收协议帧，测到达 fps 与（可选）端到端延迟。用法（engine/ 目录）：
  python -m tools.out_probe --url ws://127.0.0.1:8900/out [--count 30] [--timeout 10]
      [--save-dir out/probe] [--sends-csv sends.csv]
--sends-csv 为 feeder --log-sends 输出（seq,发送epoch毫秒），按 seq 匹配算同机 E2E 延迟。
--save-dir 存收到的首/中/末帧 PNG 作目检证据。收满 count 或 timeout 秒无帧即结束。
"""

import argparse
import asyncio
import csv
import statistics
import time
from pathlib import Path

import cv2
import numpy as np
import websockets

from service.protocol import unpack_frame


async def probe(args: argparse.Namespace) -> None:
    sends = {}
    if args.sends_csv:
        with open(args.sends_csv, newline="", encoding="utf-8") as f:
            sends = {int(r[0]): int(r[1]) for r in csv.reader(f) if r}
    frames: list[tuple[int, float, bytes]] = []  # (seq, recv_epoch_ms, jpeg)
    async with websockets.connect(args.url, max_size=None) as ws:
        while len(frames) < args.count:
            try:
                blob = await asyncio.wait_for(ws.recv(), timeout=args.timeout)
            except asyncio.TimeoutError:
                print(f"[probe] no frame for {args.timeout}s, stopping")
                break
            header, jpeg = unpack_frame(blob)
            frames.append((header.seq, time.time() * 1000, jpeg))
    if not frames:
        print("[probe] no frames received")
        return
    span = (frames[-1][1] - frames[0][1]) / 1000
    fps = (len(frames) - 1) / span if span > 0 else float("nan")
    sizes = [len(j) for _, _, j in frames]
    print(f"[probe] received {len(frames)} frames in {span:.2f}s (first->last arrival)"
          f" -> arrival fps = {fps:.2f}")
    print(f"[probe] jpeg bytes: avg={sum(sizes)//len(sizes)} min={min(sizes)} max={max(sizes)}")
    print(f"[probe] received seqs: {[s for s, _, _ in frames]}")
    lats = [(s, r - sends[s]) for s, r, _ in frames if s in sends]
    if lats:
        v = [l for _, l in lats]
        print(f"[probe] e2e latency (feeder send ts_ms -> probe recv, {len(lats)} matched"
              f" frames): mean={statistics.mean(v):.0f}ms median={statistics.median(v):.0f}ms"
              f" min={min(v):.0f}ms max={max(v):.0f}ms")
    for i, (seq, _, jpeg) in enumerate(frames):
        img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        assert img is not None, f"seq {seq}: jpeg decode failed"
        if args.save_dir and i in {0, len(frames) // 2, len(frames) - 1}:
            Path(args.save_dir).mkdir(parents=True, exist_ok=True)
            path = Path(args.save_dir) / f"probe_seq{seq}.png"
            cv2.imwrite(str(path), img)
            print(f"[probe] saved {path} shape={img.shape}")
    print(f"[probe] all {len(frames)} jpegs decode ok")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--count", type=int, default=30)
    ap.add_argument("--timeout", type=float, default=10.0)
    ap.add_argument("--save-dir", default=None)
    ap.add_argument("--sends-csv", default=None)
    asyncio.run(probe(ap.parse_args()))
