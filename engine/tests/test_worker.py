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


def _frame(v: int) -> np.ndarray:
    return np.full((8, 8, 3), v, np.uint8)


def test_latest_wins_drops_stale_frames():
    fake = FakePipeline(cost_s=0.05)
    w = ChannelWorker(pipeline=fake, name="t")
    w.start()
    try:
        for i in range(10):  # 提交快于消费，中间帧应被丢弃
            w.submit(_frame(i), seq=i)
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
    got: list[int] = []
    unsub = w.subscribe(lambda seq, jpeg: got.append(seq))
    w.start()
    try:
        w.submit(_frame(1), seq=1)
        deadline = time.time() + 2.0
        while time.time() < deadline and not got:
            time.sleep(0.01)
        assert got == [1]
        unsub()
        w.submit(_frame(2), seq=2)
        time.sleep(0.2)
        assert got == [1]                   # 退订后不再收到
    finally:
        w.stop()


def test_stats_report_processed_and_dropped():
    fake = FakePipeline(cost_s=0.05)
    w = ChannelWorker(pipeline=fake, name="t")
    w.start()
    try:
        for i in range(6):
            w.submit(_frame(i), seq=i)
        time.sleep(0.5)
        s = w.stats()
        assert s["processed"] >= 1
        assert s["processed"] + s["dropped"] == 6
        assert s["last_infer_ms"] >= 40
    finally:
        w.stop()
