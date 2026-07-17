"""流式 ASR 测试：纯分段逻辑（合成信号）+ faster-whisper 真实推理（committed 中文语音 fixtures）。"""

import asyncio
from pathlib import Path

import numpy as np
import pytest

from translate.asr import SegmentTranscriber, TranscriptSegment, split_on_silence

SR = 16000
FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _tone(seconds: float, amp: float = 0.3) -> np.ndarray:
    """440Hz 正弦"语音"，int16。"""
    t = np.arange(int(seconds * SR)) / SR
    return (np.sin(2 * np.pi * 440 * t) * amp * 32767).astype(np.int16)


def _silence(seconds: float) -> np.ndarray:
    return np.zeros(int(seconds * SR), dtype=np.int16)


# ---------- 纯分段逻辑 ----------


def test_split_two_utterances_on_silence():
    pcm = np.concatenate([_tone(1.0), _silence(1.0), _tone(0.8), _silence(1.0)])
    segs = split_on_silence(pcm, SR)
    assert len(segs) == 2
    (s0, e0), (s1, e1) = segs
    # 第一段大致覆盖 [0, 1.0s]，第二段大致覆盖 [2.0s, 2.8s]
    assert s0 / SR < 0.1
    assert abs(e0 / SR - 1.0) < 0.15
    assert abs(s1 / SR - 2.0) < 0.15
    assert abs(e1 / SR - 2.8) < 0.15


def test_split_silence_only_yields_nothing():
    segs = split_on_silence(_silence(3.0), SR)
    assert segs == []


def test_split_too_short_speech_is_discarded():
    # 0.1s 的噪声脉冲 < 最短语音 0.4s → 丢弃
    pcm = np.concatenate([_silence(0.5), _tone(0.1), _silence(1.0)])
    assert split_on_silence(pcm, SR) == []


def test_split_hard_cap_at_5s():
    # 连续 12s 语音无停顿 → 被 5s 硬上限切开
    segs = split_on_silence(_tone(12.0), SR)
    assert len(segs) == 3
    for s, e in segs:
        assert (e - s) / SR <= 5.0 + 0.05
    # flush 收尾：最后一段是尾部未闭合语音
    assert abs(segs[-1][1] / SR - 12.0) < 0.05


def test_split_trailing_speech_flushed():
    # 语音结尾没有静音尾巴 → flush 仍要产出段
    pcm = np.concatenate([_silence(0.5), _tone(0.9)])
    segs = split_on_silence(pcm, SR)
    assert len(segs) == 1
    s, e = segs[0]
    assert abs(s / SR - 0.5) < 0.15
    assert abs(e / SR - 1.4) < 0.05


# ---------- 真实 faster-whisper 推理 ----------


def _load_wav(name: str) -> np.ndarray:
    import soundfile as sf

    data, sr = sf.read(FIXTURES / name, dtype="int16")
    assert sr == SR
    if data.ndim > 1:
        data = data[:, 0]
    return data


async def _collect(tx: SegmentTranscriber) -> list[TranscriptSegment]:
    out = []
    async for seg in tx.segments():
        out.append(seg)
    return out


def _feed_in_chunks(tx: SegmentTranscriber, pcm: np.ndarray, chunk_ms: int = 100):
    chunk = SR * chunk_ms // 1000
    for i in range(0, len(pcm), chunk):
        tx.feed(pcm[i : i + chunk].tobytes(), SR)


@pytest.mark.anyio
async def test_two_sentences_two_segments():
    tx = SegmentTranscriber()
    await tx.start()
    pcm = np.concatenate(
        [_load_wav("zh_sentence1.wav"), _silence(1.0), _load_wav("zh_sentence2.wav")]
    )
    _feed_in_chunks(tx, pcm)
    await tx.close()
    segs = await _collect(tx)

    print(f"\n[ASR] segments: {[(s.id, s.text, round(s.t0, 2), round(s.t1, 2)) for s in segs]}")
    print(f"[ASR] stats: {tx.stats()}")

    assert len(segs) >= 2
    full1 = segs[0].text
    full2 = "".join(s.text for s in segs[1:])
    assert "欢迎" in full1, f"seg1 actual text: {full1!r}"
    assert "产品" in full2, f"seg2+ actual text: {full2!r}"
    assert segs[0].t1 <= segs[1].t0 + 1e-6
    stats = tx.stats()
    assert stats["segments"] == len(segs)
    assert stats["fed_seconds"] == pytest.approx(len(pcm) / SR, abs=0.01)
    assert stats["transcribe_ms_last"] > 0


@pytest.mark.anyio
async def test_silence_only_no_segments():
    tx = SegmentTranscriber()
    await tx.start()
    _feed_in_chunks(tx, _silence(3.0))
    await tx.close()
    segs = await _collect(tx)
    assert segs == []
    assert tx.stats()["segments"] == 0


@pytest.mark.anyio
async def test_close_flushes_trailing_speech():
    tx = SegmentTranscriber()
    await tx.start()
    # 句子结尾不带静音尾巴，close() 必须 flush 出来
    _feed_in_chunks(tx, _load_wav("zh_sentence2.wav"))
    await tx.close()
    segs = await _collect(tx)
    print(f"\n[ASR flush] segments: {[s.text for s in segs]}")
    assert len(segs) >= 1
    assert "产品" in "".join(s.text for s in segs)
