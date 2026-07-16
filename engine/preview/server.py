# -*- coding: utf-8 -*-
"""
OneLive V2 M0 spike - Task 6: 浏览器实时预览通路（WS + JPEG）。

FastAPI 服务：GET / 返回 index.html（canvas + WS 客户端），WS /ws 逐帧推送
JPEG 二进制。两种模式：

- --mode synthetic（默认）：512x512 合成帧（移动圆 + 帧号），按 25fps 目标节拍
  发送——用于验证传输通路本身能否跑满 25fps（通路健全性基线）。
- --mode pipeline：启动时初始化一次 LivePortrait 管线（source s10.jpg，
  驱动 d14.mp4 循环）；每次 WS 迭代读下一驱动帧→推理→发 out_crop
  （RGB→BGR 后 JPEG q80）。节拍 = 推理速度（无人工 sleep），预期 ~1.5fps
  （Arc 单路 ~660ms/帧，见 spike-results.md §1）——预览 fps == 推理 fps，
  传输不是瓶颈。

推理放在线程 executor 里跑（run_in_executor），事件循环保持响应；
split warping_spade predictor 是持锁单例，多连接并发时会在推理上串行化。
额外的进程内 infer_lock 只在数据竞争层面防止并发交叉调用；多客户端连接仍会
互相污染 pipeline 平滑状态（OneEuroFilter 等）并分摊吞吐——本服务是单客户端
验证工具，多客户端场景留给 M1 的 producer/订阅者结构。

运行（engine/.venv）：
  python engine/preview/server.py --mode synthetic --port 8891
  python engine/preview/server.py --mode pipeline  --port 8891
"""
import argparse
import asyncio
import os
import sys
import threading
import time

import cv2
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse

PREVIEW_DIR = os.path.dirname(os.path.abspath(__file__))
ENGINE_DIR = os.path.dirname(PREVIEW_DIR)
FLP_DIR = os.path.join(ENGINE_DIR, "FasterLivePortrait")
INDEX_HTML = os.path.join(PREVIEW_DIR, "index.html")
DEFAULT_SOURCE = os.path.join(FLP_DIR, "assets", "examples", "source", "s10.jpg")
DEFAULT_DRIVING = os.path.join(FLP_DIR, "assets", "examples", "driving", "d14.mp4")

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

JPEG_PARAMS = [int(cv2.IMWRITE_JPEG_QUALITY), 80]

app = FastAPI(title="OneLive engine preview")

# main() 填充；pipeline 模式下持有已就绪的管线与 source 快照
STATE = {
    "mode": "synthetic",
    "pipe": None,
    "img_src": None,
    "src_info": None,
    "driving": DEFAULT_DRIVING,
    "infer_lock": threading.Lock(),  # 平滑状态保护：同一 pipeline 不允许交叉推理
}


@app.get("/")
async def index():
    with open(INDEX_HTML, "r", encoding="utf-8") as f:
        return HTMLResponse(f.read())


def synthetic_frame(idx: int) -> np.ndarray:
    """512x512 合成帧：深色底 + 圆周运动的圆 + 帧号文本。"""
    img = np.full((512, 512, 3), (32, 24, 16), dtype=np.uint8)
    ang = idx * (2 * np.pi / 100.0)  # 100 帧一圈（25fps 下 4s）
    cx = int(256 + 180 * np.cos(ang))
    cy = int(256 + 180 * np.sin(ang))
    cv2.circle(img, (cx, cy), 40, (0, 200, 255), -1)
    cv2.putText(img, f"frame {idx}", (20, 492), cv2.FONT_HERSHEY_SIMPLEX,
                1.2, (255, 255, 255), 2, cv2.LINE_AA)
    return img


async def stream_synthetic(ws: WebSocket):
    """25fps 目标节拍发送合成帧；每 25 帧打一条实测发送 fps。"""
    target_fps = 25.0
    idx = 0
    t_start = time.perf_counter()
    t_win = t_start
    while True:
        frame = synthetic_frame(idx)
        ok, buf = cv2.imencode(".jpg", frame, JPEG_PARAMS)
        if not ok:
            raise RuntimeError("JPEG encode failed")
        await ws.send_bytes(buf.tobytes())
        idx += 1
        if idx % 25 == 0:
            now = time.perf_counter()
            print(f"[synthetic] sent {idx} frames, last-25 send fps = "
                  f"{25.0 / (now - t_win):.2f}", flush=True)
            t_win = now
        # 绝对节拍：下一帧应在 t_start + idx/fps 发出，避免累计漂移
        delay = t_start + idx / target_fps - time.perf_counter()
        if delay > 0:
            await asyncio.sleep(delay)
        else:
            await asyncio.sleep(0)  # 让出事件循环


