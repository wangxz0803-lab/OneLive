"""流式分段 ASR（faster-whisper）。

feed(pcm16) 累积音频 → 能量静音检测切分（20ms 窗口 RMS）：
语音 ≥0.4s 后出现 ≥0.6s 静音即闭合一段，或 5s 硬上限强切；
闭合段丢线程池跑 whisper，结果 TranscriptSegment 依序进 asyncio.Queue，
由 segments() 异步迭代器吐出。close() 会 flush 尾部未闭合语音。
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

WINDOW_MS = 20
RMS_THRESHOLD = 0.01  # 归一化 RMS（int16/32768），~328 int16
MIN_SPEECH_S = 0.4
MIN_SILENCE_S = 0.6
MAX_SEGMENT_S = 5.0

_DEFAULT_MODEL_DIR = Path(__file__).resolve().parents[1] / "models" / "whisper"


class SilenceSegmenter:
    """增量式能量分段器（纯逻辑，不依赖 whisper）。

    push() 喂 int16 样本，返回本次闭合的 [start, end) 样本区间；
    flush() 闭合尾部未完成的语音段。
    """

    def __init__(
        self,
        sr: int,
        window_ms: int = WINDOW_MS,
        rms_threshold: float = RMS_THRESHOLD,
        min_speech_s: float = MIN_SPEECH_S,
        min_silence_s: float = MIN_SILENCE_S,
        max_segment_s: float = MAX_SEGMENT_S,
    ) -> None:
        self.sr = sr
        self.window = sr * window_ms // 1000
        self.rms_threshold = rms_threshold
        self.min_speech_windows = max(1, int(min_speech_s * 1000 / window_ms))
        self.min_silence_windows = max(1, int(min_silence_s * 1000 / window_ms))
        self.max_segment_windows = max(1, int(max_segment_s * 1000 / window_ms))
        self._residual = np.empty(0, dtype=np.int16)
        self._pos = 0  # 已消费的完整窗口数（相对整条流）
        # 段状态
        self._seg_start: int | None = None  # 窗口下标
        self._speech_windows = 0
        self._silence_run = 0

    def push(self, samples: np.ndarray) -> list[tuple[int, int]]:
        buf = np.concatenate([self._residual, samples])
        n_windows = len(buf) // self.window
        closed: list[tuple[int, int]] = []
        for i in range(n_windows):
            w = buf[i * self.window : (i + 1) * self.window]
            rms = float(np.sqrt(np.mean((w.astype(np.float32) / 32768.0) ** 2)))
            seg = self._step(rms >= self.rms_threshold)
            if seg is not None:
                closed.append(seg)
            self._pos += 1
        self._residual = buf[n_windows * self.window :]
        return closed

    def _step(self, is_speech: bool) -> tuple[int, int] | None:
        if self._seg_start is None:
            if is_speech:
                self._seg_start = self._pos
                self._speech_windows = 1
                self._silence_run = 0
            return None

        if is_speech:
            self._speech_windows += 1
            self._silence_run = 0
        else:
            self._silence_run += 1

        seg_len = self._pos - self._seg_start + 1
        if self._silence_run >= self.min_silence_windows:
            # 静音够长：闭合到静音开始处；语音太短则当噪声丢弃
            end = self._pos + 1 - self._silence_run
            seg = (
                (self._seg_start * self.window, end * self.window)
                if self._speech_windows >= self.min_speech_windows
                else None
            )
            self._reset()
            return seg
        if seg_len >= self.max_segment_windows:
            seg = (self._seg_start * self.window, (self._pos + 1) * self.window)
            self._reset()
            return seg
        return None

    def flush(self) -> tuple[int, int] | None:
        """闭合尾部未完成段（语音太短的噪声不产出）。"""
        if self._seg_start is None:
            return None
        seg = None
        if self._speech_windows >= self.min_speech_windows:
            end = self._pos - self._silence_run
            seg = (self._seg_start * self.window, end * self.window)
        self._reset()
        return seg

    def _reset(self) -> None:
        self._seg_start = None
        self._speech_windows = 0
        self._silence_run = 0


def split_on_silence(
    pcm: np.ndarray,
    sr: int,
    **kwargs,
) -> list[tuple[int, int]]:
    """一次性分段：返回 [start, end) 样本区间列表（含尾部 flush）。"""
    seg = SilenceSegmenter(sr, **kwargs)
    out = seg.push(np.asarray(pcm, dtype=np.int16))
    tail = seg.flush()
    if tail is not None:
        out.append(tail)
    return out


@dataclass
class TranscriptSegment:
    id: int
    text: str
    t0: float  # 相对整条流的秒
    t1: float


class SegmentTranscriber:
    """喂 PCM16 → 静音切分 → whisper 转写 → segments() 依序产出。"""

    def __init__(
        self,
        model_dir: str | Path = _DEFAULT_MODEL_DIR,
        model_size: str = "small",
        lang: str = "zh",
        device: str = "cpu",
        compute_type: str = "int8",
    ) -> None:
        self.model_dir = str(model_dir)
        self.model_size = model_size
        self.lang = lang
        self.device = device
        self.compute_type = compute_type
        self._model = None
        self._sr: int | None = None
        self._segmenter: SilenceSegmenter | None = None
        self._audio: list[np.ndarray] = []  # 全量累积（段区间是全流样本下标）
        self._fed_samples = 0
        self._seg_count = 0
        self._transcribe_ms_last = 0.0
        self._pending: asyncio.Queue = asyncio.Queue()
        self._out: asyncio.Queue = asyncio.Queue()
        self._worker: asyncio.Task | None = None
        self._closed = False

    async def start(self) -> None:
        """在线程池加载模型（首次会从 HF 下载 ~460MB）并启动转写 worker。"""
        loop = asyncio.get_running_loop()
        self._model = await loop.run_in_executor(None, self._load_model)
        self._worker = asyncio.create_task(self._worker_loop())

    def _load_model(self):
        from faster_whisper import WhisperModel

        kwargs = dict(
            device=self.device,
            compute_type=self.compute_type,
            download_root=self.model_dir,
        )
        try:
            # 优先离线加载（模型已在 download_root 缓存时不发任何网络请求）
            return WhisperModel(self.model_size, local_files_only=True, **kwargs)
        except Exception:
            # 本地没有 → 走网络下载（首次 ~460MB；国内可设 HF_ENDPOINT 镜像）
            return WhisperModel(self.model_size, **kwargs)

    def feed(self, pcm16: bytes, sr: int) -> None:
        if self._closed:
            raise RuntimeError("feed() after close()")
        if self._sr is None:
            self._sr = sr
            self._segmenter = SilenceSegmenter(sr)
        elif sr != self._sr:
            raise ValueError(f"sample rate changed: {self._sr} -> {sr}")
        samples = np.frombuffer(pcm16, dtype=np.int16)
        self._audio.append(samples)
        self._fed_samples += len(samples)
        for start, end in self._segmenter.push(samples):
            self._pending.put_nowait((start, end))

    async def segments(self):
        """依序产出 TranscriptSegment；close() 后队列排空即结束。"""
        while True:
            item = await self._out.get()
            if item is None:
                return
            yield item

    async def close(self) -> None:
        """flush 尾部未闭合段，等 worker 转写完所有 pending。"""
        if self._closed:
            return
        self._closed = True
        if self._segmenter is not None:
            tail = self._segmenter.flush()
            if tail is not None:
                self._pending.put_nowait(tail)
        self._pending.put_nowait(None)
        if self._worker is not None:
            await self._worker
        self._out.put_nowait(None)

    def stats(self) -> dict:
        sr = self._sr or 16000
        return {
            "fed_seconds": self._fed_samples / sr,
            "segments": self._seg_count,
            "transcribe_ms_last": self._transcribe_ms_last,
        }

    async def _worker_loop(self) -> None:
        loop = asyncio.get_running_loop()
        full: np.ndarray | None = None
        while True:
            item = await self._pending.get()
            if item is None:
                return
            start, end = item
            full = np.concatenate(self._audio) if full is None or len(full) < end else full
            audio = full[start:end].astype(np.float32) / 32768.0
            text = await loop.run_in_executor(None, self._transcribe, audio)
            if not text:
                continue
            self._seg_count += 1
            self._out.put_nowait(
                TranscriptSegment(
                    id=self._seg_count,
                    text=text,
                    t0=start / self._sr,
                    t1=end / self._sr,
                )
            )

    def _transcribe(self, audio_f32: np.ndarray) -> str:
        t = time.perf_counter()
        segs, _info = self._model.transcribe(
            audio_f32, language=self.lang, beam_size=5, vad_filter=False
        )
        text = "".join(s.text for s in segs).strip()
        self._transcribe_ms_last = (time.perf_counter() - t) * 1000
        return text
