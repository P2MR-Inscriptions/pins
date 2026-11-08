// SPDX-License-Identifier: Apache-2.0

/**
 * Definite-length CBOR reader for the maps PINS-4 puts in field 5.
 * Indefinite lengths and tags are rejected so a weird encoding cannot sneak in.
 */

export function decodeCbor(data: Uint8Array): unknown {
  const [value, offset] = read(data, 0);
  if (offset !== data.length) throw new Error("CBOR has trailing bytes");
  return value;
}

function read(data: Uint8Array, offset: number): [unknown, number] {
  const major = data[offset] >> 5;
  const info = data[offset] & 0x1f;
  if (info === 31) throw new Error("indefinite CBOR is not accepted");
  let argument = BigInt(info);
  let next = offset + 1;
  if (info > 27) throw new Error("invalid CBOR argument");
  if (info > 23) {
    const width = 1 << (info - 24);
    argument = 0n;
    for (let i = 0; i < width; i += 1) argument = (argument << 8n) | BigInt(data[next + i]);
    next += width;
  }
  if (major === 0) return [argument <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(argument) : argument, next];
  if (major === 1) return [argument <= BigInt(Number.MAX_SAFE_INTEGER) ? -1 - Number(argument) : -1n - argument, next];
  if (major === 2) return [data.slice(next, next + Number(argument)), next + Number(argument)];
  if (major === 3) return [new TextDecoder().decode(data.slice(next, next + Number(argument))), next + Number(argument)];
  if (major === 4) {
    const items: unknown[] = [];
    for (let i = 0; i < Number(argument); i += 1) {
      const [item, after] = read(data, next);
      items.push(item);
      next = after;
    }
    return [items, next];
  }
  if (major === 5) {
    const map: Record<string, unknown> = {};
    for (let i = 0; i < Number(argument); i += 1) {
      const [key, afterKey] = read(data, next);
      const [value, afterValue] = read(data, afterKey);
      if (typeof key !== "string") throw new Error("CBOR map key is not text");
      map[key] = value;
      next = afterValue;
    }
    return [map, next];
  }
  throw new Error("unsupported CBOR major type");
}
