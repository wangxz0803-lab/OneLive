// 唯一权威格式在 engine/service/protocol.py（_FMT="<HBBQQ"）。此测试用 Python
// pack_frame 金样逐字节钉死本 TS 编码器。金样已 VERIFIED。
import { HEADER_LEN, MAGIC, VERSION, encodeFrame } from "./frame";

const toHex = (u: Uint8Array): string =>
  Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");

describe("frame constants", () => {
  it("matches protocol.py header layout", () => {
    expect(HEADER_LEN).toBe(20);
    expect(MAGIC).toBe(0x4f4c);
    expect(VERSION).toBe(1);
  });
});

describe("encodeFrame golden (protocol.py pack_frame)", () => {
  it("reproduces the verified python golden hex", () => {
    const out = encodeFrame(
      7,
      0x0102030405060708n,
      0x1112131415161718n,
      new Uint8Array([0xff, 0xd8, 0xaa])
    );
    expect(toHex(out)).toBe(
      "4c4f010708070605040302011817161514131211ffd8aa"
    );
  });

  it("emits a header of HEADER_LEN + payload length", () => {
    const out = encodeFrame(0, 0n, 0n, new Uint8Array([0x01, 0x02]));
    expect(out.length).toBe(HEADER_LEN + 2);
  });
});

describe("encodeFrame field encoding", () => {
  it("masks channel to a u8", () => {
    const out = encodeFrame(0x107, 0n, 0n, new Uint8Array());
    expect(out[3]).toBe(0x07);
  });

  it("writes the magic little-endian (low byte first)", () => {
    const out = encodeFrame(0, 0n, 0n, new Uint8Array());
    expect(out[0]).toBe(0x4c);
    expect(out[1]).toBe(0x4f);
  });

  it("accepts number seq/ts (capture.html uses Date.now()) read back LE", () => {
    const seq = 42;
    const ts = 1_700_000_000_000; // Date.now()-style ms, exceeds u32
    const out = encodeFrame(3, seq, ts, new Uint8Array([0xaa]));
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    expect(dv.getBigUint64(4, true)).toBe(BigInt(seq));
    expect(dv.getBigUint64(12, true)).toBe(BigInt(ts));
    expect(out[3]).toBe(3);
    expect(out[HEADER_LEN]).toBe(0xaa);
  });
});
