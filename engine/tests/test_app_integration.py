"""集成测试：fake 管线下 /ingest → worker → /out 全链路 + /status，
以及翻译服务集成（/audio 上行 + /events 广播 + /status.translation）。"""

import asyncio
import json
import struct
import time

import numpy as np
import cv2
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from service.app import create_app, event_to_wire
from service.protocol import FrameHeader, pack_frame, unpack_frame
from translate.pipeline import (
    PipelineErrorEvent,
    SubtitleEvent,
    TranslationEvent,
    TTSReadyEvent,
)
from translate.tts import TTSResult


class EchoPipeline:
    def infer(self, frame_bgr, seq):
        return frame_bgr


def _jpeg(v: int) -> bytes:
    ok, jpg = cv2.imencode(".jpg", np.full((16, 16, 3), v, np.uint8))
    assert ok
    return jpg.tobytes()


def test_ingest_to_out_roundtrip():
    app = create_app(lambda ch: EchoPipeline())
    client = TestClient(app)
    with client.websocket_connect("/out") as out_ws:
        with client.websocket_connect("/ingest") as in_ws:
            in_ws.send_bytes(pack_frame(FrameHeader(seq=7, ts_ms=123, channel=0), _jpeg(9)))
            blob = out_ws.receive_bytes()
    header, payload = unpack_frame(blob)
    assert header.seq == 7
    assert header.ts_ms == 123              # /out 帧头透传 /ingest 的真实 ts_ms
    img = cv2.imdecode(np.frombuffer(payload, np.uint8), cv2.IMREAD_COLOR)
    assert img.shape == (16, 16, 3)


def test_status_endpoint():
    app = create_app(lambda ch: EchoPipeline())
    client = TestClient(app)
    r = client.get("/status")
    assert r.status_code == 200
    body = r.json()
    assert {"processed", "dropped", "last_infer_ms"} <= set(body["channel"])
    assert "skipped" in body["channel"]
    assert "errors" in body["channel"]
    assert body["engine"] == "ok"


def test_two_subscribers_share_one_inference():
    """扇出：两个 /out 订阅者都收到同一帧，且只推理一次（processed == 1）。"""
    app = create_app(lambda ch: EchoPipeline())
    client = TestClient(app)
    with client.websocket_connect("/out") as out_a, client.websocket_connect("/out") as out_b:
        with client.websocket_connect("/ingest") as in_ws:
            in_ws.send_bytes(pack_frame(FrameHeader(seq=5, ts_ms=99, channel=0), _jpeg(7)))
            blob_a = out_a.receive_bytes()
            blob_b = out_b.receive_bytes()
    assert unpack_frame(blob_a)[0].seq == 5
    assert unpack_frame(blob_b)[0].seq == 5
    body = client.get("/status").json()
    assert body["channel"]["processed"] == 1  # 新订阅者不触发新推理，共享一次扇出


def test_bad_frame_does_not_kill_ingest():
    app = create_app(lambda ch: EchoPipeline())
    client = TestClient(app)
    with client.websocket_connect("/out") as out_ws:
        with client.websocket_connect("/ingest") as in_ws:
            in_ws.send_bytes(b"garbage")  # 坏帧 → 忽略并继续
            in_ws.send_bytes(pack_frame(FrameHeader(seq=1, ts_ms=1, channel=0), _jpeg(3)))
            blob = out_ws.receive_bytes()
    assert unpack_frame(blob)[0].seq == 1


