"""频道 worker：常驻推理线程 + latest-wins 单槽队列 + 订阅者扇出。

设计约束（来自 M0 结论）：推理 0.5-0.7s/帧且底层 split predictor 串行，
排队旧帧只会放大延迟——slot 里永远只保留最新一帧，被覆盖即计 dropped。
submit() 收 JPEG bytes，解码（cv2.imdecode）在 worker 线程内、取槽之后进行：
被 latest-wins 覆盖的帧根本不解码，事件循环也不再为注定丢弃的帧付解码成本。
订阅者回调收到 (seq, ts_ms, jpeg_bytes)，ts_ms 为提交时随帧传入的采集时间戳
（epoch 毫秒），原样透传用于端到端延迟测量；回调在 worker 线程执行，必须非阻塞。
"""

import logging
import threading
import time
from typing import Callable, Optional

import cv2
import numpy as np

log = logging.getLogger("engine.worker")

Subscriber = Callable[[int, int, bytes], None]  # (seq, ts_ms, jpeg_bytes)


class ChannelWorker:
    """一次性生命周期：start/stop 各调一次，不可重启。submit() 收 JPEG bytes（不可变），无借用问题。"""

    def __init__(self, pipeline, name: str = "ch0", jpeg_quality: int = 80):
        self._pipeline = pipeline
        self._name = name
        self._quality = jpeg_quality
        self._slot: Optional[tuple[bytes, int, int]] = None  # (jpeg_bytes, seq, ts_ms)
        self._slot_lock = threading.Condition()
        self._subs: dict[int, Subscriber] = {}
        self._subs_lock = threading.Lock()
        self._next_sub_id = 0
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._stats = {"processed": 0, "dropped": 0, "skipped": 0, "errors": 0,
                       "last_infer_ms": 0.0}

    def start(self) -> None:
        self._thread = threading.Thread(target=self._loop, name=f"worker-{self._name}", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        with self._slot_lock:
            self._slot_lock.notify_all()
        if self._thread:
            self._thread.join(timeout=5)

    def submit(self, jpeg_bytes: bytes, seq: int, ts_ms: int) -> None:
        """提交一帧 JPEG bytes 待解码+推理。ts_ms 为该帧的采集时间戳（epoch 毫秒），随帧透传给订阅者。

        解码延后到 worker 线程取槽之后——被覆盖丢弃的帧完全不付解码成本。
        """
        with self._slot_lock:
            if self._slot is not None:
                self._stats["dropped"] += 1
            self._slot = (jpeg_bytes, seq, ts_ms)
            self._slot_lock.notify()

    def subscribe(self, cb: Subscriber) -> Callable[[], None]:
        with self._subs_lock:
            sid = self._next_sub_id
            self._next_sub_id += 1
            self._subs[sid] = cb

        def unsubscribe() -> None:
            with self._subs_lock:
                self._subs.pop(sid, None)

        return unsubscribe

    def stats(self) -> dict:
        return dict(self._stats)

    def _loop(self) -> None:
        while not self._stop.is_set():
            with self._slot_lock:
                while self._slot is None and not self._stop.is_set():
                    self._slot_lock.wait(timeout=0.1)
                if self._stop.is_set():
                    return
                jpeg, seq, ts_ms = self._slot
                self._slot = None
            try:
                frame = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
                if frame is None:
                    log.error("worker %s: jpeg decode failed on seq=%d (%d bytes)",
                              self._name, seq, len(jpeg))
                    self._stats["errors"] += 1
                    continue
                t0 = time.perf_counter()
                out_bgr = self._pipeline.infer(frame, seq)
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
