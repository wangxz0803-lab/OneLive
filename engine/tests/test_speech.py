"""SpeechSchedule 纯逻辑测试（M2b Task 2）。

不依赖任何 service 运行时（无 app/worker 导入），时间全部显式传入
lip_at(now)，只有跨线程 smoke 用真实时钟。
"""

import threading
import time

import numpy as np
import pytest

from service.speech import SpeechClip, SpeechSchedule


def make_clip(segment_id: int, lang: str = "en", curve=None, fps: float = 25.0):
    if curve is None:
        curve = np.array([0.0, 0.5, 1.0, 0.25], dtype=np.float32)
    curve = np.asarray(curve, dtype=np.float32)
    return SpeechClip(
        segment_id=segment_id,
        lang=lang,
        curve=curve,
        fps=fps,
        duration_s=len(curve) / fps,
    )


# ---------------------------------------------------------------- validation


def test_clip_validation():
    with pytest.raises(ValueError):
        SpeechClip(segment_id=1, lang="en", curve=np.array([]), fps=25.0, duration_s=0.0)
    with pytest.raises(ValueError):
        SpeechClip(segment_id=1, lang="en", curve=np.array([0.5]), fps=0.0, duration_s=0.04)
    with pytest.raises(ValueError):
        # duration 与 len(curve)/fps 相差远超一帧 → 不一致
        SpeechClip(segment_id=1, lang="en", curve=np.array([0.5, 0.5]), fps=25.0, duration_s=5.0)


def test_clip_rejects_nonfinite_and_clips_range():
    """NaN/inf 直接拒绝（上游特征提取 bug 不能悄悄进渲染）；
    有限但越界的值 clip 到 [0,1]（半开半闭噪声不至于炸掉整段）。"""
    with pytest.raises(ValueError):
        SpeechClip(segment_id=1, lang="en", curve=np.array([0.5, np.nan]),
                   fps=25.0, duration_s=0.08)
    with pytest.raises(ValueError):
        SpeechClip(segment_id=1, lang="en", curve=np.array([np.inf, 0.5]),
                   fps=25.0, duration_s=0.08)
    c = SpeechClip(segment_id=1, lang="en", curve=np.array([-0.5, 1.5]),
                   fps=25.0, duration_s=0.08)
    assert c.curve.tolist() == [0.0, 1.0]


# ------------------------------------------------------------------ timeline


def test_timeline_indexing():
    sched = SpeechSchedule()
    sched.enqueue(make_clip(1))  # fps=25, curve [0, .5, 1, .25], dur=0.16
    t0 = 1000.0
    assert sched.lip_at(t0) == pytest.approx(0.0)
    assert sched.lip_at(t0 + 0.04) == pytest.approx(0.5)
    assert sched.lip_at(t0 + 0.08) == pytest.approx(1.0)
    # 仍在时长内但索引越界 → clamp 到最后一帧
    assert sched.lip_at(t0 + 0.159) == pytest.approx(0.25)
    assert sched.current() == (1, "en")


def test_clamp_when_duration_exceeds_curve():
    # duration_s 比 len/fps 略长（一帧容差内），末尾索引 clamp 到最后一帧
    clip = SpeechClip(
        segment_id=7, lang="ja",
        curve=np.array([0.1, 0.2, 0.3, 0.9], dtype=np.float32),
        fps=25.0, duration_s=0.19,
    )
    sched = SpeechSchedule()
    sched.enqueue(clip)
    t0 = 50.0
    assert sched.lip_at(t0) == pytest.approx(0.1)
    # idx = int(0.17*25) = 4 → clamp 3
    assert sched.lip_at(t0 + 0.17) == pytest.approx(0.9)


def test_past_end_advances_or_none():
    sched = SpeechSchedule()
    sched.enqueue(make_clip(1))
    t0 = 10.0
    assert sched.lip_at(t0) == pytest.approx(0.0)
    # 超过 duration 且队列为空 → None，current 清空，played+1
    assert sched.lip_at(t0 + 1.0) is None
    assert sched.current() is None
    assert sched.stats()["played"] == 1


