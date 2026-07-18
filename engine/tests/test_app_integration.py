"""集成测试：fake 管线下 /ingest → worker → /out 全链路 + /status，
以及翻译服务集成（/audio 上行 + /events 广播 + /status.translation）。"""

import asyncio
import json
import struct
import threading
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
    def infer(self, frame_bgr, seq, lip_ratio=None):
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
    # 每频道 speech 块（M2b）：口型调度器进度透出到 /status
    assert body["channel"]["speech"] == {"queued": 0, "played": 0, "dropped": 0}
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


# ---------------------------------------------------------------- casting 控制


class CastablePipeline(EchoPipeline):
    """EchoPipeline + set_source 记录器（记录路径与执行线程）。"""

    def __init__(self):
        self.cast_calls: list[tuple[str, int]] = []

    def set_source(self, image_path: str) -> None:
        self.cast_calls.append((image_path, threading.get_ident()))


class CastFailPipeline(EchoPipeline):
    def set_source(self, image_path: str) -> None:
        raise ValueError("no face detected")


def _casting(ch, source) -> str:
    return json.dumps({"type": "casting", "channel": ch, "source": source})


def test_casting_rejects_bad_source_names(tmp_path, monkeypatch):
    """白名单：路径穿越 / 绝对路径 / 分隔符 / 非法扩展名 / 非字符串 一律 ok=false，
    连接不死。nack 是同步发出的，必须先于后续 ping 的 pong 到达。"""
    monkeypatch.setenv("ONELIVE_AVATAR_DIR", str(tmp_path))
    app = create_app(lambda ch: CastablePipeline())
    client = TestClient(app)
    bad = ["../evil.jpg", "..\\evil.jpg", "sub/dir.jpg", "sub\\dir.jpg",
           "C:\\evil.jpg", "/etc/passwd.jpg", "evil.exe", "no_ext", "", None, 42]
    with client.websocket_connect("/ingest") as ws:
        for src in bad:
            ws.send_text(_casting(0, src))
            ws.send_text('{"type": "ping"}')
            ack = ws.receive_json()
            assert ack["type"] == "casting_ack", f"source={src!r}: got {ack}"
            assert ack["ok"] is False
            assert ack["detail"]
            assert ws.receive_json() == {"type": "pong"}  # 连接活着且 nack 未乱序


def test_casting_non_int_channel_nacked_connection_survives(tmp_path, monkeypatch):
    """channel 非 int（list/dict 等不可哈希类型直接进 workers.get 会 TypeError
    杀死接收循环）：必须 nack "invalid channel"，连接活着（尾随 ping 有 pong）。"""
    (tmp_path / "s1.jpg").write_bytes(b"x")
    monkeypatch.setenv("ONELIVE_AVATAR_DIR", str(tmp_path))
    app = create_app(lambda ch: CastablePipeline())
    client = TestClient(app)
    bad_channels = [[0], {"ch": 0}, "0", 1.5, True, None]
    with client.websocket_connect("/ingest") as ws:
        for ch in bad_channels:
            ws.send_text(_casting(ch, "s1.jpg"))
            ack = ws.receive_json()
            assert ack["type"] == "casting_ack", f"channel={ch!r}: got {ack}"
            assert ack["ok"] is False
            assert ack["detail"] == "invalid channel"
            ws.send_text('{"type": "ping"}')
            assert ws.receive_json() == {"type": "pong"}  # 接收循环没死


def test_casting_unknown_channel_nacked(tmp_path, monkeypatch):
    (tmp_path / "s1.jpg").write_bytes(b"x")
    monkeypatch.setenv("ONELIVE_AVATAR_DIR", str(tmp_path))
    app = create_app(lambda ch: CastablePipeline())  # 只有频道 0
    client = TestClient(app)
    with client.websocket_connect("/ingest") as ws:
        ws.send_text(_casting(7, "s1.jpg"))
        ack = ws.receive_json()
    assert ack["type"] == "casting_ack"
    assert ack["ok"] is False
    assert "channel" in ack["detail"]


def test_casting_missing_file_nacked(tmp_path, monkeypatch):
    monkeypatch.setenv("ONELIVE_AVATAR_DIR", str(tmp_path))
    app = create_app(lambda ch: CastablePipeline())
    client = TestClient(app)
    with client.websocket_connect("/ingest") as ws:
        ws.send_text(_casting(0, "nope.jpg"))  # 名字合法但文件不存在
        ack = ws.receive_json()
    assert ack["ok"] is False
    assert "not found" in ack["detail"]


