// SPDX-License-Identifier: Apache-2.0
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApi } from "../../packages/indexer/api.ts";
import type { ChainBlock, ChainTx } from "../../packages/indexer/pins.ts";
import { Store } from "../../packages/indexer/store.ts";
import { encodeGenesisField } from "../../packages/inscriber/preflight.ts";
import { itemsLeaf } from "../../packages/inscriber/reveal.ts";

/** The explorer runs against the indexer in packages/, not against a mock. */

const ISSUER = new Uint8Array(32).fill(9);
const STRANGER = new Uint8Array(32).fill(7);
const SCRIPT = Uint8Array.from([0x52, 0x20, ...new Uint8Array(32).fill(4)]);
const GENESIS = "a1".repeat(32);
const BAD_ISSUER = "b1".repeat(32);
const BAD_STRANGER = "b2".repeat(32);
const PIECE = "c1".repeat(32);
const BODY = Uint8Array.of(9, 8, 7);
// CBOR { meta: { name: "#1", attributes: [] } }
const PIECE_FIELD = Buffer.from("a1646d657461a2646e616d656223316a6174747269627574657380", "hex");
// CBOR { meta: { name: 5 } }. The name is not text.
const BAD_FIELD = Buffer.from("a1646d657461a1646e616d6505", "hex");

function leafOf(number: number, body: Uint8Array, metadata: Uint8Array): Buffer {
  const preimage = Buffer.alloc(68);
  preimage.writeUInt32BE(number, 0);
  createHash("sha256").update(body).digest().copy(preimage, 4);
  createHash("sha256").update(metadata).digest().copy(preimage, 36);
  return createHash("sha256").update(preimage).digest();
}

function block(height: number, txs: ChainTx[]): ChainBlock {
  return { hash: `b${height}`, height, subsidy: 50n, txs };
}

function coinbase(txid: string): ChainTx {
  return { txid, inputs: [{ coinbase: true, value: 50n }], outputs: [{ value: 50n, script: SCRIPT }] };
}

type Item = { body: Uint8Array; contentType: string; metadata?: Uint8Array };

function reveal(txid: string, prevTxid: string, key: Uint8Array, items: Item[]): ChainTx {
  return {
    txid,
    inputs: [{ prevTxid, prevVout: 0, value: 10_000n * BigInt(items.length), leafScript: itemsLeaf(key, items) }],
    outputs: items.map(() => ({ value: 10_000n, script: SCRIPT })),
  };
}

const octets = (metadata: Uint8Array): Item[] => [{ body: BODY, contentType: "application/octet-stream", metadata }];

let dir = "";
let store: Store;
let indexer: { url: string; close: () => Promise<void> };
let server: Server;
let base = "";
let badId = "";

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "explorer-indexer-"));
  store = new Store(join(dir, "index.sqlite"), { network: "regtest" });
  const leaf = leafOf(1, BODY, PIECE_FIELD);
  const field5 = await encodeGenesisField({
    schema: "pins-collection/1",
    name: "Set",
    supply: 1,
    first: 1,
    namePrefix: "#",
    itemType: "application/octet-stream",
    root: leaf.toString("hex"),
    issuer: Buffer.from(ISSUER).toString("hex"),
    saleCommitment: "11".repeat(32),
  });
  store.commit(block(1, [coinbase("c1"), reveal(GENESIS, "00", ISSUER, [
    { body: new TextEncoder().encode("{}"), contentType: "application/json", metadata: field5 },
    { body: new Uint8Array(leaf), contentType: "application/octet-stream" },
  ])]));
  // One inscription under another key and one under the issuer key, both with a field 5 that has a non-text name.
  store.commit(block(2, [coinbase("c2"), reveal(BAD_ISSUER, "02", ISSUER, octets(BAD_FIELD)), reveal(BAD_STRANGER, "03", STRANGER, octets(BAD_FIELD))]));
  store.commit(block(3, [coinbase("c3"), reveal(PIECE, "01", ISSUER, octets(PIECE_FIELD))]));
  badId = [...store.indexer.inscriptions.values()].find((item) => item.txid === BAD_ISSUER)?.id ?? "";
  indexer = await startApi(store, 0, "regtest");
  process.env.INDEXER_URL = indexer.url;
  process.env.MANIFEST = "config/manifest.mock.json";
  process.env.RATE_PER_MINUTE = "1000";
  process.env.HOST = "127.0.0.1";
  delete process.env.QBIT_RPC_URL;
  delete process.env.QBIT_RPC_USER;
  delete process.env.QBIT_RPC_PASSWORD;
  delete process.env.QBIT_CONF;
  const { cache } = await import("../server/index-cache.ts");
  const { createExplorer } = await import("../server/index.ts");
  await cache.tick();
  server = createExplorer();
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  server?.close();
  await indexer?.close();
  store?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const api = async (path: string) => {
  const response = await fetch(base + path);
  return { status: response.status, body: await response.json() as any };
};

test("the explorer reads a snapshot from the indexer in packages/", async () => {
  const { status, body } = await api("/api/status");
  assert.equal(status, 200);
  assert.equal(body.indexer.reachable, true);
  assert.equal(body.indexer.mock, undefined);
  assert.equal(body.snapshot.ready, true);
  assert.equal(body.snapshot.stale, false);
});

test("a field 5 with a non-text name does not stop the explorer snapshot", async () => {
  assert.ok(badId);
  const collection = (await api("/api/collection")).body;
  assert.equal(collection.authenticPieces, 1);
  const pieces = await api("/api/collection/pieces?offset=0&limit=10");
  assert.equal(pieces.status, 200);
  assert.equal(pieces.body.total, 1);
  const detail = await api(`/api/inscription/${badId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.piece, null);
  assert.equal(detail.body.authenticity, "unknown");
});
