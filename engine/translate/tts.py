"""edge-tts 语音合成 + 嘴型曲线提取。

流程：edge_tts.Communicate 流式收 mp3 → ffmpeg 管道转 16k mono pcm16
→ audio_to_lip_curve 提取 25fps 口型开合曲线（整句离线计算，
TTS 按整句合成，音频本来就是完整的，M0 的离线设计在这里完全适用）。

错误契约（与 providers 的"永不抛异常"不同）：synthesize() 失败时抛
TTSError。理由：翻译失败还能退化显示原文，而 TTS 没有任何有意义的
部分结果——没有音频就没有嘴型曲线，返回半截结构体只会把失败往下游
传得更隐蔽。由调用方（管线编排层）决定降级策略（如跳过该句配音）。

ffmpeg 路径解析优先级：显式参数 > 环境变量 ONELIVE_FFMPEG > winget
安装的默认全路径。
"""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass

import numpy as np

from lipsync.audio_lip import audio_to_lip_curve

# 各目标语言默认音色（女声；男声音色待 casting 集成时按角色选择）
VOICES = {
    "en": "en-US-JennyNeural",
    "ja": "ja-JP-NanamiNeural",
    "es": "es-MX-DaliaNeural",
}

TARGET_SR = 16000
LIP_FPS = 25

_DEFAULT_FFMPEG = (
    r"C:\Users\76475\AppData\Local\Microsoft\WinGet\Packages"
    r"\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"
    r"\ffmpeg-8.1.2-full_build\bin\ffmpeg.exe"
)


class TTSError(Exception):
    """TTS 合成失败（网络 / edge-tts 服务错误 / ffmpeg 解码失败）。

    携带失败原因细节；调用方 catch 后自行决定降级（TTS 无部分结果可言）。
    """


@dataclass
class TTSResult:
    audio_pcm16: bytes  # 16kHz mono s16le
    sr: int
    lip_curve: np.ndarray  # 0..1, 25fps
    duration_s: float
    synth_ms: int  # 整个 synthesize 耗时（含网络 + 转码 + 曲线提取）


def _resolve_ffmpeg(ffmpeg_path: str | None) -> str:
    return ffmpeg_path or os.environ.get("ONELIVE_FFMPEG") or _DEFAULT_FFMPEG


async def _collect_mp3(text: str, voice: str) -> bytes:
    """edge-tts 流式收 mp3 字节；任何服务端/网络错误包装为 TTSError。"""
    import edge_tts

    chunks: list[bytes] = []
    try:
        communicate = edge_tts.Communicate(text, voice)
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                chunks.append(chunk["data"])
    except Exception as e:
        raise TTSError(f"edge-tts synthesis failed (voice={voice}): {e!r}") from e
    mp3 = b"".join(chunks)
    if not mp3:
        raise TTSError(f"edge-tts returned no audio (voice={voice}, text={text[:50]!r})")
    return mp3


async def _mp3_to_pcm16(mp3: bytes, ffmpeg_path: str) -> bytes:
    """mp3 → 16k mono s16le，全程管道，不落临时文件。"""
    try:
        proc = await asyncio.create_subprocess_exec(
            ffmpeg_path,
            "-hide_banner", "-loglevel", "error",
            "-i", "pipe:0",
            "-f", "s16le", "-acodec", "pcm_s16le",
            "-ac", "1", "-ar", str(TARGET_SR),
            "pipe:1",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except OSError as e:
        raise TTSError(f"ffmpeg not launchable at {ffmpeg_path!r}: {e}") from e
    pcm, err = await proc.communicate(input=mp3)
    if proc.returncode != 0:
        raise TTSError(
            f"ffmpeg exited {proc.returncode}: {err.decode('utf-8', 'replace').strip()}"
        )
    if not pcm:
        raise TTSError("ffmpeg produced no PCM output")
    return pcm


async def synthesize(
    text: str, voice: str, ffmpeg_path: str | None = None
) -> TTSResult:
    """整句合成：text → mp3 → 16k pcm16 → 嘴型曲线。失败抛 TTSError（见模块 docstring）。"""
    t0 = time.perf_counter()
    mp3 = await _collect_mp3(text, voice)
    pcm = await _mp3_to_pcm16(mp3, _resolve_ffmpeg(ffmpeg_path))

    audio_f32 = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    lip_curve = audio_to_lip_curve(audio_f32, TARGET_SR, fps=LIP_FPS)
    duration_s = len(audio_f32) / TARGET_SR
    synth_ms = int((time.perf_counter() - t0) * 1000)
    return TTSResult(
        audio_pcm16=pcm,
        sr=TARGET_SR,
        lip_curve=lip_curve,
        duration_s=duration_s,
        synth_ms=synth_ms,
    )
