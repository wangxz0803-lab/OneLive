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
未配管线时 /audio、/events、/speech 接受后立即 close(4404)。

TTS tee（M2b）：广播任务在 TTSReadyEvent 上分流——lang_channels 把语言映射
到频道，映射命中时把口型曲线 enqueue 进该频道 worker 的 SpeechSchedule
（驱动数字人嘴型），并把音频以二进制帧广播给 /speech 订阅者
（[u8 channel][u32 LE segment_id][u32 LE sr][pcm16]，viewer 端播放）；
未映射语言只走 /events 元数据，与之前行为一致。

A/V 同步契约（M2b，机制正确性即达标，精确对齐留给 M3）：
- 音频：viewer 收到 /speech 帧即以 FIFO 链式排播（AudioContext.currentTime
  上把每段接在上一段之后，镜像 SpeechSchedule 的 FIFO 语义，不并行混播）；
- 嘴型：曲线在 worker 下一次渲染轮询时才开始消费——最多晚一个渲染周期
  （本地慢速链路 ~1.7-1.9fps 即 ~500ms），且 25fps 曲线被渲染帧率欠采样；
- 已知分歧源：/speech 订阅队列 Queue(8) 丢最旧 vs SpeechSchedule maxlen=16
  ——严重积压时两端各自丢段，嘴型可能"念"到 viewer 没听到的段（反之亦然）。
