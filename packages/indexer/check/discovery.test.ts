// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";

test("the root test command discovers a nested TypeScript test", () => {
  assert.equal(1 + 1, 2);
});
