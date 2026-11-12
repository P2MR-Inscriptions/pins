// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { MARKER, OP_ENDIF, OP_FALSE, OP_IF, concatBytes, parseEnvelopes, pushBytes } from "./script.ts";

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
