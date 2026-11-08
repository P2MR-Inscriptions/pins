// SPDX-License-Identifier: Apache-2.0

/**
 * PINS-1 script and envelope encoding.
 *
 * Pushes inside the unexecuted OP_FALSE OP_IF branch are still limited to 520
 * bytes, so bodies and chunked metadata are split. The branch never places
 * those bytes on the stack.
 */

export const OP_FALSE = 0x00;
export const OP_IF = 0x63;
export const OP_ENDIF = 0x68;
export const OP_CHECKSIGPQC = 0xb3;
export const OP_PUSHDATA1 = 0x4c;
export const OP_PUSHDATA2 = 0x4d;
export const MARKER = new Uint8Array([0x70, 0x69, 0x6e, 0x73]);
export const MAX_PUSH = 520;
export const POSTAGE = 10_000n;

export type ScriptInstruction = {
  opcode: number;
  /** Data a push places, including the one-byte values of OP_1..OP_16. */
  data: Uint8Array | null;
};

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Minimal data push, or a deliberately non-minimal PUSHDATA1 when asked. */
export function pushBytes(data: Uint8Array, minimal = true): Uint8Array {
  if (!minimal && data.length <= 0xff) {
    return concatBytes([Uint8Array.of(OP_PUSHDATA1, data.length), data]);
  }
  if (data.length === 0) return Uint8Array.of(OP_FALSE);
  if (data.length === 1 && data[0] === 0x81) return Uint8Array.of(0x4f);
  if (data.length === 1 && data[0] >= 1 && data[0] <= 16) return Uint8Array.of(0x50 + data[0]);
  if (data.length <= 75) return concatBytes([Uint8Array.of(data.length), data]);
  if (data.length <= 0xff) return concatBytes([Uint8Array.of(OP_PUSHDATA1, data.length), data]);
  if (data.length <= 0xffff) {
    const head = new Uint8Array(3);
    head[0] = OP_PUSHDATA2;
    head[1] = data.length & 0xff;
    head[2] = (data.length >> 8) & 0xff;
    return concatBytes([head, data]);
  }
  const head = new Uint8Array(5);
  head[0] = 0x4e;
  new DataView(head.buffer).setUint32(1, data.length, true);
  return concatBytes([head, data]);
}

export function chunks(data: Uint8Array, size = MAX_PUSH): Uint8Array[] {
  if (data.length === 0) return [new Uint8Array()];
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < data.length; offset += size) out.push(data.subarray(offset, offset + size));
  return out;
}

/** Little-endian pointer with trailing zero bytes removed. Zero is empty. */
export function encodePointer(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffffffffffffffffn) throw new Error("pointer does not fit in 8 bytes");
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0n) {
    bytes.push(Number(rest & 0xffn));
    rest >>= 8n;
  }
  return Uint8Array.from(bytes);
}

export type EnvelopeField = { tag: number; value: Uint8Array };

/**
 * One PINS envelope. Tag 0 is reserved for the body separator and is not a field.
 * `minimal` is false only for the Q7 standardness probe.
 */
export function buildEnvelope(fields: EnvelopeField[], body: Uint8Array, minimal = true, marker: Uint8Array = MARKER): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.of(OP_FALSE, OP_IF), pushBytes(marker, minimal)];
  for (const field of fields) {
    if (field.tag < 1 || field.tag > 255) throw new Error("field tag must be one byte");
    parts.push(pushBytes(Uint8Array.of(field.tag), minimal));
    for (const piece of chunks(field.value)) parts.push(pushBytes(piece, minimal));
  }
  parts.push(pushBytes(new Uint8Array(), minimal));
  for (const piece of chunks(body)) parts.push(pushBytes(piece, minimal));
  parts.push(Uint8Array.of(OP_ENDIF));
  return concatBytes(parts);
}

/** `<pubkey> OP_CHECKSIGPQC` plus the envelopes that this reveal publishes. */
export function revealLeaf(pubkey: Uint8Array, envelopes: Uint8Array[]): Uint8Array {
  if (pubkey.length !== 32) throw new Error("pubkey must be 32 bytes");
  return concatBytes([pushBytes(pubkey), Uint8Array.of(OP_CHECKSIGPQC), ...envelopes]);
}

/** Recovery leaf: the same check, and no envelope, so a spend reveals nothing. */
export function recoveryLeaf(pubkey: Uint8Array): Uint8Array {
  return revealLeaf(pubkey, []);
}

