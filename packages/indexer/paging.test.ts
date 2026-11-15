// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { MAX_PAGE_LIMIT, pageRequest, slicePage } from "./paging.ts";

const params = (query: string) => new URLSearchParams(query);

test("no offset and no limit mean the whole list, or the default limit of a list that pages by default", () => {
  assert.deepEqual(pageRequest(params(""), null), { offset: 0, limit: null });
  assert.deepEqual(pageRequest(params("owner=x"), null), { offset: 0, limit: null });
  assert.deepEqual(pageRequest(params(""), 100), { offset: 0, limit: 100 });
  assert.deepEqual(pageRequest(params("offset=5"), null), { offset: 5, limit: null });
  assert.deepEqual(pageRequest(params("limit=7"), 100), { offset: 0, limit: 7 });
});

test("offset and limit are whole numbers in digits, and limit is 1 to the maximum", () => {
  assert.equal(MAX_PAGE_LIMIT, 1000);
  assert.deepEqual(pageRequest(params("offset=0&limit=1000"), null), { offset: 0, limit: 1000 });
  assert.deepEqual(pageRequest(params("offset=0&limit=0001"), null), { offset: 0, limit: 1 });
  for (const query of ["limit=0", "limit=1001", "limit=-1", "limit=abc", "limit=", "limit=1e1", "limit=0x10", "limit=1.5", "limit=%205", "offset=-1", "offset=abc", "offset=", "offset=1.5", "offset=1e3", "offset=9999999999999999"]) {
    assert.equal(pageRequest(params(query), null), null, query);
    assert.equal(pageRequest(params(query), 100), null, query);
  }
});

test("a page is a window of the list, and the total is the whole list", () => {
  const rows = [1, 2, 3, 4, 5];
  assert.deepEqual(slicePage(rows, { offset: 0, limit: null }), { total: 5, offset: 0, limit: null, shown: rows });
  assert.deepEqual(slicePage(rows, { offset: 1, limit: 2 }), { total: 5, offset: 1, limit: 2, shown: [2, 3] });
  assert.deepEqual(slicePage(rows, { offset: 4, limit: 10 }).shown, [5]);
  assert.deepEqual(slicePage(rows, { offset: 5, limit: 10 }).shown, []);
  assert.deepEqual(slicePage(rows, { offset: 50, limit: null }), { total: 5, offset: 50, limit: null, shown: [] });
});
