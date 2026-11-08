import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { pageSlice, paging } from "../server/api.ts";

const SIZE = 104;
const total = 10_000;
const items = Array.from({ length: total }, (_, n) => n);

function nextOffset(offset: number): number {
  const page = Math.floor(offset / SIZE) + 1;
  return page * SIZE;
}

function previousOffset(offset: number): number {
  const page = Math.floor(offset / SIZE) + 1;
  return (page - 2) * SIZE;
}

function goOffset(input: number): number {
  const pages = Math.max(1, Math.ceil(total / SIZE));
  const page = Math.min(pages, Math.max(1, input));
  return (page - 1) * SIZE;
}

test("10,000 collection pieces are 97 pages of 104 with a 16-piece last page", () => {
  assert.equal(Math.ceil(total / SIZE), 97);
  assert.equal(96 * SIZE, 9984);
  const seen: number[] = [];
  let offset = 0;
  for (let guard = 0; guard < 200; guard += 1) {
    const window = pageSlice(items, offset, SIZE);
    assert.equal(window.total, total);
    assert.equal(window.offset, offset);
    assert.equal(window.limit, SIZE);
    seen.push(...window.shown);
    const page = Math.floor(offset / SIZE) + 1;
    if (page >= 97) break;
    offset = nextOffset(offset);
  }
  assert.equal(offset, 9984);
  assert.deepEqual(seen, items);
  assert.equal(pageSlice(items, 9984, SIZE).shown.length, 16);
  assert.deepEqual(pageSlice(items, 9984, SIZE).shown[0], 9984);
  assert.deepEqual(pageSlice(items, 9984, SIZE).shown.at(-1), 9999);
});

test("paging rejects an unknown range and a direct offset past the end adds nothing", () => {
  assert.deepEqual(paging(new URL("http://explorer.local/api/collection/pieces?offset=104&limit=104")), { offset: 104, limit: 104 });
  assert.throws(() => paging(new URL("http://explorer.local/api/collection/pieces?offset=-1&limit=104")));
  assert.throws(() => paging(new URL("http://explorer.local/api/collection/pieces?offset=0&limit=201")));
  assert.deepEqual(pageSlice(items, total, SIZE).shown, []);
  assert.deepEqual(pageSlice(items, 50_000, SIZE).shown, []);
  assert.equal(goOffset(0), 0);
  assert.equal(goOffset(97), 9984);
  assert.equal(goOffset(500), 9984);
  assert.equal(previousOffset(104), 0);
  assert.equal(previousOffset(9984), 96 * SIZE - SIZE);
});

test("the explorer page is 104 and the indexer piece read stays 100", () => {
  const app = readFileSync("public/app.js", "utf8");
  const cache = readFileSync("server/index-cache.ts", "utf8");
  assert.match(app, /const PAGE_SIZE = 104;/);
  assert.match(app, /const HOME_FETCH = HOME_SIDE \+ 1;/);
  assert.match(cache, /\/pieces\?offset=0&limit=100/);
  assert.match(cache, /const pageSize = 100;/);
});
