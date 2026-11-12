// SPDX-License-Identifier: Apache-2.0

/**
 * In text a person reads, "inscription" is always "P2MR Inscription". `scripts/check-terminology.mjs`
 * finds every other occurrence and says why it is allowed (a code identifier, an API path, a JSON
 * key, a test, a code span, a dated history entry). This test fails on any it cannot place.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { scan, spellingProblems } from "../../scripts/check-terminology.mjs";

test("every bare occurrence of the word inscription is a code name, a path, a key, a test or a history entry", () => {
  const rows = scan();
  assert.ok(rows.length > 100, "the scan reads the repository");
  assert.deepEqual(rows.filter((row) => row.category === "UNCLASSIFIED"), []);
});

test("the first mainnet collection is spelled as its genesis spells it, Flatbits", () => {
  assert.deepEqual(spellingProblems(), []);
});
