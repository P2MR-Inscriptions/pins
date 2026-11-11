// SPDX-License-Identifier: Apache-2.0

/**
 * Definite-length CBOR reader for the maps PINS-4 puts in field 5.
 * Lengths are checked before any allocation. Indefinite lengths, tags, floats,
 * and non-canonical integer widths are rejected.
 * This copy must stay aligned with packages/indexer/cbor.ts.
 */

const MAX_DEPTH = 32;

export function decodeCbor(data: Uint8Array): unknown {
  const [value, offset] = read(data, 0, 0);
  if (offset !== data.length) throw new Error("CBOR has trailing bytes");
  return value;
}

function read(data: Uint8Array, offset: number, depth: number): [unknown, number] {
  if (depth > MAX_DEPTH) throw new Error("CBOR nesting is too deep");
  if (offset >= data.length) throw new Error("CBOR truncated");
  const major = data[offset] >> 5;
  const info = data[offset] & 0x1f;
  if (info === 31) throw new Error("indefinite CBOR is not accepted");
  if (info > 27) throw new Error("invalid CBOR argument");
  let argument = BigInt(info);
  let next = offset + 1;
  if (info > 23) {
    const width = 1 << (info - 24);
    if (next + width > data.length) throw new Error("CBOR truncated");
    argument = 0n;
    for (let i = 0; i < width; i += 1) argument = (argument << 8n) | BigInt(data[next + i] ?? 0);
    if (major !== 7) {
      if (width === 1 && argument < 24n) throw new Error("non-canonical CBOR integer");
      if (width === 2 && argument <= 0xffn) throw new Error("non-canonical CBOR integer");
      if (width === 4 && argument <= 0xffffn) throw new Error("non-canonical CBOR integer");
      if (width === 8 && argument <= 0xffffffffn) throw new Error("non-canonical CBOR integer");
    }
    next += width;
  }
  const asLength = (): number => {
    if (argument > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CBOR length exceeds data");
    return Number(argument);
  };
  if (major === 0) return [argument <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(argument) : argument, next];
  if (major === 1) return [argument <= BigInt(Number.MAX_SAFE_INTEGER) ? -1 - Number(argument) : -1n - argument, next];
  if (major === 2 || major === 3) {
    const count = asLength();
    if (next + count > data.length) throw new Error("CBOR length exceeds data");
    const slice = data.subarray(next, next + count);
    if (major === 2) return [slice, next + count];
    return [new TextDecoder("utf-8", { fatal: true }).decode(slice), next + count];
  }
  if (major === 4) {
    const count = asLength();
    if (count > data.length - next) throw new Error("CBOR length exceeds data");
    const items: unknown[] = [];
    for (let i = 0; i < count; i += 1) {
      const [item, after] = read(data, next, depth + 1);
      items.push(item);
      next = after;
    }
    return [items, next];
  }
  if (major === 5) {
    const count = asLength();
    if (count > Math.floor((data.length - next) / 2)) throw new Error("CBOR length exceeds data");
    const map: Record<string, unknown> = {};
    for (let i = 0; i < count; i += 1) {
      const [key, afterKey] = read(data, next, depth + 1);
      const [value, afterValue] = read(data, afterKey, depth + 1);
      if (typeof key !== "string") throw new Error("CBOR map key is not text");
      map[key] = value;
      next = afterValue;
    }
    return [map, next];
  }
  if (major === 6) throw new Error("CBOR tags are not accepted");
  if (major === 7) {
    if (info > 23) throw new Error("unsupported CBOR simple value");
    if (info === 20) return [false, next];
    if (info === 21) return [true, next];
    if (info === 22) return [null, next];
    throw new Error("unsupported CBOR simple value");
  }
  throw new Error("unsupported CBOR major type");
}
