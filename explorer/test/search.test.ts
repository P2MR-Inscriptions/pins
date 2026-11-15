// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADDRESS, MAX_QUERY_LENGTH, classifyQuery } from "../server/search.ts";

/**
 * The search patterns as they were before they were rewritten to be linear. They are kept here only to prove
 * that the new ones accept and refuse exactly the same text, and take the same number from it.
 */
function before(q: string): { type: string; path: string } | null {
  const s = q.trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (/^[0-9a-f]{64}i\d+$/.test(lower)) return { type: "inscription", path: `/inscription/${lower}` };
  if (/^[0-9a-f]{64}$/.test(lower)) return { type: "transaction", path: `/tx/${lower}` };
  if (/^(qb|tq|qbrt)1[0-9a-z]{6,120}$/.test(lower)) return { type: "address", path: `/address/${lower}` };
  const words = "item|piece";
  const piece = new RegExp(`^(?:${words})?\\s*#\\s*(\\d+)$`, "i").exec(s) ?? new RegExp(`^(?:${words})\\s+(\\d+)$`, "i").exec(s);
  if (piece) return { type: "collection piece", path: `/item/${Number(piece[1])}` };
  const block = /^block\s*#?\s*(\d+)$/i.exec(s);
  if (block) return { type: "block", path: `/block/${Number(block[1])}` };
  const numbered = /^(?:no\.?|n°|inscription)\s*#?\s*(\d+)$/i.exec(s);
  if (numbered) return { type: "inscription number", path: `/number/${Number(numbered[1])}` };
  if (/^\d+$/.test(s)) return { type: "inscription number", path: `/number/${Number(s)}` };
  return null;
}

const ACCEPTED: [string, string, string][] = [
  ["item #12", "collection piece", "/item/12"],
  ["piece #12", "collection piece", "/item/12"],
  ["item 12", "collection piece", "/item/12"],
  ["piece 12", "collection piece", "/item/12"],
  ["ITEM#12", "collection piece", "/item/12"],
  ["#12", "collection piece", "/item/12"],
  ["# 12", "collection piece", "/item/12"],
  ["  #12  ", "collection piece", "/item/12"],
  ["block 5", "block", "/block/5"],
  ["block #5", "block", "/block/5"],
  ["block5", "block", "/block/5"],
  ["Block#5", "block", "/block/5"],
  ["block   #   5", "block", "/block/5"],
  ["no. 7", "inscription number", "/number/7"],
  ["no 7", "inscription number", "/number/7"],
  ["No.#7", "inscription number", "/number/7"],
  ["n° 7", "inscription number", "/number/7"],
  ["n°7", "inscription number", "/number/7"],
  ["inscription #7", "inscription number", "/number/7"],
  ["inscription 7", "inscription number", "/number/7"],
  ["7", "inscription number", "/number/7"],
  ["007", "inscription number", "/number/7"],
  ["ab".repeat(32), "transaction", `/tx/${"ab".repeat(32)}`],
  [`${"AB".repeat(32)}i3`, "inscription", `/inscription/${"ab".repeat(32)}i3`],
  ["qb1" + "q".repeat(40), "address", `/address/qb1${"q".repeat(40)}`],
];

const REFUSED = ["", "   ", "hello", "item", "block", "block #", "item #", "#", "no.", "item #x", "12 item", "block 5 5", "block ## 5", "item ## 12", "# #12", "piece-12", "block-5", "no..7", "n° ° 7", "1.5", "-5", "5x", "x5", "item\n\n"];

test("the search box accepts these texts and sends each to the page it names", () => {
  for (const [text, type, path] of ACCEPTED) assert.deepEqual(classifyQuery(text), { type, path }, JSON.stringify(text));
});

test("the search box refuses these texts", () => {
  for (const text of REFUSED) assert.equal(classifyQuery(text), null, JSON.stringify(text));
});

test("the rewritten patterns accept and refuse exactly the texts the earlier patterns did", () => {
  const tokens = ["", "item", "Piece", "block", "BLOCK", "no", "no.", "N°", "n°", "inscription", "#", " ", "  ", "\t", "\u00a0", "\n", "7", "12", "x"];
  let count = 0;
  const walk = (prefix: string, depth: number) => {
    for (const token of tokens) {
      const text = prefix + token;
      count += 1;
      assert.deepEqual(classifyQuery(text), before(text), JSON.stringify(text));
      if (depth > 1) walk(text, depth - 1);
    }
  };
  walk("", 4);
  assert.ok(count > 100_000);
});

test("a query over the limit is not a search, and the limit still holds the longest address", () => {
  assert.equal(MAX_QUERY_LENGTH, 128);
  const longest = "qbrt1" + "q".repeat(120);
  assert.equal(longest.length, 125);
  assert.ok(ADDRESS.test(longest));
  assert.equal(classifyQuery(longest)?.type, "address");
  assert.equal(classifyQuery("1".repeat(MAX_QUERY_LENGTH))?.type, "inscription number");
  assert.equal(classifyQuery("1".repeat(MAX_QUERY_LENGTH + 1)), null);
  assert.equal(classifyQuery("block " + "1".repeat(MAX_QUERY_LENGTH)), null);
  // The limit counts the trimmed text, so spaces around a short query do not matter.
  assert.equal(classifyQuery(" ".repeat(500) + "block 5" + " ".repeat(500))?.path, "/block/5");
});

test("text built to make a pattern backtrack is answered at once", () => {
  const nasty = [
    "block" + " ".repeat(200_000) + "x",
    "block" + "\t".repeat(200_000) + "#",
    "block" + " #".repeat(100_000) + "x",
    "no." + " ".repeat(200_000) + "x",
    "n°" + "\u00a0".repeat(200_000) + "x",
    "inscription" + " ".repeat(100_000) + "#" + " ".repeat(100_000) + "x",
    "item" + " ".repeat(200_000) + "x",
    "#" + " ".repeat(200_000) + "x",
    " ".repeat(200_000) + "block" + " ".repeat(200_000) + "x",
    "1".repeat(200_000) + "x",
    "\n".repeat(200_000),
  ];
  const started = performance.now();
  for (const text of nasty) assert.equal(classifyQuery(text), null);
  assert.ok(performance.now() - started < 500, `took ${Math.round(performance.now() - started)} ms`);
  // Just under the limit, the old shape of attack costs nothing either.
  const small = performance.now();
  for (let i = 0; i < 2000; i += 1) classifyQuery("block" + " ".repeat(MAX_QUERY_LENGTH - 6) + "x");
  assert.ok(performance.now() - small < 500);
});
