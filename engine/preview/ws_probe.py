# -*- coding: utf-8 -*-
"""
OneLive V2 M0 spike - Task 6 验证探针：无浏览器环境下程序化验证预览通路。

做三件事：
1. GET /：断言 200 且包含 "OneLive engine preview"；
2. 连 WS 收 --count 条二进制消息，测到达 fps（(N-1)/(t_last-t_first)）与
   平均/最小/最大 JPEG 字节数；
3. 解码首帧断言合法 JPEG（cv2.imdecode 非 None），可选 --save-dir 把
   首帧/末帧存成 {prefix}_f0.png / {prefix}_f{N-1}.png 供目视核验。

运行（engine/.venv）：
  python engine/preview/ws_probe.py --url ws://127.0.0.1:8891/ws --count 100
  python engine/preview/ws_probe.py --url ws://127.0.0.1:8891/ws --count 15 \
      --save-dir engine/out --prefix preview_pipeline
"""
import argparse
import asyncio
import os
import sys
import time
import urllib.request

import cv2
import numpy as np
import websockets

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def check_http(ws_url: str) -> None:
    http_url = ws_url.replace("ws://", "http://").rsplit("/ws", 1)[0] + "/"
    with urllib.request.urlopen(http_url, timeout=10) as resp:
        body = resp.read().decode("utf-8")
        ok_title = "OneLive engine preview" in body
        print(f"[http] GET {http_url} -> {resp.status}, "
              f"title present: {ok_title}, {len(body)} bytes")
        assert resp.status == 200 and ok_title, "HTTP index check failed"


async def probe(url: str, count: int, save_dir: str | None, prefix: str) -> None:
    print(f"[ws] connecting {url}, expecting {count} binary messages...")
    frames: list[bytes] = []
    async with websockets.connect(url, max_size=8 * 1024 * 1024,
                                  open_timeout=30) as ws:
        t_first = None
        while len(frames) < count:
            msg = await asyncio.wait_for(ws.recv(), timeout=60)
            if not isinstance(msg, (bytes, bytearray)):
                continue
            if t_first is None:
                t_first = time.perf_counter()
            frames.append(bytes(msg))
        t_last = time.perf_counter()

    sizes = np.array([len(f) for f in frames])
    elapsed = t_last - t_first
    fps = (len(frames) - 1) / elapsed if elapsed > 0 else float("inf")
    print(f"[ws] received {len(frames)} frames in {elapsed:.2f}s "
          f"(from first to last arrival) -> arrival fps = {fps:.2f}")
    print(f"[ws] jpeg bytes: avg={sizes.mean():.0f} min={sizes.min()} "
          f"max={sizes.max()}")

    first = cv2.imdecode(np.frombuffer(frames[0], np.uint8), cv2.IMREAD_COLOR)
    last = cv2.imdecode(np.frombuffer(frames[-1], np.uint8), cv2.IMREAD_COLOR)
    assert first is not None and last is not None, "JPEG decode failed"
    print(f"[decode] first frame shape={first.shape}, last frame shape={last.shape}")

    if save_dir:
        os.makedirs(save_dir, exist_ok=True)
        p0 = os.path.join(save_dir, f"{prefix}_f0.png")
        pn = os.path.join(save_dir, f"{prefix}_f{len(frames) - 1}.png")
        cv2.imwrite(p0, first)
        cv2.imwrite(pn, last)
        print(f"[save] {p0}")
        print(f"[save] {pn}")


def main():
    p = argparse.ArgumentParser(description="WS preview probe (Task 6)")
    p.add_argument("--url", default="ws://127.0.0.1:8891/ws")
    p.add_argument("--count", type=int, default=100)
    p.add_argument("--save-dir", default=None)
    p.add_argument("--prefix", default="preview")
    p.add_argument("--skip-http", action="store_true", help="跳过 GET / 检查")
    args = p.parse_args()

    if not args.skip_http:
        check_http(args.url)
    asyncio.run(probe(args.url, args.count, args.save_dir, args.prefix))
    print("[probe] OK")


if __name__ == "__main__":
    main()
