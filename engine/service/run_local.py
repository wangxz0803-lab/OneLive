"""本地启动引擎服务（Arc 慢速链路）。用法：
  <m0-venv-python> -m service.run_local [--port 8900] [--source <img>] [--channels N]
                                        [--https] [--host H] [--cfg onnx_infer.yaml]
                                        [--translate]

--translate：启用翻译链路（/audio 上行 + /events 广播）。真实组件：
faster-whisper small ASR + from_env() 翻译 Provider（AI_API_URL/AI_API_KEY/
AI_MODEL 环境变量；未配 key 时 Provider 诚实 unavailable——字幕照出、
翻译事件 status="unavailable"、不做 TTS，绝不伪造译文）+ edge-tts 英文配音。

需从本 worktree 的 engine/ 目录运行（-m 方式）；M0 资产路径通过
环境变量 ONELIVE_M0_ENGINE 指定（默认 .worktrees/v2-m0-spike/engine）。

--channels N：起 N 个频道（0..N-1），每频道一条独立 LivePortraitPipeline。
ONNX 权重经单例缓存共享（M0 验证过），显存不随频道数线性涨；但推理算力
共享同一块 Arc——本地 >1 频道时 ~1.9fps 会被均分，仅作功能验证用。

--https：用 <repo-root>/certs/onelive-cert.pem + onelive-key.pem 起 TLS。
手机浏览器的 getUserMedia 只在安全上下文可用，局域网真机采集必须走 HTTPS，
故 --https 时 --host 默认 0.0.0.0（可显式覆盖）。
"""

import argparse
import logging
import os
import sys
from pathlib import Path

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
    ap.add_argument("--cfg", default="onnx_infer.yaml",
                    help="LivePortrait 配置名（clone configs/ 下的 yaml）")
    ap.add_argument("--https", action="store_true",
                    help="TLS 服务（证书取 <repo-root>/certs/onelive-{cert,key}.pem）")
    ap.add_argument("--host", default=None,
                    help="监听地址（默认 127.0.0.1；--https 时默认 0.0.0.0）")
    ap.add_argument("--translate", action="store_true",
                    help="启用翻译链路（whisper ASR + from_env() Provider + en TTS）")
    args = ap.parse_args()

    translation_pipeline = None
    if args.translate:
        from translate.asr import SegmentTranscriber
        from translate.pipeline import TranslationPipeline
        from translate.providers import from_env
        provider = from_env()
        if not provider.available:
            print("[run_local] translate: AI_API_KEY/AI_API_URL 未配置，"
                  "Provider unavailable——字幕照常，翻译事件 status=unavailable，无 TTS")
        translation_pipeline = TranslationPipeline(
            transcriber=SegmentTranscriber(),
            provider=provider,
            tts_langs=("en",))

    ssl_kwargs = {}
    if args.https:
        # 本文件在 <repo-root>/engine/service/ 下，parents[2] 即 repo 根；
        # certs/ 在 .gitignore 里，worktree 下没有时从主 checkout 拷或重新生成
        certs_dir = Path(__file__).resolve().parents[2] / "certs"
        cert = certs_dir / "onelive-cert.pem"
        key = certs_dir / "onelive-key.pem"
        if not (cert.is_file() and key.is_file()):
            sys.exit(
                f"[run_local] --https 需要证书，但未找到：\n  {cert}\n  {key}\n"
                "生成方式（任选其一）：\n"
                "  1) 跑一次 Node demo（会在 repo-root/certs/ 生成自签证书）\n"
                "  2) openssl req -x509 -newkey rsa:2048 -nodes -days 365 "
                '-subj "/CN=onelive.local" '
                f'-keyout "{key}" -out "{cert}"')
        ssl_kwargs = {"ssl_certfile": str(cert), "ssl_keyfile": str(key)}

    host = args.host or ("0.0.0.0" if args.https else "127.0.0.1")
    scheme_ws = "wss" if args.https else "ws"
    scheme_http = "https" if args.https else "http"
    show_host = "127.0.0.1" if host in ("0.0.0.0", "::") else host

    # 适配器构造时 os.chdir(_CLONE)，相对路径会错误地相对 clone 目录解析——先转绝对
    source = os.path.abspath(args.source) if args.source else None
    channels = tuple(range(args.channels))
    app = create_app(
        lambda ch: LivePortraitPipeline(source_image=source, cfg_name=args.cfg),
        channels=channels,
        translation_pipeline=translation_pipeline)
    for ch in channels:
        print(f"[run_local] channel {ch}: "
              f"{scheme_ws}://{show_host}:{args.port}/out?channel={ch}"
              f"  viewer: {scheme_http}://{show_host}:{args.port}/?channel={ch}"
              f"  capture: {scheme_http}://{show_host}:{args.port}/capture?channel={ch}")
    uvicorn.run(app, host=host, port=args.port, **ssl_kwargs)