"""

import asyncio
import json
import logging
import os
import re
import struct
import time
from collections.abc import Iterable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Callable

from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse

_VIEWER_HTML = Path(__file__).resolve().parent / "viewer.html"
_CAPTURE_HTML = Path(__file__).resolve().parent / "capture.html"

from service.protocol import FrameHeader, pack_frame, unpack_frame
from service.speech import SpeechClip
from service.worker import ChannelWorker
from translate.tts import LIP_FPS  # TTS 口型曲线帧率（25fps），tee 入队时随 clip 传递
from translate.pipeline import (
    PipelineErrorEvent,
    SubtitleEvent,
    TranslationEvent,
    TTSReadyEvent,
)

log = logging.getLogger("engine.service")

# casting 底图白名单：纯文件名（字母数字下划线连字符 + jpg/jpeg/png 扩展名）。
# 任何路径分隔符 / 盘符 / ".." 都过不了字符类——不给路径穿越留任何解析歧义。
_AVATAR_NAME_RE = re.compile(r"^[\w-]+\.(jpg|jpeg|png)$")


def _avatar_dir() -> Path:
    """casting 底图目录。ONELIVE_AVATAR_DIR 显式指定优先；默认引用 M0 资产
    （ONELIVE_M0_ENGINE 下的 LivePortrait 示例源图，不往仓库提交二进制）。"""
    explicit = os.environ.get("ONELIVE_AVATAR_DIR")
    if explicit:
        return Path(explicit)
    from service.liveportrait_pipeline import _CLONE  # 与管线适配器同一份 M0 路径逻辑
    return _CLONE / "assets" / "examples" / "source"


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


async def _ws_subscriber_loop(ws: WebSocket, queue: asyncio.Queue,
                              send, unsubscribe: Callable[[], None],
                              tag: str) -> None:
    """订阅端点共享的竞速循环（/out /events /speech 同一模式，第三处出现时
    按三振规则抽取）。queue.get() 与 ws.receive() 二选一竞速：只 await queue
    永远感知不到无数据流动时的客户端断开（M1a E2E 僵尸订阅者 bug），哪边先
    完成处理哪边，各自完成后各自重新武装——任意时刻每种任务最多一个。

    send: async callable，把一个队列项发给客户端（send_bytes / send_text+json）。
    unsubscribe: 同步零 await 的清理回调，finally 里最先执行。清理必须全同步：
    外部取消（TestClient 退出时 portal cancel）会在 finally 的任意 await 点
    重投 CancelledError，之前版本在此 await gather 偶发（~2%）拦腰打断 finally。
    两个竞速任务只 cancel 不 await（绑在本循环上，取消后由循环回收），
    done_callback 兜底取回可能已挂上的异常，避免 never-retrieved 告警。"""
    queue_task: asyncio.Task = asyncio.ensure_future(queue.get())
    recv_task: asyncio.Task = asyncio.ensure_future(ws.receive())
    try:
        while True:
            done, _ = await asyncio.wait({queue_task, recv_task},
                                         return_when=asyncio.FIRST_COMPLETED)
            if recv_task in done:
                msg = recv_task.result()  # ws.receive() 把断开作为消息返回
                if msg["type"] == "websocket.disconnect":
                    # 若此刻 queue_task 恰好也完成了，那一项随取消丢弃——
                    # 客户端都断开了，为它保数据毫无意义，明确接受这个取舍。
                    break
                log.warning("%s: unexpected client message ignored: %r", tag, msg)
                recv_task = asyncio.ensure_future(ws.receive())
            if queue_task in done:
                await send(queue_task.result())
                queue_task = asyncio.ensure_future(queue.get())
    except WebSocketDisconnect:
        pass
    finally:
        unsubscribe()
        for task in (queue_task, recv_task):
            task.cancel()
            task.add_done_callback(
                lambda t: None if t.cancelled() else t.exception())


def create_app(pipeline_factory: Callable[[int], object],
               channels: Iterable[int] = (0,),
               translation_pipeline=None,
               lang_channels: dict[str, int] | None = None) -> FastAPI:
    """pipeline_factory(ch) 为每个频道构造一条独立管线（协议头 channel 为 u8，
    合法频道号 0-255）。不做单管线兼容 shim——所有调用点统一工厂形式。

    translation_pipeline: 可选 TranslationPipeline。start() 是 async，在
    lifespan startup 里做（对比 worker 在 create_app 时启动——线程 start
    是同步的，TestClient 不进 lifespan 也能用；翻译相关测试则必须进）。

    lang_channels: TTS 语言 → 数字人频道映射（默认 {"en": 0}）。映射命中的
    TTSReadyEvent 会 tee 进对应 worker 的 SpeechSchedule 并广播到 /speech；
    未映射语言只发 /events 元数据。仅在配了翻译管线时校验/生效。"""
    # 先整体校验再启动 worker：校验中途 raise 不会留下已启动的孤儿线程
    channels = tuple(channels)
    seen: set[int] = set()
    for ch in channels:
        if not 0 <= ch <= 255:
            raise ValueError(f"channel {ch} out of range 0-255 (protocol header channel is u8)")
        if ch in seen:
            raise ValueError(f"duplicate channel {ch}")
        seen.add(ch)
    if lang_channels is None:
        lang_channels = {"en": 0}
    if translation_pipeline is not None:
        for lang, ch in lang_channels.items():
            if ch not in seen:
                raise ValueError(
                    f"lang_channels[{lang!r}] = {ch!r} is not a configured channel")
    workers: dict[int, ChannelWorker] = {}
    for ch in channels:
        w = ChannelWorker(pipeline=pipeline_factory(ch), name=f"ch{ch}")
        w.start()
        workers[ch] = w

    # /events /speech 订阅队列。广播任务与所有订阅端点都跑在同一事件循环，
    # add/discard/put 全是循环内同步操作，无需 /out 那样的 call_soon_threadsafe 桥。
    events_subs: set[asyncio.Queue] = set()
    speech_subs: dict[int, set[asyncio.Queue]] = {ch: set() for ch in channels}

    def _tee_tts(ev: TTSReadyEvent, ch: int) -> None:
        """TTSReadyEvent 分流到频道 ch：口型曲线入 SpeechSchedule + 音频广播
        给该频道的 /speech 订阅者。坏曲线（NaN 等）SpeechClip 构造会 raise——
        只记日志跳过入队，绝不能杀死广播任务；音频帧照常广播（音频本身
        与曲线无关，viewer 仍可放声）。"""
        r = ev.result
        try:
            # fps=LIP_FPS：曲线由 translate.tts 以 25fps 生成，帧率随 clip
            # 传给调度器——两端耦合在这一个常量上，改帧率只动 translate.tts。
            workers[ch].speech.enqueue(SpeechClip(
                segment_id=ev.segment_id, lang=ev.lang, curve=r.lip_curve,
                fps=float(LIP_FPS), duration_s=r.duration_s))
        except Exception:
            log.exception("tts tee: clip rejected, lip skipped (segment=%d lang=%s)",
                          ev.segment_id, ev.lang)
        # 音频广播独立 try：坏曲线不挡音频（viewer 仍可放声），反过来
        # struct.pack 失败（如上游给出越界 segment_id/sr）也绝不能杀死
        # 广播任务——两个半区各自兜底。
        try:
            frame = struct.pack("<BII", ch, ev.segment_id, r.sr) + r.audio_pcm16
            for q in list(speech_subs[ch]):
                if q.full():
                    q.get_nowait()  # 订阅端 latest-wins 丢最旧，同 /out /events
                q.put_nowait(frame)
        except Exception:
            log.exception("tts tee: speech broadcast failed (segment=%d lang=%s)",
                          ev.segment_id, ev.lang)

    async def _broadcast_events() -> None:
        # 管线 events() 的唯一消费者（单消费者契约），向所有 /events 订阅者
        # 扇出 wire JSON；TTSReadyEvent 额外 tee 进语音调度 + /speech 广播。
        # 坏事件映射失败只记日志跳过——广播任务绝不能死。
        async for ev in translation_pipeline.events():
            try:
                wire = event_to_wire(ev)
            except Exception:
                log.exception("events: unmappable event skipped (%s)", type(ev).__name__)
                continue
            if isinstance(ev, TTSReadyEvent):
                ch = lang_channels.get(ev.lang)
                wire["channel"] = ch  # int 或 null：告诉订阅者这段去了哪个数字人
                if ch is not None:
                    _tee_tts(ev, ch)  # 映射频道已在 create_app 校验存在
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
            try:
                await translation_pipeline.start()
            except BaseException:
                # startup 失败时 finally 不会跑（yield 未到）：worker 是
                # create_app 时启动的，这里必须亲手停掉，不留孤儿线程
                for w in workers.values():
                    w.stop()
                raise
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

    async def _handle_casting(ws: WebSocket, ctrl: dict,
                              pending: set[asyncio.Task]) -> None:
        """casting 控制帧：校验（同步 nack）→ post_command 到频道 worker →
        完成后异步 ack。ack 等待放在独立 task 里——prepare_source 真管线要
        1-2s，/ingest 接收循环不能为它停摆（驱动帧还得继续进）。"""
        ch = ctrl.get("channel", 0)
        source = ctrl.get("source")

        async def nack(detail: str) -> None:
            log.warning("casting rejected (channel=%r source=%r): %s", ch, source, detail)
            await ws.send_text(json.dumps(
                {"type": "casting_ack", "ok": False, "channel": ch,
                 "source": source, "detail": detail}, ensure_ascii=False))

        # channel 必须是真 int（bool 是 int 子类，也拒）：list/dict 等不可哈希
        # 类型直接进 workers.get 会抛 TypeError 杀死 /ingest 接收循环
        if not isinstance(ch, int) or isinstance(ch, bool):
            await nack("invalid channel")
            return
        worker = workers.get(ch)
        if worker is None:
            await nack(f"unknown channel: {ch!r}")
            return
        # 白名单：正则本身就容不下 / \ .. 等字符，前置显式检查纯属纵深防御
        if (not isinstance(source, str) or "/" in source or "\\" in source
                or ".." in source or not _AVATAR_NAME_RE.fullmatch(source)):
            await nack(f"source rejected by whitelist: {source!r}")
            return
        path = _avatar_dir() / source
        if not path.is_file():
            await nack(f"source not found: {path}")
            return

        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        t0 = time.perf_counter()

        def on_done(exc) -> None:  # worker 线程回调 → 桥回事件循环
            loop.call_soon_threadsafe(
                lambda: None if fut.cancelled() else fut.set_result(exc))

        worker.post_command(lambda p: p.set_source(str(path)), on_done=on_done)

        async def _ack() -> None:
            try:
                exc = await asyncio.wait_for(fut, timeout=60)
            except asyncio.TimeoutError:  # wait_for 超时已顺带 cancel fut
                exc = TimeoutError("casting timed out after 60s")
            ms = round((time.perf_counter() - t0) * 1000, 1)
            if exc is None:
                body = {"type": "casting_ack", "ok": True, "channel": ch,
                        "source": source, "ms": ms}
            else:
                body = {"type": "casting_ack", "ok": False, "channel": ch,
                        "source": source, "ms": ms,
                        "detail": str(exc) or type(exc).__name__}
            try:
                await ws.send_text(json.dumps(body, ensure_ascii=False))
            except Exception:  # 客户端等 ack 期间断开：尽力而为
                log.info("casting ack not delivered (client gone): %s", body)

        task = asyncio.create_task(_ack())
        pending.add(task)  # 持强引用防 GC；完成自摘
        task.add_done_callback(pending.discard)

    @app.websocket("/ingest")
    async def ingest(ws: WebSocket) -> None:
        # 手动 ws.receive() 分发：二进制帧 = 视频帧（JPEG 原样交给 worker，
        # 解码在 worker 线程内做，事件循环不再为注定被 latest-wins 丢弃的帧付
        # 解码成本）；文本帧 = JSON 控制消息（protocol.py 的协议约定），坏
        # JSON / 未知类型只记日志忽略——任何一类坏输入都不得杀死连接。
        # casting 控制帧走 _handle_casting（校验同步、执行与 ack 异步）。
        await ws.accept()
        casting_tasks: set[asyncio.Task] = set()
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
                    elif isinstance(ctrl, dict) and ctrl.get("type") == "casting":
                        await _handle_casting(ws, ctrl, casting_tasks)
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

        # 竞速循环 + 全同步 finally 抽在 _ws_subscriber_loop（空闲断连清理
        # bug 的教训见其 docstring）。unsubscribe 同步廉价，任何路径不漏。
        unsubscribe = worker.subscribe(on_frame)
        await _ws_subscriber_loop(ws, queue, ws.send_bytes, unsubscribe, "out")

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
                    if (len(data) - 4) % 2:
                        # pcm16 必须偶数字节：奇数说明发送端截断/错位，硬喂
                        # 会让转写器在半个采样上出错，整帧丢弃（M2a backlog）
                        log.warning("audio: odd pcm16 length (%d bytes) dropped",
                                    len(data) - 4)
                        continue
                    try:
                        translation_pipeline.feed_audio(data[4:], sr)
                    except ValueError as e:
                        # 转写器对采样率中途变化的契约是 raise（asr.feed）——
                        # 这是会话级配置冲突而非单帧坏输入，重试无意义：发一次
                        # 性说明后以专用码 4409 关闭，客户端据码停止自动重连
                        # （裸异常关闭会触发 capture 端 1s 重连风暴）。
                        log.warning("audio: feed rejected, closing 4409: %s", e)
                        try:
                            await ws.send_text(json.dumps(
                                {"type": "error", "code": 4409, "detail": str(e)},
                                ensure_ascii=False))
                        except Exception:  # 客户端恰好已断开：说明帧尽力而为
                            pass
                        await ws.close(code=4409)
                        return
                elif msg.get("text") is not None:
                    log.warning("audio: unexpected text frame ignored: %r", msg["text"][:120])
        except WebSocketDisconnect:
            log.info("audio disconnected")

    @app.websocket("/events")
    async def events(ws: WebSocket) -> None:
        # 广播订阅端，竞速循环见 _ws_subscriber_loop；区别仅在数据源是本
        # 循环内的广播队列而非 worker 线程回调，出帧是 JSON 文本而非二进制。
        await ws.accept()
        if translation_pipeline is None:
            log.warning("events: no translation pipeline configured, closing 4404")
            await ws.close(code=4404)
            return
        queue: asyncio.Queue = asyncio.Queue(maxsize=32)
        events_subs.add(queue)

        async def send_json(item) -> None:
            await ws.send_text(json.dumps(item, ensure_ascii=False))

        await _ws_subscriber_loop(ws, queue, send_json,
                                  lambda: events_subs.discard(queue), "events")

    @app.websocket("/speech")
    async def speech(ws: WebSocket, channel: int = Query(0)) -> None:
        # TTS 音频下行订阅端（帧格式见模块 docstring）。按 ?channel= 过滤，
        # 只收本频道数字人的语音；竞速循环同 _ws_subscriber_loop。队列浅
        # （8 段）+ 丢最旧：直播场景积压的旧语音早已过时，同 SpeechSchedule。
        # A/V 同步契约（详见模块 docstring）：音频 = viewer 收到即 FIFO 链式
        # 排播；嘴型 = worker 下一次渲染轮询才开始（≤1 渲染周期，本地 ~500ms）；
        # 本队列 (8) 与 SpeechSchedule maxlen (16) 不同——积压时两端各自丢段，
        # 嘴型与听到的音频可能对不上段；精确 A/V 对齐是 M3 范畴。
        await ws.accept()
        if translation_pipeline is None:
            log.warning("speech: no translation pipeline configured, closing 4404")
            await ws.close(code=4404)
            return
        subs = speech_subs.get(channel)
        if subs is None:
            log.warning("speech: unknown channel %d, closing 4400", channel)
            await ws.close(code=4400)
            return
        queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=8)
        subs.add(queue)
        await _ws_subscriber_loop(ws, queue, ws.send_bytes,
                                  lambda: subs.discard(queue), "speech")

    return app