def test_casting_ok_calls_set_source_and_acks_with_ms(tmp_path, monkeypatch):
    """合法请求：set_source 在 worker 线程收到解析后的绝对路径，完成后
    ack ok=true 携带耗时 ms；接收循环不被阻塞（casting 期间 ping 照常回）。"""
    (tmp_path / "s1.jpg").write_bytes(b"x")
    monkeypatch.setenv("ONELIVE_AVATAR_DIR", str(tmp_path))
    pipes: dict[int, CastablePipeline] = {}

    def factory(ch):
        pipes[ch] = CastablePipeline()
        return pipes[ch]

    app = create_app(factory)
    client = TestClient(app)
    with client.websocket_connect("/ingest") as ws:
        ws.send_text(_casting(0, "s1.jpg"))
        ack = ws.receive_json()
    assert ack["type"] == "casting_ack"
    assert ack["ok"] is True
    assert ack["channel"] == 0
    assert ack["source"] == "s1.jpg"
    assert isinstance(ack["ms"], (int, float)) and ack["ms"] >= 0
    assert len(pipes[0].cast_calls) == 1
    called_path, tid = pipes[0].cast_calls[0]
    assert called_path == str(tmp_path / "s1.jpg")  # 白名单解析后的绝对路径
    assert tid != threading.get_ident()             # 在 worker 线程执行，非测试线程


def test_casting_set_source_failure_nacked_with_detail(tmp_path, monkeypatch):
    """set_source 抛异常（如无脸）：ack ok=false 带异常详情，worker/连接都活着。"""
    (tmp_path / "s1.jpg").write_bytes(b"x")
    monkeypatch.setenv("ONELIVE_AVATAR_DIR", str(tmp_path))
    app = create_app(lambda ch: CastFailPipeline())
    client = TestClient(app)
    with client.websocket_connect("/out") as out_ws:
        with client.websocket_connect("/ingest") as ws:
            ws.send_text(_casting(0, "s1.jpg"))
            ack = ws.receive_json()
            assert ack["ok"] is False
            assert "no face detected" in ack["detail"]
            # 失败后帧路径不受影响
            ws.send_bytes(pack_frame(FrameHeader(seq=8, ts_ms=88, channel=0), _jpeg(3)))
            blob = out_ws.receive_bytes()
    assert unpack_frame(blob)[0].seq == 8


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
        self._sr: int | None = None
        self._q: asyncio.Queue = asyncio.Queue()

    async def start(self):
        self.started = True

    def feed_audio(self, pcm16: bytes, sr: int) -> None:
        # 复刻真实链路契约：SegmentTranscriber.feed 对采样率中途变化 raise
        # ValueError（asr.py），pipeline.feed_audio 不捕获、原样上抛
        if self._sr is None:
            self._sr = sr
        elif sr != self._sr:
            raise ValueError(f"sample rate changed: {self._sr} -> {sr}")
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
    # duration_s 必须与 len(lip_curve)/25fps 一致（8 帧 → 0.32s）：早期写 0.5
    # 会让 SpeechClip 构造 raise，凡经过 tee 的用例全走了异常路径而非快乐路径
    result = TTSResult(audio_pcm16=b"\x01\x02" * 160, sr=16000,
                       lip_curve=np.zeros(8, np.float32), duration_s=0.32, synth_ms=42)
    return TTSReadyEvent(segment_id=1, lang="en", voice="en-US-JennyNeural",
                         duration_s=0.32, synth_ms=42, result=result)


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
                 "voice": "en-US-JennyNeural", "duration_s": 0.32, "synth_ms": 42,
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


def test_audio_sample_rate_change_closes_4409():
    """sr 中途变化：转写器契约是 raise ValueError（asr.feed）。/audio 不得以
    裸异常炸掉连接（否则 capture 端 1s 重连风暴）——发一条一次性 error 文本
    说明后以专用码 4409 关闭，客户端据码停止自动重连。"""
    tp = FakeTranslationPipeline()
    app = create_app(lambda ch: EchoPipeline(), translation_pipeline=tp)
    with TestClient(app) as client:
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect("/audio") as ws:
                ws.send_bytes(_audio_chunk(16000, b"\x00\x01"))
                ws.send_bytes(_audio_chunk(48000, b"\x00\x01"))
                warn = ws.receive_json()          # 关闭前的一次性说明帧
                assert warn["type"] == "error"
                assert warn["code"] == 4409
                assert "sample rate" in warn["detail"]
                ws.receive_text()                 # 下一次 receive 感知服务端 close
        assert exc.value.code == 4409
    assert tp.fed == [(b"\x00\x01", 16000)]  # 第二块被拒，未入管线


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


