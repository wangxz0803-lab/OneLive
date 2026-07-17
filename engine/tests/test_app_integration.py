"""集成测试：fake 管线下 /ingest → worker → /out 全链路 + /status。"""

import numpy as np
import cv2
from fastapi.testclient import TestClient

from service.app import create_app
from service.protocol import FrameHeader, pack_frame, unpack_frame


class EchoPipeline:
    def infer(self, frame_bgr, seq):
        return frame_bgr


def _jpeg(v: int) -> bytes:
    ok, jpg = cv2.imencode(".jpg", np.full((16, 16, 3), v, np.uint8))
    assert ok
    return jpg.tobytes()


def test_ingest_to_out_roundtrip():
    app = create_app(pipeline=EchoPipeline())
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
    app = create_app(pipeline=EchoPipeline())
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
    app = create_app(pipeline=EchoPipeline())
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
    app = create_app(pipeline=EchoPipeline())
    client = TestClient(app)
    with client.websocket_connect("/out") as out_ws:
        with client.websocket_connect("/ingest") as in_ws:
            in_ws.send_bytes(b"garbage")  # 坏帧 → 忽略并继续
            in_ws.send_bytes(pack_frame(FrameHeader(seq=1, ts_ms=1, channel=0), _jpeg(3)))
            blob = out_ws.receive_bytes()
    assert unpack_frame(blob)[0].seq == 1


def test_ingest_text_ping_gets_pong():
    """协议约定控制消息走 JSON 文本帧：ping → pong，连接不死。"""
    app = create_app(pipeline=EchoPipeline())
    client = TestClient(app)
    with client.websocket_connect("/ingest") as in_ws:
        in_ws.send_text('{"type": "ping"}')
        assert in_ws.receive_json() == {"type": "pong"}


def test_ingest_garbage_text_survives():
    """坏 JSON / 未知类型的文本帧只记日志忽略，之后的二进制帧照常流转。"""
    app = create_app(pipeline=EchoPipeline())
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
