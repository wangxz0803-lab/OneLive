"""每信道实时连续音轨混音器（V2 M3a Task 1）。

RTMP 推流需要不间断的音轨：本模块按实时节拍产出 pcm16 块流——
空闲时是静音（全零），TTS 语音按 FIFO 追加在时间线尾部依次播出。
"对齐 SpeechSchedule" 仅限 FIFO 语义（排队播放、不重叠）；丢弃上限
并不一致——本混音器按时长（默认 60s）、SpeechSchedule 按段数（16）、
/speech 订阅队列按段数（8），积压时各自丢段（见 app.py A/V 契约，
统一化留 M3b）。消费方：/stream.wav HTTP 响应经 ``subscribe()`` 订阅。

生命周期一次性：start → stop 一个来回，stop 后再 start 是
RuntimeError——重启 = 新建实例（lifespan 每次启动都新建 app）。

线程模型：**全部方法只能在 asyncio 事件循环线程调用**（splice 由
TTS 事件处理器调、subscribe 由 HTTP handler 调），因此无锁。

节拍：注入的 ``clock`` 只参与排程运算——tick n 的目标时刻为
``t0 + n * chunk_s``（绝对时刻防漂移，同 feeder）；实际等待走
``asyncio.sleep``（事件循环时钟）。睡过头时后续 deadline 已过、
sleep(0) 连发补齐，平均速率不漂。纯拼装逻辑 ``_next_chunk`` 与
节拍循环分离，前者可确定性单测。

溢出策略：语音队列按总秒数有界（默认 60s），溢出丢最老的 *排队*
段并累计 dropped_speech（正在播的头段不掐断；若只剩头段则超额
接收），同 SpeechSchedule。订阅队列有界（16 块）丢最旧；stop()
后订阅者收 ``None`` 哨兵——在任务 finally 里发，任何退出路径不漏。
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from typing import Callable

__all__ = ["AudioMixer"]

log = logging.getLogger(__name__)

_SUB_QUEUE_MAX = 16  # 每订阅者积压上限（块数），满则丢最旧


class AudioMixer:
    """单信道连续 pcm16 块流：静音打底 + FIFO 语音拼接（事件循环内使用）。"""

    def __init__(self, sr: int = 16000, chunk_ms: int = 100,
                 clock: Callable[[], float] = time.monotonic,
                 max_queued_s: float = 60.0) -> None:
        if sr <= 0:
            raise ValueError(f"sr must be > 0, got {sr}")
        if chunk_ms <= 0:
            raise ValueError(f"chunk_ms must be > 0, got {chunk_ms}")
        if (sr * chunk_ms) % 1000:
            raise ValueError(
                f"sr*chunk_ms/1000 must be a whole sample count, got sr={sr} chunk_ms={chunk_ms}")
        if max_queued_s <= 0:
            raise ValueError(f"max_queued_s must be > 0, got {max_queued_s}")
        self._sr = sr
        self._chunk_s = chunk_ms / 1000.0
        self._chunk_bytes = (sr * chunk_ms // 1000) * 2  # pcm16 = 2 字节/样本
        self._clock = clock
        self._silence = bytes(self._chunk_bytes)
        self._max_queued_bytes = int(max_queued_s * sr) * 2

        self._speech: deque[bytes] = deque()  # 待播语音段（FIFO）
        self._head_off = 0  # 头段已消费字节数；>0 表示头段"正在播"
        self._queued_bytes = 0  # 未消费语音总字节（含头段剩余）

        self._subs: set[asyncio.Queue] = set()
        self._task: asyncio.Task | None = None
        self._started = False  # 一次性生命周期：start 过（含已 stop）即不可再 start
        self._stopped = False  # stop() 已调用：晚到的 subscribe 直接给哨兵，不挂死

        self._chunks_emitted = 0
        self._spliced = 0
        self._dropped = 0

    # ------------------------------------------------------------- lifecycle

    @property
    def sr(self) -> int:
        """采样率（Hz）：/stream.wav 写 WAV 头、tee 校验 TTS 采样率都用它。"""
        return self._sr

    async def start(self) -> None:
        """启动常驻节拍任务。一次性生命周期：重复 start 或 stop 后再
        start 都是 RuntimeError（订阅者已收 None 哨兵，重启只会造出一条
        没人听的音轨——重启 = 新建实例）。"""
        if self._started:
            raise RuntimeError("AudioMixer lifecycle is one-shot: already started "
                               "(restart = create a new instance)")
        self._started = True
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        """取消节拍任务并等它退出；订阅者由任务 finally 发 None 哨兵。"""
        self._stopped = True  # 置于 early-return 前：此后 subscribe 一律给哨兵
        if self._task is None:
            return
        task, self._task = self._task, None
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    # ------------------------------------------------------------- producers

    def splice(self, pcm16: bytes, segment_id: int) -> None:
        """把一段 TTS 语音追加到时间线尾部（FIFO，事件循环线程内调用）。

        溢出（总时长超 max_queued_s）丢最老的排队段并计数；正在播的
        头段不掐断——只剩头段时超额接收本段。空段是 no-op。
        """
        if len(pcm16) % 2:
            raise ValueError(
                f"pcm16 must be an even number of bytes (int16), got {len(pcm16)}")
        if not pcm16:
            return
        while self._queued_bytes + len(pcm16) > self._max_queued_bytes:
            drop_idx = 1 if self._head_off > 0 else 0  # 跳过正在播的头段
            if drop_idx >= len(self._speech):
                break  # 无可丢的排队段：不掐断播放，超额接收
            victim = self._speech[drop_idx]
            del self._speech[drop_idx]
            self._queued_bytes -= len(victim)
            self._dropped += 1
            log.warning("audio mixer: speech queue overflow, dropped oldest "
                        "queued segment (%d bytes) for segment_id=%d",
                        len(victim), segment_id)
        self._speech.append(bytes(pcm16))
        self._queued_bytes += len(pcm16)
        self._spliced += 1

    # ------------------------------------------------------------- consumers

    def subscribe(self) -> tuple[asyncio.Queue, Callable[[], None]]:
        """注册订阅者，返回 (队列, 退订回调)。

        队列有界（16 块）满则丢最旧，慢消费者绝不拖慢节拍任务。
        退订回调全同步零 await，放 finally 里最先执行（同 app.py 惯例）。

        stop() 之后订阅：节拍任务已终结、不会再 fanout，若给空队列则
        /stream.wav 的 ``await queue.get()`` 永久挂死（shutdown 竞态：晚到
        的拉流请求）。改为预置 None 哨兵——消费者立即收到正常终结信号，
        与常规 shutdown 路径（任务 finally fanout None）行为一致。
        """
        queue: asyncio.Queue = asyncio.Queue(maxsize=_SUB_QUEUE_MAX)
        if self._stopped:
            queue.put_nowait(None)  # 晚到订阅：立即终结而非挂死

            def unsubscribe() -> None:  # 从未入 _subs，退订是 no-op
                pass

            return queue, unsubscribe
        self._subs.add(queue)

        def unsubscribe() -> None:
            self._subs.discard(queue)

        return queue, unsubscribe

    def stats(self) -> dict:
        return {
            "chunks_emitted": self._chunks_emitted,
            "spliced_segments": self._spliced,
            "dropped_speech": self._dropped,
            "queued_speech_s": self._queued_bytes / (2 * self._sr),
        }

    # ------------------------------------------------------------- internal

    def _next_chunk(self) -> bytes:
        """拼装下一块：语音队列有货切片（跨段无缝），不足补零；纯逻辑。"""
        if not self._speech:
            return self._silence
        out = bytearray()
        need = self._chunk_bytes
        while need and self._speech:
            head = self._speech[0]
            take = min(len(head) - self._head_off, need)
            out += head[self._head_off:self._head_off + take]
            self._head_off += take
            self._queued_bytes -= take
            need -= take
            if self._head_off == len(head):
                self._speech.popleft()
                self._head_off = 0
        if need:
            out += bytes(need)  # 尾块：语音在前，静音补齐
        return bytes(out)

    def _fanout(self, item: bytes | None) -> None:
        """向所有订阅者非阻塞投递；满则丢最旧腾位（哨兵也走此路径）。"""
        for queue in tuple(self._subs):
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            queue.put_nowait(item)

    async def _run(self) -> None:
        """常驻节拍循环：每 tick 发一块；绝对时刻排程防漂移。"""
        try:
            t0 = self._clock()
            n = 0
            while True:
                self._fanout(self._next_chunk())
                self._chunks_emitted += 1
                n += 1
                await asyncio.sleep(max(0.0, t0 + n * self._chunk_s - self._clock()))
        finally:
            # 任何退出路径（cancel / 意外异常）订阅者都必须能终结
            self._fanout(None)
