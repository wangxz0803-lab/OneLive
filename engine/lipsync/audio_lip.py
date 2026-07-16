"""音频包络 -> 口型开合曲线（0..1），用于 LivePortrait lip retarget。"""

import numpy as np


def audio_to_lip_curve(audio: np.ndarray, sr: int, fps: int = 25,
                       attack: float = 0.55, release: float = 0.25) -> np.ndarray:
    """按视频帧粒度计算 RMS 包络，归一化到 0..1，并做不对称平滑（张嘴快、闭嘴慢）。"""
    hop = sr // fps
    n_frames = len(audio) // hop
    rms = np.array([
        float(np.sqrt(np.mean(np.square(audio[i * hop:(i + 1) * hop]))))
        for i in range(n_frames)
    ])
    peak = float(rms.max())
    if peak < 1e-4:
        return np.zeros(n_frames, dtype=np.float32)
    norm = np.clip(rms / peak, 0.0, 1.0)
    out = np.zeros_like(norm)
    prev = 0.0
    for i, v in enumerate(norm):
        alpha = attack if v > prev else release
        prev = prev + alpha * (v - prev)
        out[i] = prev
    return np.clip(out, 0.0, 1.0).astype(np.float32)
