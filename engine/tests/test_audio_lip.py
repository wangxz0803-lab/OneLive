import numpy as np

from lipsync.audio_lip import audio_to_lip_curve


def test_lip_curve_range_and_length():
    sr = 16000
    t = np.linspace(0, 2.0, sr * 2, endpoint=False)
    audio = (np.random.randn(sr * 2) * 0.1 * (0.5 + 0.5 * np.sin(2 * np.pi * 1.0 * t))).astype(np.float32)
    curve = audio_to_lip_curve(audio, sr, fps=25)
    assert len(curve) == 50
    assert float(curve.min()) >= 0.0 and float(curve.max()) <= 1.0
    assert float(curve.max()) > 0.3


def test_silence_keeps_mouth_closed():
    sr = 16000
    curve = audio_to_lip_curve(np.zeros(sr, dtype=np.float32), sr, fps=25)
    assert float(curve.max()) < 0.05
