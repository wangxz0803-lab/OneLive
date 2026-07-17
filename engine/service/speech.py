"""每信道语音口型调度器（M2b Task 2，纯逻辑）。

消费方：
- 渲染 worker 线程：每帧调用 ``lip_at(now)``（now = time.monotonic()）；
- asyncio 事件循环线程：TTSReadyEvent 到达时调用 ``enqueue()``。

线程安全：单把 ``threading.Lock`` 保护全部状态；锁内只有 O(1) 的
deque/算术操作，无任何阻塞调用，渲染线程不会被事件循环卡住。

溢出策略：队列有界（默认 16 段）。溢出时丢弃 *最老的排队* 片段
（正在播放的不受影响）并累计 ``dropped``——直播场景下用户更需要
听到 / 看到最近的话，积压的旧语音早已过时。
"""

from __future__ import annotations

import threading
from collections import deque
from dataclasses import dataclass

import numpy as np

__all__ = ["SpeechClip", "SpeechSchedule"]


@dataclass
class SpeechClip:
    """一段 TTS 语音对应的口型曲线。

    curve: float 数组，值域 0..1（每帧张嘴比例）；
    fps: 曲线采样帧率；duration_s: 音频实际时长。

    duration_s 与 len(curve)/fps 允许存在最多一帧（1/fps）的偏差：
    口型曲线由音频分帧产生，最后一个不完整帧可能被丢弃或补齐，
    因此二者天然差半帧到一帧；超过一帧即视为调用方传参错误。
    """

    segment_id: int
    lang: str
    curve: np.ndarray
    fps: float
    duration_s: float

    def __post_init__(self) -> None:
        self.curve = np.asarray(self.curve, dtype=np.float32)
        if self.curve.ndim != 1 or len(self.curve) == 0:
            raise ValueError("curve must be a non-empty 1-D array")
        if not np.all(np.isfinite(self.curve)):
            raise ValueError("curve contains NaN/inf")  # 上游特征 bug，拒收
        self.curve = np.clip(self.curve, 0.0, 1.0)  # 有限越界值 clip 进值域
        if not self.fps > 0:
            raise ValueError(f"fps must be > 0, got {self.fps}")
        if not self.duration_s > 0:
            raise ValueError(f"duration_s must be > 0, got {self.duration_s}")
        tol = 1.0 / self.fps + 1e-6  # 最多一帧偏差
        expected = len(self.curve) / self.fps
        if abs(self.duration_s - expected) > tol:
            raise ValueError(
                f"duration_s={self.duration_s:.4f} inconsistent with "
                f"len(curve)/fps={expected:.4f} (tolerance {tol:.4f})"
            )


@dataclass
class _Playing:
    clip: SpeechClip
    start: float  # monotonic 时间线上的起播时刻


class SpeechSchedule:
    """FIFO 口型片段调度器（单信道）。"""

    def __init__(self, maxlen: int = 16) -> None:
        if maxlen < 1:
            raise ValueError("maxlen must be >= 1")
        self._maxlen = maxlen
        self._lock = threading.Lock()
        self._queue: deque[SpeechClip] = deque()
        self._playing: _Playing | None = None
        self._played = 0
        self._dropped = 0

    # ------------------------------------------------------------- producers

    def enqueue(self, clip: SpeechClip) -> None:
        """入队一段口型曲线；溢出时丢最老的排队片段（不动正在播的）。"""
        with self._lock:
            if len(self._queue) >= self._maxlen:
                self._queue.popleft()
                self._dropped += 1
            self._queue.append(clip)

    def drop_all(self) -> None:
        """清空队列与当前播放（换语言 / 打断时用）；不计入 dropped。"""
        with self._lock:
            self._queue.clear()
            self._playing = None

    # ------------------------------------------------------------- consumers

    def lip_at(self, now: float) -> float | None:
        """返回 now 时刻的口型值（0..1），无内容时返回 None。

        now 必须来自同一单调时钟（渲染线程传 time.monotonic()）。
        空闲后的第一次调用会把当前片段的起点定为 now；片段播完则
        立刻切到下一个排队片段（新起点 = now）。
        """
        with self._lock:
            if self._playing is None:
                if not self._queue:
                    return None
                self._playing = _Playing(self._queue.popleft(), now)

            p = self._playing
            if now - p.start >= p.clip.duration_s:
                # 当前片段播完 → 前进
                self._played += 1
                if self._queue:
                    p = self._playing = _Playing(self._queue.popleft(), now)
                else:
                    self._playing = None
                    return None

            # +1e-6 帧：抵消浮点减法误差（如 (t0+0.04-t0)*25 = 0.99999…）
            idx = int((now - p.start) * p.clip.fps + 1e-6)
            idx = max(0, min(idx, len(p.clip.curve) - 1))  # clamp（时长内越界/时钟毛刺）
            return float(p.clip.curve[idx])

    def current(self) -> tuple[int, str] | None:
        """正在播放片段的 (segment_id, lang)；未在播放返回 None。"""
        with self._lock:
            if self._playing is None:
                return None
            return (self._playing.clip.segment_id, self._playing.clip.lang)

    def stats(self) -> dict[str, int]:
        with self._lock:
            return {
                "queued": len(self._queue),
                "played": self._played,
                "dropped": self._dropped,
            }
