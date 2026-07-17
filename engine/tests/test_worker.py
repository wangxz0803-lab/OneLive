import threading
import time

import cv2
import numpy as np
import pytest

from service.speech import SpeechClip, SpeechSchedule
from service.worker import ChannelWorker


class FakePipeline:
    """可控耗时的假管线：返回输入帧的副本并记录调用序号与输入形状。"""

    def __init__(self, cost_s: float = 0.0):
        self.cost_s = cost_s
        self.calls: list[int] = []
        self.shapes: list[tuple] = []

    def infer(self, frame_bgr: np.ndarray, seq: int, lip_ratio=None) -> np.ndarray:
        assert isinstance(frame_bgr, np.ndarray)  # worker 内解码后必须是 ndarray
        self.calls.append(seq)
        self.shapes.append(frame_bgr.shape)
        if self.cost_s:
            time.sleep(self.cost_s)
        return frame_bgr.copy()


class BlockingPipeline:
    """首帧 infer 阻塞在 gate 上，用于确定性验证单槽 latest-wins。"""

    def __init__(self):
        self.gate = threading.Event()
        self.started = threading.Event()
        self.calls: list[int] = []

    def infer(self, frame_bgr: np.ndarray, seq: int, lip_ratio=None) -> np.ndarray:
        self.calls.append(seq)
        self.started.set()
        self.gate.wait(timeout=5)
        return frame_bgr.copy()


class RaisingPipeline:
    """第一次 infer 抛异常，之后正常返回。"""

    def __init__(self):
        self.calls: list[int] = []

    def infer(self, frame_bgr: np.ndarray, seq: int, lip_ratio=None) -> np.ndarray:
        self.calls.append(seq)
        if len(self.calls) == 1:
            raise RuntimeError("boom")
        return frame_bgr.copy()


class NonePipeline:
    """总是返回 None（如无脸帧），带少量耗时以便断言 last_infer_ms。"""

    def __init__(self):
        self.calls: list[int] = []

    def infer(self, frame_bgr: np.ndarray, seq: int, lip_ratio=None):
        self.calls.append(seq)
        time.sleep(0.02)
        return None


def _jpeg(v: int) -> bytes:
    """编码一张 8x8 纯色小图为真实 JPEG bytes（worker 现在收 JPEG，解码在其线程内）。"""
    ok, jpg = cv2.imencode(".jpg", np.full((8, 8, 3), v, np.uint8))
    assert ok
    return jpg.tobytes()


def test_latest_wins_drops_stale_frames():
    fake = FakePipeline(cost_s=0.05)
    w = ChannelWorker(pipeline=fake, name="t")
    w.start()
    try:
        for i in range(10):  # 提交快于消费，中间帧应被丢弃
            w.submit(_jpeg(i), seq=i, ts_ms=1000 + i)
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
        w.submit(_jpeg(1), seq=1, ts_ms=1234)
        deadline = time.time() + 2.0
        while time.time() < deadline and not got:
            time.sleep(0.01)
        assert got == [(1, 1234)]           # 回调收到的 ts_ms 必须等于提交时的值
        assert fake.shapes == [(8, 8, 3)]   # JPEG → 解码 ndarray 的形状经 roundtrip 保持
        unsub()
        w.submit(_jpeg(2), seq=2, ts_ms=5678)
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
            w.submit(_jpeg(i), seq=i, ts_ms=2000 + i)
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
        w.submit(_jpeg(0), seq=0, ts_ms=3000)
        assert fake.started.wait(timeout=2)  # worker 已取走 frame 0 并阻塞在 infer 中
        for i in range(1, 10):               # 阻塞期间提交 1..9，槽内只留 9
            w.submit(_jpeg(i), seq=i, ts_ms=3000 + i)
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
        w.submit(_jpeg(1), seq=1, ts_ms=41)  # 第一次 infer 抛异常
        deadline = time.time() + 2.0
        while time.time() < deadline and not fake.calls:
            time.sleep(0.01)
        w.submit(_jpeg(2), seq=2, ts_ms=42)  # 线程必须存活并继续处理
        deadline = time.time() + 2.0
        while time.time() < deadline and not got:
            time.sleep(0.01)
        assert got == [(2, 42)]              # ts_ms 随帧透传到订阅者
        s = w.stats()
        assert s["errors"] >= 1
        assert s["processed"] == 1
    finally:
        w.stop()


def test_garbage_jpeg_counts_error_and_thread_survives():
    """解码失败（垃圾 bytes）计入 errors，不进 infer，线程存活并继续处理好帧。"""
    fake = FakePipeline()
    w = ChannelWorker(pipeline=fake, name="t")
    got: list[tuple[int, int]] = []
    w.subscribe(lambda seq, ts_ms, jpeg: got.append((seq, ts_ms)))
    w.start()
    try:
        w.submit(b"not a jpeg at all", seq=1, ts_ms=10)
        deadline = time.time() + 2.0
        while time.time() < deadline and w.stats()["errors"] < 1:
            time.sleep(0.01)
        assert w.stats()["errors"] == 1
        assert fake.calls == []              # 解码失败的帧不得进入 infer
        w.submit(_jpeg(2), seq=2, ts_ms=20)  # 下一好帧必须正常处理
        deadline = time.time() + 2.0
        while time.time() < deadline and not got:
            time.sleep(0.01)
        assert got == [(2, 20)]
        assert w.stats()["processed"] == 1
    finally:
        w.stop()


