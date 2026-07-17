"""数字人引擎服务：/ingest 收驱动帧（producer），/out 扇出渲染帧，/status 状态。

与 M0 preview server 的关键区别：推理由常驻 ChannelWorker 驱动，
WS 连接只是数据的进出口——多个 /out 订阅者共享同一路渲染结果，
新订阅者不会触发新推理，/ingest 断开重连不重置管线状态。
"""

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path

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
    app.state.worker = worker  # 暴露给测试（标准 FastAPI 模式），生产代码不依赖

    @app.get("/")
    async def index() -> HTMLResponse:
        return HTMLResponse(_VIEWER_HTML.read_text(encoding="utf-8"))

    @app.get("/status")
    async def status() -> dict:
        # channel 统计口径：last_infer_ms = 最近一次“跑到计时代码”的 infer 耗时
        # （无脸帧也会刷新；infer 抛异常则不更新）；errors 聚合解码失败 +
        # 管线异常 + JPEG 编码失败 + 订阅者回调异常四类。
        return {"engine": "ok", "channel": worker.stats()}

    @app.websocket("/ingest")
    async def ingest(ws: WebSocket) -> None:
        # 手动 ws.receive() 分发：二进制帧 = 视频帧（JPEG 原样交给 worker，
        # 解码在 worker 线程内做，事件循环不再为注定被 latest-wins 丢弃的帧付
        # 解码成本）；文本帧 = JSON 控制消息（protocol.py 的协议约定），坏
        # JSON / 未知类型只记日志忽略——任何一类坏输入都不得杀死连接。
        await ws.accept()
        try:
            while True:
                msg = await ws.receive()
                if msg["type"] == "websocket.disconnect":
                    log.info("ingest disconnected")
                    break
                if msg.get("bytes") is not None:
                    try:
                        header, payload = unpack_frame(msg["bytes"])
                    except ValueError as e:
                        log.warning("ingest: bad frame dropped: %s", e)
                        continue
                    worker.submit(payload, seq=header.seq, ts_ms=header.ts_ms)
                elif msg.get("text") is not None:
                    try:
                        ctrl = json.loads(msg["text"])
                    except json.JSONDecodeError as e:
                        log.warning("ingest: bad control JSON ignored: %s", e)
                        continue
                    if isinstance(ctrl, dict) and ctrl.get("type") == "ping":
                        await ws.send_text(json.dumps({"type": "pong"}))
                    else:
                        log.warning("ingest: unknown control message ignored: %r", ctrl)
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

        # 空闲断连清理（M1a E2E 复现的 bug）：只 await queue.get() 永远感知不到
        # 无帧流动时的客户端断开，僵尸订阅者要等下一帧 send_bytes 抛错才清掉。
        # 修复：queue.get() 与 ws.receive() 二选一竞速，哪边先完成处理哪边，
        # 各自完成后各自重新武装——任意时刻每种任务最多存在一个，不会无限增殖。
        unsubscribe = worker.subscribe(on_frame)
        queue_task: asyncio.Task = asyncio.ensure_future(queue.get())
        recv_task: asyncio.Task = asyncio.ensure_future(ws.receive())
        try:
            while True:
                done, _ = await asyncio.wait({queue_task, recv_task},
                                             return_when=asyncio.FIRST_COMPLETED)
                if recv_task in done:
                    msg = recv_task.result()  # ws.receive() 把断开作为消息返回
                    if msg["type"] == "websocket.disconnect":
                        # 若此刻 queue_task 恰好也完成了，那一帧随取消丢弃——
                        # 客户端都断开了，为它保帧毫无意义，明确接受这个取舍。
                        break
                    log.warning("out: unexpected client message ignored: %r", msg)
                    recv_task = asyncio.ensure_future(ws.receive())
                if queue_task in done:
                    await ws.send_bytes(queue_task.result())
                    queue_task = asyncio.ensure_future(queue.get())
        except WebSocketDisconnect:
            pass
        finally:
            for task in (queue_task, recv_task):
                task.cancel()
            # return_exceptions=True 吞掉 CancelledError 及已完成任务上挂着的
            # 其他异常（如断开后 receive 的 RuntimeError），清理路径绝不再抛。
            await asyncio.gather(queue_task, recv_task, return_exceptions=True)
            unsubscribe()

    return app
