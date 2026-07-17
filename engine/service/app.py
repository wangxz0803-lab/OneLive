"""数字人引擎服务：/ingest 收驱动帧（producer），/out 扇出渲染帧，/status 状态。

与 M0 preview server 的关键区别：推理由常驻 ChannelWorker 驱动，
WS 连接只是数据的进出口——多个 /out 订阅者共享同一路渲染结果，
新订阅者不会触发新推理，/ingest 断开重连不重置管线状态。

多频道（M2 三市场铺垫）：create_app 收 pipeline_factory + channels，每个
频道一个 ChannelWorker（管线互相独立，帧路由靠协议头 channel 字节）。
/ingest 单连接可混发多频道帧；/out 用 ?channel=N 选订哪一路。

翻译集成（M2a）：可选注入 TranslationPipeline。/audio 收音频上行
（二进制帧 = 4 字节 LE u32 采样率前缀 + pcm16），/events 向订阅者广播
管线事件的 JSON 元数据（wire 格式见 event_to_wire）。管线 events() 是
单消费者契约——服务层起唯一一个广播任务扇出，多订阅者互不抢事件。
未配管线时 /audio、/events 接受后立即 close(4404)。
"""

import asyncio
import json
import logging
from collections.abc import Iterable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Callable

from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse

_VIEWER_HTML = Path(__file__).resolve().parent / "viewer.html"
_CAPTURE_HTML = Path(__file__).resolve().parent / "capture.html"

from service.protocol import FrameHeader, pack_frame, unpack_frame
from service.worker import ChannelWorker
from translate.pipeline import (
    PipelineErrorEvent,
    SubtitleEvent,
    TranslationEvent,
    TTSReadyEvent,
)

log = logging.getLogger("engine.service")


def event_to_wire(ev) -> dict:
    """管线事件 → /events 广播的 JSON 元数据。显式逐类映射，绝不 asdict：
    TTSReadyEvent.result 带 pcm bytes + ndarray 嘴型曲线，asdict 会在 JSON
    序列化时爆掉；音频/曲线只在进程内消费（M2b 数字人集成），wire 上仅以
    has_audio 标记存在性。type 字符串与事件类名对应（snake_case 去 Event）。"""
    if isinstance(ev, SubtitleEvent):
        return {"type": "subtitle", "segment_id": ev.segment_id,
                "text": ev.text, "t0": ev.t0, "t1": ev.t1}
    if isinstance(ev, TranslationEvent):
        return {"type": "translation", "segment_id": ev.segment_id, "lang": ev.lang,
                "status": ev.status, "text": ev.text, "detail": ev.detail}
    if isinstance(ev, TTSReadyEvent):
        return {"type": "tts_ready", "segment_id": ev.segment_id, "lang": ev.lang,
                "voice": ev.voice, "duration_s": ev.duration_s,
                "synth_ms": ev.synth_ms, "has_audio": True}
    if isinstance(ev, PipelineErrorEvent):
        return {"type": "pipeline_error", "segment_id": ev.segment_id, "lang": ev.lang,
                "stage": ev.stage, "detail": ev.detail}
    raise TypeError(f"unknown pipeline event type: {type(ev).__name__}")


