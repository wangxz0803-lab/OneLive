"""频道 worker：常驻推理线程 + latest-wins 单槽队列 + 订阅者扇出。

设计约束（来自 M0 结论）：推理 0.5-0.7s/帧且底层 split predictor 串行，
排队旧帧只会放大延迟——slot 里永远只保留最新一帧，被覆盖即计 dropped。
submit() 收 JPEG bytes，解码（cv2.imdecode）在 worker 线程内、取槽之后进行：
被 latest-wins 覆盖的帧根本不解码，事件循环也不再为注定丢弃的帧付解码成本。
订阅者回调收到 (seq, ts_ms, jpeg_bytes)，ts_ms 为提交时随帧传入的采集时间戳
（epoch 毫秒），原样透传用于端到端延迟测量；回调在 worker 线程执行，必须非阻塞。

管线协议（M2b 起）：``infer(frame_bgr, seq, lip_ratio=None) -> ndarray | None``。
worker 每帧渲染前用 ``clock()``（默认 time.monotonic）查询 ``self.speech``
（SpeechSchedule）的当前口型值 0..1，以 ``lip_ratio`` kwarg 传给管线；
无语音内容时传 None（管线走原样 legacy 路径）。
"""

import logging
import threading
import time
from collections import deque
from typing import Callable, Optional

import cv2
import numpy as np

from service.speech import SpeechSchedule

log = logging.getLogger("engine.worker")

Subscriber = Callable[[int, int, bytes], None]  # (seq, ts_ms, jpeg_bytes)


