// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { backHash, backLabel, isDetailHash, isListHash, isTransientHash } from "../public/history.js";
import { authenticityState, chainInclusion, inscriptionNeighbors } from "../server/api.ts";
import { latestFirst } from "../server/index-cache.ts";

test("back returns to the explorer list and falls back for a direct detail link", () => {
  const detail = "#/inscription/" + "ab".repeat(32) + "i0";
  assert.equal(isDetailHash(detail), true);
  assert.equal(isListHash("#/collection?offset=100"), true);
  assert.equal(isListHash(detail), false);
  assert.equal(backHash("#/collection?offset=100", detail), "#/collection?offset=100");
  assert.equal(backHash("#/", detail), "#/");
  assert.equal(backHash(null, detail), "#/inscriptions");
  assert.equal(backHash(detail, detail), "#/inscriptions");
  assert.equal(isTransientHash("#/number/12"), true);
  assert.equal(isTransientHash("#/item/12"), true);
  assert.equal(isTransientHash("#/inscriptions?offset=104"), false);
  assert.equal(backHash("#/number/12", detail), "#/inscriptions");
  assert.equal(backHash("#/item/3", detail), "#/inscriptions");
  assert.equal(backHash("#/inscriptions?offset=104", detail), "#/inscriptions?offset=104");
  assert.equal(backLabel("#/collection?offset=100"), "Back to collection");
  assert.equal(backLabel("#/inscriptions"), "Back to Latest P2MR Inscriptions");
  assert.equal(backLabel("#/how-it-works/status"), "Back to How it works");
  assert.equal(isListHash("#/how-it-works"), true);
});

const tip = { mock: false, stale: false, tipHeight: 200, tipHash: "ab".repeat(32), createdHeight: 120 };

test("on-chain is the indexed block, separate from collection authenticity", () => {
  assert.equal(chainInclusion(tip), "confirmed");
  assert.equal(chainInclusion({ ...tip, createdHeight: 200 }), "confirmed");
  assert.equal(chainInclusion({ ...tip, createdHeight: 201 }), "unknown");
  assert.equal(chainInclusion({ ...tip, tipHash: null }), "unknown");
  assert.equal(chainInclusion({ ...tip, tipHash: "abc" }), "unknown");
  assert.equal(chainInclusion({ ...tip, createdHeight: "120" }), "unknown");
  assert.equal(chainInclusion({ ...tip, tipHeight: null }), "unknown");
  assert.equal(chainInclusion({ ...tip, stale: true }), "stale");
  assert.equal(chainInclusion({ ...tip, mock: true }), "mock");
  assert.equal(chainInclusion({ ...tip, mock: true, stale: true }), "mock");
});

test("authenticity is confirmed only for a boolean true from the indexer", () => {
  assert.equal(authenticityState({ authentic: true }), "confirmed");
  assert.equal(authenticityState({ authentic: false }), "rejected");
  assert.equal(authenticityState(null), "unknown");
  assert.equal(authenticityState({}), "unknown");
  assert.equal(authenticityState({ authentic: "yes" }), "unknown");
});

test("previous and next follow existing inscription numbers and skip gaps", () => {
  const order = [1, 2, 4];
  const byNumber = new Map(order.map((n) => [n, { id: `id-${n}` }]));
  assert.deepEqual(inscriptionNeighbors(order, byNumber, 2), { prev: { number: 1, id: "id-1" }, next: { number: 4, id: "id-4" } });
  assert.deepEqual(inscriptionNeighbors(order, byNumber, 1).prev, null);
  assert.deepEqual(inscriptionNeighbors(order, byNumber, 4).next, null);
  assert.deepEqual(inscriptionNeighbors(order, byNumber, 3), { prev: { number: 2, id: "id-2" }, next: { number: 4, id: "id-4" } });
  assert.deepEqual(inscriptionNeighbors([], byNumber, 2), { prev: null, next: null });
});

test("latest order is block height, then transaction index, not inscription number", () => {
  const rows = [
    { createdHeight: 9, createdIndex: 0, n: 0, number: 100, id: "high-number" },
    { createdHeight: 9, createdIndex: 2, n: 0, number: 1, id: "later-tx" },
    { createdHeight: 3, createdIndex: 9, n: 0, number: 1000, id: "low-block" },
  ];
  rows.sort(latestFirst);
  assert.deepEqual(rows.map((row) => row.id), ["later-tx", "high-number", "low-block"]);
});