def _pipeline_infer_encode(dri_frame: np.ndarray, first: bool) -> bytes | None:
    """在 executor 线程里跑：推理 + RGB→BGR + JPEG 编码。返回 None 表示无脸帧。"""
    st = STATE
    with st["infer_lock"]:
        _, out_crop, _, _ = st["pipe"].run(
            dri_frame, st["img_src"], st["src_info"], first_frame=first)
    if out_crop is None:
        return None
    bgr = cv2.cvtColor(out_crop, cv2.COLOR_RGB2BGR)  # out_crop 是 RGB（实测确认）
    ok, buf = cv2.imencode(".jpg", bgr, JPEG_PARAMS)
    if not ok:
        raise RuntimeError("JPEG encode failed")
    return buf.tobytes()


async def stream_pipeline(ws: WebSocket):
    """驱动视频循环读帧→管线推理→推 JPEG；节拍 = 推理速度。每 5 帧打实测 fps。"""
    loop = asyncio.get_event_loop()
    vcap = cv2.VideoCapture(STATE["driving"])
    if not vcap.isOpened():
        raise RuntimeError(f"cannot open driving video {STATE['driving']}")
    try:
        idx = 0
        t_win = time.perf_counter()
        while True:
            ret, dri_frame = vcap.read()
            if not ret:  # 循环播放
                vcap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                ret, dri_frame = vcap.read()
                if not ret:
                    raise RuntimeError("driving video loop read failed")
            payload = await loop.run_in_executor(
                None, _pipeline_infer_encode, dri_frame, idx == 0)
            if payload is None:  # 驱动帧无脸：跳过不发
                idx += 1
                continue
            await ws.send_bytes(payload)
            idx += 1
            if idx % 5 == 0:
                now = time.perf_counter()
                print(f"[pipeline] sent {idx} frames, last-5 send fps = "
                      f"{5.0 / (now - t_win):.2f}", flush=True)
                t_win = now
    finally:
        vcap.release()


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    peer = f"{ws.client.host}:{ws.client.port}" if ws.client else "?"
    print(f"[ws] client connected: {peer} (mode={STATE['mode']})", flush=True)
    try:
        if STATE["mode"] == "pipeline":
            await stream_pipeline(ws)
        else:
            await stream_synthetic(ws)
    except WebSocketDisconnect:
        print(f"[ws] client disconnected: {peer}", flush=True)
    except (ConnectionError, RuntimeError) as e:
        # uvicorn 在连接关闭后 send 会抛 RuntimeError；按断连处理
        print(f"[ws] connection closed ({peer}): {e}", flush=True)


def init_pipeline(source_path: str, driving_path: str):
    """一次性初始化 LivePortrait 管线（模式=pipeline 时调用，服务启动前）。"""
    # pipeline 代码用 `from src....` 导入，且 mask_crop 等相对路径以 clone 根为基准
    sys.path.insert(0, FLP_DIR)
    os.chdir(FLP_DIR)
    from omegaconf import OmegaConf
    from src.pipelines.faster_live_portrait_pipeline import FasterLivePortraitPipeline

    cfg = OmegaConf.load(os.path.join(FLP_DIR, "configs", "onnx_infer.yaml"))
    cfg.infer_params.flag_pasteback = False  # 只出 512 crop，与基准口径一致

    t0 = time.perf_counter()
    pipe = FasterLivePortraitPipeline(cfg=cfg, is_animal=False)
    t1 = time.perf_counter()
    if not pipe.prepare_source(source_path, realtime=True):
        print(f"ERROR: prepare_source 未检出人脸: {source_path}", flush=True)
        sys.exit(1)
    t2 = time.perf_counter()
    # prepare_source 会清空重建 src_imgs/src_infos，立即快照
    STATE["pipe"] = pipe
    STATE["img_src"] = pipe.src_imgs[0]
    STATE["src_info"] = pipe.src_infos[0]
    STATE["driving"] = driving_path
    print(f"[init] pipeline ready: init {(t1 - t0) * 1000:.0f} ms, "
          f"prepare_source {(t2 - t1) * 1000:.0f} ms "
          f"(source={os.path.basename(source_path)}, "
          f"driving={os.path.basename(driving_path)})", flush=True)


def main():
    p = argparse.ArgumentParser(description="OneLive M0 browser preview server (Task 6)")
    p.add_argument("--mode", choices=["synthetic", "pipeline"], default="synthetic")
    p.add_argument("--port", type=int, default=8891)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--source", default=DEFAULT_SOURCE, help="pipeline 模式 source 图")
    p.add_argument("--driving", default=DEFAULT_DRIVING, help="pipeline 模式驱动视频")
    args = p.parse_args()

    STATE["mode"] = args.mode
    if args.mode == "pipeline":
        init_pipeline(args.source, args.driving)

    import uvicorn
    print(f"[serve] mode={args.mode} http://{args.host}:{args.port}/", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
