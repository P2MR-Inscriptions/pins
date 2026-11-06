// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { ENTRY, STATUS } from "./index.mjs";

test("the indexer reference does not open a socket from the package entry", () => {
  assert.equal(STATUS, "reference");
  assert.equal(ENTRY, "./pins.ts");
});