class ChannelWorker:
    """一次性生命周期：start/stop 各调一次，不可重启。submit() 收 JPEG bytes（不可变），无借用问题。"""

    def __init__(self, pipeline, name: str = "ch0", jpeg_quality: int = 80,
                 speech: Optional[SpeechSchedule] = None,
                 clock: Callable[[], float] = time.monotonic):
        self._pipeline = pipeline
        self._name = name
        self._quality = jpeg_quality
        # 每个 worker 自带口型调度器（TTS 侧 enqueue，渲染循环消费）；
        # clock 可注入以便测试确定性驱动时间线。
        self.speech = speech if speech is not None else SpeechSchedule()
        self._clock = clock
        self._slot: Optional[tuple[bytes, int, int]] = None  # (jpeg_bytes, seq, ts_ms)
        self._slot_lock = threading.Condition()
        self._subs: dict[int, Subscriber] = {}
        self._subs_lock = threading.Lock()
        self._next_sub_id = 0
        self._stop = threading.Event()
        # 命令队列（casting 等控制操作）：与帧槽分离——命令不能 latest-wins 覆盖
        # （每条都要执行且 on_done 都要回），用小有界 deque；溢出即拒绝（回调收
        # RuntimeError），绝不静默丢弃已受理的命令。
        self._cmds: deque[tuple[Callable[[object], None], Optional[Callable]]] = deque()
        self._cmds_max = 8
        self._thread: Optional[threading.Thread] = None
        self._stats = {"processed": 0, "dropped": 0, "skipped": 0, "errors": 0,
                       "last_infer_ms": 0.0}

    def start(self) -> None:
        self._thread = threading.Thread(target=self._loop, name=f"worker-{self._name}", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """停线程并 drain 未执行命令：每条 on_done 收 RuntimeError("worker stopped")
        ——已受理的命令绝不静默消失（与溢出拒绝同一契约）。"""
        self._stop.set()
        with self._slot_lock:
            self._slot_lock.notify_all()
        if self._thread:
            self._thread.join(timeout=5)
        with self._slot_lock:
            pending = list(self._cmds)
            self._cmds.clear()
        for _fn, on_done in pending:  # 锁外回调，与 _run_pending_commands 同模式
            if on_done is not None:
                try:
                    on_done(RuntimeError("worker stopped"))
                except Exception:
                    log.exception("worker %s: on_done failed during stop drain", self._name)

    def submit(self, jpeg_bytes: bytes, seq: int, ts_ms: int) -> None:
        """提交一帧 JPEG bytes 待解码+推理。ts_ms 为该帧的采集时间戳（epoch 毫秒），随帧透传给订阅者。

        解码延后到 worker 线程取槽之后——被覆盖丢弃的帧完全不付解码成本。
        """
        with self._slot_lock:
            if self._slot is not None:
                self._stats["dropped"] += 1
            self._slot = (jpeg_bytes, seq, ts_ms)
            self._slot_lock.notify()

    def post_command(self, fn: Callable[[object], None],
                     on_done: Optional[Callable[[Optional[BaseException]], None]] = None) -> None:
        """投递一条在 worker 推理线程上执行的命令 fn(pipeline)。

        执行时机：_loop 每轮取帧之前清空全部积压命令（槽锁之外执行）——与 infer
        天然串行，pipeline 状态操作（如 set_source 的 prepare+快照）无需自带锁。
        fn 抛异常：log + errors++，异常经 on_done 转交调用方。
        on_done(exc_or_none)（若给出）在【worker 线程】回调——成功传 None，失败传
        异常对象；回调方要回事件循环必须自己 call_soon_threadsafe。
        队列有界（8）：溢出即拒绝，on_done 立即（在调用方线程）收 RuntimeError。
        stop() 后仍在队列里的命令同样以 on_done(RuntimeError("worker stopped"))
        通知——任何已受理命令都不会静默消失。
        """
        with self._slot_lock:
            if len(self._cmds) < self._cmds_max:
                self._cmds.append((fn, on_done))
                self._slot_lock.notify()
                return
        # 溢出拒绝：回调在锁外 + try/except，与 _run_pending_commands 同模式
        log.error("worker %s: command queue full (%d), command rejected",
                  self._name, self._cmds_max)
        if on_done is not None:
            try:
                on_done(RuntimeError("command queue full"))
            except Exception:
                log.exception("worker %s: on_done failed on overflow reject", self._name)

    def subscribe(self, cb: Subscriber) -> Callable[[], None]:
        with self._subs_lock:
            sid = self._next_sub_id
            self._next_sub_id += 1
            self._subs[sid] = cb

        def unsubscribe() -> None:
            with self._subs_lock:
                self._subs.pop(sid, None)

        return unsubscribe

    def subscriber_count(self) -> int:
        with self._subs_lock:
            return len(self._subs)

    def stats(self) -> dict:
        # "speech" 块来自口型调度器（queued/played/dropped）——/status 借此
        # 每频道透出语音播报进度；speech 可被测试替换，约定必须实现 stats()。
        s = dict(self._stats)
        s["speech"] = self.speech.stats()
        return s

    def _run_pending_commands(self) -> None:
        """清空积压命令。逐条在锁外执行——命令（如 prepare_source ~1-2s）不能
        占着槽锁把 submit()/post_command() 卡死。"""
        while True:
            with self._slot_lock:
                if not self._cmds:
                    return
                fn, on_done = self._cmds.popleft()
            exc: Optional[BaseException] = None
            try:
                fn(self._pipeline)
            except Exception as e:
                log.exception("worker %s: command failed", self._name)
                self._stats["errors"] += 1
                exc = e
            if on_done is not None:
                try:
                    on_done(exc)  # worker 线程回调（契约见 post_command docstring）
                except Exception:
                    log.exception("worker %s: command on_done callback failed", self._name)

    def _loop(self) -> None:
        while not self._stop.is_set():
            self._run_pending_commands()  # 每轮取帧前先清空命令（casting 不等下一帧）
            with self._slot_lock:
                while self._slot is None and not self._cmds and not self._stop.is_set():
                    self._slot_lock.wait(timeout=0.1)
                if self._stop.is_set():
                    return
                if self._slot is None:
                    continue  # 被命令唤醒：回到循环头执行命令
                jpeg, seq, ts_ms = self._slot
                self._slot = None
            try:
                frame = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
                if frame is None:
                    log.error("worker %s: jpeg decode failed on seq=%d (%d bytes)",
                              self._name, seq, len(jpeg))
                    self._stats["errors"] += 1
                    continue
                lip = self.speech.lip_at(self._clock())  # 无语音 → None
                if lip is not None:
                    # 语音期观测锚点（也是 E2E 的机制证据）：本帧确实带非 None
                    # 口型值进了管线。仅说话期间有帧率约束（本地 ~1.9fps），
                    # INFO 量级无害；空闲期零输出。
                    log.info("worker %s: speech lip=%.3f on seq=%d", self._name, lip, seq)
                t0 = time.perf_counter()
                out_bgr = self._pipeline.infer(frame, seq, lip_ratio=lip)
                self._stats["last_infer_ms"] = (time.perf_counter() - t0) * 1000
                if out_bgr is None:  # 管线返回 None 表示本帧无输出（如无脸）
                    self._stats["skipped"] += 1
                    continue
                ok, jpg = cv2.imencode(".jpg", out_bgr, [cv2.IMWRITE_JPEG_QUALITY, self._quality])
                if not ok:
                    log.error("worker %s: jpeg encode failed on seq=%d", self._name, seq)
                    self._stats["errors"] += 1
                    continue
                payload = jpg.tobytes()
            except Exception:
                log.exception("worker %s: decode/pipeline/encode failed on seq=%d", self._name, seq)
                self._stats["errors"] += 1
                continue
            self._stats["processed"] += 1
            with self._subs_lock:
                subs = list(self._subs.values())
            for cb in subs:
                try:
                    cb(seq, ts_ms, payload)
                except Exception:
                    log.exception("worker %s: subscriber callback failed on seq=%d", self._name, seq)
                    self._stats["errors"] += 1