# ---------------------------------------------------------- TTS tee + /speech


class RecordingSchedule:
    """替身 SpeechSchedule：只记录 enqueue 到的 clip（渲染侧 lip_at 返回 None）。
    stats() 必须实现——worker.stats() 的 speech 块对替身同样生效。"""

    def __init__(self):
        self.clips = []

    def enqueue(self, clip) -> None:
        self.clips.append(clip)

    def lip_at(self, now):
        return None

    def stats(self) -> dict:
        return {"queued": len(self.clips), "played": 0, "dropped": 0}


def _tts_ready_ev(segment_id=1, lang="en", pcm=b"\x01\x02" * 160, sr=16000,
                  curve=None, duration_s=0.5):
    if curve is None:
        curve = np.full(12, 0.5, np.float32)  # 12 帧 / 25fps ≈ 0.48s，与 0.5s 差半帧
    result = TTSResult(audio_pcm16=pcm, sr=sr, lip_curve=curve,
                       duration_s=duration_s, synth_ms=42)
    return TTSReadyEvent(segment_id=segment_id, lang=lang, voice="v",
                         duration_s=duration_s, synth_ms=42, result=result)


def _parse_speech_frame(blob: bytes):
    """/speech 二进制帧 [u8 channel][u32 LE segment_id][u32 LE sr][pcm16]。"""
    ch, seg, sr = struct.unpack_from("<BII", blob)
    return ch, seg, sr, blob[9:]


def test_tts_tee_enqueues_clip_and_broadcasts_speech_frame():
    """TTSReadyEvent（映射语言）→ worker.speech 收到 clip（字段一致），
    /speech 订阅者收到帧格式正确的二进制（pcm 原样），wire 事件带 channel。"""
    pcm = b"\xaa\xbb" * 100
    ev = _tts_ready_ev(segment_id=7, lang="en", pcm=pcm, sr=24000)
    tp = FakeTranslationPipeline([ev])
    app = create_app(lambda ch: EchoPipeline(), translation_pipeline=tp)
    sched = RecordingSchedule()
    app.state.workers[0].speech = sched
    with TestClient(app) as client:
        with client.websocket_connect("/speech") as sp_ws, \
             client.websocket_connect("/events") as ev_ws:
            with client.websocket_connect("/audio") as au_ws:
                au_ws.send_bytes(_audio_chunk(16000, b"\x00\x00"))
                wire = ev_ws.receive_json()
                blob = sp_ws.receive_bytes()
    assert wire["type"] == "tts_ready"
    assert wire["channel"] == 0                      # wire 新增 channel 字段
    ch, seg, sr, got_pcm = _parse_speech_frame(blob)
    assert (ch, seg, sr) == (0, 7, 24000)
    assert got_pcm == pcm                            # pcm 原样透传
    assert _wait(lambda: len(sched.clips) == 1), "clip 未入队"
    clip = sched.clips[0]
    assert (clip.segment_id, clip.lang) == (7, "en")
    assert clip.fps == 25.0                          # TTS 曲线帧率（LIP_FPS 耦合）
    assert clip.duration_s == 0.5
    assert np.allclose(clip.curve, 0.5)


def test_tts_tee_unmapped_lang_events_only():
    """未映射语言：不入队、/speech 无帧、不崩——wire channel 为 null，
    随后映射语言的事件照常入队 + 广播（/speech 首帧必须是映射段）。"""
    ja = _tts_ready_ev(segment_id=1, lang="ja")
    en = _tts_ready_ev(segment_id=2, lang="en")
    tp = FakeTranslationPipeline([ja, en])
    app = create_app(lambda ch: EchoPipeline(), translation_pipeline=tp)
    sched = RecordingSchedule()
    app.state.workers[0].speech = sched
    with TestClient(app) as client:
        with client.websocket_connect("/speech") as sp_ws, \
             client.websocket_connect("/events") as ev_ws:
            with client.websocket_connect("/audio") as au_ws:
                au_ws.send_bytes(_audio_chunk(16000, b"\x00\x00"))
                w_ja = ev_ws.receive_json()
                w_en = ev_ws.receive_json()
                blob = sp_ws.receive_bytes()
    assert (w_ja["segment_id"], w_ja["channel"]) == (1, None)
    assert (w_en["segment_id"], w_en["channel"]) == (2, 0)
    assert _parse_speech_frame(blob)[1] == 2         # /speech 首帧就是映射段 2
    assert [c.segment_id for c in sched.clips] == [2]  # ja 段未入队


