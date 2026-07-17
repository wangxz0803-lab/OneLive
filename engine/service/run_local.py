"""本地启动引擎服务（Arc 慢速链路）。用法：
  <m0-venv-python> -m service.run_local [--port 8900] [--source <img>] [--channels N]

需从本 worktree 的 engine/ 目录运行（-m 方式）；M0 资产路径通过
环境变量 ONELIVE_M0_ENGINE 指定（默认 .worktrees/v2-m0-spike/engine）。

--channels N：起 N 个频道（0..N-1），每频道一条独立 LivePortraitPipeline。
ONNX 权重经单例缓存共享（M0 验证过），显存不随频道数线性涨；但推理算力
共享同一块 Arc——本地 >1 频道时 ~1.9fps 会被均分，仅作功能验证用。
"""

import argparse
import logging
import os

import uvicorn

from service.app import create_app
from service.liveportrait_pipeline import LivePortraitPipeline

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8900)
    ap.add_argument("--source", default=None)
    ap.add_argument("--channels", type=int, default=1,
                    help="频道数（0..N-1），本地 Arc >1 时帧率被均分")
    args = ap.parse_args()
    # 适配器构造时 os.chdir(_CLONE)，相对路径会错误地相对 clone 目录解析——先转绝对
    source = os.path.abspath(args.source) if args.source else None
    channels = tuple(range(args.channels))
    app = create_app(lambda ch: LivePortraitPipeline(source_image=source),
                     channels=channels)
    for ch in channels:
        print(f"[run_local] channel {ch}: ws://127.0.0.1:{args.port}/out?channel={ch}"
              f"  viewer: http://127.0.0.1:{args.port}/?channel={ch}")
    uvicorn.run(app, host="127.0.0.1", port=args.port)
