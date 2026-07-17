"""翻译管线编排纯逻辑测试：Fake 转写器 / Provider / TTS，无网络无 whisper，全程 <2s。"""

import asyncio

import numpy as np
import pytest

from translate.asr import TranscriptSegment
from translate.pipeline import (
    PipelineErrorEvent,
    SubtitleEvent,
    TranslationEvent,
    TranslationPipeline,
    TTSReadyEvent,
)
from translate.providers import TranslateResult
from translate.tts import TTSError, TTSResult


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ---------------------------------------------------------------- fakes


class FakeTranscriber:
    """按预置列表产段；close() 发终止哨兵（复刻 SegmentTranscriber 契约）。"""

    def __init__(self, segs):
        self._segs = list(segs)
        self._out: asyncio.Queue = asyncio.Queue()
        self.fed = []
        self.closed = False

    async def start(self):
        for s in self._segs:
            self._out.put_nowait(s)

    def feed(self, pcm16, sr):
        self.fed.append((pcm16, sr))

    async def segments(self):
        while True:
            item = await self._out.get()
            if item is None:
                return
            yield item

    async def close(self):
        self.closed = True
        self._out.put_nowait(None)


class FakeProvider:
    """per-lang 预置结果；未预置的语言回显 ok 译文 '{lang}:{text}'。"""

    available = True

    def __init__(self, per_lang=None):
        self.per_lang = per_lang or {}
        self.calls = []

    async def translate(self, text, target_lang):
        self.calls.append((text, target_lang))
        canned = self.per_lang.get(target_lang)
        if canned is not None:
            return canned
        return TranslateResult(ok=True, text=f"{target_lang}:{text}", status="ok")


def make_tts_result(duration_s=1.0):
    return TTSResult(
        audio_pcm16=b"\x00\x00" * int(16000 * duration_s),
        sr=16000,
        lip_curve=np.zeros(int(25 * duration_s), dtype=np.float32),
        duration_s=duration_s,
        synth_ms=3,
    )


class FakeTTS:
    """即时返回；fail_voices 抛 TTSError；hang_voices 挂死（靠管线超时收割）。"""

    def __init__(self, fail_voices=(), hang_voices=()):
        self.calls = []
        self.fail_voices = set(fail_voices)
        self.hang_voices = set(hang_voices)

    async def __call__(self, text, voice, timeout_s=None, **kwargs):
        self.calls.append((text, voice))
        if voice in self.hang_voices:
            await asyncio.sleep(60)  # 无视 timeout_s，模拟不守约的实现
        if voice in self.fail_voices:
            raise TTSError("boom")
        return make_tts_result()


VOICES2 = {"en": "v-en", "ja": "v-ja"}

SEG1 = TranscriptSegment(id=1, text="大家好", t0=0.1, t1=1.2)
SEG2 = TranscriptSegment(id=2, text="三款产品", t0=2.0, t1=3.5)


async def run_pipeline(segs, provider, tts, langs, tts_timeout_s=15.0):
    """跑完整个生命周期并收集全部事件（wait_for 保证消费者必然终止）。"""
    transcriber = FakeTranscriber(segs)
    pipe = TranslationPipeline(
        transcriber,
        provider,
        tts_langs=langs,
        voices=VOICES2,
        tts_fn=tts,
        tts_timeout_s=tts_timeout_s,
    )
    await pipe.start()
    await pipe.close()

    events = []

    async def collect():
        async for ev in pipe.events():
            events.append(ev)

    await asyncio.wait_for(collect(), timeout=5)
    return pipe, transcriber, events


def indices(events, cond):
    return [i for i, ev in enumerate(events) if cond(ev)]


# ---------------------------------------------------------------- tests


@pytest.mark.anyio
async def test_event_order_single_segment():
    """单段单语言：subtitle → translation → tts_ready，严格有序。"""
    tts = FakeTTS()
    pipe, _, events = await run_pipeline([SEG1], FakeProvider(), tts, langs=("en",))

    assert [type(ev) for ev in events] == [SubtitleEvent, TranslationEvent, TTSReadyEvent]
    sub, tr, ready = events
    assert (sub.segment_id, sub.text, sub.t0, sub.t1) == (1, "大家好", 0.1, 1.2)
    assert (tr.segment_id, tr.lang, tr.status, tr.text) == (1, "en", "ok", "en:大家好")
    assert (ready.segment_id, ready.lang, ready.voice) == (1, "en", "v-en")
    assert ready.duration_s == ready.result.duration_s
    assert ready.synth_ms == ready.result.synth_ms
    assert tts.calls == [("en:大家好", "v-en")]


@pytest.mark.anyio
async def test_id_lang_correlation_interleaved():
    """2 段 × 2 语言交错：每个 (segment, lang) 恰好一条 translation + 一条 tts_ready，
    且 subtitle < 该段 translation < 该 (段, lang) 的 tts_ready。"""
    tts = FakeTTS()
    pipe, _, events = await run_pipeline([SEG1, SEG2], FakeProvider(), tts, langs=("en", "ja"))

    for seg in (SEG1, SEG2):
        [sub_i] = indices(
            events, lambda e, s=seg: isinstance(e, SubtitleEvent) and e.segment_id == s.id
        )
        for lang in ("en", "ja"):
            [tr_i] = indices(
                events,
                lambda e, s=seg, l=lang: isinstance(e, TranslationEvent)
                and e.segment_id == s.id and e.lang == l,
            )
            [ready_i] = indices(
                events,
                lambda e, s=seg, l=lang: isinstance(e, TTSReadyEvent)
                and e.segment_id == s.id and e.lang == l,
            )
            assert sub_i < tr_i < ready_i
            # 译文与 TTS 输入按 (段, 语言) 正确关联
            assert events[tr_i].text == f"{lang}:{seg.text}"
            assert events[ready_i].voice == VOICES2[lang]
    assert sorted(tts.calls) == sorted(
        (f"{lang}:{seg.text}", VOICES2[lang]) for seg in (SEG1, SEG2) for lang in ("en", "ja")
    )
    assert not [e for e in events if isinstance(e, PipelineErrorEvent)]