def test_tts_tee_bad_curve_consumer_survives():
    """NaN 曲线：SpeechClip 构造 raise → 只记日志跳过入队，广播任务不死，
    后续事件照常广播。"""
    bad = _tts_ready_ev(segment_id=1, lang="en",
                        curve=np.array([0.5, np.nan, 0.5], np.float32))
    tp = FakeTranslationPipeline([
        bad, SubtitleEvent(segment_id=2, text="still alive", t0=0.0, t1=0.5)])
    app = create_app(lambda ch: EchoPipeline(), translation_pipeline=tp)
    with TestClient(app) as client:
        with client.websocket_connect("/events") as ev_ws:
            with client.websocket_connect("/audio") as au_ws:
                au_ws.send_bytes(_audio_chunk(16000, b"\x00\x00"))
                msgs = [ev_ws.receive_json() for _ in range(2)]
    assert [m["type"] for m in msgs] == ["tts_ready", "subtitle"]  # 消费者活着
    sched = app.state.workers[0].speech
    assert sched.stats()["queued"] == 0              # 坏曲线未入队


def test_speech_channel_filtering():
    """两频道两语言：帧只到对应 ?channel= 的订阅者。"""
    en = _tts_ready_ev(segment_id=10, lang="en")
    ja = _tts_ready_ev(segment_id=11, lang="ja")
    tp = FakeTranslationPipeline([en, ja])
    app = create_app(lambda ch: EchoPipeline(), channels=(0, 1),
                     translation_pipeline=tp,
                     lang_channels={"en": 0, "ja": 1})
    with TestClient(app) as client:
        with client.websocket_connect("/speech?channel=0") as sp0, \
             client.websocket_connect("/speech?channel=1") as sp1:
            with client.websocket_connect("/audio") as au_ws:
                au_ws.send_bytes(_audio_chunk(16000, b"\x00\x00"))
                b0 = sp0.receive_bytes()
                b1 = sp1.receive_bytes()
    assert _parse_speech_frame(b0)[:2] == (0, 10)
    assert _parse_speech_frame(b1)[:2] == (1, 11)


def test_status_speech_stats_reflect_tee():
    """tee 入队后 /status 的每频道 speech 块反映排队进度（无渲染帧流动时
    queued=1：clip 已入队但渲染循环未消费）。"""
    tp = FakeTranslationPipeline([_tts_ready_ev(segment_id=3, lang="en")])
    app = create_app(lambda ch: EchoPipeline(), translation_pipeline=tp)
    with TestClient(app) as client:
        with client.websocket_connect("/audio") as au_ws:
            au_ws.send_bytes(_audio_chunk(16000, b"\x00\x00"))
            sched = app.state.workers[0].speech
            assert _wait(lambda: sched.stats()["queued"] == 1), "clip 未入队"
        body = client.get("/status").json()
    assert body["channels"]["0"]["speech"] == {"queued": 1, "played": 0, "dropped": 0}


def test_speech_without_pipeline_closes_4404():
    app = create_app(lambda ch: EchoPipeline())
    client = TestClient(app)
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect("/speech") as ws:
            ws.receive_bytes()
    assert exc.value.code == 4404


def test_speech_unknown_channel_closes_4400():
    tp = FakeTranslationPipeline()
    app = create_app(lambda ch: EchoPipeline(), translation_pipeline=tp)
    with TestClient(app) as client:
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect("/speech?channel=7") as ws:
                ws.receive_bytes()
        assert exc.value.code == 4400


def test_create_app_rejects_lang_channel_without_worker():
    """lang_channels 指到不存在的频道：配了翻译管线时 create_app 即报错。"""
    with pytest.raises(ValueError, match="lang_channels"):
        create_app(lambda ch: EchoPipeline(), channels=(0,),
                   translation_pipeline=FakeTranslationPipeline(),
                   lang_channels={"en": 3})


