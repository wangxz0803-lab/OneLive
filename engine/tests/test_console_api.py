"""UplinkStore 单元测试（M3b Task 2）：record 打时间戳、snapshot 算 age/stale。

时钟全注入（now 是参数），纯逻辑无副作用——不碰 monotonic 真实时钟，
断言可对精确的 age_s / stale 边界。"""

from service.console_api import UplinkStore


def _stats(fps=10.0, skipped=0, rtt=25):
    return {"fps_sent": fps, "skipped": skipped, "rtt_ms": rtt}


def test_empty_snapshot():
    store = UplinkStore()
    assert store.snapshot(now=100.0) == {}


def test_record_then_snapshot_fresh_not_stale():
    store = UplinkStore()
    store.record(0, _stats(fps=9.5, skipped=2, rtt=30), now=100.0)
    snap = store.snapshot(now=103.0)  # 3s 后，< 默认 5s 阈值
    assert set(snap) == {0}
    rec = snap[0]
    assert rec["fps_sent"] == 9.5
    assert rec["skipped"] == 2
    assert rec["rtt_ms"] == 30
    assert rec["age_s"] == 3.0        # 精确差值
    assert rec["stale"] is False
    assert "received_at" not in rec   # 内部时间戳不外泄


def test_aged_report_marked_stale():
    store = UplinkStore()
    store.record(0, _stats(), now=100.0)
    snap = store.snapshot(now=106.0)  # 6s 后 > 5s → stale
    assert snap[0]["age_s"] == 6.0
    assert snap[0]["stale"] is True


def test_stale_boundary_at_threshold():
    """age == 阈值即视为 stale（>=）。"""
    store = UplinkStore()
    store.record(0, _stats(), now=100.0)
    assert store.snapshot(now=105.0)[0]["stale"] is True   # 恰好 5.0s
    assert store.snapshot(now=104.999)[0]["stale"] is False


def test_custom_stale_after():
    store = UplinkStore()
    store.record(0, _stats(), now=100.0)
    assert store.snapshot(now=102.0, stale_after_s=1.0)[0]["stale"] is True
    assert store.snapshot(now=100.5, stale_after_s=1.0)[0]["stale"] is False


def test_multi_channel_isolation():
    store = UplinkStore()
    store.record(0, _stats(fps=8.0), now=100.0)
    store.record(1, _stats(fps=12.0), now=104.0)
    snap = store.snapshot(now=106.0)
    assert set(snap) == {0, 1}
    assert snap[0]["fps_sent"] == 8.0 and snap[0]["age_s"] == 6.0 and snap[0]["stale"] is True
    assert snap[1]["fps_sent"] == 12.0 and snap[1]["age_s"] == 2.0 and snap[1]["stale"] is False


def test_record_overwrites_same_channel():
    """同频道后一次上报覆盖前一次（HUD 只关心最新态）。"""
    store = UplinkStore()
    store.record(0, _stats(fps=5.0), now=100.0)
    store.record(0, _stats(fps=11.0), now=110.0)
    snap = store.snapshot(now=111.0)
    assert snap[0]["fps_sent"] == 11.0
    assert snap[0]["age_s"] == 1.0
