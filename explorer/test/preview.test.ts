// SPDX-License-Identifier: Apache-2.0
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

let indexer: Server;
const TOTAL = 400;
const started = Date.now();
let inscriptionsAt = 0;
let piecesStarted = 0;
let previewAt = 0;
let fullAt = 0;

function item(n: number) {
  const id = `${n.toString(16).padStart(64, "0")}i0`;
  return {
    id, txid: id.slice(0, 64), n: n % 3, number: n, contentType: n % 5 === 0 ? "text/plain" : "image/png",
    bodySha256: "aa", bodyLength: 8, fields: [], createdHeight: 1000 + (n % 50), createdIndex: n % 4,
    locationHeight: 1000, location: null, ownerAddress: "", ownerScript: "", leafIssuer: "", flags: [], burned: false, reinscription: false,
  };
}

before(async () => {
  indexer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (body: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
    if (url.pathname === "/status") return send({ network: "regtest", chain: "regtest", height: 2000, hash: "ab", stateHash: "ab", inscriptions: TOTAL });
    if (url.pathname === "/inscriptions") {
      inscriptionsAt = Date.now() - started;
      return send({ inscriptions: Array.from({ length: TOTAL }, (_, n) => item(n)) });
    }
    if (url.pathname === "/collection") return send({ status: "present", name: "Example", supply: TOTAL, first: 1, genesisId: item(0).id, root: "00", issuer: "ab", itemType: "image/png" });
    if (url.pathname === "/pieces") {
      piecesStarted = piecesStarted || Date.now() - started;
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 100);
      setTimeout(() => send({ total: TOTAL, offset, limit, pieces: Array.from({ length: Math.min(limit, Math.max(0, TOTAL - offset)) }, (_, i) => ({ number: offset + i + 1, inscriptionId: null, authentic: false, reason: "no", status: "unassigned", location: null, ownerAddress: "", ownerScript: "", confirmations: 0, final: false, attributes: [] })) }), 300);
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((ok) => indexer.listen(0, "127.0.0.1", () => ok()));
  process.env.INDEXER_URL = `http://127.0.0.1:${(indexer.address() as { port: number }).port}`;
  process.env.MANIFEST = "config/does-not-exist.json";
  process.env.HOST = "127.0.0.1";
  delete process.env.QBIT_RPC_URL;
  delete process.env.QBIT_RPC_USER;
  delete process.env.QBIT_RPC_PASSWORD;
  delete process.env.QBIT_CONF;
});

after(() => indexer.close());

test("latest inscriptions are readable before the collection piece pages finish", async () => {
  const { cache } = await import("../server/index-cache.ts");
  const done = cache.tick();
  const previewDeadline = Date.now() + 2000;
  while (!cache.previewReady && Date.now() < previewDeadline) await new Promise((r) => setTimeout(r, 10));
  previewAt = Date.now() - started;
  assert.equal(cache.previewReady, true);
  assert.equal(cache.ready, false);
  assert.equal(cache.piecesComplete, false);
  assert.equal(cache.list.length, TOTAL);
  assert.equal(cache.newest.length, TOTAL);
  assert.ok(previewAt < piecesStarted + 80 || piecesStarted === 0 || previewAt < fullAt);
  const top = cache.newest[0];
  assert.ok(top);
  assert.equal(top.createdHeight, Math.max(...cache.list.map((row) => row.createdHeight)));
  await done;
  fullAt = Date.now() - started;
  assert.equal(cache.piecesComplete, true);
  assert.equal(cache.ready, true);
  assert.ok(fullAt > previewAt);
  console.log(JSON.stringify({ inscriptionsAt, previewAt, piecesStarted, fullAt, total: TOTAL }));
});