async def _poll(cond, timeout: float = 2.0, interval: float = 0.01) -> bool:
    """在事件循环内轮询 cond()，让出控制权给端点协程。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if cond():
            return True
        await asyncio.sleep(interval)
    return cond()


def test_out_idle_disconnect_unsubscribes_immediately():
    """已知 bug（M1a E2E 复现）：/out 只 await queue.get() 不读 socket，
    空闲期（无帧流动）断开的客户端会留下僵尸订阅者。

    注意不能用 TestClient 复现：它退出 session 时会 cancel 掉端点 task，
    cancel 恰好触发 finally 里的 unsubscribe，掩盖了 bug。真实服务器
    （uvicorn）的语义是投递 websocket.disconnect 消息、task 继续活着——
    这里直接以 ASGI 消息驱动 app 来模拟。"""
    app = create_app(lambda ch: EchoPipeline())
    asyncio.run(_drive_idle_disconnect(app))


async def _drive_idle_disconnect(app) -> None:
    worker = app.state.worker
    to_app: asyncio.Queue = asyncio.Queue()
    from_app: asyncio.Queue = asyncio.Queue()
    scope = {"type": "websocket", "path": "/out", "raw_path": b"/out",
             "headers": [], "query_string": b"", "subprotocols": [],
             "client": ("test", 1), "server": ("test", 80), "scheme": "ws"}
    task = asyncio.ensure_future(app(scope, to_app.get, from_app.put))
    try:
        await to_app.put({"type": "websocket.connect"})
        msg = await asyncio.wait_for(from_app.get(), timeout=2)
        assert msg["type"] == "websocket.accept"
        assert await _poll(lambda: worker.subscriber_count() == 1), \
            f"订阅未注册, count={worker.subscriber_count()}"
        # 全程不发任何帧——就是要覆盖"无帧流动时客户端断开"这条路径
        await to_app.put({"type": "websocket.disconnect", "code": 1001})
        assert await _poll(lambda: worker.subscriber_count() == 0), \
            f"空闲断开后订阅者未清理, count={worker.subscriber_count()}"
        await asyncio.wait_for(task, timeout=2)  # 端点协程必须真正退出
    finally:
        if not task.done():
            task.cancel()
        worker.stop()


def test_ingest_text_ping_gets_pong():
    """协议约定控制消息走 JSON 文本帧：ping → pong，连接不死。"""
    app = create_app(lambda ch: EchoPipeline())
    client = TestClient(app)
    with client.websocket_connect("/ingest") as in_ws:
        in_ws.send_text('{"type": "ping"}')
        assert in_ws.receive_json() == {"type": "pong"}


def test_two_channels_route_independently():
    """多频道：ch1 的帧只到 ?channel=1 订阅者；/status 每频道独立计数 + 顶层别名。"""
    app = create_app(lambda ch: EchoPipeline(), channels=(0, 1))
    client = TestClient(app)
    with client.websocket_connect("/out?channel=0") as out0, \
         client.websocket_connect("/out?channel=1") as out1:
        with client.websocket_connect("/ingest") as in_ws:
            in_ws.send_bytes(pack_frame(FrameHeader(seq=11, ts_ms=1, channel=1), _jpeg(4)))
            blob1 = out1.receive_bytes()
            # out0 不应收到 ch1 的帧：随后发一帧 ch0，out0 收到的第一帧必须是它
            in_ws.send_bytes(pack_frame(FrameHeader(seq=22, ts_ms=2, channel=0), _jpeg(6)))
            blob0 = out0.receive_bytes()
    h1, _ = unpack_frame(blob1)
    h0, _ = unpack_frame(blob0)
    assert (h1.seq, h1.channel) == (11, 1)
    assert (h0.seq, h0.channel) == (22, 0)
    body = client.get("/status").json()
    assert body["channels"]["0"]["processed"] == 1
    assert body["channels"]["1"]["processed"] == 1
    assert body["channel"] == body["channels"]["0"]  # 顶层别名 = 频道 0（向后兼容）


def test_out_unknown_channel_closes_4400():
    app = create_app(lambda ch: EchoPipeline())  # 默认只有频道 0
    client = TestClient(app)
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/out?channel=7") as ws:
            ws.receive_bytes()
    assert exc.value.code == 4400


def test_ingest_unknown_channel_frame_ignored():
    """未知频道的帧只记日志忽略：连接活着、任何频道的计数都不动。"""
    app = create_app(lambda ch: EchoPipeline())
    client = TestClient(app)
    with client.websocket_connect("/out") as out_ws:
        with client.websocket_connect("/ingest") as in_ws:
            in_ws.send_bytes(pack_frame(FrameHeader(seq=1, ts_ms=1, channel=9), _jpeg(2)))
            in_ws.send_bytes(pack_frame(FrameHeader(seq=2, ts_ms=2, channel=0), _jpeg(3)))
            blob = out_ws.receive_bytes()  # 连接没死，后续 ch0 帧照常流转
    assert unpack_frame(blob)[0].seq == 2
    body = client.get("/status").json()
    assert body["channels"]["0"]["processed"] == 1  # 未知频道帧没进任何 worker
    assert body["channels"]["0"]["dropped"] == 0
    assert body["channels"]["0"]["errors"] == 0


def test_capture_page_served():
    """GET /capture 返回采集页（与 GET / viewer 同一 serve 模式）。"""
    app = create_app(lambda ch: EchoPipeline())
    client = TestClient(app)
    r = client.get("/capture")
    assert r.status_code == 200
    assert "OneLive" in r.text
    assert "/ingest" in r.text  # 采集页往 /ingest 推帧


def test_create_app_rejects_out_of_range_channel():
    """协议头 channel 是 u8：频道号超出 0-255 必须在 create_app 就报错。"""
    with pytest.raises(ValueError, match="out of range"):
        create_app(lambda ch: EchoPipeline(), channels=(0, 256))


def test_create_app_rejects_duplicate_channel():
    with pytest.raises(ValueError, match="duplicate"):
        create_app(lambda ch: EchoPipeline(), channels=(0, 1, 0))


def test_ingest_garbage_text_survives():
    """坏 JSON / 未知类型的文本帧只记日志忽略，之后的二进制帧照常流转。"""
    app = create_app(lambda ch: EchoPipeline())
    client = TestClient(app)
    with client.websocket_connect("/out") as out_ws:
        with client.websocket_connect("/ingest") as in_ws:
            in_ws.send_text("this is not json {{{")           # 坏 JSON → 忽略
            in_ws.send_text('{"type": "warp-drive"}')         # 未知类型 → 忽略
            in_ws.send_bytes(pack_frame(FrameHeader(seq=3, ts_ms=33, channel=0), _jpeg(5)))
            blob = out_ws.receive_bytes()
    header, _ = unpack_frame(blob)
    assert header.seq == 3
    assert header.ts_ms == 33


# ---------------------------------------------------------------- 翻译服务集成


class FakeTranslationPipeline:
    """与 TranslationPipeline 同形的 fake：记录 start/close/feed_audio 调用；
    scripted 事件在首次 feed_audio 时入队（测试先订 /events 再触发，避免
    订阅前事件被广播丢失的竞态）。events() 与真管线同为单消费者 + 哨兵终结。"""

    def __init__(self, scripted=()):
        self.scripted = list(scripted)
        self.started = False
        self.closed = False
        self.fed: list[tuple[bytes, int]] = []
        self._q: asyncio.Queue = asyncio.Queue()

    async def start(self):
        self.started = True

    def feed_audio(self, pcm16: bytes, sr: int) -> None:
        self.fed.append((pcm16, sr))
        for ev in self.scripted:
            self._q.put_nowait(ev)
        self.scripted = []

    async def events(self):
        while True:
            item = await self._q.get()
            if item is None:
                return
            yield item

    async def close(self):
        self.closed = True
        self._q.put_nowait(None)

    def stats(self) -> dict:
        return {"segments": 3, "translated_ok": 2, "translations_unavailable": 0,
                "tts_ok": 1, "errors": 1}


def _tts_ready() -> TTSReadyEvent:
    result = TTSResult(audio_pcm16=b"\x01\x02" * 160, sr=16000,
                       lip_curve=np.zeros(8, np.float32), duration_s=0.5, synth_ms=42)
    return TTSReadyEvent(segment_id=1, lang="en", voice="en-US-JennyNeural",
                         duration_s=0.5, synth_ms=42, result=result)


def _audio_chunk(sr: int, pcm: bytes) -> bytes:
    """/audio 二进制帧：4 字节 LE u32 采样率前缀 + pcm16。"""
    return struct.pack("<I", sr) + pcm


def _wait(cond, timeout: float = 2.0) -> bool:
    """测试线程侧轮询（服务端跑在 TestClient portal 线程的事件循环里）。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if cond():
            return True
        time.sleep(0.01)
    return cond()


