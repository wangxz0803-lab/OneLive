// 唯一权威格式在 engine/service/protocol.py（_FMT="<HBBQQ" =
// magic u16 0x4F4C | version u8 1 | channel u8 | seq u64 | ts_ms u64，
// 全部 little-endian，后接 JPEG payload）。任何格式改动以 protocol.py 为准，
// 并同步 frame.test.ts 的 Python pack_frame 金样。

export const HEADER_LEN = 20;
export const MAGIC = 0x4f4c;
export const VERSION = 1;

/**
 * 编码一帧：20 字节定长头 + payload，逐字节等价于 protocol.py 的 pack_frame。
 * seq/ts 接受 number（capture.html 用 Date.now()，可超 u32）或 bigint。
 */
export function encodeFrame(
  channel: number,
  seq: number | bigint,
  tsMs: number | bigint,
  payload: Uint8Array
): Uint8Array {
  const out = new Uint8Array(HEADER_LEN + payload.length);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, MAGIC, true);
  dv.setUint8(2, VERSION);
  dv.setUint8(3, channel & 0xff);
  dv.setBigUint64(4, BigInt(seq), true);
  dv.setBigUint64(12, BigInt(tsMs), true);
  out.set(payload, HEADER_LEN);
  return out;
}