# ------------------------------------------------------- FIFO / auto-advance


def test_fifo_order_and_auto_advance():
    sched = SpeechSchedule()
    c1 = make_clip(1, "en")
    c2 = make_clip(2, "ja", curve=[0.7, 0.8])
    sched.enqueue(c1)
    sched.enqueue(c2)
    t0 = 0.0
    assert sched.lip_at(t0) == pytest.approx(0.0)
    assert sched.current() == (1, "en")
    # clip1 结束后自动切到 clip2，且 clip2 从第 0 帧、以 now 为新起点开始
    t1 = t0 + 0.5
    assert sched.lip_at(t1) == pytest.approx(0.7)
    assert sched.current() == (2, "ja")
    assert sched.lip_at(t1 + 0.04) == pytest.approx(0.8)
    # 全部播完 → None，played==2
    assert sched.lip_at(t1 + 5.0) is None
    assert sched.stats()["played"] == 2


def test_empty_returns_none():
    sched = SpeechSchedule()
    assert sched.lip_at(123.0) is None
    assert sched.current() is None
    assert sched.stats() == {"queued": 0, "played": 0, "dropped": 0}


# ------------------------------------------------------------------ overflow


def test_overflow_drops_oldest():
    sched = SpeechSchedule(maxlen=16)
    for i in range(17):
        sched.enqueue(make_clip(i))
    st = sched.stats()
    assert st["queued"] == 16
    assert st["dropped"] == 1
    # 最老的 segment 0 被丢弃，下一个播放的是 segment 1
    sched.lip_at(0.0)
    assert sched.current() == (1, "en")
    # 最新的 segment 16 仍保留在队尾
    sched.drop_all()
    sched2 = SpeechSchedule(maxlen=2)
    sched2.enqueue(make_clip(100))
    sched2.enqueue(make_clip(101))
    sched2.enqueue(make_clip(102))
    sched2.lip_at(0.0)
    assert sched2.current() == (101, "en")


def test_overflow_never_drops_current():
    sched = SpeechSchedule(maxlen=2)
    sched.enqueue(make_clip(1))
    sched.lip_at(0.0)  # segment 1 正在播放，已出队
    for i in range(2, 6):
        sched.enqueue(make_clip(i))
    assert sched.current() == (1, "en")  # 播放中的不受溢出影响


# ------------------------------------------------------------------ drop_all


def test_drop_all_mid_play():
    sched = SpeechSchedule()
    sched.enqueue(make_clip(1))
    sched.enqueue(make_clip(2))
    assert sched.lip_at(0.0) == pytest.approx(0.0)
    sched.drop_all()
    assert sched.current() is None
    assert sched.lip_at(0.04) is None
    assert sched.stats()["queued"] == 0


# ------------------------------------------------------- cross-thread smoke


def test_cross_thread_smoke():
    """渲染线程 poll lip_at(monotonic)，主线程 enqueue，短时确定性收敛。"""
    sched = SpeechSchedule()
    n_clips = 5
    stop = threading.Event()
    errors = []

    def render_loop():
        try:
            while not stop.is_set():
                v = sched.lip_at(time.monotonic())
                if v is not None:
                    assert 0.0 <= v <= 1.0
                time.sleep(0.001)
        except Exception as exc:  # pragma: no cover
            errors.append(exc)

    t = threading.Thread(target=render_loop, daemon=True)
    t.start()
    for i in range(n_clips):
        # 5 帧 @1000fps → 每段 5ms
        sched.enqueue(make_clip(i, curve=[0.1, 0.2, 0.3, 0.4, 0.5], fps=1000.0))
        time.sleep(0.002)

    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        if sched.stats()["played"] == n_clips:
            break
        time.sleep(0.005)
    stop.set()
    t.join(timeout=1.0)

    assert not errors
    assert sched.stats()["played"] == n_clips
    assert sched.lip_at(time.monotonic()) is None
