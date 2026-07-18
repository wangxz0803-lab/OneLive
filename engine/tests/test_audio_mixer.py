"""AudioMixer 测试：纯 _next_chunk 拼装序列（确定性）+ 短时长真实节拍循环。

节拍测试用 chunk_ms=10、约 10 块、宽松时间断言，总时长 <2s。
"""

import asyncio
import struct
import time

import pytest

from service.audio_mixer import AudioMixer


@pytest.fixture
def anyio_backend():
    return "asyncio"


def pcm(n_samples: int, start: int = 0) -> bytes:
    """确定性可辨识 pcm16：小端 int16 递增序列。"""
    return b"".join(struct.pack("<h", (start + i) % 30000) for i in range(n_samples))


# ---------------------------------------------------------- _next_chunk 纯逻辑
# sr=1000, chunk_ms=100 → 每块 100 样本 = 200 字节


def test_next_chunk_silence_is_exact_zeros():
    m = AudioMixer(sr=1000, chunk_ms=100)
    chunk = m._next_chunk()
    assert chunk == b"\x00" * 200
    assert m._next_chunk() == b"\x00" * 200  # 持续空闲持续静音


def test_next_chunk_speech_slices_in_order_with_padded_tail():
    m = AudioMixer(sr=1000, chunk_ms=100)
    data = pcm(250)  # 500 字节 = 2.5 块
    m.splice(data, segment_id=1)
    assert m._next_chunk() == data[0:200]
    assert m._next_chunk() == data[200:400]
    # 尾块：先语音后补零，字节级精确
    assert m._next_chunk() == data[400:500] + b"\x00" * 100
    assert m._next_chunk() == b"\x00" * 200  # 播完回到静音


def test_next_chunk_two_splices_fifo_seamless():
    m = AudioMixer(sr=1000, chunk_ms=100)
    a = pcm(150)
    b = pcm(120, start=10000)
    m.splice(a, segment_id=1)
    m.splice(b, segment_id=2)
    joined = a + b  # 540 字节：跨段无缝衔接，FIFO 顺序
    assert m._next_chunk() == joined[0:200]
    assert m._next_chunk() == joined[200:400]
    assert m._next_chunk() == joined[400:540] + b"\x00" * 60


def test_splice_overflow_drops_oldest_queued():
    # 上限 0.5s = 500 样本 = 1000 字节
    m = AudioMixer(sr=1000, chunk_ms=100, max_queued_s=0.5)
    a = pcm(300)
    b = pcm(300, start=10000)
    m.splice(a, segment_id=1)
    m.splice(b, segment_id=2)  # 300+300 > 500 → 丢最老的 a
    s = m.stats()
    assert s["dropped_speech"] == 1
    assert s["queued_speech_s"] == pytest.approx(0.3)
    assert m._next_chunk() == b[0:200]  # 剩下的是新段 b


def test_splice_overflow_never_cuts_partially_played_head():
    m = AudioMixer(sr=1000, chunk_ms=100, max_queued_s=0.5)
    a = pcm(400)
    m.splice(a, segment_id=1)
    m._next_chunk()  # 消费 a 的前 100 样本 → 头段"正在播"
    b = pcm(400, start=10000)
    m.splice(b, segment_id=2)  # 超限但唯一可丢的是正在播的头段 → 不丢，超额接收
    assert m.stats()["dropped_speech"] == 0
    assert m._next_chunk() == a[200:400]  # 头段继续不中断


def test_stats_pure_accounting():
    m = AudioMixer(sr=1000, chunk_ms=100)
    assert m.stats() == {
        "chunks_emitted": 0,
        "spliced_segments": 0,
        "dropped_speech": 0,
        "queued_speech_s": 0.0,
    }
    m.splice(pcm(250), segment_id=1)
    s = m.stats()
    assert s["spliced_segments"] == 1
    assert s["queued_speech_s"] == pytest.approx(0.25)
    m._next_chunk()  # 消费 100 样本
    assert m.stats()["queued_speech_s"] == pytest.approx(0.15)


def test_splice_rejects_odd_length():
    m = AudioMixer(sr=1000, chunk_ms=100)
    with pytest.raises(ValueError):
        m.splice(b"\x01\x02\x03", segment_id=1)


# ---------------------------------------------------------------- 节拍循环


