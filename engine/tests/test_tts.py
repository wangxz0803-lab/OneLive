"""流式 TTS 测试：edge-tts 真实合成（需网络）+ 嘴型曲线真实提取（不 mock audio_to_lip_curve）。"""

import time

import pytest

from translate.tts import TTSError, TTSResult, VOICES, synthesize

SR = 16000
FPS = 25


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_synthesize_english_with_lip_curve():
    text = "Hello everyone, welcome to my live stream."
    result = await synthesize(text, VOICES["en"])

    print(f"\n[TTS en] synth_ms={result.synth_ms} duration_s={result.duration_s:.3f} "
          f"lip_frames={len(result.lip_curve)} lip_max={result.lip_curve.max():.3f}")

    assert isinstance(result, TTSResult)
    assert len(result.audio_pcm16) > 0
    assert result.sr == SR
    assert 1.0 < result.duration_s < 10.0
    # pcm16 字节数与 duration 一致（2 bytes/sample）
    assert result.duration_s == pytest.approx(len(result.audio_pcm16) / 2 / SR, abs=0.01)
    # 嘴型曲线帧数 = duration * 25fps ± 1
    assert abs(len(result.lip_curve) - round(result.duration_s * FPS)) <= 1
    assert result.lip_curve.max() > 0.3
    assert result.lip_curve.min() >= 0.0
    assert result.lip_curve.max() <= 1.0
    assert result.synth_ms > 0


@pytest.mark.anyio
async def test_synthesize_japanese_smoke():
    result = await synthesize("こんにちは、ようこそ。", VOICES["ja"])
    print(f"\n[TTS ja] synth_ms={result.synth_ms} duration_s={result.duration_s:.3f}")
    assert result.duration_s > 0.5
    assert len(result.audio_pcm16) > 0


@pytest.mark.anyio
async def test_unknown_voice_raises_tts_error():
    with pytest.raises(TTSError):
        await synthesize("hello", "xx-XX-DoesNotExistNeural")


@pytest.mark.anyio
async def test_bad_ffmpeg_path_raises_tts_error():
    with pytest.raises(TTSError):
        await synthesize("hello", VOICES["en"], ffmpeg_path="C:/nonexistent/ffmpeg.exe")
