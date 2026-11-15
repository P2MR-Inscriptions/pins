// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { decodeScript } from "./script.ts";

test("PUSHDATA1, PUSHDATA2, and PUSHDATA4 keep a one-byte push", () => {
  const one = Uint8Array.of(0x4c, 0x01, 0xab);
  const two = Uint8Array.of(0x4d, 0x01, 0x00, 0xab);
  const four = Uint8Array.of(0x4e, 0x01, 0x00, 0x00, 0x00, 0xab);
  for (const script of [one, two, four]) {
    const decoded = decodeScript(script);
    assert.ok(decoded);
    assert.equal(decoded.length, 1);
    assert.equal(decoded[0].data?.[0], 0xab);
  }
});

test("PUSHDATA4 with the high bit set returns null without allocating the declared length", () => {
  const started = Date.now();
  const decoded = decodeScript(Uint8Array.of(0x4e, 0x00, 0x00, 0x00, 0x80));
  assert.equal(decoded, null);
  assert.ok(Date.now() - started < 1000);
});

test("a truncated PUSHDATA2 returns null", () => {
  assert.equal(decodeScript(Uint8Array.of(0x4d, 0x02, 0x00, 0xab)), null);
});
