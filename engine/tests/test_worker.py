import threading
import time

import numpy as np

from service.worker import ChannelWorker


class FakePipeline:
    """可控耗时的假管线：返回输入帧的副本并记录调用序号。"""

    def __init__(self, cost_s: float = 0.0):
        self.cost_s = cost_s
        self.calls: list[int] = []

    def infer(self, frame_bgr: np.ndarray, seq: int) -> np.ndarray:
        self.calls.append(seq)
        if self.cost_s:
            time.sleep(self.cost_s)
        return frame_bgr.copy()


class BlockingPipeline:
    """首帧 infer 阻塞在 gate 上，用于确定性验证单槽 latest-wins。"""

    def __init__(self):
        self.gate = threading.Event()
        self.started = threading.Event()
        self.calls: list[int] = []

    def infer(self, frame_bgr: np.ndarray, seq: int) -> np.ndarray:
        self.calls.append(seq)
        self.started.set()
        self.gate.wait(timeout=5)
        return frame_bgr.copy()


class RaisingPipeline:
    """第一次 infer 抛异常，之后正常返回。"""

    def __init__(self):
        self.calls: list[int] = []

    def infer(self, frame_bgr: np.ndarray, seq: int) -> np.ndarray:
        self.calls.append(seq)
        if len(self.calls) == 1:
            raise RuntimeError("boom")
        return frame_bgr.copy()


class NonePipeline:
    """总是返回 None（如无脸帧），带少量耗时以便断言 last_infer_ms。"""

    def __init__(self):
        self.calls: list[int] = []

    def infer(self, frame_bgr: np.ndarray, seq: int):
        self.calls.append(seq)
        time.sleep(0.02)
        return None


def _frame(v: int) -> np.ndarray:
    return np.full((8, 8, 3), v, np.uint8)


def test_latest_wins_drops_stale_frames():
    fake = FakePipeline(cost_s=0.05)
    w = ChannelWorker(pipeline=fake, name="t")
    w.start()
    try:
        for i in range(10):  # 提交快于消费，中间帧应被丢弃
            w.submit(_frame(i), seq=i, ts_ms=1000 + i)
            time.sleep(0.01)
        deadline = time.time() + 2.0
        while time.time() < deadline and (not fake.calls or fake.calls[-1] != 9):
            time.sleep(0.01)
        assert fake.calls[-1] == 9          # 最新帧必被处理
        assert len(fake.calls) < 10         # 有丢帧（latest-wins）
        assert fake.calls == sorted(fake.calls)  # 不回退
    finally:
        w.stop()


def test_subscribers_receive_rendered_frames():
    fake = FakePipeline()
    w = ChannelWorker(pipeline=fake, name="t")
    got: list[tuple[int, int]] = []
    unsub = w.subscribe(lambda seq, ts_ms, jpeg: got.append((seq, ts_ms)))
    w.start()
    try:
        w.submit(_frame(1), seq=1, ts_ms=1234)
        deadline = time.time() + 2.0
        while time.time() < deadline and not got:
            time.sleep(0.01)
        assert got == [(1, 1234)]           # 回调收到的 ts_ms 必须等于提交时的值
        unsub()
        w.submit(_frame(2), seq=2, ts_ms=5678)
        time.sleep(0.2)
        assert got == [(1, 1234)]           # 退订后不再收到
    finally:
        w.stop()


def test_stats_report_processed_and_dropped():
    fake = FakePipeline(cost_s=0.05)
    w = ChannelWorker(pipeline=fake, name="t")
    w.start()
    try:
        for i in range(6):
            w.submit(_frame(i), seq=i, ts_ms=2000 + i)
        time.sleep(0.5)
        s = w.stats()
        assert s["processed"] >= 1
        assert s["processed"] + s["dropped"] == 6
        assert s["last_infer_ms"] >= 40
    finally:
        w.stop()


def test_single_slot_keeps_only_latest_deterministic():
    fake = BlockingPipeline()
    w = ChannelWorker(pipeline=fake, name="t")
    w.start()
    try:
        w.submit(_frame(0), seq=0, ts_ms=3000)
        assert fake.started.wait(timeout=2)  # worker 已取走 frame 0 并阻塞在 infer 中
        for i in range(1, 10):               # 阻塞期间提交 1..9，槽内只留 9
            w.submit(_frame(i), seq=i, ts_ms=3000 + i)
        fake.gate.set()
        deadline = time.time() + 2.0
        while time.time() < deadline and len(fake.calls) < 2:
            time.sleep(0.01)
        assert fake.calls == [0, 9]          # 单槽 latest-wins 的确定性契约
        assert w.stats()["dropped"] == 8     # 2..9 各覆盖一次前帧
    finally:
        w.stop()


def test_worker_survives_pipeline_exception():
    fake = RaisingPipeline()
    w = ChannelWorker(pipeline=fake, name="t")
    got: list[tuple[int, int]] = []
    w.subscribe(lambda seq, ts_ms, jpeg: got.append((seq, ts_ms)))
    w.start()
    try:
        w.submit(_frame(1), seq=1, ts_ms=41)  # 第一次 infer 抛异常
        deadline = time.time() + 2.0
        while time.time() < deadline and not fake.calls:
            time.sleep(0.01)
        w.submit(_frame(2), seq=2, ts_ms=42)  # 线程必须存活并继续处理
        deadline = time.time() + 2.0
        while time.time() < deadline and not got:
            time.sleep(0.01)
        assert got == [(2, 42)]              # ts_ms 随帧透传到订阅者
        s = w.stats()
        assert s["errors"] >= 1
        assert s["processed"] == 1
    finally:
        w.stop()


def test_none_return_counts_skipped_without_delivery():
    fake = NonePipeline()
    w = ChannelWorker(pipeline=fake, name="t")
    got: list[tuple[int, int]] = []
    w.subscribe(lambda seq, ts_ms, jpeg: got.append((seq, ts_ms)))
    w.start()
    try:
        w.submit(_frame(1), seq=1, ts_ms=7)
        deadline = time.time() + 2.0
        while time.time() < deadline and w.stats()["skipped"] < 1:
            time.sleep(0.01)
        s = w.stats()
        assert s["skipped"] == 1
        assert s["processed"] == 0
        assert s["errors"] == 0
        assert s["last_infer_ms"] >= 10      # None 返回也要更新 last_infer_ms
        assert got == []                     # 无输出帧不做扇出
    finally:
        w.stop()