def test_event_to_wire_subtitle():
    w = event_to_wire(SubtitleEvent(segment_id=3, text="大家好", t0=0.0, t1=1.2))
    assert w == {"type": "subtitle", "segment_id": 3, "text": "大家好", "t0": 0.0, "t1": 1.2}


def test_event_to_wire_translation():
    w = event_to_wire(TranslationEvent(segment_id=3, lang="en", status="ok",
                                       text="hello", detail=None))
    assert w == {"type": "translation", "segment_id": 3, "lang": "en",
                 "status": "ok", "text": "hello", "detail": None}


def test_event_to_wire_tts_ready_metadata_only():
    """TTSReadyEvent 上 wire 只带元数据：不得出现 pcm bytes / lip_curve ndarray
    （asdict 会在这俩上爆 JSON 序列化），存在性用 has_audio 标记。"""
    w = event_to_wire(_tts_ready())
    assert w == {"type": "tts_ready", "segment_id": 1, "lang": "en",
                 "voice": "en-US-JennyNeural", "duration_s": 0.5, "synth_ms": 42,
                 "has_audio": True}
    json.dumps(w)  # 必须整体可 JSON 序列化


def test_event_to_wire_pipeline_error():
    w = event_to_wire(PipelineErrorEvent(segment_id=7, lang="ja", stage="tts", detail="boom"))
    assert w == {"type": "pipeline_error", "segment_id": 7, "lang": "ja",
                 "stage": "tts", "detail": "boom"}


def test_event_to_wire_unknown_type_raises():
    with pytest.raises(TypeError, match="unknown pipeline event"):
        event_to_wire(object())


