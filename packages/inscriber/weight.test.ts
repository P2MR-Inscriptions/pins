// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { packEnvelopes, revealSerialized, revealWeight } from "./weight.ts";

test("the weight formula matches the serializer", () => {
  for (const leaf of [40, 252, 20_000, 70_000, 395_000]) {
    for (const outputs of [1, 252, 253, 625]) {
      assert.equal(revealWeight(leaf, outputs), revealSerialized(leaf, outputs).length);
    }
  }
});

test("batches stay inside the standard weight limit", () => {
  const batches = packEnvelopes(Array.from({ length: 10 }, () => 200_000));
  assert.equal(batches.length, 10);
  assert.ok(batches.every((batch) => batch.weight <= 400_000));
});

test("a large 625-output reveal has 3855 bytes of fixed overhead", () => {
  const leaf = 34 + 100_000;
  const overhead = revealWeight(leaf, 625) - (leaf - 34) - 43 * 625;
  assert.equal(overhead, 3855);
});
