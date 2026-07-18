"""纯协议/wire 辅助（V2 M3b Task 1，从 app.py 拆出，行为零变化）。

只放无状态的 wire 格式函数：管线事件 → /events 广播 JSON 的映射，
以及 /stream.wav 的无限流 WAV 头。二者都不持有服务状态、不依赖
事件循环，可脱离 create_app 单测（见 test_app_integration 的
event_to_wire 用例）。A/V 同步契约的完整叙述仍以 app.py 模块
docstring 为唯一出处（编排层总览），此处不重复。
"""

import struct

from translate.pipeline import (
    PipelineErrorEvent,
    SubtitleEvent,
    TranslationEvent,
    TTSReadyEvent,
)


def event_to_wire(ev) -> dict:
    """管线事件 → /events 广播的 JSON 元数据。显式逐类映射，绝不 asdict：
    TTSReadyEvent.result 带 pcm bytes + ndarray 嘴型曲线，asdict 会在 JSON
    序列化时爆掉；音频/曲线只在进程内消费（M2b 数字人集成），wire 上仅以
    has_audio 标记存在性。type 字符串与事件类名对应（snake_case 去 Event）。"""
    if isinstance(ev, SubtitleEvent):
        return {"type": "subtitle", "segment_id": ev.segment_id,
                "text": ev.text, "t0": ev.t0, "t1": ev.t1}
    if isinstance(ev, TranslationEvent):
        return {"type": "translation", "segment_id": ev.segment_id, "lang": ev.lang,
                "status": ev.status, "text": ev.text, "detail": ev.detail}
    if isinstance(ev, TTSReadyEvent):
        return {"type": "tts_ready", "segment_id": ev.segment_id, "lang": ev.lang,
                "voice": ev.voice, "duration_s": ev.duration_s,
                "synth_ms": ev.synth_ms, "has_audio": True}
    if isinstance(ev, PipelineErrorEvent):
        return {"type": "pipeline_error", "segment_id": ev.segment_id, "lang": ev.lang,
                "stage": ev.stage, "detail": ev.detail}
    raise TypeError(f"unknown pipeline event type: {type(ev).__name__}")


def wav_stream_header(sr: int) -> bytes:
    """44 字节无限流 WAV 头：PCM(1) 单声道 16 位；RIFF/data 尺寸字段填
    0xFFFFFFFF（无限流惯例——ffmpeg/播放器读到即按"到 EOF 为止"处理）。"""
    return struct.pack("<4sI4s4sIHHIIHH4sI",
                       b"RIFF", 0xFFFFFFFF, b"WAVE",
                       b"fmt ", 16, 1, 1, sr, sr * 2, 2, 16,
                       b"data", 0xFFFFFFFF)