# ---------------------------------------------------------- M3a 拉流端点


class _AsgiLifespan:
    """手动驱动 lifespan scope。流式端点不能用 TestClient 测：它把整个响应
    体缓冲到 app 返回为止（testclient.py 里 portal.call(self.app, ...) 跑到
    完成才组装响应），无限流会永久挂死；只能手驱 ASGI。而 mixer 只在
    lifespan startup 里启动，所以 lifespan 也一并手驱（同 _drive_idle_disconnect
    的 ASGI 消息驱动模式）。"""

    def __init__(self, app):
        self._to_app: asyncio.Queue = asyncio.Queue()
        self._from_app: asyncio.Queue = asyncio.Queue()
        self._task = asyncio.ensure_future(
            app({"type": "lifespan"}, self._to_app.get, self._from_app.put))

    async def __aenter__(self):
        await self._to_app.put({"type": "lifespan.startup"})
        msg = await asyncio.wait_for(self._from_app.get(), 10)
        assert msg["type"] == "lifespan.startup.complete", msg
        return self

    async def __aexit__(self, *exc):
        await self._to_app.put({"type": "lifespan.shutdown"})
        msg = await asyncio.wait_for(self._from_app.get(), 10)
        assert msg["type"] == "lifespan.shutdown.complete", msg
        await asyncio.wait_for(self._task, 5)


class _HttpStream:
    """手动驱动一个 GET http scope，增量读响应体（动机见 _AsgiLifespan）。"""

    def __init__(self, app, path: str, query: str = ""):
        self._to_app: asyncio.Queue = asyncio.Queue()
        self._from_app: asyncio.Queue = asyncio.Queue()
        scope = {"type": "http", "http_version": "1.1", "method": "GET",
                 "path": path, "raw_path": path.encode(), "root_path": "",
                 "query_string": query.encode(), "headers": [],
                 "client": ("test", 1), "server": ("test", 80), "scheme": "http"}
        self.task = asyncio.ensure_future(
            app(scope, self._to_app.get, self._from_app.put))
        self.status: int | None = None
        self.headers: dict[str, str] = {}

    async def start(self) -> None:
        msg = await asyncio.wait_for(self._from_app.get(), 5)
        assert msg["type"] == "http.response.start", msg
        self.status = msg["status"]
        self.headers = {k.decode(): v.decode() for k, v in msg.get("headers", [])}

    async def chunk(self, timeout: float = 2.0) -> bytes:
        msg = await asyncio.wait_for(self._from_app.get(), timeout)
        assert msg["type"] == "http.response.body", msg
        return msg.get("body", b"")

    async def disconnect(self) -> None:
        await self._to_app.put({"type": "http.disconnect"})
        try:
            await asyncio.wait_for(self.task, 5)
        except asyncio.CancelledError:
            pass


async def _read_until(s: _HttpStream, n_bytes: int, max_chunks: int = 200) -> bytes:
    buf = b""
    for _ in range(max_chunks):
        if len(buf) >= n_bytes:
            return buf
        buf += await s.chunk()
    raise AssertionError(f"stream produced only {len(buf)} bytes, wanted {n_bytes}")


def _parse_mjpeg(buf: bytes) -> list[bytes]:
    """解析 multipart/x-mixed-replace 完整帧；边界格式逐字节严格校验。"""
    frames = []
    pos = 0
    while True:
        start = buf.find(b"--frame\r\n", pos)
        if start < 0:
            break
        hdr_end = buf.find(b"\r\n\r\n", start)
        if hdr_end < 0:
            break
        lines = buf[start + len(b"--frame\r\n"):hdr_end].decode("ascii").split("\r\n")
        assert lines[0] == "Content-Type: image/jpeg", lines
        assert lines[1].startswith("Content-Length: "), lines
        n = int(lines[1][len("Content-Length: "):])
        body_start = hdr_end + 4
        if len(buf) < body_start + n + 2:
            break  # 帧体还没到齐
        frames.append(buf[body_start:body_start + n])
        assert buf[body_start + n:body_start + n + 2] == b"\r\n"
        pos = body_start + n + 2
    return frames


def test_stream_mjpeg_multipart_frames_decode():
    app = create_app(lambda ch: EchoPipeline())
    asyncio.run(_drive_mjpeg_frames(app))


