// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { MARKER, OP_ENDIF, OP_FALSE, OP_IF, buildEnvelope, concatBytes, contentTypeField, decodeScript, metadataField, parseEnvelopes, pushBytes, revealLeaf } from "./script.ts";

const text = (value: string) => new TextEncoder().encode(value);
const EMPTY = new Uint8Array();

/** An envelope from raw pushes, so a test can place an empty push anywhere. */
function envelopeOf(pushes: Uint8Array[]): Uint8Array {
  return concatBytes([Uint8Array.of(OP_FALSE, OP_IF), pushBytes(MARKER), ...pushes.map((push) => pushBytes(push)), Uint8Array.of(OP_ENDIF)]);
}

function only(pushes: Uint8Array[]) {
  const found = parseEnvelopes(envelopeOf(pushes));
  assert.equal(found.length, 1);
  return found[0];
}

test("an empty value before the separator is a value, not the separator", () => {
  const parsed = only([Uint8Array.of(1), EMPTY, Uint8Array.of(5), Uint8Array.of(0xaa), EMPTY, Uint8Array.of(0x42)]);
  assert.deepEqual(parsed.flags, []);
  assert.deepEqual(parsed.fields.map((field) => [field.tag, [...field.value]]), [[1, []], [5, [0xaa]]]);
  assert.deepEqual([...parsed.body], [0x42]);
});

test("a pointer with an empty value keeps the body that follows the separator", () => {
  const parsed = only([Uint8Array.of(2), EMPTY, EMPTY, text("body")]);
  assert.deepEqual(parsed.flags, []);
  assert.deepEqual(parsed.fields.map((field) => [field.tag, field.value.length]), [[2, 0]]);
  assert.equal(new TextDecoder().decode(parsed.body), "body");
});

test("the first empty push at a tag position is the separator, and later empty pushes are body pushes", () => {
  const parsed = only([Uint8Array.of(1), text("a"), EMPTY, EMPTY, Uint8Array.of(7), EMPTY, Uint8Array.of(9)]);
  assert.deepEqual(parsed.flags, []);
  assert.deepEqual(parsed.fields.map((field) => field.tag), [1]);
  assert.deepEqual([...parsed.body], [7, 9]);
});

test("a separator at the end gives an empty body and no flag", () => {
  const parsed = only([Uint8Array.of(1), text("a"), EMPTY]);
  assert.deepEqual(parsed.flags, []);
  assert.equal(parsed.body.length, 0);
});

test("a dangling tag is ignored and the envelope has no body", () => {
  const parsed = only([Uint8Array.of(1), text("a"), Uint8Array.of(5)]);
  assert.deepEqual(parsed.flags, ["no_body", "incomplete_field"]);
  assert.deepEqual(parsed.fields.map((field) => field.tag), [1]);
  assert.equal(parsed.body.length, 0);
});

test("a multi-byte tag with an even first byte makes the inscription opaque", () => {
  assert.deepEqual(only([Uint8Array.of(0x04, 0x00), text("x"), EMPTY]).flags, ["opaque"]);
  assert.deepEqual(only([Uint8Array.of(0x04, 0x01), text("x"), EMPTY]).flags, ["opaque"]);
  assert.deepEqual(only([Uint8Array.of(0x02, 0x00, 0x00), text("x"), EMPTY]).flags, ["opaque"]);
});

test("a multi-byte tag with an odd first byte is ignored", () => {
  const parsed = only([Uint8Array.of(0x05, 0x00), text("x"), Uint8Array.of(1), text("t"), EMPTY]);
  assert.deepEqual(parsed.flags, []);
  assert.deepEqual(parsed.fields.map((field) => field.tag), [1]);
});

test("a multi-byte tag is never a field, even when its first byte is a known tag", () => {
  const parsed = only([Uint8Array.of(0x01, 0x00), text("x"), EMPTY]);
  assert.deepEqual(parsed.flags, []);
  assert.equal(parsed.fields.length, 0);
});

test("the known even tag 2 does not make an inscription opaque", () => {
  assert.deepEqual(only([Uint8Array.of(2), Uint8Array.of(1), EMPTY]).flags, []);
});

// PINS-1 §5.3: a chunked field is written as the tag and a chunk of at most 520 bytes, repeated.
const pattern = (length: number): Uint8Array => Uint8Array.from({ length }, (_, index) => (index * 7 + 3) % 251);

