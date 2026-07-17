"""翻译管线编排：ASR 段 → 字幕 → 逐语言翻译 → 逐语言 TTS。

拓扑：转写器 segments() 由单个 consumer 任务消费；每来一段立即发
SubtitleEvent（字幕永远先于该段的任何翻译/配音事件），随后为每个目标
语言 spawn 一个独立任务：translate → TranslationEvent（status 原样透传，
unavailable/error 不做 TTS）→ 成功则 tts_fn → TTSReadyEvent。

隔离契约：一个 (段, 语言) 的失败（TTSError、挂死超时、provider 违约
抛异常）只产出一条 PipelineErrorEvent，绝不影响其他语言或其他段。
TTS 调用同时受管线级 asyncio.wait_for(tts_timeout_s) 约束——即使
tts_fn 不守自己的 timeout_s 契约（或被注入的假实现挂死）也能收割。

events() 是单消费者契约：内部只有一个 asyncio.Queue，多个消费者会
互相抢事件。唯一消费者是服务层（Task 5），由它负责向多个 WebSocket
客户端扇出。

任务追踪：所有 spawn 的任务都登记在 self._tasks，close() 先关转写器
（consumer 随哨兵退出），再限时 gather 全部剩余任务，超时的直接
cancel 并补发 PipelineErrorEvent，最后发事件哨兵——events() 消费者
必然终结。
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field

from translate.asr import TranscriptSegment
from translate.providers import TranslateProvider
from translate.tts import TTSError, TTSResult, VOICES, synthesize

logger = logging.getLogger(__name__)


@dataclass
class SubtitleEvent:
    """原文字幕：段一到手立即发出（不等翻译）。"""

    segment_id: int
    text: str
    t0: float
    t1: float


@dataclass
class TranslationEvent:
    """单语言翻译结果。status: "ok" | "unavailable" | "error"（provider 原样透传）。"""

    segment_id: int
    lang: str
    status: str
    text: str | None = None
    detail: str | None = None


@dataclass
class TTSReadyEvent:
    """单语言配音就绪（含完整 TTSResult：pcm/嘴型曲线由服务层分发）。"""

    segment_id: int
    lang: str
    voice: str
    duration_s: float
    synth_ms: int
    result: TTSResult = field(repr=False)


@dataclass
class PipelineErrorEvent:
    """某 (段, 语言) 在某阶段失败。stage: "translate" | "tts" | "close"。"""

    segment_id: int
    lang: str | None
    stage: str
    detail: str


class TranslationPipeline:
    """编排层。用法：start() → feed_audio()* → close()；events() 单消费者迭代。"""

    def __init__(
        self,
        transcriber,
        provider: TranslateProvider,
        tts_langs: tuple[str, ...] = ("en",),
        voices: dict[str, str] = VOICES,
        tts_fn=synthesize,
        tts_timeout_s: float = 15.0,
    ) -> None:
        self._transcriber = transcriber
        self._provider = provider
        self._tts_langs = tuple(tts_langs)
        self._voices = voices
        self._tts_fn = tts_fn
        self._tts_timeout_s = tts_timeout_s
        # close() 收尾等待剩余任务的上限：比单次 TTS 超时略宽即可
        self._drain_timeout_s = tts_timeout_s + 5.0

        self._events: asyncio.Queue = asyncio.Queue()
        self._tasks: dict[asyncio.Task, tuple[int, str]] = {}
        self._consumer: asyncio.Task | None = None
        self._closed = False
        self._stats = {
            "segments": 0,
            "translated_ok": 0,
            "translations_unavailable": 0,
            "tts_ok": 0,
            "errors": 0,
        }

    async def start(self) -> None:
        """启动转写器 + segments() 消费任务。"""
        await self._transcriber.start()
        self._consumer = asyncio.create_task(self._consume_segments())

    def feed_audio(self, pcm16: bytes, sr: int) -> None:
        """PCM 直通转写器。"""
        self._transcriber.feed(pcm16, sr)

    async def events(self):
        """单消费者事件流（见模块 docstring）；close() 收尾后自然终结。"""
        while True:
            item = await self._events.get()
            if item is None:
                return
            yield item

    async def close(self) -> None:
        """关转写器 → 等 consumer 退出 → 限时收割全部剩余任务 → 发事件哨兵。"""
        if self._closed:
            return
        self._closed = True
        try:
            await self._transcriber.close()
            if self._consumer is not None:
                try:
                    await self._consumer
                except Exception:
                    logger.exception("segment consumer died unexpectedly")
            pending = [t for t in self._tasks if not t.done()]
            if pending:
                _done, stragglers = await asyncio.wait(
                    pending, timeout=self._drain_timeout_s
                )
                for task in stragglers:
                    seg_id, lang = self._tasks.get(task, (-1, None))
                    task.cancel()
                    self._stats["errors"] += 1
                    self._events.put_nowait(
                        PipelineErrorEvent(
                            segment_id=seg_id,
                            lang=lang,
                            stage="close",
                            detail=f"task still running after {self._drain_timeout_s}s "
                            "drain timeout, cancelled",
                        )
                    )
                if stragglers:
                    await asyncio.gather(*stragglers, return_exceptions=True)
        finally:
            # 无论收尾过程出什么幺蛾子，events() 消费者都必须能终结
            self._events.put_nowait(None)

    def stats(self) -> dict:
        return dict(self._stats)

    # ------------------------------------------------------------ internal

    async def _consume_segments(self) -> None:
        async for seg in self._transcriber.segments():
            self._stats["segments"] += 1
            # 字幕先于该段一切后续事件（put 在 spawn 之前，同步完成）
            self._events.put_nowait(
                SubtitleEvent(segment_id=seg.id, text=seg.text, t0=seg.t0, t1=seg.t1)
            )
            for lang in self._tts_langs:
                task = asyncio.create_task(self._process_lang(seg, lang))
                self._tasks[task] = (seg.id, lang)
                task.add_done_callback(lambda t: self._tasks.pop(t, None))

    async def _process_lang(self, seg: TranscriptSegment, lang: str) -> None:
        """单 (段, 语言) 全链路；任何失败就地收敛为事件，绝不外溢。"""
        try:
            result = await self._provider.translate(seg.text, lang)
        except Exception as e:  # provider 契约是永不抛；这里防御违约实现
            self._stats["errors"] += 1
            self._events.put_nowait(
                PipelineErrorEvent(
                    segment_id=seg.id, lang=lang, stage="translate", detail=repr(e)
                )
            )
            return

        self._events.put_nowait(
            TranslationEvent(
                segment_id=seg.id,
                lang=lang,
                status=result.status,
                text=result.text,
                detail=result.detail,
            )
        )
        if result.status == "ok":
            self._stats["translated_ok"] += 1
        elif result.status == "unavailable":
            self._stats["translations_unavailable"] += 1
        else:
            self._stats["errors"] += 1
        if not result.ok or not result.text:
            return  # unavailable / error：不做 TTS

        voice = self._voices[lang]
        try:
            # 双保险：把 timeout_s 传给 tts_fn，同时套管线级 wait_for
            # （tts_fn 不守约/被注入假实现挂死时也能收割）
            tts = await asyncio.wait_for(
                self._tts_fn(result.text, voice, timeout_s=self._tts_timeout_s),
                self._tts_timeout_s,
            )
        except asyncio.TimeoutError:
            self._stats["errors"] += 1
            self._events.put_nowait(
                PipelineErrorEvent(
                    segment_id=seg.id,
                    lang=lang,
                    stage="tts",
                    detail=f"timeout after {self._tts_timeout_s}s (voice={voice})",
                )
            )
            return
        except TTSError as e:
            self._stats["errors"] += 1
            self._events.put_nowait(
                PipelineErrorEvent(
                    segment_id=seg.id, lang=lang, stage="tts", detail=str(e)
                )
            )
            return
        except Exception as e:  # tts_fn 契约外异常同样就地收敛
            self._stats["errors"] += 1
            self._events.put_nowait(
                PipelineErrorEvent(
                    segment_id=seg.id, lang=lang, stage="tts", detail=repr(e)
                )
            )
            return

        self._stats["tts_ok"] += 1
        self._events.put_nowait(
            TTSReadyEvent(
                segment_id=seg.id,
                lang=lang,
                voice=voice,
                duration_s=tts.duration_s,
                synth_ms=tts.synth_ms,
                result=tts,
            )
        )
