// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decodeCbor } from "../server/cbor.ts";

test("false, true, and null stay distinct", () => {
  const decoded = decodeCbor(Uint8Array.of(0xa1, 0x61, 0x61, 0xf4)) as { a: boolean };
  assert.equal(decoded.a, false);
  assert.throws(() => decodeCbor(Uint8Array.of(0x9b, 0x00, 0x01)), /truncated/);
  assert.throws(() => decodeCbor(Uint8Array.of(0xf9, 0x00, 0x00)), /simple value/);
});

test("a declared array of twenty million items does not exhaust a small heap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pins-cbor-"));
  const file = join(dir, "child.mts");
  writeFileSync(file, `
    import { decodeCbor } from ${JSON.stringify(join(process.cwd(), "server/cbor.ts"))};
    const header = Uint8Array.of(0x9b, 0x00, 0x00, 0x00, 0x00, 0x01, 0x31, 0x2d, 0x00);
    try { decodeCbor(header); console.log("RETURNED"); }
    catch { console.log("THREW"); }
  `);
  const child = spawn(process.execPath, ["--max-old-space-size=64", "--experimental-strip-types", file], { timeout: 4000 });
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { out += chunk; });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(code, 0);
  assert.match(out, /THREW/);
});
