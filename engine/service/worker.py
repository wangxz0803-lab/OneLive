"""频道 worker：常驻推理线程 + latest-wins 单槽队列 + 订阅者扇出。

设计约束（来自 M0 结论）：推理 0.5-0.7s/帧且底层 split predictor 串行，
排队旧帧只会放大延迟——slot 里永远只保留最新一帧，被覆盖即计 dropped。
订阅者回调收到 (seq, jpeg_bytes)；回调在 worker 线程执行，必须非阻塞。
"""

import threading
import time
from typing import Callable, Optional

import cv2
import numpy as np

Subscriber = Callable[[int, bytes], None]


class ChannelWorker:
    def __init__(self, pipeline, name: str = "ch0", jpeg_quality: int = 80):
        self._pipeline = pipeline
        self._name = name
        self._quality = jpeg_quality
        self._slot: Optional[tuple[np.ndarray, int]] = None
        self._slot_lock = threading.Condition()
        self._subs: dict[int, Subscriber] = {}
        self._subs_lock = threading.Lock()
        self._next_sub_id = 0
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._stats = {"processed": 0, "dropped": 0, "last_infer_ms": 0.0}

    def start(self) -> None:
        self._thread = threading.Thread(target=self._loop, name=f"worker-{self._name}", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        with self._slot_lock:
            self._slot_lock.notify_all()
        if self._thread:
            self._thread.join(timeout=5)

    def submit(self, frame_bgr: np.ndarray, seq: int) -> None:
        with self._slot_lock:
            if self._slot is not None:
                self._stats["dropped"] += 1
            self._slot = (frame_bgr, seq)
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
                frame, seq = self._slot
                self._slot = None
            t0 = time.perf_counter()
            out_bgr = self._pipeline.infer(frame, seq)
            self._stats["last_infer_ms"] = (time.perf_counter() - t0) * 1000
            if out_bgr is None:  # 管线可返回 None 表示本帧无输出（如无脸）
                continue
            self._stats["processed"] += 1
            ok, jpg = cv2.imencode(".jpg", out_bgr, [cv2.IMWRITE_JPEG_QUALITY, self._quality])
            if not ok:
                continue
            payload = jpg.tobytes()
            with self._subs_lock:
                subs = list(self._subs.values())
            for cb in subs:
                cb(seq, payload)