@pytest.mark.anyio
async def test_unavailable_no_tts_attempt():
    """ja 不可用：TranslationEvent(unavailable) 透传，绝不调 TTS；en 照常配音。"""
    provider = FakeProvider(
        per_lang={
            "ja": TranslateResult(ok=False, text=None, status="unavailable", detail="no key")
        }
    )
    tts = FakeTTS()
    pipe, _, events = await run_pipeline([SEG1], provider, tts, langs=("en", "ja"))

    [tr_ja] = [e for e in events if isinstance(e, TranslationEvent) and e.lang == "ja"]
    assert (tr_ja.status, tr_ja.text, tr_ja.detail) == ("unavailable", None, "no key")
    assert [v for _, v in tts.calls] == ["v-en"]  # ja 音色从未被调用
    assert not [e for e in events if isinstance(e, TTSReadyEvent) and e.lang == "ja"]
    assert [e.lang for e in events if isinstance(e, TTSReadyEvent)] == ["en"]


@pytest.mark.anyio
async def test_tts_error_isolated_per_lang():
    """ja 的 TTSError → PipelineErrorEvent(stage=tts)；en 的 tts_ready 照常到达。"""
    tts = FakeTTS(fail_voices=("v-ja",))
    pipe, _, events = await run_pipeline([SEG1], FakeProvider(), tts, langs=("en", "ja"))

    [err] = [e for e in events if isinstance(e, PipelineErrorEvent)]
    assert (err.segment_id, err.lang, err.stage) == (1, "ja", "tts")
    assert "boom" in err.detail
    assert [e.lang for e in events if isinstance(e, TTSReadyEvent)] == ["en"]
    # ja 的 TranslationEvent 仍然发出（翻译成功，失败的只是 TTS）
    assert [e for e in events if isinstance(e, TranslationEvent) and e.lang == "ja"]


@pytest.mark.anyio
async def test_hanging_tts_times_out_pipeline_continues():
    """挂死的 TTS（无视 timeout_s）由管线级 wait_for 收割 → PipelineErrorEvent(stage=tts)；
    其他语言、后续段不受影响。"""
    tts = FakeTTS(hang_voices=("v-ja",))
    pipe, _, events = await run_pipeline(
        [SEG1, SEG2], FakeProvider(), tts, langs=("en", "ja"), tts_timeout_s=0.2
    )

    errs = [e for e in events if isinstance(e, PipelineErrorEvent)]
    assert sorted((e.segment_id, e.lang) for e in errs) == [(1, "ja"), (2, "ja")]
    assert all(e.stage == "tts" and "timeout" in e.detail for e in errs)
    assert sorted(e.segment_id for e in events if isinstance(e, TTSReadyEvent) and e.lang == "en") == [1, 2]


@pytest.mark.anyio
async def test_feed_audio_passthrough_and_close_terminates():
    """feed_audio 透传给转写器；close() 后 events() 消费者必然终结（无事件也一样）。"""
    transcriber = FakeTranscriber([])
    pipe = TranslationPipeline(
        transcriber, FakeProvider(), tts_langs=("en",), voices=VOICES2, tts_fn=FakeTTS()
    )
    await pipe.start()
    pipe.feed_audio(b"\x01\x02", 16000)
    assert transcriber.fed == [(b"\x01\x02", 16000)]

    # 消费者先挂起等待，close() 必须把它放行
    async def collect():
        return [ev async for ev in pipe.events()]

    task = asyncio.create_task(collect())
    await asyncio.sleep(0.05)
    assert not task.done()
    await pipe.close()
    events = await asyncio.wait_for(task, timeout=2)
    assert events == []
    assert transcriber.closed


@pytest.mark.anyio
async def test_stats():
    """segments / translated_ok / translations_unavailable / tts_ok / errors 全量对账。"""
    # en：两段都 ok + TTS ok；ja：status=error（计入 errors，不做 TTS）
    provider = FakeProvider(
        per_lang={
            "ja": TranslateResult(ok=False, text=None, status="error", detail="HTTP 500")
        }
    )
    tts = FakeTTS()
    pipe, _, events = await run_pipeline([SEG1, SEG2], provider, tts, langs=("en", "ja"))

    assert pipe.stats() == {
        "segments": 2,
        "translated_ok": 2,
        "translations_unavailable": 0,
        "tts_ok": 2,
        "errors": 2,
    }

    # unavailable 分支单独对账
    provider2 = FakeProvider(
        per_lang={
            "ja": TranslateResult(ok=False, text=None, status="unavailable", detail="no key")
        }
    )
    pipe2, _, _ = await run_pipeline([SEG1], provider2, FakeTTS(), langs=("en", "ja"))
    assert pipe2.stats() == {
        "segments": 1,
        "translated_ok": 1,
        "translations_unavailable": 1,
        "tts_ok": 1,
        "errors": 0,
    }
