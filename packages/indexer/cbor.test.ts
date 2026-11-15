// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decodeCbor } from "./cbor.ts";

test("definite false, true, and null are distinct from a missing key", () => {
  const decoded = decodeCbor(Uint8Array.of(
    0xa3,
    0x61, 0x61, 0xf4,
    0x61, 0x62, 0xf5,
    0x61, 0x63, 0xf6,
  )) as Record<string, unknown>;
  assert.equal(decoded.a, false);
  assert.equal(decoded.b, true);
  assert.equal(decoded.c, null);
  assert.equal("d" in decoded, false);
  assert.notEqual(decoded.a, undefined);
  assert.notEqual(decoded.c, undefined);
  assert.notEqual(decoded.a, null);
});

test("an unknown key is retained so a reader can ignore it", () => {
  const decoded = decodeCbor(Uint8Array.of(
    0xa2,
    0x64, 0x6d, 0x65, 0x74, 0x61, 0xa1, 0x64, 0x6e, 0x61, 0x6d, 0x65, 0x61, 0x78,
    0x65, 0x65, 0x78, 0x74, 0x72, 0x61, 0xf4,
  )) as { meta: { name: string }; extra: boolean };
  assert.equal(decoded.meta.name, "x");
  assert.equal(decoded.extra, false);
});

test("floats, undefined, indefinite lengths, and a non-canonical simple value are rejected", () => {
  assert.throws(() => decodeCbor(Uint8Array.of(0xf9, 0x00, 0x00)), /simple value|unsupported CBOR/);
  assert.throws(() => decodeCbor(Uint8Array.of(0xf7)), /simple value/);
  assert.throws(() => decodeCbor(Uint8Array.of(0x9f, 0xff)), /indefinite/);
  assert.throws(() => decodeCbor(Uint8Array.of(0xf8, 0x14)), /simple value/);
  assert.throws(() => decodeCbor(Uint8Array.of(0xc0, 0x00)), /tag/);
});

test("a nested map and array still decode", () => {
  const decoded = decodeCbor(Uint8Array.of(0x81, 0xa1, 0x61, 0x6b, 0x01)) as [{ k: number }];
  assert.equal(decoded[0].k, 1);
});

test("a truncated header and an oversized declared length are rejected before the loop", () => {
  assert.throws(() => decodeCbor(Uint8Array.of(0x9b, 0x00, 0x01)), /truncated/);
  assert.throws(() => decodeCbor(Uint8Array.of(0x9b, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00)), /exceeds data/);
  assert.throws(() => decodeCbor(Uint8Array.of(0xa1)), /exceeds data|truncated/);
});

test("a declared array of twenty million items does not exhaust a small heap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pins-cbor-"));
  const file = join(dir, "child.mts");
  writeFileSync(file, `
    import { decodeCbor } from ${JSON.stringify(join(process.cwd(), "packages/indexer/cbor.ts"))};
    const header = Uint8Array.of(0x9b, 0x00, 0x00, 0x00, 0x00, 0x01, 0x31, 0x2d, 0x00);
    try { decodeCbor(header); console.log("RETURNED"); }
    catch (error) { console.log("THREW"); }
  `);
  const child = spawn(process.execPath, ["--max-old-space-size=64", "--experimental-strip-types", file], { timeout: 4000 });
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { out += chunk; });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(code, 0);
  assert.match(out, /THREW/);
  assert.equal(out.includes("RETURNED"), false);
});

test("a map key named __proto__ is kept as an own key and does not change the prototype", () => {
  const key = Uint8Array.of(0x69, ...Buffer.from("__proto__"));
  const decoded = decodeCbor(Uint8Array.of(0xa2, ...key, 0xa1, 0x61, 0x61, 0x01, 0x61, 0x78, 0xf5)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(decoded), ["__proto__", "x"]);
  assert.equal(Object.getPrototypeOf(decoded), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(decoded, "__proto__")?.value, { a: 1 });
  assert.equal((decoded as { a?: number }).a, undefined);
  assert.equal(decoded.x, true);
});

test("a __proto__ key with a scalar value is kept", () => {
  const key = Uint8Array.of(0x69, ...Buffer.from("__proto__"));
  const decoded = decodeCbor(Uint8Array.of(0xa1, ...key, 0x07)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(decoded), ["__proto__"]);
  assert.equal(Object.getOwnPropertyDescriptor(decoded, "__proto__")?.value, 7);
});

test("a repeated key keeps the last value at the position of the first", () => {
  const decoded = decodeCbor(Uint8Array.of(0xa3, 0x61, 0x61, 0x01, 0x61, 0x62, 0x02, 0x61, 0x61, 0x03));
  assert.deepEqual(Object.entries(decoded as Record<string, unknown>), [["a", 3], ["b", 2]]);
});

test("a leading byte order mark in a text string is kept", () => {
  assert.equal(decodeCbor(Uint8Array.of(0x65, 0xef, 0xbb, 0xbf, 0x61, 0x62)), "\ufeffab");
  const decoded = decodeCbor(Uint8Array.of(0xa1, 0x64, 0xef, 0xbb, 0xbf, 0x61, 0xf4)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(decoded), ["\ufeffa"]);
  assert.equal(decoded.a, undefined);
});
