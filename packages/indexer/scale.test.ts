// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { startApi } from "./api.ts";
import { Store } from "./store.ts";

const COUNT = 1_000_000;
const here = fileURLToPath(import.meta.url);

if (process.argv[2] === "fill") {
  fill(process.argv[3]!, Number(process.argv[4] ?? COUNT));
  process.exit(0);
}

function rss(): { rssMb: number; heapMb: number } {
  const usage = process.memoryUsage();
  return { rssMb: usage.rss / 1024 / 1024, heapMb: usage.heapUsed / 1024 / 1024 };
}

function fill(path: string, count: number): void {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = OFF");
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE blocks (height INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, prev_hash TEXT, state_hash TEXT NOT NULL);
    CREATE TABLE undo (height INTEGER PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE outputs (txid TEXT NOT NULL, vout INTEGER NOT NULL, value TEXT NOT NULL, height INTEGER NOT NULL, p2mr INTEGER, spent_height INTEGER, PRIMARY KEY (txid, vout));
    CREATE TABLE inscriptions (
      id TEXT PRIMARY KEY, number INTEGER NOT NULL, payload TEXT NOT NULL, body BLOB NOT NULL, metadata BLOB,
      owner_address TEXT NOT NULL DEFAULT '', loc_state TEXT NOT NULL DEFAULT '', loc_txid TEXT, loc_vout INTEGER, loc_offset TEXT,
      leaf_issuer TEXT NOT NULL DEFAULT '', content_type TEXT NOT NULL DEFAULT '',
      created_height INTEGER NOT NULL DEFAULT 0, created_index INTEGER NOT NULL DEFAULT 0, n INTEGER NOT NULL DEFAULT 0, state_line BLOB
    );
    CREATE UNIQUE INDEX inscriptions_number ON inscriptions (number);
    CREATE INDEX inscriptions_owner ON inscriptions (owner_address);
    CREATE INDEX inscriptions_location ON inscriptions (loc_txid, loc_vout);
  `);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema', '1')").run();
  const insert = db.prepare(`
    INSERT INTO inscriptions (id, number, payload, body, owner_address, loc_state, loc_txid, loc_vout, loc_offset, content_type, created_height, created_index, n, state_line)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
  `);
  const body = Buffer.from([1]);
  const line = Buffer.from([0]);
  db.exec("BEGIN");
  for (let n = 0; n < count; n += 1) {
    const txid = n.toString(16).padStart(64, "0");
    const id = `${txid}i0`;
    const located = n % 100 === 0;
    const owner = located ? (n % 1000 === 0 ? "qb1scaleowner" : "qb1scaleother") : "";
    const locState = located ? "located" : "unbound";
    const payload = JSON.stringify({
      id, txid, n: 0, number: n, flags: [], bodyLength: 1, bodySha256: "11".repeat(32),
      fields: [{ tag: 1, value: Buffer.from("text/plain").toString("hex") }],
      createdHeight: 1, createdIndex: 0, locationHeight: 1, leafIssuer: "",
      ownerScript: located ? "00" : "", ownerAddress: owner,
      location: located ? { state: "located", txid, vout: 0, offset: "0", script: "00" } : { state: "unbound" },
    });
    insert.run(id, n, payload, body, owner, locState, located ? txid : null, located ? 0 : null, located ? "0" : null, "text/plain", 1, line);
  }
  db.exec("COMMIT");
  db.close();
}

test("one million P2MR Inscriptions stay in SQLite; the API pages without holding the set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pins-scale-"));
  const path = join(dir, "index.sqlite");
  const before = rss();
  const tFill = Date.now();
  const child = spawnSync(process.execPath, ["--experimental-strip-types", here, "fill", path, String(COUNT)], { encoding: "utf8" });
  if (child.status !== 0) throw new Error(child.stderr || child.stdout || "fill failed");
  const fillMs = Date.now() - tFill;
  const store = new Store(path, { network: "regtest", primeHashLines: false });
  const afterOpen = rss();
  assert.equal(store.inscriptionCount(), COUNT);
  assert.equal(store.indexer.size, COUNT);
  assert.ok(store.indexer.inscriptions.size < 1000, `map held ${store.indexer.inscriptions.size} objects`);
  const api = await startApi(store, 0, "regtest");
  try {
    const timed = async (name: string, path: string): Promise<{ name: string; ms: number; status: number; bytes: number }> => {
      const t0 = Date.now();
      const response = await fetch(`${api.url}${path}`);
      const text = await response.text();
      return { name, ms: Date.now() - t0, status: response.status, bytes: Buffer.byteLength(text) };
    };
    const mid = (COUNT / 2).toString(16).padStart(64, "0");
    const firstLocated = (0).toString(16).padStart(64, "0");
    const status = await timed("status", "/status");
    const page = await timed("page", "/inscriptions?offset=0&limit=100");
    const midPage = await timed("mid-page", `/inscriptions?offset=${COUNT - 100}&limit=100`);
    const owner = await timed("owner", "/inscriptions?owner=qb1scaleowner&limit=50");
    const one = await timed("one", `/inscription/${mid}i0`);
    const output = await timed("output", `/output/${firstLocated}:0`);
    const afterApi = rss();
    const report = { count: COUNT, fillMs, before, afterOpen, afterApi, mapSize: store.indexer.inscriptions.size, status, page, midPage, owner, one, output };
    console.log(JSON.stringify(report));
    assert.equal(status.status, 200);
    assert.equal(page.status, 200);
    assert.equal(midPage.status, 200);
    assert.equal(owner.status, 200);
    assert.equal(one.status, 200);
    assert.equal(output.status, 200);
    assert.ok(JSON.parse((await (await fetch(`${api.url}/status`)).text())).inscriptions === COUNT);
    // A full in-memory set of 1M rows would be well above 1 GiB. Opening the store and serving pages must stay well under that.
    assert.ok(afterApi.heapMb < 400, `heap ${afterApi.heapMb.toFixed(1)} MiB`);
    assert.ok(afterApi.rssMb < 800, `rss ${afterApi.rssMb.toFixed(1)} MiB`);
    assert.ok(page.ms < 500, `first page ${page.ms} ms`);
    assert.ok(one.ms < 200, `one row ${one.ms} ms`);
  } finally {
    await api.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
