"""集成测试：fake 管线下 /ingest → worker → /out 全链路 + /status。"""

import asyncio
import time

import numpy as np
import cv2
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

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
