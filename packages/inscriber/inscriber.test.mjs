// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { BROADCAST_ENABLED, ENTRY, STATUS } from "./index.mjs";

test("the inscriber reference does not broadcast from the package entry", () => {
  assert.equal(STATUS, "reference");
  assert.equal(BROADCAST_ENABLED, false);
  assert.equal(ENTRY, "./reveal.ts");
});
