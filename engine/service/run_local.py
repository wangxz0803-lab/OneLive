"""本地启动引擎服务（Arc 慢速链路）。用法：
  <m0-venv-python> -m service.run_local [--port 8900] [--source <img>]

需从本 worktree 的 engine/ 目录运行（-m 方式）；M0 资产路径通过
环境变量 ONELIVE_M0_ENGINE 指定（默认 .worktrees/v2-m0-spike/engine）。
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
    args = ap.parse_args()
    # 适配器构造时 os.chdir(_CLONE)，相对路径会错误地相对 clone 目录解析——先转绝对
    source = os.path.abspath(args.source) if args.source else None
    app = create_app(pipeline=LivePortraitPipeline(source_image=source))
    uvicorn.run(app, host="127.0.0.1", port=args.port)
