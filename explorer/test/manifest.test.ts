// SPDX-License-Identifier: Apache-2.0
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const genesisId = `${"aa".repeat(32)}i0`;
let indexer: Server;
let explorer: Server;
let base = "";

before(async () => {
  indexer = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    res.setHeader("content-type", "application/json");
    if (path === "/status") {
      res.end(JSON.stringify({ network: "regtest", chain: "regtest", height: 4, hash: "ee", stateHash: "ff", inscriptions: 0 }));
      return;
    }
    if (path === "/inscriptions") { res.end(JSON.stringify({ inscriptions: [] })); return; }
    if (path === "/collection") {
      res.end(JSON.stringify({
        status: "present", name: "On-chain name", supply: 2, first: 1, genesisId,
        root: "bb".repeat(32), itemType: "image/png",
      }));
      return;
    }
    if (path === "/pieces") { res.end(JSON.stringify({ total: 0, offset: 0, limit: 100, pieces: [] })); return; }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((ok) => indexer.listen(0, "127.0.0.1", () => ok()));
  const dir = mkdtempSync(join(tmpdir(), "pins-manifest-"));
  const manifest = join(dir, "manifest.json");
  writeFileSync(manifest, JSON.stringify({
    name: "Config name", supply: 2, first: 1, genesisId, merkleRoot: "cc".repeat(32), itemType: "image/png",
  }));
  process.env.INDEXER_URL = `http://127.0.0.1:${(indexer.address() as { port: number }).port}`;
  process.env.MANIFEST = manifest;
  process.env.HOST = "127.0.0.1";
  process.env.RATE_PER_MINUTE = "1000";
  delete process.env.QBIT_RPC_URL;
  delete process.env.QBIT_RPC_USER;
  delete process.env.QBIT_RPC_PASSWORD;
  delete process.env.QBIT_CONF;
  const { cache } = await import("../server/index-cache.ts");
  const { createExplorer } = await import("../server/index.ts");
  await cache.tick();
  explorer = createExplorer();
  await new Promise<void>((ok) => explorer.listen(0, "127.0.0.1", () => ok()));
  base = `http://127.0.0.1:${(explorer.address() as { port: number }).port}`;
});

after(() => { explorer.close(); indexer.close(); });

test("a configured manifest is compared and is not treated as chain data", async () => {
  const body = await (await fetch(`${base}/api/collection`)).json() as { checks: { field: string; match: boolean | null }[]; onchain: { name: string } };
  const byField = Object.fromEntries(body.checks.map((row) => [row.field, row.match]));
  assert.equal(body.onchain.name, "On-chain name");
  assert.equal(byField.Name, false);
  assert.equal(byField["Merkle root"], false);
  assert.equal(byField.Supply, true);
  assert.equal(byField["Genesis P2MR Inscription"], true);
});