async def _drive_mjpeg_frames(app) -> None:
    worker = app.state.workers[0]
    async with _AsgiLifespan(app):
        s = _HttpStream(app, "/stream.mjpeg", "channel=0")
        try:
            await s.start()
            assert s.status == 200
            assert s.headers["content-type"] == "multipart/x-mixed-replace; boundary=frame"
            # 等订阅注册完成再喂帧：订阅在响应体生成器首次迭代时才发生
            assert await _poll(lambda: worker.subscriber_count() == 1)
            jpeg = _jpeg(9)
            buf = b""
            for seq in range(60):
                worker.submit(jpeg, seq=seq, ts_ms=seq)  # /ingest 的最终去处
                buf += await s.chunk()
                if len(_parse_mjpeg(buf)) >= 2:
                    break
            frames = _parse_mjpeg(buf)
            assert len(frames) >= 2, f"only {len(frames)} frames in {len(buf)} bytes"
            assert buf.startswith(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ")
            img = cv2.imdecode(np.frombuffer(frames[0], np.uint8), cv2.IMREAD_COLOR)
            assert img is not None and img.shape == (16, 16, 3)
        finally:
            await s.disconnect()
    assert worker.subscriber_count() == 0  # 断连后订阅清理


def test_stream_mjpeg_disconnect_unsubscribes():
    app = create_app(lambda ch: EchoPipeline())
    asyncio.run(_drive_mjpeg_disconnect(app))


async def _drive_mjpeg_disconnect(app) -> None:
    worker = app.state.workers[0]
    async with _AsgiLifespan(app):
        s = _HttpStream(app, "/stream.mjpeg", "channel=0")
        await s.start()
        assert await _poll(lambda: worker.subscriber_count() == 1)
        # 全程不发一帧——覆盖"空闲期客户端断开"：CancelledError 落在
        # queue.get()，生成器 finally 必须退订（/out 僵尸订阅者的教训）
        await s.disconnect()
        assert await _poll(lambda: worker.subscriber_count() == 0), \
            f"断连后订阅者未清理, count={worker.subscriber_count()}"


def test_stream_mjpeg_unknown_channel_404():
    app = create_app(lambda ch: EchoPipeline())
    client = TestClient(app)
    assert client.get("/stream.mjpeg?channel=7").status_code == 404


_WAV_HDR = struct.Struct("<4sI4s4sIHHIIHH4sI")  # 44 字节 RIFF/WAVE 头


def test_stream_wav_header_and_silence():
    app = create_app(lambda ch: EchoPipeline())
    asyncio.run(_drive_wav_header(app))


async def _drive_wav_header(app) -> None:
    async with _AsgiLifespan(app):
        mixer = app.state.mixers[0]
        s = _HttpStream(app, "/stream.wav", "channel=0")
        try:
            await s.start()
            assert s.status == 200
            assert s.headers["content-type"] == "audio/wav"
            buf = await _read_until(s, 44 + 3200)  # 头 + ≥1 块（100ms@16k=3200B）
        finally:
            await s.disconnect()
        (riff, riff_size, wave, fmt, fmt_size, audio_fmt, n_ch, sr,
         byte_rate, block_align, bits, data, data_size) = _WAV_HDR.unpack_from(buf)
        assert (riff, wave, fmt, data) == (b"RIFF", b"WAVE", b"fmt ", b"data")
        assert riff_size == 0xFFFFFFFF and data_size == 0xFFFFFFFF  # 无限流惯例
        assert (fmt_size, audio_fmt, n_ch, bits) == (16, 1, 1, 16)  # PCM 单声道 16 位
        assert (sr, byte_rate, block_align) == (16000, 32000, 2)
        body = buf[44:]
        assert body == b"\x00" * len(body)  # 无 TTS → 纯静音
        assert mixer._subs == set()  # 断连后混音器订阅清理


def test_stream_wav_contains_spliced_speech():
    app = create_app(lambda ch: EchoPipeline())
    asyncio.run(_drive_wav_splice(app))


async def _drive_wav_splice(app) -> None:
    async with _AsgiLifespan(app):
        mixer = app.state.mixers[0]
        s = _HttpStream(app, "/stream.wav", "channel=0")
        try:
            await s.start()
            buf = await _read_until(s, 44 + 3200)  # 订阅已激活且在收静音
            pattern = b"\x11\x22\x33\x44" * 400  # 1600 字节 = 0.05s @ 16k
            mixer.splice(pattern, segment_id=1)  # 事件循环内直接拼（tee 集成另测）
            for _ in range(100):
                if pattern in buf:
                    break
                buf += await s.chunk()
            assert pattern in buf  # 语音字节原样出现在音轨流里
        finally:
            await s.disconnect()


def test_stream_wav_unknown_channel_404():
    app = create_app(lambda ch: EchoPipeline())
    client = TestClient(app)
    assert client.get("/stream.wav?channel=7").status_code == 404


def test_tts_tee_splices_mixer_alongside_schedule_and_speech():
    """tee 三路并行：同一 TTSReadyEvent → SpeechSchedule 入队 + /speech 广播
    + mixer.splice，三处都到货。"""
    pcm = b"\x0a\x0b" * 1600  # 3200 字节 = 0.1s @ 16k
    ev = _tts_ready_ev(segment_id=9, lang="en", pcm=pcm, sr=16000)
    tp = FakeTranslationPipeline([ev])
    app = create_app(lambda ch: EchoPipeline(), translation_pipeline=tp)
    sched = RecordingSchedule()
    app.state.workers[0].speech = sched
    with TestClient(app) as client:
        mixer = app.state.mixers[0]
        with client.websocket_connect("/speech") as sp_ws:
            with client.websocket_connect("/audio") as au_ws:
                au_ws.send_bytes(_audio_chunk(16000, b"\x00\x00"))
                blob = sp_ws.receive_bytes()
        assert _wait(lambda: mixer.stats()["spliced_segments"] == 1), "mixer 未收到 splice"
    assert _parse_speech_frame(blob)[1] == 9
    assert [c.segment_id for c in sched.clips] == [9]


def test_tts_tee_sr_mismatch_not_spliced_consumer_survives():
    """TTSResult.sr 与 mixer 采样率不一致：不 splice（宁缺毋腐——错采样率
    的字节进音轨是变速噪音），只记日志；广播任务活着，后续匹配段照常拼。"""
    bad = _tts_ready_ev(segment_id=1, lang="en", sr=24000)
    good = _tts_ready_ev(segment_id=2, lang="en", sr=16000)
    tp = FakeTranslationPipeline([bad, good])
    app = create_app(lambda ch: EchoPipeline(), translation_pipeline=tp)
    with TestClient(app) as client:
        mixer = app.state.mixers[0]
        with client.websocket_connect("/audio") as au_ws:
            au_ws.send_bytes(_audio_chunk(16000, b"\x00\x00"))
            assert _wait(lambda: mixer.stats()["spliced_segments"] == 1)
    assert mixer.stats()["spliced_segments"] == 1  # 只有 sr 匹配的段入混音器


def test_mixers_run_in_lifespan_without_translation_pipeline():
    """mixer 不依赖翻译管线（纯静音直播也要有音轨）：create_app 即存在，
    lifespan startup 启动、shutdown 停止；停后不可重启（一次性生命周期）。"""
    app = create_app(lambda ch: EchoPipeline(), channels=(0, 1))
    assert set(app.state.mixers) == {0, 1}
    with TestClient(app):
        mixer = app.state.mixers[0]
        assert _wait(lambda: mixer.stats()["chunks_emitted"] > 0), "lifespan 内节拍未跑"
    emitted = mixer.stats()["chunks_emitted"]
    time.sleep(0.35)
    assert mixer.stats()["chunks_emitted"] == emitted  # shutdown 已停节拍
    with pytest.raises(RuntimeError):
        asyncio.run(mixer.start())  # 停后重启不支持：重启 = 新建实例


def test_audio_odd_byte_frame_dropped_connection_survives():
    """pcm16 字节数为奇数的 /audio 帧：丢弃不进管线，连接活着。"""
    tp = FakeTranslationPipeline()
    app = create_app(lambda ch: EchoPipeline(), translation_pipeline=tp)
    with TestClient(app) as client:
        with client.websocket_connect("/audio") as ws:
            ws.send_bytes(_audio_chunk(16000, b"\x01\x02\x03"))  # 奇数 → 丢弃
            ws.send_bytes(_audio_chunk(16000, b"\x01\x02"))
            assert _wait(lambda: len(tp.fed) == 1)
    assert tp.fed == [(b"\x01\x02", 16000)]
