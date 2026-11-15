// SPDX-License-Identifier: Apache-2.0
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

let phase = "alice";
let tornReads = 0;
let indexer: Server;

function item(owner: string) {
  const txid = "ab".repeat(32);
  return {
    id: `${txid}i0`, txid, n: 0, number: 7, contentType: "image/png", bodySha256: "aa", bodyLength: 1,
    fields: [], createdHeight: 2, createdIndex: 0, locationHeight: 2,
    location: { state: "located", txid, vout: 0, offset: "0", script: "00" },
    ownerAddress: owner, ownerScript: "00", leafIssuer: "", flags: [], burned: false, reinscription: false,
  };
}

before(async () => {
  indexer = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    res.setHeader("content-type", "application/json");
    if (path === "/status") {
      if (phase === "fail") { res.statusCode = 500; res.end("nope"); return; }
      let hash = "a";
      if (phase === "bob") hash = "c";
      if (phase === "torn") {
        tornReads += 1;
        hash = tornReads === 1 ? "b" : "c";
      }
      res.end(JSON.stringify({ network: "regtest", chain: "regtest", height: 9, hash, stateHash: hash, inscriptions: 1 }));
      return;
    }
    if (path === "/inscriptions") {
      const owner = phase === "torn" || phase === "bob" ? "qb1mockownerbbbbbbbbbbbbbbbbbbbbbb" : "qb1mockowneraaaaaaaaaaaaaaaaaaaaaa";
      res.end(JSON.stringify({ inscriptions: [item(owner)] }));
      return;
    }
    if (path === "/collection") { res.end(JSON.stringify({ status: "absent" })); return; }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((ok) => indexer.listen(0, "127.0.0.1", () => ok()));
  process.env.INDEXER_URL = `http://127.0.0.1:${(indexer.address() as { port: number }).port}`;
  process.env.MANIFEST = "config/does-not-exist.json";
  process.env.HOST = "127.0.0.1";
  process.env.RATE_PER_MINUTE = "1000";
  delete process.env.QBIT_RPC_URL;
  delete process.env.QBIT_RPC_USER;
  delete process.env.QBIT_RPC_PASSWORD;
  delete process.env.QBIT_CONF;
});

after(() => indexer.close());

test("a torn reorg read does not replace the last consistent snapshot", async () => {
  const { cache } = await import("../server/index-cache.ts");
  await cache.tick();
  assert.equal(cache.ready, true);
  assert.equal(cache.byNumber.get(7)?.ownerAddress, "qb1mockowneraaaaaaaaaaaaaaaaaaaaaa");
  phase = "torn";
  tornReads = 0;
  await cache.tick();
  assert.equal(cache.byNumber.get(7)?.ownerAddress, "qb1mockowneraaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(cache.stale, true);
  phase = "bob";
  await cache.tick();
  assert.equal(cache.stale, false);
  assert.equal(cache.byNumber.get(7)?.ownerAddress, "qb1mockownerbbbbbbbbbbbbbbbbbbbbbb");
  phase = "fail";
  await cache.tick();
  assert.equal(cache.stale, true);
  assert.equal(cache.byNumber.get(7)?.ownerAddress, "qb1mockownerbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal((cache.error ?? "").includes("dummy"), false);
});