export function contentTypeField(mime: string): EnvelopeField {
  return { tag: 1, value: new TextEncoder().encode(mime) };
}

export function pointerField(value: bigint): EnvelopeField {
  return { tag: 2, value: encodePointer(value) };
}

export function metadataField(cbor: Uint8Array): EnvelopeField {
  return { tag: 5, value: cbor };
}

/** Decode a script. A truncated push returns null so the indexer drops the input. */
export function decodeScript(script: Uint8Array): ScriptInstruction[] | null {
  const out: ScriptInstruction[] = [];
  let i = 0;
  while (i < script.length) {
    const opcode = script[i];
    if (opcode === 0) {
      out.push({ opcode, data: new Uint8Array() });
      i += 1;
      continue;
    }
    if (opcode <= 75) {
      if (i + 1 + opcode > script.length) return null;
      out.push({ opcode, data: script.slice(i + 1, i + 1 + opcode) });
      i += 1 + opcode;
      continue;
    }
    if (opcode === OP_PUSHDATA1 || opcode === OP_PUSHDATA2 || opcode === 0x4e) {
      const width = opcode === OP_PUSHDATA1 ? 1 : opcode === OP_PUSHDATA2 ? 2 : 4;
      if (i + 1 + width > script.length) return null;
      let length = 0;
      let scale = 1;
      for (let b = 0; b < width; b += 1) {
        length += script[i + 1 + b] * scale;
        scale *= 256;
      }
      if (!Number.isSafeInteger(length) || length < 0 || i + 1 + width + length > script.length) return null;
      out.push({ opcode, data: script.slice(i + 1 + width, i + 1 + width + length) });
      const next = i + 1 + width + length;
      if (next <= i) return null;
      i = next;
      continue;
    }
    if (opcode === 0x4f) {
      out.push({ opcode, data: Uint8Array.of(0x81) });
      i += 1;
      continue;
    }
    if (opcode >= 0x51 && opcode <= 0x60) {
      out.push({ opcode, data: Uint8Array.of(opcode - 0x50) });
      i += 1;
      continue;
    }
    out.push({ opcode, data: null });
    i += 1;
  }
  return out;
}

export type ParsedEnvelope = {
  fields: { tag: number; value: Uint8Array }[];
  body: Uint8Array;
  flags: string[];
};

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false;
  return true;
}

/** PINS-1 §4. Walk every candidate. A failed candidate resumes one instruction later. */
export function parseEnvelopes(script: Uint8Array, expectedMarker: Uint8Array = MARKER): ParsedEnvelope[] {
  const program = decodeScript(script);
  if (!program) return [];
  const found: ParsedEnvelope[] = [];
  for (let j = 0; j < program.length; j += 1) {
    if (program[j].opcode !== OP_FALSE || program[j + 1]?.opcode !== OP_IF) continue;
    const marker = program[j + 2];
    if (!marker?.data || !sameBytes(marker.data, expectedMarker)) continue;
    let end = j + 3;
    let closed = false;
    for (; end < program.length; end += 1) {
      if (program[end].data === null) {
        if (program[end].opcode === OP_ENDIF) closed = true;
        break;
      }
    }
    if (!closed) continue;
    const pushes = program.slice(j + 3, end).map((instruction) => instruction.data ?? new Uint8Array());
    found.push(readFields(pushes));
    j = end;
  }
  return found;
}

function readFields(pushes: Uint8Array[]): ParsedEnvelope {
  const flags: string[] = [];
  let separator = pushes.findIndex((push) => push.length === 0);
  if (separator < 0) {
    flags.push("no_body");
    separator = pushes.length;
  }
  const head = pushes.slice(0, separator);
  if (head.length % 2 === 1) {
    flags.push("incomplete_field");
    head.pop();
  }
  const fields: { tag: number; value: Uint8Array }[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < head.length; i += 2) {
    const tagBytes = head[i];
    const value = head[i + 1];
    if (tagBytes.length !== 1) continue;
    const tag = tagBytes[0];
    if (tag % 2 === 0 && ![2].includes(tag)) flags.push("opaque");
    if (seen.has(tag) && tag !== 5) flags.push("duplicate_field");
    seen.add(tag);
    const existing = fields.find((field) => field.tag === tag);
    if (existing && tag === 5) existing.value = concatBytes([existing.value, value]);
    else if (!existing) fields.push({ tag, value });
  }
  const bodyParts = pushes.slice(separator + 1);
  return { fields, body: concatBytes(bodyParts), flags };
}
