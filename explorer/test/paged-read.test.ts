// SPDX-License-Identifier: Apache-2.0
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

// The explorer reads the P2MR Inscription list in pages of 1000. An indexer from before paging sends every row
// without a total, and that still works. A list that does not add up, or is too large, is refused.
let mode: "paged" | "unpaged" | "short" | "huge" = "paged";
let hash = "a";
let requests: string[] = [];
let indexer: Server;
const ROWS = 2300;

function row(number: number) {
  const txid = number.toString(16).padStart(64, "0");
  return {
    id: `${txid}i0`, txid, n: 0, number, contentType: "text/plain", bodySha256: "aa", bodyLength: 1,
    fields: [], createdHeight: 2, createdIndex: number, locationHeight: 2,
    location: { state: "located", txid, vout: 0, offset: "0", script: "00" },
    ownerAddress: "qb1mockowneraaaaaaaaaaaaaaaaaaaaaa", ownerScript: "00", leafIssuer: "", flags: [], burned: false, reinscription: false,
  };
}

const all = Array.from({ length: ROWS }, (_, index) => row(index + 1));

before(async () => {
  indexer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/status") {
      res.end(JSON.stringify({ network: "regtest", chain: "regtest", height: 9, hash, stateHash: hash, inscriptions: ROWS }));
      return;
    }
    if (url.pathname === "/inscriptions") {
      requests.push(`${url.search}`);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 1_000_000);
      if (mode === "unpaged") { res.end(JSON.stringify({ inscriptions: all })); return; }
      if (mode === "huge") { res.end(JSON.stringify({ total: 3000, offset, limit, inscriptions: all.slice(0, limit) })); return; }
      const shown = all.slice(offset, offset + limit);
      // "short" loses the last row of the last page, as an indexer that is wrong about its own total would.
      res.end(JSON.stringify({ total: ROWS, offset, limit, inscriptions: mode === "short" && offset + limit >= ROWS ? shown.slice(0, -1) : shown }));
      return;
    }
    if (url.pathname === "/collection") { res.end(JSON.stringify({ status: "absent" })); return; }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((ok) => indexer.listen(0, "127.0.0.1", () => ok()));
  process.env.INDEXER_URL = `http://127.0.0.1:${(indexer.address() as { port: number }).port}`;
  process.env.MANIFEST = "config/does-not-exist.json";
  process.env.HOST = "127.0.0.1";
  process.env.RATE_PER_MINUTE = "1000";
  process.env.MAX_INSCRIPTIONS = "2500";
  delete process.env.QBIT_RPC_URL;
  delete process.env.QBIT_RPC_USER;
  delete process.env.QBIT_RPC_PASSWORD;
  delete process.env.QBIT_CONF;
});

after(() => indexer.close());

test("the list is read in pages of 1000 and every row arrives", async () => {
  const { cache } = await import("../server/index-cache.ts");
  await cache.tick();
  assert.equal(cache.ready, true);
  assert.equal(cache.list.length, ROWS);
  assert.equal(cache.byNumber.get(ROWS)?.id, all[ROWS - 1].id);
  assert.deepEqual([...requests].sort(), ["?offset=0&limit=1000", "?offset=1000&limit=1000", "?offset=2000&limit=1000"]);
});

test("an indexer from before paging sends every row without a total, and that is taken as the list", async () => {
  const { cache } = await import("../server/index-cache.ts");
  mode = "unpaged";
  hash = "b";
  requests = [];
  await cache.tick();
  assert.equal(cache.error, null);
  assert.equal(cache.list.length, ROWS);
  assert.equal(requests.length, 1);
  assert.equal(cache.status?.hash, "b");
});

test("pages that do not add up to the total are refused, and the last snapshot stays", async () => {
  const { cache } = await import("../server/index-cache.ts");
  mode = "short";
  hash = "c";
  await cache.tick();
  assert.match(cache.error ?? "", /do not add up/);
  assert.equal(cache.stale, true);
  assert.equal(cache.list.length, ROWS);
});

test("a total above the limit is refused after the first page, before the rest is read", async () => {
  const { cache } = await import("../server/index-cache.ts");
  mode = "huge";
  hash = "d";
  requests = [];
  await cache.tick();
  assert.match(cache.error ?? "", /exceeds the P2MR Inscription limit/);
  assert.deepEqual(requests, ["?offset=0&limit=1000"]);
  assert.equal(cache.list.length, ROWS);
});