@pytest.mark.anyio
async def test_paced_loop_realtime_rate_and_sentinel_on_stop():
    m = AudioMixer(sr=1000, chunk_ms=10)  # 每块 20 字节
    queue, unsubscribe = m.subscribe()
    await m.start()
    try:
        t0 = time.monotonic()
        chunks = [await asyncio.wait_for(queue.get(), 1.0) for _ in range(10)]
        elapsed = time.monotonic() - t0
    finally:
        await m.stop()
    assert all(c == b"\x00" * 20 for c in chunks)
    # 10 块 ≈ 90ms 节拍；宽松上下界（Windows 定时器粒度 ~15ms）
    assert 0.05 < elapsed < 1.0, f"pacing off: {elapsed:.3f}s for 10 chunks"
    # stop() 后订阅者必收 None 哨兵
    while True:
        item = await asyncio.wait_for(queue.get(), 1.0)
        if item is None:
            break
        assert isinstance(item, bytes)
    unsubscribe()


@pytest.mark.anyio
async def test_running_loop_delivers_spliced_pcm():
    """节拍循环运行中 splice：订阅者收到的字节流里完整连续地出现语音段
    （语音从块边界开始、跨块无缝拼接），内容级确定性。"""
    m = AudioMixer(sr=1000, chunk_ms=10)  # 每块 20 字节
    queue, unsubscribe = m.subscribe()
    await m.start()
    data = pcm(50, start=20000)  # 100 字节 = 恰 5 块
    got = b""
    try:
        m.splice(data, segment_id=1)
        for _ in range(60):
            item = await asyncio.wait_for(queue.get(), 1.0)
            got += item
            if data in got:
                break
    finally:
        await m.stop()
    unsubscribe()
    assert data in got


@pytest.mark.anyio
async def test_unsubscribe_stops_delivery():
    m = AudioMixer(sr=1000, chunk_ms=10)
    queue, unsubscribe = m.subscribe()
    await m.start()
    try:
        await asyncio.wait_for(queue.get(), 1.0)  # 投递已开始
        unsubscribe()
        while not queue.empty():  # 清掉退订前已入队的块
            queue.get_nowait()
        base = m.stats()["chunks_emitted"]
        deadline = time.monotonic() + 1.5
        while m.stats()["chunks_emitted"] < base + 3 and time.monotonic() < deadline:
            await asyncio.sleep(0.01)
        assert m.stats()["chunks_emitted"] >= base + 3  # 节拍仍在跑
        assert queue.empty()  # 但退订后不再投递
    finally:
        await m.stop()
    assert queue.empty()  # stop 的哨兵也不投给已退订队列


@pytest.mark.anyio
async def test_lifecycle_is_one_shot():
    """运行中重复 start 与 stop 后再 start 都必须 RuntimeError：
    一次性生命周期，重启 = 新建实例。"""
    m = AudioMixer(sr=1000, chunk_ms=10)
    await m.start()
    with pytest.raises(RuntimeError):
        await m.start()
    await m.stop()
    with pytest.raises(RuntimeError):
        await m.start()


@pytest.mark.anyio
async def test_subscribe_after_stop_yields_sentinel_not_hang():
    """stop() 之后订阅（shutdown 竞态：晚到的 /stream.wav）必须立即拿到
    None 哨兵而非永久挂在 queue.get() 上——节拍任务已终结、不会再 fanout。"""
    m = AudioMixer(sr=1000, chunk_ms=10)
    await m.start()
    await m.stop()
    queue, unsubscribe = m.subscribe()
    item = await asyncio.wait_for(queue.get(), 1.0)  # 挂死则超时失败
    assert item is None
    unsubscribe()  # no-op（从未入 _subs），不得抛


@pytest.mark.anyio
async def test_slow_consumer_does_not_block_emission():
    m = AudioMixer(sr=1000, chunk_ms=10)
    queue, unsubscribe = m.subscribe()  # 从不消费 → 队列打满
    await m.start()
    try:
        deadline = time.monotonic() + 1.5
        while m.stats()["chunks_emitted"] < 25 and time.monotonic() < deadline:
            await asyncio.sleep(0.02)
        emitted = m.stats()["chunks_emitted"]
        assert emitted >= 25, f"emission blocked by slow consumer: {emitted}"
        assert queue.qsize() == 16  # 有界丢最旧，不无限增长
    finally:
        await m.stop()
    # 队列已满也要收到哨兵（丢最旧腾位）
    items = []
    while not queue.empty():
        items.append(queue.get_nowait())
    assert items[-1] is None
    assert queue.qsize() == 0
    unsubscribe()
