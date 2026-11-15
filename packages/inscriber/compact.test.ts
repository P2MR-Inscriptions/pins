// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { readCompactSize, writeCompactSize } from "./compact.ts";

function roundTrip(value: number): number {
  const encoded = writeCompactSize(value);
  const decoded = readCompactSize(encoded, 0);
  assert.equal(decoded.next, encoded.length);
  return decoded.value;
}

test("compact size uses the canonical width at the boundaries", () => {
  assert.deepEqual([...writeCompactSize(0xfc)], [0xfc]);
  assert.deepEqual([...writeCompactSize(0xfd)], [0xfd, 0xfd, 0x00]);
  assert.deepEqual([...writeCompactSize(0xffff)], [0xfd, 0xff, 0xff]);
  assert.deepEqual([...writeCompactSize(0x10000)], [0xfe, 0x00, 0x00, 0x01, 0x00]);
  assert.equal(roundTrip(0xfc), 0xfc);
  assert.equal(roundTrip(0xfd), 0xfd);
  assert.equal(roundTrip(0xffff), 0xffff);
  assert.equal(roundTrip(0x10000), 0x10000);
  assert.equal(roundTrip(0x100000000), 0x100000000);
});

test("compact size rejects a non-canonical or truncated prefix", () => {
  assert.throws(() => readCompactSize(Uint8Array.of(0xfd, 0xfc, 0x00), 0), /non-canonical/);
  assert.throws(() => readCompactSize(Uint8Array.of(0xfe, 0xff, 0xff, 0x00, 0x00), 0), /non-canonical/);
  assert.throws(() => readCompactSize(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00), 0), /non-canonical/);
  assert.throws(() => readCompactSize(Uint8Array.of(0xfe, 0x00, 0x00), 0), /truncated/);
  assert.throws(() => readCompactSize(Uint8Array.of(0xfd), 1), /truncated/);
});