def create_app(pipeline_factory: Callable[[int], object],
               channels: Iterable[int] = (0,),
               translation_pipeline=None) -> FastAPI:
    """pipeline_factory(ch) 为每个频道构造一条独立管线（协议头 channel 为 u8，
    合法频道号 0-255）。不做单管线兼容 shim——所有调用点统一工厂形式。

    translation_pipeline: 可选 TranslationPipeline。start() 是 async，在
    lifespan startup 里做（对比 worker 在 create_app 时启动——线程 start
    是同步的，TestClient 不进 lifespan 也能用；翻译相关测试则必须进）。"""
    # 先整体校验再启动 worker：校验中途 raise 不会留下已启动的孤儿线程
    channels = tuple(channels)
    seen: set[int] = set()
    for ch in channels:
        if not 0 <= ch <= 255:
            raise ValueError(f"channel {ch} out of range 0-255 (protocol header channel is u8)")
        if ch in seen:
            raise ValueError(f"duplicate channel {ch}")
        seen.add(ch)
    workers: dict[int, ChannelWorker] = {}
    for ch in channels:
        w = ChannelWorker(pipeline=pipeline_factory(ch), name=f"ch{ch}")
        w.start()
        workers[ch] = w

    # /events 订阅队列集合。广播任务与所有订阅端点都跑在同一事件循环，
    # add/discard/put 全是循环内同步操作，无需 /out 那样的 call_soon_threadsafe 桥。
    events_subs: set[asyncio.Queue] = set()

    async def _broadcast_events() -> None:
        # 管线 events() 的唯一消费者（单消费者契约），向所有 /events 订阅者
        # 扇出 wire JSON。坏事件映射失败只记日志跳过——广播任务绝不能死。
        async for ev in translation_pipeline.events():
            try:
                wire = event_to_wire(ev)
            except Exception:
                log.exception("events: unmappable event skipped (%s)", type(ev).__name__)
                continue
            for q in list(events_subs):
                if q.full():
                    q.get_nowait()  # 订阅端 latest-wins 丢最旧，同 /out
                q.put_nowait(wire)

    # 计划里用的 @app.on_event("shutdown") 在当前 FastAPI (0.139) 已弃用并发
    # DeprecationWarning，改用 lifespan。worker 在 create_app 时启动（TestClient
    # 不进 lifespan startup 也能工作），lifespan 退出时全部停止。
    # 翻译管线 start() 是 async，只能在 lifespan startup 做；shutdown 时
    # wait_for 硬上限包裹 close()（其总时长不完全有界：whisper 线程池 drain）。
    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        consumer: asyncio.Task | None = None
        if translation_pipeline is not None:
            await translation_pipeline.start()
            consumer = asyncio.create_task(_broadcast_events())
        try:
            yield
        finally:
            if translation_pipeline is not None:
                try:
                    await asyncio.wait_for(translation_pipeline.close(), 30)
                except Exception:
                    log.exception("translation pipeline close failed or timed out")
                if consumer is not None:
                    try:
                        # close() 保证发事件哨兵（finally 里），正常路径立即退出；
                        # wait_for 超时会顺带 cancel 掉 consumer，不留孤儿任务
                        await asyncio.wait_for(consumer, 5)
                    except Exception:
                        log.exception("events broadcast task did not exit cleanly")
            for w in workers.values():
                w.stop()

    app = FastAPI(lifespan=lifespan)
    app.state.workers = workers
    # 频道 0 的 worker 单独暴露，兼容既有测试/工具的 app.state.worker 访问习惯
    app.state.worker = workers.get(0)

    @app.get("/")
    async def index() -> HTMLResponse:
        return HTMLResponse(_VIEWER_HTML.read_text(encoding="utf-8"))

    @app.get("/capture")
    async def capture() -> HTMLResponse:
        return HTMLResponse(_CAPTURE_HTML.read_text(encoding="utf-8"))

    @app.get("/status")
    async def status() -> dict:
        # 统计口径：last_infer_ms = 最近一次“跑到计时代码”的 infer 耗时
        # （无脸帧也会刷新；infer 抛异常则不更新）；errors 聚合解码失败 +
        # 管线异常 + JPEG 编码失败 + 订阅者回调异常四类。
        body = {"engine": "ok",
                "channels": {str(ch): w.stats() for ch, w in workers.items()}}
        if 0 in workers:  # 顶层 "channel" 别名 = 频道 0，兼容既有测试/工具
            body["channel"] = body["channels"]["0"]
        if translation_pipeline is not None:  # 没配翻译时键整体不存在
            body["translation"] = translation_pipeline.stats()
        return body

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
                    target = workers.get(header.channel)
                    if target is None:  # 未知频道：只记日志忽略，连接不死、计数不动
                        log.warning("ingest: frame for unknown channel %d dropped (seq=%d)",
                                    header.channel, header.seq)
                        continue
                    target.submit(payload, seq=header.seq, ts_ms=header.ts_ms)
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
    async def out(ws: WebSocket, channel: int = Query(0)) -> None:
        await ws.accept()
        worker = workers.get(channel)
        if worker is None:
            # 未知频道：accept 后再 close(4400)，客户端能读到明确的应用层关闭码
            log.warning("out: unknown channel %d, closing 4400", channel)
            await ws.close(code=4400)
            return
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=4)

        def on_frame(seq: int, ts_ms: int, jpeg: bytes) -> None:  # worker 线程回调 → 事件循环
            # ts_ms 为 /ingest 帧头带来的采集时间戳，原样透传，/out 端可直接算 E2E 延迟
            blob = pack_frame(FrameHeader(seq=seq, ts_ms=ts_ms, channel=channel), jpeg)

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
            # 清理必须全同步、零 await：外部取消（如 TestClient 退出时 portal
            # cancel）会在 finally 的任意 await 点重投 CancelledError——之前版本
            # 在此 await gather，偶发（~2%）把 finally 拦腰打断：unsubscribe 被
            # 跳过、端点 future 以 CANCELLED 收场令 TestClient teardown 抛错。
            # unsubscribe 最先执行（同步、廉价），保证任何路径都不会漏。
            unsubscribe()
            # 只 cancel 不 await：任务绑在本事件循环上，取消后由循环自行回收。
            # done_callback 兜底取回可能已挂在任务上的异常（如断开后 receive
            # 的 RuntimeError），避免 "Task exception was never retrieved" 告警；
            # 已取消的任务不能调 exception()，先判 cancelled()。
            for task in (queue_task, recv_task):
                task.cancel()
                task.add_done_callback(
                    lambda t: None if t.cancelled() else t.exception())

    @app.websocket("/audio")
    async def audio(ws: WebSocket) -> None:
        # 音频上行：二进制帧 = 4 字节 LE u32 采样率前缀 + pcm16 → feed_audio。
        # 采样率随帧走（前端 AudioContext 未必给到 16k），转写器自会校验恒定性。
        # 坏帧（短于前缀 / sr=0）与文本帧只记日志忽略——坏输入不得杀死连接。
        await ws.accept()
        if translation_pipeline is None:
            # accept 后再 close(4404)，客户端能读到明确的应用层关闭码（同 /out 4400 模式）
            log.warning("audio: no translation pipeline configured, closing 4404")
            await ws.close(code=4404)
            return
        try:
            while True:
                msg = await ws.receive()
                if msg["type"] == "websocket.disconnect":
                    log.info("audio disconnected")
                    break
                data = msg.get("bytes")
                if data is not None:
                    if len(data) < 4:
                        log.warning("audio: short frame (%d bytes) dropped", len(data))
                        continue
                    sr = int.from_bytes(data[:4], "little")
                    if sr == 0:
                        log.warning("audio: frame with sr=0 dropped")
                        continue
                    translation_pipeline.feed_audio(data[4:], sr)
                elif msg.get("text") is not None:
                    log.warning("audio: unexpected text frame ignored: %r", msg["text"][:120])
        except WebSocketDisconnect:
            log.info("audio disconnected")

    @app.websocket("/events")
    async def events(ws: WebSocket) -> None:
        # 广播订阅端。竞速循环 + 全同步 finally 与 /out 同模式（空闲断连
        # 清理 bug 的教训见 /out 注释）；区别仅在数据源是本循环内的广播
        # 队列而非 worker 线程回调，出帧是 JSON 文本而非二进制。
        await ws.accept()
        if translation_pipeline is None:
            log.warning("events: no translation pipeline configured, closing 4404")
            await ws.close(code=4404)
            return
        queue: asyncio.Queue = asyncio.Queue(maxsize=32)
        events_subs.add(queue)
        queue_task: asyncio.Task = asyncio.ensure_future(queue.get())
        recv_task: asyncio.Task = asyncio.ensure_future(ws.receive())
        try:
            while True:
                done, _ = await asyncio.wait({queue_task, recv_task},
                                             return_when=asyncio.FIRST_COMPLETED)
                if recv_task in done:
                    msg = recv_task.result()
                    if msg["type"] == "websocket.disconnect":
                        break
                    log.warning("events: unexpected client message ignored: %r", msg)
                    recv_task = asyncio.ensure_future(ws.receive())
                if queue_task in done:
                    await ws.send_text(json.dumps(queue_task.result(), ensure_ascii=False))
                    queue_task = asyncio.ensure_future(queue.get())
        except WebSocketDisconnect:
            pass
        finally:
            # 与 /out 同理：清理全同步零 await，先摘订阅再 cancel 两个任务
            events_subs.discard(queue)
            for task in (queue_task, recv_task):
                task.cancel()
                task.add_done_callback(
                    lambda t: None if t.cancelled() else t.exception())

    return app
