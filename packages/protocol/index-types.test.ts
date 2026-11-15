// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

test("the type file of the protocol constants names every export", async () => {
  const module = await import("./index.mjs");
  const declared = [...readFileSync(join(HERE, "index.d.mts"), "utf8").matchAll(/^export const (\w+)/gm)].map((match) => match[1]);
  assert.deepEqual(declared.sort(), Object.keys(module).sort());
});

test("marketplace finality is defined once, and the indexer reads it from there", async () => {
  const module = await import("./index.mjs");
  assert.equal(module.CONFIRMATIONS_FINAL, 6);
  const collection = readFileSync(join(HERE, "../indexer/collection.ts"), "utf8");
  assert.match(collection, /import \{ CONFIRMATIONS_FINAL \} from "\.\.\/protocol\/index\.mjs";/);
  assert.doesNotMatch(collection, /const CONFIRMATIONS_FINAL\b/);
});
