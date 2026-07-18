"""翻译上/下行端点：/audio + /events + /speech，含 tee 与广播消费者
（V2 M3b Task 1，从 app.py 拆出，行为零变化）。

路由注册模式：工厂函数 register_translate_endpoints(app, ...) 在 create_app
内被调用，@app.websocket 装饰的处理器闭包捕获传入的 workers/mixers/
translation_pipeline/lang_channels/events_subs/speech_subs。工厂返回
_broadcast_events 协程函数——lifespan（仍在 app.py）在 startup 时经
app.state.broadcast_events 取到并 create_task（仅在配了翻译管线时）。
_tee_tts 与 _broadcast_events 紧耦合（后者调前者），一并搬来。

A/V 同步契约、TTS tee 帧格式的完整叙述见 app.py 模块 docstring（唯一出处）。
"""

import asyncio
import json
import logging
import struct

from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect

from service.speech import SpeechClip
from service.wire import event_to_wire
from service.ws_util import ws_subscriber_loop
from translate.tts import LIP_FPS  # TTS 口型曲线帧率（25fps），tee 入队时随 clip 传递
from translate.pipeline import TTSReadyEvent

log = logging.getLogger("engine.service")


def register_translate_endpoints(app: FastAPI, *, workers: dict, mixers: dict,
                                 translation_pipeline, lang_channels: dict,
                                 events_subs: set, speech_subs: dict):
    """注册 /audio /events /speech；返回 _broadcast_events 供 lifespan 起消费者。"""

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
        # 混音器 splice 是第三个独立兜底半区：/stream.wav 音轨故障不拖累
        # 嘴型/浏览器广播，反之亦然。sr 不匹配宁缺毋腐——错采样率的字节
        # 直接进音轨是变速噪音，跳过并记日志（TTSResult.sr 契约 16k）。
        try:
            mixer = mixers[ch]
            if r.sr != mixer.sr:
                log.warning("tts tee: sr mismatch (tts=%d, mixer=%d), segment %d "
                            "not spliced into audio track", r.sr, mixer.sr, ev.segment_id)
            else:
                mixer.splice(r.audio_pcm16, ev.segment_id)
        except Exception:
            log.exception("tts tee: mixer splice failed (segment=%d lang=%s)",
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
        # 广播订阅端，竞速循环见 ws_subscriber_loop；区别仅在数据源是本
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

        await ws_subscriber_loop(ws, queue, send_json,
                                 lambda: events_subs.discard(queue), "events")

    @app.websocket("/speech")
    async def speech(ws: WebSocket, channel: int = Query(0)) -> None:
        # TTS 音频下行订阅端（帧格式见模块 docstring）。按 ?channel= 过滤，
        # 只收本频道数字人的语音；竞速循环同 ws_subscriber_loop。队列浅
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
        await ws_subscriber_loop(ws, queue, ws.send_bytes,
                                 lambda: subs.discard(queue), "speech")

    return _broadcast_events