def test_audio_uplink_feeds_pipeline():
    """/audio 二进制帧 [u32 LE sr][pcm16] → feed_audio(pcm, sr) 解析无误。"""
    tp = FakeTranslationPipeline()
    app = create_app(lambda ch: EchoPipeline(), translation_pipeline=tp)
    pcm = b"\x00\x01" * 100
    with TestClient(app) as client:
        assert tp.started  # lifespan startup 已 await start()
        with client.websocket_connect("/audio") as ws:
            ws.send_bytes(_audio_chunk(16000, pcm))
            assert _wait(lambda: len(tp.fed) == 1), "feed_audio 未被调用"
    assert tp.fed[0] == (pcm, 16000)
    assert tp.closed  # lifespan shutdown 已 close()


def test_audio_short_frame_dropped_connection_survives():
    """不足 4 字节前缀的帧丢弃不上抛，连接活着，后续帧照常送达。"""
    tp = FakeTranslationPipeline()
    app = create_app(lambda ch: EchoPipeline(), translation_pipeline=tp)
    with TestClient(app) as client:
        with client.websocket_connect("/audio") as ws:
            ws.send_bytes(b"\x01\x02")                    # 短帧 → 丢弃
            ws.send_text("not audio")                     # 文本帧 → 忽略
            ws.send_bytes(_audio_chunk(48000, b"\xaa\xbb"))
            assert _wait(lambda: len(tp.fed) == 1)
    assert tp.fed == [(b"\xaa\xbb", 48000)]


def test_events_broadcasts_all_event_types():
    """/events 订阅者按序收到四类事件的 wire JSON；tts_ready 不带原始音频。"""
    scripted = [
        SubtitleEvent(segment_id=1, text="大家好", t0=0.0, t1=1.0),
        TranslationEvent(segment_id=1, lang="en", status="ok", text="hello", detail=None),
        _tts_ready(),
        PipelineErrorEvent(segment_id=1, lang="ja", stage="tts", detail="boom"),
    ]
    tp = FakeTranslationPipeline(scripted)
    app = create_app(lambda ch: EchoPipeline(), translation_pipeline=tp)
    with TestClient(app) as client:
        with client.websocket_connect("/events") as ev_ws:
            with client.websocket_connect("/audio") as au_ws:
                au_ws.send_bytes(_audio_chunk(16000, b"\x00\x00"))  # 触发 scripted 事件
                msgs = [ev_ws.receive_json() for _ in range(4)]
    assert [m["type"] for m in msgs] == ["subtitle", "translation", "tts_ready", "pipeline_error"]
    tts = msgs[2]
    assert tts["has_audio"] is True
    assert "result" not in tts and "audio_pcm16" not in tts and "lip_curve" not in tts
    assert msgs[0]["text"] == "大家好"  # 中文按原文过 wire（ensure_ascii 关闭与否均可解）


def test_events_consumer_survives_bad_event():
    """广播消费者遇到映射不了的事件只记日志跳过，后续事件照常广播。"""
    scripted = [
        SubtitleEvent(segment_id=1, text="a", t0=0.0, t1=0.5),
        object(),  # 未知事件 → skip，消费者不死
        TranslationEvent(segment_id=1, lang="en", status="ok", text="b", detail=None),
    ]
    tp = FakeTranslationPipeline(scripted)
    app = create_app(lambda ch: EchoPipeline(), translation_pipeline=tp)
    with TestClient(app) as client:
        with client.websocket_connect("/events") as ev_ws:
            with client.websocket_connect("/audio") as au_ws:
                au_ws.send_bytes(_audio_chunk(16000, b"\x00\x00"))
                msgs = [ev_ws.receive_json() for _ in range(2)]
    assert [m["type"] for m in msgs] == ["subtitle", "translation"]


def test_audio_without_pipeline_closes_4404():
    app = create_app(lambda ch: EchoPipeline())  # 未配翻译管线
    client = TestClient(app)
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/audio") as ws:
            ws.receive_bytes()
    assert exc.value.code == 4404


def test_events_without_pipeline_closes_4404():
    app = create_app(lambda ch: EchoPipeline())
    client = TestClient(app)
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/events") as ws:
            ws.receive_text()
    assert exc.value.code == 4404


def test_status_translation_stats():
    """配了翻译管线：/status 带 translation 节；没配：键不存在。"""
    tp = FakeTranslationPipeline()
    app = create_app(lambda ch: EchoPipeline(), translation_pipeline=tp)
    with TestClient(app) as client:
        body = client.get("/status").json()
    assert body["translation"] == tp.stats()

    plain = TestClient(create_app(lambda ch: EchoPipeline()))
    assert "translation" not in plain.get("/status").json()


def test_capture_page_has_audio_uplink():
    app = create_app(lambda ch: EchoPipeline())
    client = TestClient(app)
    r = client.get("/capture")
    assert "/audio" in r.text  # 采集页有音频上行路径