class OrderedPipeline:
    """记录 infer 事件顺序与线程 id；首帧阻塞在 gate 上以便在推理中途投递命令。"""

    def __init__(self):
        self.gate = threading.Event()
        self.started = threading.Event()
        self.events: list[tuple] = []

    def infer(self, frame_bgr: np.ndarray, seq: int, lip_ratio=None) -> np.ndarray:
        self.events.append(("frame", seq, threading.get_ident()))
        self.started.set()
        self.gate.wait(timeout=5)
        return frame_bgr.copy()


def _wait_until(cond, timeout: float = 2.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if cond():
            return True
        time.sleep(0.01)
    return cond()


def test_post_command_executes_between_frames_on_worker_thread():
    """命令在 worker 推理线程执行、fn 收到 pipeline 对象、且排在两帧之间
    （每轮取帧前先清空命令队列）。"""
    fake = OrderedPipeline()
    w = ChannelWorker(pipeline=fake, name="t")
    w.start()
    try:
        w.submit(_jpeg(0), seq=0, ts_ms=1)
        assert fake.started.wait(timeout=2)   # worker 阻塞在 frame 0 的 infer 中
        w.post_command(lambda p: p.events.append(("cmd", None, threading.get_ident())))
        w.submit(_jpeg(1), seq=1, ts_ms=2)    # 阻塞期间投递：命令必须先于 frame 1
        fake.gate.set()
        assert _wait_until(lambda: len(fake.events) == 3)
        kinds = [(k, s) for k, s, _ in fake.events]
        assert kinds == [("frame", 0), ("cmd", None), ("frame", 1)]
        tids = {t for _, _, t in fake.events}
        assert len(tids) == 1                 # 命令与推理同一 worker 线程（串行契约）
    finally:
        w.stop()


def test_post_command_runs_without_frames():
    """无帧流动时命令也要被执行（casting 可发生在开播前）；on_done(None) 表示成功，
    且在 worker 线程回调。"""
    fake = FakePipeline()
    w = ChannelWorker(pipeline=fake, name="t")
    w.start()
    try:
        ran: list[tuple] = []
        done: list = []
        w.post_command(lambda p: ran.append((p, threading.get_ident())),
                       on_done=lambda exc: done.append((exc, threading.get_ident())))
        assert _wait_until(lambda: len(done) == 1)
        assert ran[0][0] is fake              # fn 收到的就是构造时传入的 pipeline
        assert done[0][0] is None             # 成功 → on_done(None)
        assert ran[0][1] == done[0][1]        # on_done 也在 worker 线程回调
        assert ran[0][1] != threading.get_ident()
        assert w.stats()["errors"] == 0
    finally:
        w.stop()


def test_post_command_exception_counts_error_and_worker_survives():
    """命令抛异常：errors++、on_done 收到该异常、线程存活并继续处理后续帧。"""
    def boom(_p):
        raise RuntimeError("cast boom")

    fake = FakePipeline()
    w = ChannelWorker(pipeline=fake, name="t")
    got: list[tuple[int, int]] = []
    w.subscribe(lambda seq, ts_ms, jpeg: got.append((seq, ts_ms)))
    w.start()
    try:
        done: list = []
        w.post_command(boom, on_done=done.append)
        assert _wait_until(lambda: len(done) == 1)
        assert isinstance(done[0], RuntimeError)
        assert str(done[0]) == "cast boom"
        assert w.stats()["errors"] == 1
        w.submit(_jpeg(2), seq=2, ts_ms=20)   # 命令炸了不影响帧路径
        assert _wait_until(lambda: got == [(2, 20)])
        assert w.stats()["processed"] == 1
    finally:
        w.stop()


def test_stop_drains_pending_commands_with_runtime_error():
    """stop() 后仍未执行的命令不得静默消失：on_done 收 RuntimeError("worker stopped")。

    构造：worker 阻塞在 frame 0 的 infer 里 → 投递命令（进队列但不执行）→
    stop()（先置 _stop 再等线程退出）→ 0.2s 后放行 infer，线程回到循环头
    发现 _stop 直接退出（不再清命令队列）→ stop() 的 drain 必须通知该命令。"""
    fake = BlockingPipeline()
    w = ChannelWorker(pipeline=fake, name="t")
    w.start()
    ran: list = []
    done: list = []
    w.submit(_jpeg(0), seq=0, ts_ms=1)
    assert fake.started.wait(timeout=2)   # worker 已阻塞在 infer 中
    w.post_command(lambda p: ran.append(p), on_done=done.append)
    t = threading.Timer(0.2, fake.gate.set)  # stop() 置位后再放行 infer
    t.start()
    try:
        w.stop()
    finally:
        t.cancel()
        fake.gate.set()
    assert ran == []                      # 命令从未执行
    assert len(done) == 1
    assert isinstance(done[0], RuntimeError)
    assert str(done[0]) == "worker stopped"


def test_post_command_overflow_rejects_ninth_with_runtime_error():
    """队列有界（8）：第 1 条命令阻塞执行中，再投 8 条填满队列，第 9 条
    立即（调用方线程）收 RuntimeError("command queue full")；放行后已受理
    的 8 条全部执行并 on_done(None)——溢出拒绝不影响已受理命令。"""
    fake = FakePipeline()
    w = ChannelWorker(pipeline=fake, name="t")
    w.start()
    gate = threading.Event()
    executing = threading.Event()

    def blocker(_p):
        executing.set()
        gate.wait(timeout=5)

    accepted_done: list = []
    rejected_done: list = []
    try:
        w.post_command(blocker)
        assert executing.wait(timeout=2)  # 第 1 条已出队、阻塞执行中
        for _ in range(8):                # 填满 8 槽队列
            w.post_command(lambda p: None, on_done=accepted_done.append)
        w.post_command(lambda p: None, on_done=rejected_done.append)  # 第 9 条
        assert len(rejected_done) == 1    # 同步拒绝（调用方线程立即回调）
        assert isinstance(rejected_done[0], RuntimeError)
        assert str(rejected_done[0]) == "command queue full"
        gate.set()
        assert _wait_until(lambda: len(accepted_done) == 8)
        assert all(exc is None for exc in accepted_done)
    finally:
        gate.set()
        w.stop()


def test_none_return_counts_skipped_without_delivery():
    fake = NonePipeline()
    w = ChannelWorker(pipeline=fake, name="t")
    got: list[tuple[int, int]] = []
    w.subscribe(lambda seq, ts_ms, jpeg: got.append((seq, ts_ms)))
    w.start()
    try:
        w.submit(_jpeg(1), seq=1, ts_ms=7)
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


# ------------------------------------------------------------ speech/lip (M2b)


class LipRecordingPipeline:
    """记录每次 infer 收到的 lip_ratio（管线协议：infer(frame, seq, lip_ratio=None)）。"""

    def __init__(self):
        self.lips: list = []

    def infer(self, frame_bgr: np.ndarray, seq: int, lip_ratio=None) -> np.ndarray:
        self.lips.append(lip_ratio)
        return frame_bgr.copy()


def test_worker_passes_speech_lip_to_pipeline():
    """注入假时钟（确定性）：worker 每帧用 clock() 查 speech.lip_at，
    把曲线值原样以 lip_ratio kwarg 传给管线；片段播完传 None。"""
    fake = LipRecordingPipeline()
    now = [100.0]
    w = ChannelWorker(pipeline=fake, name="t", clock=lambda: now[0])
    w.speech.enqueue(SpeechClip(
        segment_id=1, lang="en",
        curve=np.array([0.2, 0.4, 0.6, 0.8], dtype=np.float32),
        fps=25.0, duration_s=0.16,
    ))
    w.start()
    try:
        for i, t_off in enumerate([0.0, 0.04, 0.08, 0.12]):
            now[0] = 100.0 + t_off
            w.submit(_jpeg(i), seq=i, ts_ms=i)
            assert _wait_until(lambda: len(fake.lips) == i + 1)
        assert fake.lips == pytest.approx([0.2, 0.4, 0.6, 0.8])
        now[0] = 105.0                        # 远超 duration → 片段播完
        w.submit(_jpeg(9), seq=9, ts_ms=9)
        assert _wait_until(lambda: len(fake.lips) == 5)
        assert fake.lips[-1] is None
        assert w.speech.stats()["played"] == 1
    finally:
        w.stop()


def test_stats_include_speech_block():
    """worker.stats() 带 speech 块（调度器 queued/played/dropped），供 /status 透出。"""
    w = ChannelWorker(pipeline=FakePipeline(), name="t")
    s = w.stats()
    assert s["speech"] == {"queued": 0, "played": 0, "dropped": 0}
    w.speech.enqueue(SpeechClip(segment_id=1, lang="en",
                                curve=np.array([0.5], np.float32),
                                fps=25.0, duration_s=0.04))
    assert w.stats()["speech"]["queued"] == 1


def test_worker_empty_schedule_passes_none():
    """无语音内容时每帧 lip_ratio=None（管线走原样 legacy 路径）；
    worker 默认自带一个 SpeechSchedule。"""
    fake = LipRecordingPipeline()
    w = ChannelWorker(pipeline=fake, name="t")
    assert isinstance(w.speech, SpeechSchedule)
    w.start()
    try:
        w.submit(_jpeg(0), seq=0, ts_ms=0)
        assert _wait_until(lambda: len(fake.lips) == 1)
        assert fake.lips == [None]
    finally:
        w.stop()
