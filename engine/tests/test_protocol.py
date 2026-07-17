import pytest

from service.protocol import FrameHeader, pack_frame, unpack_frame


def test_frame_roundtrip():
    payload = b"\xff\xd8fakejpeg"
    header = FrameHeader(seq=42, ts_ms=1234567890123, channel=0)
    blob = pack_frame(header, payload)
    h2, p2 = unpack_frame(blob)
    assert h2 == header
    assert p2 == payload


def test_unpack_rejects_short_blob():
    with pytest.raises(ValueError):
        unpack_frame(b"tiny")


def test_unpack_rejects_bad_magic_or_version():
    with pytest.raises(ValueError):
        unpack_frame(b"\x00" * 20)          # bad magic
    good = pack_frame(FrameHeader(seq=1, ts_ms=1), b"")
    tampered = good[:2] + b"\x02" + good[3:]  # version byte -> 2
    with pytest.raises(ValueError):
        unpack_frame(tampered)


def test_seq_and_ts_ranges():
    h = FrameHeader(seq=2**31, ts_ms=2**52, channel=255)
    h2, _ = unpack_frame(pack_frame(h, b"x"))
    assert h2.seq == 2**31 and h2.ts_ms == 2**52 and h2.channel == 255
