"""引擎服务二进制帧协议：20 字节定长头 + JPEG payload。

头部布局（little-endian）：magic u16 = 0x4F4C ("OL") | version u8 | channel u8 |
seq u64 | ts_ms u64（发送方 epoch 毫秒）。控制消息走 JSON 文本帧，不经此模块。
"""

import struct
from dataclasses import dataclass

_MAGIC = 0x4F4C
_VERSION = 1
_FMT = "<HBBQQ"
_HEADER_LEN = struct.calcsize(_FMT)  # 20


@dataclass(frozen=True)
class FrameHeader:
    seq: int
    ts_ms: int
    channel: int = 0


def pack_frame(header: FrameHeader, payload: bytes) -> bytes:
    return struct.pack(_FMT, _MAGIC, _VERSION, header.channel,
                       header.seq, header.ts_ms) + payload


def unpack_frame(blob: bytes) -> tuple[FrameHeader, bytes]:
    if len(blob) < _HEADER_LEN:
        raise ValueError(f"frame blob too short: {len(blob)} < {_HEADER_LEN}")
    magic, version, channel, seq, ts_ms = struct.unpack_from(_FMT, blob)
    if magic != _MAGIC or version != _VERSION:
        raise ValueError(f"bad magic/version: {magic:#x}/{version}")
    return FrameHeader(seq=seq, ts_ms=ts_ms, channel=channel), blob[_HEADER_LEN:]
