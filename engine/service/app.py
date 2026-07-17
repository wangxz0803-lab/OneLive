"""数字人引擎服务：/ingest 收驱动帧（producer），/out 扇出渲染帧，/status 状态。

与 M0 preview server 的关键区别：推理由常驻 ChannelWorker 驱动，
WS 连接只是数据的进出口——多个 /out 订阅者共享同一路渲染结果，
新订阅者不会触发新推理，/ingest 断开重连不重置管线状态。
"""

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse

_VIEWER_HTML = Path(__file__).resolve().parent / "viewer.html"

from service.protocol import FrameHeader, pack_frame, unpack_frame
from service.worker import ChannelWorker

log = logging.getLogger("engine.service")


def create_app(pipeline) -> FastAPI:
    worker = ChannelWorker(pipeline=pipeline, name="ch0")
    worker.start()

    # 计划里用的 @app.on_event("shutdown") 在当前 FastAPI (0.139) 已弃用并发
    # DeprecationWarning，改用 lifespan。worker 在 create_app 时启动（TestClient
    # 不进 lifespan startup 也能工作），lifespan 退出时停止。
    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        worker.stop()

    app = FastAPI(lifespan=lifespan)

    @app.get("/")
    async def index() -> HTMLResponse:
        return HTMLResponse(_VIEWER_HTML.read_text(encoding="utf-8"))

    @app.get("/status")
    async def status() -> dict:
        # channel 统计口径：last_infer_ms = 最近一次“跑到计时代码”的 infer 耗时
        # （无脸帧也会刷新；infer 抛异常则不更新）；errors 聚合管线异常 +
        # JPEG 编码失败 + 订阅者回调异常三类。
        return {"engine": "ok", "channel": worker.stats()}

    @app.websocket("/ingest")
    async def ingest(ws: WebSocket) -> None:
        await ws.accept()
        try:
            while True:
                blob = await ws.receive_bytes()
                try:
                    header, payload = unpack_frame(blob)
                    frame = cv2.imdecode(np.frombuffer(payload, np.uint8), cv2.IMREAD_COLOR)
                    if frame is None:
                        raise ValueError("jpeg decode failed")
                except ValueError as e:
                    log.warning("ingest: bad frame dropped: %s", e)
                    continue
                worker.submit(frame, seq=header.seq, ts_ms=header.ts_ms)
        except WebSocketDisconnect:
            log.info("ingest disconnected")

    @app.websocket("/out")
    async def out(ws: WebSocket) -> None:
        await ws.accept()
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=4)

        def on_frame(seq: int, ts_ms: int, jpeg: bytes) -> None:  # worker 线程回调 → 事件循环
            # ts_ms 为 /ingest 帧头带来的采集时间戳，原样透传，/out 端可直接算 E2E 延迟
            blob = pack_frame(FrameHeader(seq=seq, ts_ms=ts_ms, channel=0), jpeg)

            def _put() -> None:
                if queue.full():
                    queue.get_nowait()  # 订阅端也是 latest-wins
                queue.put_nowait(blob)

            loop.call_soon_threadsafe(_put)

        unsubscribe = worker.subscribe(on_frame)
        try:
            while True:
                await ws.send_bytes(await queue.get())
        except WebSocketDisconnect:
            pass
        finally:
            unsubscribe()

    return app
