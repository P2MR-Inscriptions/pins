// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { TipCache } from "./tip-cache.ts";

test("an entry is computed once for a tip, and again for the next tip", async () => {
  const cache = new TipCache();
  let runs = 0;
  const compute = () => { runs += 1; return runs; };
  assert.equal(await cache.get("tip1", "a", compute), 1);
  assert.equal(await cache.get("tip1", "a", compute), 1);
  assert.equal(await cache.get("tip1", "b", compute), 2);
  assert.deepEqual([cache.hits, cache.misses], [1, 2]);
  // A new tip drops every entry, and so does going back to an older one (a reorg).
  assert.equal(await cache.get("tip2", "a", compute), 3);
  assert.equal(await cache.get("tip1", "a", compute), 4);
});

test("requests for one entry that overlap share one computation", async () => {
  const cache = new TipCache();
  let runs = 0;
  const slow = async () => { runs += 1; await new Promise((resolve) => setTimeout(resolve, 10)); return "done"; };
  const results = await Promise.all([cache.get("t", "a", slow), cache.get("t", "a", slow), cache.get("t", "a", slow)]);
  assert.deepEqual(results, ["done", "done", "done"]);
  assert.equal(runs, 1);
});

test("a computation that fails is not kept", async () => {
  const cache = new TipCache();
  let runs = 0;
  const flaky = () => { runs += 1; if (runs === 1) throw new Error("first run fails"); return "ok"; };
  await assert.rejects(cache.get("t", "a", flaky), /first run fails/);
  assert.equal(await cache.get("t", "a", flaky), "ok");
  assert.equal(runs, 2);
});
