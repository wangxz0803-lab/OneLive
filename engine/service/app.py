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

音轨/画面拉流（M3a）：每频道一个 AudioMixer（app.state.mixers）常驻实时
节拍——静音打底，TTSReady tee 到达即把语音接到时间线尾部；/stream.wav
输出无限 WAV（RIFF/data 尺寸字段 0xFFFFFFFF 惯例），/stream.mjpeg 输出
multipart JPEG，两者是 ffmpeg 的拉流源（推 RTMP）。A/V 契约的 M3a 补充：
- 锚点分歧：混音器"到达即拼"=音频连续实时播出；嘴型要等 worker 下一次
  渲染轮询才开始——每逢段切换嘴型额外滞后 ≤1 渲染周期，背靠背多段会
  逐段累积，直到两侧队列都排空才归零；
- 丢弃上限如今有三处且各自为政：mixer 60s（按时长）/ SpeechSchedule 16
  （按段数）/ /speech Queue(8)（按段数）——严重积压时三端各自丢段是
  已知失同步源，统一丢弃策略留给 M3b。

推流监督（M3a Task 3）：可选注入 StreamerManager（service/streamer.py，
run_local --rtmp 构造），每频道一个 ffmpeg 拉 /stream.* 推 RTMP；/status
增 "streams" 块。启停顺序是硬约束：启动走 lifespan 后台任务（探针等
serving 开始后才 spawn），停机在 shutdown 里最先 stop_all——puller 是
/stream.* 的客户端，不先杀会卡死 uvicorn 连接 draining（详见 streamer.py）。
"""

import asyncio
import json
import logging
import os
import re
import time
from collections.abc import Iterable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Callable

from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse

_VIEWER_HTML = Path(__file__).resolve().parent / "viewer.html"
_CAPTURE_HTML = Path(__file__).resolve().parent / "capture.html"
_CONSOLE_HTML = Path(__file__).resolve().parent / "console.html"

from service.audio_mixer import AudioMixer
from service.console_api import UplinkStore
from service.endpoints_stream import register_stream_endpoints
from service.endpoints_translate import register_translate_endpoints
from service.protocol import FrameHeader, pack_frame, unpack_frame
from service.wire import event_to_wire  # re-exported: test_app_integration imports from service.app
from service.worker import ChannelWorker
from service.ws_util import ws_subscriber_loop

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


def create_app(pipeline_factory: Callable[[int], object],
               channels: Iterable[int] = (0,),
               translation_pipeline=None,
               lang_channels: dict[str, int] | None = None,
               streamer=None) -> FastAPI:
    """pipeline_factory(ch) 为每个频道构造一条独立管线（协议头 channel 为 u8，
    合法频道号 0-255）。不做单管线兼容 shim——所有调用点统一工厂形式。

    translation_pipeline: 可选 TranslationPipeline。start() 是 async，在
    lifespan startup 里做（对比 worker 在 create_app 时启动——线程 start
    是同步的，TestClient 不进 lifespan 也能用；翻译相关测试则必须进）。

    lang_channels: TTS 语言 → 数字人频道映射（默认 {"en": 0}）。映射命中的
    TTSReadyEvent 会 tee 进对应 worker 的 SpeechSchedule 并广播到 /speech；
    未映射语言只发 /events 元数据。仅在配了翻译管线时校验/生效。

    streamer: 可选 StreamerManager（M3a，run_local --rtmp 构造）。/status 增
    "streams" 块；启动 = lifespan 起后台任务跑 start_all（其内部先 await
    ready_probe 等 serving 真正开始，再 spawn ffmpeg puller），停机 = shutdown
    里【最先】stop_all——启停顺序 rationale 见 streamer.py 模块 docstring。"""
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

    # 每频道一个混音器，与翻译管线无关（纯静音直播也要有连续音轨——
    # RTMP 编码器断音轨即断流）。构造在此、start/stop 在 lifespan（async）。
    # 默认 sr=16000 与 TTSResult.sr 一致，tee 侧仍校验以防上游变更。
    mixers: dict[int, AudioMixer] = {ch: AudioMixer() for ch in channels}

    # /events /speech 订阅队列。广播任务与所有订阅端点都跑在同一事件循环，
    # add/discard/put 全是循环内同步操作，无需 /out 那样的 call_soon_threadsafe 桥。
    events_subs: set[asyncio.Queue] = set()
    speech_subs: dict[int, set[asyncio.Queue]] = {ch: set() for ch in channels}

    # 计划里用的 @app.on_event("shutdown") 在当前 FastAPI (0.139) 已弃用并发
    # DeprecationWarning，改用 lifespan。worker 在 create_app 时启动（TestClient
    # 不进 lifespan startup 也能工作），lifespan 退出时全部停止。
    # 翻译管线 start() 是 async，只能在 lifespan startup 做；shutdown 时
    # wait_for 硬上限包裹 close()（其总时长不完全有界：whisper 线程池 drain）。
    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        # 混音器最先启动（start 是 async 只能在这做；不依赖翻译管线——
        # 静音音轨对 RTMP 同样是硬需求）。注意 TestClient 需 with 才进 lifespan。
        for m in mixers.values():
            await m.start()
        consumer: asyncio.Task | None = None
        if translation_pipeline is not None:
            try:
                await translation_pipeline.start()
            except BaseException:
                # startup 失败时 finally 不会跑（yield 未到）：worker/mixer 是
                # 此前启动的，这里必须亲手停掉，不留孤儿线程/任务
                for m in mixers.values():
                    await m.stop()
                for w in workers.values():
                    w.stop()
                raise
            # _broadcast_events 现居 endpoints_translate；工厂把它存进
            # app.state.broadcast_events（create_app 尾部注册），此处取用。
            consumer = asyncio.create_task(_app.state.broadcast_events())
        # 推流监督（M3a）：start_all 只能作为后台任务——ffmpeg 要拉的
        # /stream.* 端点在 serving 开始后才可达，而 lifespan startup 完成
        # 于 serving 之前；任务内部先 await ready_probe（轮询 localhost
        # /status 到 200）再 spawn，见 streamer.py。
        streamer_start: asyncio.Task | None = None
        if streamer is not None:
            streamer_start = asyncio.create_task(streamer.start_all())
        try:
            yield
        finally:
            # 停机顺序（M3a review carry-forward）：streamer 必须最先停。
            # ffmpeg puller 就是 /stream.* 的长连接 HTTP 客户端——先走服务
            # 收尾的话，uvicorn 优雅停机等这些连接 drain、puller 只会继续
            # 拉，互相僵持；先杀 puller，流式生成器随断连取消，之后的
            # 管线/混音器/worker 收尾才畅通。
            if streamer is not None:
                if streamer_start is not None:
                    streamer_start.cancel()  # 可能还卡在 ready_probe 上
                    try:
                        await streamer_start
                    except asyncio.CancelledError:
                        pass
                    except Exception:
                        log.exception("streamer start task failed")
                try:
                    await streamer.stop_all()
                except Exception:
                    log.exception("streamer stop_all failed")
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
            # 混音器停在广播任务回收之后：tee（跑在 consumer 里）已终结，
            # 不会再有晚到的 TTSReady splice 打在已停的 mixer 上——先断
            # 供给端、再停混音器（订阅者此刻才收 None 哨兵）。
            for m in mixers.values():
                await m.stop()
            for w in workers.values():
                w.stop()

    # 上行统计（M3b）：capture 端每 2s 上报的 fps_sent/skipped/rtt_ms 落这里，
    # /status 取快照。now 用 time.monotonic()（/ingest 记录、/status 快照一致）。
    uplink = UplinkStore()

    # 引擎启动时刻（M3b Task 3，console 顶栏正常运行时长）。monotonic 算
    # 时长（不受墙钟跳变影响）；started_at 墙钟仅作页面展示锚点，不参与运算。
    started_mono = time.monotonic()
    started_at = time.time()

    app = FastAPI(lifespan=lifespan)
    app.state.workers = workers
    app.state.mixers = mixers
    app.state.uplink = uplink
    # 频道 0 的 worker 单独暴露，兼容既有测试/工具的 app.state.worker 访问习惯
    app.state.worker = workers.get(0)

    @app.get("/")
    async def index() -> HTMLResponse:
        return HTMLResponse(_VIEWER_HTML.read_text(encoding="utf-8"))

    @app.get("/capture")
    async def capture() -> HTMLResponse:
        return HTMLResponse(_CAPTURE_HTML.read_text(encoding="utf-8"))

    @app.get("/console")
    async def console() -> HTMLResponse:
        # 导播控制台（M3b Task 3）：单文件自包含页面，无构建步骤。
        return HTMLResponse(_CONSOLE_HTML.read_text(encoding="utf-8"))

    @app.get("/avatars")
    async def avatars() -> dict:
        # casting 底图白名单枚举：列 _avatar_dir()、按 _AVATAR_NAME_RE 过滤。
        # 与 _handle_casting 用同一份目录逻辑 + 同一条正则——console 下拉里能
        # 选到的，正是服务端会接受的（不给前后端白名单漂移留缝）。目录不存在
        # 时诚实返回空列表（未部署资产也不 500）。
        names: list[str] = []
        try:
            for p in sorted(_avatar_dir().iterdir()):
                if p.is_file() and _AVATAR_NAME_RE.fullmatch(p.name):
                    names.append(p.name)
        except (FileNotFoundError, NotADirectoryError, PermissionError):
            pass  # 目录缺失/不是目录/无权限：诚实返回空列表，不 500
        return {"avatars": names}

    @app.get("/status")
    async def status() -> dict:
        # 统计口径：last_infer_ms = 最近一次“跑到计时代码”的 infer 耗时
        # （无脸帧也会刷新；infer 抛异常则不更新）；errors 聚合解码失败 +
        # 管线异常 + JPEG 编码失败 + 订阅者回调异常四类。
        body = {"engine": "ok",
                # 正常运行时长（M3b console 顶栏）+ 墙钟启动锚点（仅展示）。
                "uptime_s": round(time.monotonic() - started_mono, 1),
                "started_at": started_at,
                "channels": {str(ch): w.stats() for ch, w in workers.items()},
                # 上行 HUD（M3b）：始终在场——无上报时为空 dict。now 与 /ingest
                # 记录同源（monotonic），age/stale 差值口径一致。
                "uplink": uplink.snapshot(time.monotonic())}
        if 0 in workers:  # 顶层 "channel" 别名 = 频道 0，兼容既有测试/工具
            body["channel"] = body["channels"]["0"]
        if translation_pipeline is not None:  # 没配翻译时键整体不存在
            body["translation"] = translation_pipeline.stats()
            # 语言→频道映射（console 据此给频道卡打语言标签、把 tts_ready 事件
            # 归到对应频道）。仅在配了翻译时透出——没翻译时映射无实义（诚实）。
            body["lang_channels"] = lang_channels
        if streamer is not None:  # 没配推流时键整体不存在（同 translation）
            body["streams"] = streamer.status()
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
                        # RTT 探测：带 t 就原样回显（capture 端 rtt = now - t）；
                        # 不带 t 走原始纯 pong（既有 ping→pong 契约不变）。
                        pong = {"type": "pong"}
                        if "t" in ctrl:
                            pong["t"] = ctrl["t"]
                        await ws.send_text(json.dumps(pong))
                    elif isinstance(ctrl, dict) and ctrl.get("type") == "casting":
                        await _handle_casting(ws, ctrl, casting_tasks)
                    elif isinstance(ctrl, dict) and ctrl.get("type") == "uplink_stats":
                        # 上行统计上报（M3b）：channel 必须是真 int（复用 casting
                        # 的守卫——不可哈希类型进 dict 键会崩接收循环；bool 也拒）。
                        # 字段缺失只记 None，坏帧只记日志忽略，连接不死。
                        # 注意 rtt_ms 是 WS 传输层往返（capture 端 ping/pong 测），
                        # 不是蜂窝/RAN 上行 RTT——loopback ~0ms、LAN 为局域网时延。
                        # Task 3 console 渲染须带同一限定词，勿标成蜂窝时延。
                        ch = ctrl.get("channel")
                        if not isinstance(ch, int) or isinstance(ch, bool):
                            log.warning("ingest: uplink_stats invalid channel %r ignored", ch)
                        else:
                            uplink.record(ch, {"fps_sent": ctrl.get("fps_sent"),
                                               "skipped": ctrl.get("skipped"),
                                               "rtt_ms": ctrl.get("rtt_ms")},
                                          time.monotonic())
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

        # 竞速循环 + 全同步 finally 抽在 ws_subscriber_loop（空闲断连清理
        # bug 的教训见其 docstring）。unsubscribe 同步廉价，任何路径不漏。
        unsubscribe = worker.subscribe(on_frame)
        await ws_subscriber_loop(ws, queue, ws.send_bytes, unsubscribe, "out")

    # 翻译端点（/audio /events /speech）与拉流端点（/stream.mjpeg /stream.wav）
    # 在独立模块注册：工厂内的处理器闭包捕获传入状态，与内联注册语义一致。
    # register_translate_endpoints 返回 _broadcast_events——lifespan startup
    # 经 app.state.broadcast_events 取用（仅在配了翻译管线时 create_task）。
    app.state.broadcast_events = register_translate_endpoints(
        app, workers=workers, mixers=mixers,
        translation_pipeline=translation_pipeline, lang_channels=lang_channels,
        events_subs=events_subs, speech_subs=speech_subs)
    register_stream_endpoints(app, workers, mixers)

    return app