for (const length of [0, 1, 519, 520, 521, 1039, 1040, 1041, 2000]) {
  test(`a field 5 of ${length} bytes is written and read back whole`, () => {
    const value = pattern(length);
    const envelope = buildEnvelope([contentTypeField("image/png"), metadataField(value)], Uint8Array.of(7, 8, 9));
    const [parsed, ...rest] = parseEnvelopes(envelope);
    assert.equal(rest.length, 0);
    assert.deepEqual(parsed.flags, []);
    const field5 = parsed.fields.find((field) => field.tag === 5);
    assert.deepEqual([...(field5?.value ?? [])], [...value]);
    assert.deepEqual([...parsed.body], [7, 8, 9]);
    assert.equal(parsed.fields.find((field) => field.tag === 1)?.value.length, "image/png".length);
  });
}

test("the tag repeats once per chunk and no push is longer than 520 bytes", () => {
  const envelope = buildEnvelope([metadataField(pattern(1041))], Uint8Array.of(1));
  const program = decodeScript(envelope) ?? [];
  // OP_FALSE OP_IF, then every push up to OP_ENDIF: marker, (tag, chunk) three times, separator, body
  assert.equal(program[0].opcode, OP_FALSE);
  assert.equal(program[1].opcode, OP_IF);
  const pushes = program.slice(2, -1).map((instruction) => instruction.data as Uint8Array);
  assert.equal(pushes.length, 1 + 6 + 1 + 1);
  assert.deepEqual(pushes[0], MARKER);
  assert.deepEqual([pushes[1], pushes[3], pushes[5]].map((push) => [...push]), [[5], [5], [5]]);
  assert.deepEqual([pushes[2], pushes[4], pushes[6]].map((push) => push.length), [520, 520, 1]);
  assert.ok(pushes.every((push) => push.length <= 520));
});

test("a field of one chunk is written as before", () => {
  const value = pattern(40);
  const envelope = buildEnvelope([contentTypeField("image/png"), metadataField(value)], Uint8Array.of(1));
  const expected = concatBytes([
    Uint8Array.of(OP_FALSE, OP_IF), pushBytes(MARKER),
    pushBytes(Uint8Array.of(1)), pushBytes(text("image/png")),
    pushBytes(Uint8Array.of(5)), pushBytes(value),
    pushBytes(EMPTY), pushBytes(Uint8Array.of(1)), Uint8Array.of(OP_ENDIF),
  ]);
  assert.deepEqual([...envelope], [...expected]);
});

test("a value that is not chunked and does not fit in one push is refused", () => {
  assert.throws(() => buildEnvelope([contentTypeField("x".repeat(521))], Uint8Array.of(1)), /not chunked/);
  assert.doesNotThrow(() => buildEnvelope([contentTypeField("x".repeat(520))], Uint8Array.of(1)));
  assert.throws(() => buildEnvelope([{ tag: 7, value: pattern(600) }], Uint8Array.of(1)), /not chunked/);
});

test("a long field 5 survives a whole reveal leaf, next to a second envelope", () => {
  const long = pattern(1500);
  const leaf = revealLeaf(Uint8Array.from({ length: 32 }, () => 2), [
    buildEnvelope([contentTypeField("image/png"), metadataField(long)], pattern(900)),
    buildEnvelope([contentTypeField("text/plain")], text("tail")),
  ]);
  const found = parseEnvelopes(leaf);
  assert.equal(found.length, 2);
  assert.deepEqual([...(found[0].fields.find((field) => field.tag === 5)?.value ?? [])], [...long]);
  assert.deepEqual([...found[0].body], [...pattern(900)]);
  assert.equal(new TextDecoder().decode(found[1].body), "tail");
});

test("the reader does not read the old form as one whole field 5", () => {
  // tag 5, then two chunks after one tag: the second chunk stands where a tag belongs.
  const old = envelopeOf([Uint8Array.of(5), pattern(520), pattern(80), EMPTY, Uint8Array.of(1)]);
  const [parsed] = parseEnvelopes(old);
  assert.equal(parsed.fields.find((field) => field.tag === 5)?.value.length, 520);
  assert.ok(parsed.flags.includes("incomplete_field"));
});
