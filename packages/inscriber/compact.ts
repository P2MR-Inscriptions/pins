// SPDX-License-Identifier: Apache-2.0

/**
 * CompactSize, the integer prefix on vectors and witness items.
 * A short form is required: 0xfd only at 253 and above, 0xfe only at 65536
 * and above, 0xff only at 2^32 and above. Anything else is non-canonical.
 * The prefix must be inside `raw`. Values that do not fit a safe integer
 * are rejected.
 */
export function readCompactSize(raw: Uint8Array, offset: number): { value: number; next: number } {
  if (offset < 0 || offset >= raw.length) throw new Error("transaction is truncated");
  const head = raw[offset];
  if (head < 0xfd) return { value: head, next: offset + 1 };
  if (head === 0xfd) {
    if (offset + 3 > raw.length) throw new Error("transaction is truncated");
    const value = raw[offset + 1] | (raw[offset + 2] << 8);
    if (value < 0xfd) throw new Error("non-canonical compact size");
    return { value, next: offset + 3 };
  }
  if (head === 0xfe) {
    if (offset + 5 > raw.length) throw new Error("transaction is truncated");
    const value = new DataView(raw.buffer, raw.byteOffset + offset + 1, 4).getUint32(0, true);
    if (value < 0x10000) throw new Error("non-canonical compact size");
    return { value, next: offset + 5 };
  }
  if (offset + 9 > raw.length) throw new Error("transaction is truncated");
  const wide = new DataView(raw.buffer, raw.byteOffset + offset + 1, 8).getBigUint64(0, true);
  if (wide < 0x100000000n) throw new Error("non-canonical compact size");
  if (wide > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("compact size is out of range");
  return { value: Number(wide), next: offset + 9 };
}

export function compactSizeLength(value: number): number {
  assertCompactRange(value);
  if (value < 0xfd) return 1;
  if (value <= 0xffff) return 3;
  if (value <= 0xffffffff) return 5;
  return 9;
}

export function writeCompactSize(value: number): Uint8Array {
  assertCompactRange(value);
  if (value < 0xfd) return Uint8Array.of(value);
  if (value <= 0xffff) return Uint8Array.of(0xfd, value & 0xff, value >> 8);
  if (value <= 0xffffffff) {
    const out = new Uint8Array(5);
    out[0] = 0xfe;
    new DataView(out.buffer).setUint32(1, value, true);
    return out;
  }
  const out = new Uint8Array(9);
  out[0] = 0xff;
  new DataView(out.buffer).setBigUint64(1, BigInt(value), true);
  return out;
}

function assertCompactRange(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error("compact size is out of range");
  }
}
