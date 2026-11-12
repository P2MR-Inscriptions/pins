// SPDX-License-Identifier: Apache-2.0

/**
 * The list endpoints take optional `offset` and `limit`, the answer for the same tip is kept and dropped when
 * the tip changes, and `/status` names the standards. docs/indexer/API.md describes each of these.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { STANDARDS } from "../protocol/index.mjs";
import { encodeGenesisField } from "../inscriber/preflight.ts";
import { itemsLeaf } from "../inscriber/reveal.ts";
import { INDEXER_STANDARD_IDS, startApi } from "./api.ts";
import type { ChainBlock, ChainTx } from "./pins.ts";
import { Store } from "./store.ts";

const KEY_A = new Uint8Array(32).fill(9);
const KEY_B = new Uint8Array(32).fill(8);

function script(fill: number): Uint8Array {
  const out = new Uint8Array(34);
  out[0] = 0x52;
  out[1] = 0x20;
  out.set(new Uint8Array(32).fill(fill), 2);
  return out;
}

const OWNER_A = script(4);
const OWNER_B = script(5);

function block(partial: Omit<ChainBlock, "subsidy">): ChainBlock {
  return { subsidy: 50n, ...partial };
}

function coinbase(txid: string): ChainTx {
  return { txid, inputs: [{ coinbase: true, value: 50n }], outputs: [{ value: 50n, script: OWNER_A }] };
}

/** One reveal that writes `count` items. They all bind to the first bit of the input, so they sit in output 0. */
function reveal(txid: string, prevTxid: string, key: Uint8Array, owner: Uint8Array, count: number, tag: number): ChainTx {
  const items = Array.from({ length: count }, (_, index) => ({ body: Uint8Array.of(tag, index), contentType: "application/octet-stream" }));
  return {
    txid,
    inputs: [{ prevTxid, prevVout: 0, value: 20_000n, leafScript: itemsLeaf(key, items) }],
    outputs: [{ value: 10_000n, script: owner }],
  };
}

type Page = { total: number; offset: number; limit: number | null; inscriptions: { id: string; number: number; ownerAddress: string }[] };

async function json<T>(url: string): Promise<{ status: number; body: T; tip: string | null }> {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() as T, tip: response.headers.get("x-indexed-tip") };
}

async function withApi(run: (api: Awaited<ReturnType<typeof startApi>>, store: Store) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "api-paging-"));
  const store = new Store(join(dir, "a.sqlite"), { network: "regtest" });
  store.bindActivation(1);
  store.commit(block({ hash: "a", height: 1, txs: [coinbase("c1"), reveal("t1", "00", KEY_A, OWNER_A, 3, 1)] }));
  store.commit(block({ hash: "b", height: 2, txs: [coinbase("c2"), reveal("t2", "01", KEY_B, OWNER_B, 2, 2)] }));
  const api = await startApi(store, 0, "regtest");
  try {
    await run(api, store);
  } finally {
    await api.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("/inscriptions without offset or limit still returns every P2MR Inscription, now with its total", async () => {
  await withApi(async (api) => {
    const { status, body } = await json<Page>(`${api.url}/inscriptions`);
    assert.equal(status, 200);
    assert.equal(body.inscriptions.length, 5);
    assert.deepEqual(body.inscriptions.map((row) => row.number), [0, 1, 2, 3, 4].map((index) => body.inscriptions[0].number + index));
    assert.deepEqual([body.total, body.offset, body.limit], [5, 0, null]);
  });
});

test("/inscriptions pages add up to the whole list, in number order", async () => {
  await withApi(async (api) => {
    const whole = (await json<Page>(`${api.url}/inscriptions`)).body.inscriptions;
    const collected: Page["inscriptions"] = [];
    for (let offset = 0; offset < 5; offset += 2) {
      const { status, body } = await json<Page>(`${api.url}/inscriptions?offset=${offset}&limit=2`);
      assert.equal(status, 200);
      assert.deepEqual([body.total, body.offset, body.limit], [5, offset, 2]);
      collected.push(...body.inscriptions);
    }
    assert.deepEqual(collected, whole);
    const beyond = (await json<Page>(`${api.url}/inscriptions?offset=5&limit=2`)).body;
    assert.deepEqual([beyond.total, beyond.inscriptions.length], [5, 0]);
    const tail = (await json<Page>(`${api.url}/inscriptions?offset=3`)).body;
    assert.deepEqual([tail.total, tail.limit, tail.inscriptions.length], [5, null, 2]);
  });
});

test("the owner filter counts only the rows of that owner, and pages them", async () => {
  await withApi(async (api) => {
    const whole = (await json<Page>(`${api.url}/inscriptions`)).body.inscriptions;
    const owner = whole[whole.length - 1].ownerAddress;
    const own = whole.filter((row) => row.ownerAddress === owner);
    assert.ok(own.length > 0 && own.length < whole.length);
    const page = (await json<Page>(`${api.url}/inscriptions?owner=${owner}&offset=1&limit=1`)).body;
    assert.equal(page.total, own.length);
    assert.deepEqual(page.inscriptions, own.slice(1, 2));
    assert.equal((await json<Page>(`${api.url}/inscriptions?owner=nobody`)).body.total, 0);
  });
});

test("a bad offset or limit is a 400 on every list endpoint, and the limit goes up to 1000", async () => {
  await withApi(async (api) => {
    const outpoint = "t1:0";
    for (const path of ["/inscriptions", `/output/${outpoint}`, "/pieces"]) {
      for (const query of ["limit=0", "limit=1001", "limit=-1", "limit=abc", "limit=", "limit=1e1", "offset=-1", "offset=1.5", "offset="]) {
        const { status, body } = await json<{ error: string }>(`${api.url}${path}?${query}`);
        assert.equal(status, 400, `${path}?${query}`);
        assert.match(body.error, /offset must be a whole number/);
      }
      assert.equal((await json<unknown>(`${api.url}${path}?limit=1000&offset=0`)).status, 200, path);
    }
  });
});

test("/output pages the P2MR Inscriptions at one output", async () => {
  await withApi(async (api) => {
    const all = await json<{ outpoint: string; total: number; offset: number; limit: number | null; inscriptions: { id: string }[] }>(`${api.url}/output/t1:0`);
    assert.equal(all.status, 200);
    assert.deepEqual([all.body.outpoint, all.body.total, all.body.offset, all.body.limit, all.body.inscriptions.length], ["t1:0", 3, 0, null, 3]);
    const page = (await json<typeof all.body>(`${api.url}/output/t1:0?offset=2&limit=5`)).body;
    assert.deepEqual([page.total, page.limit, page.inscriptions.map((row) => row.id)], [3, 5, [all.body.inscriptions[2].id]]);
    const none = (await json<typeof all.body>(`${api.url}/output/t1:7`)).body;
    assert.deepEqual([none.total, none.inscriptions.length], [0, 0]);
    assert.equal((await json<typeof all.body>(`${api.url}/output/nothing`)).body.total, 0);
  });
});

test("/pieces keeps its default of 100 and now accepts a limit up to 1000", async () => {
  await withApi(async (api) => {
    const { status, body } = await json<{ total: number; offset: number; limit: number; pieces: unknown[] }>(`${api.url}/pieces`);
    assert.equal(status, 200);
    assert.deepEqual([body.total, body.offset, body.limit, body.pieces.length], [0, 0, 100, 0]);
    assert.equal((await json<{ limit: number }>(`${api.url}/pieces?limit=1000`)).body.limit, 1000);
  });
});

test("every JSON answer names the tip it was computed for", async () => {
  await withApi(async (api, store) => {
    const tip = store.tip();
    const expected = `${tip?.height}:${tip?.hash}`;
    for (const path of ["/status", "/inscriptions", "/output/t1:0", "/collection", "/pieces", "/inscription/none", "/inscriptions?limit=0"]) {
      assert.equal((await json<unknown>(`${api.url}${path}`)).tip, expected, path);
    }
    const first = (await json<Page>(`${api.url}/inscriptions`)).body.inscriptions[0];
    const content = await fetch(`${api.url}/content/${first.id}`);
    assert.equal(content.headers.get("x-indexed-tip"), expected);
    assert.equal(content.headers.get("x-content-type-options"), "nosniff");
    assert.equal(content.headers.get("cache-control"), "no-store");
  });
});

test("/status lists the standards the indexer implements and the schema texts it reads", async () => {
  await withApi(async (api) => {
    const { body } = await json<{ standards: { id: string; status: string }[]; schemas: Record<string, string>; height: number }>(`${api.url}/status`);
    assert.deepEqual(body.standards, [1, 2, 3, 4, 5].map((n) => ({ id: `PINS-${n}`, status: "draft" })));
    assert.deepEqual(body.schemas, {
      collection: "pins-collection/1",
      price: "pins-price/1",
      leafList: "pins-leaflist/1",
      saleReveal: "pins-sale-reveal/1",
      close: "pins-close/1",
    });
    assert.equal(body.height, 2);
    // PINS-6 is for wallets and marketplaces, and the indexer reads no PSBT.
    assert.ok(STANDARDS.some((standard) => standard.id === "PINS-6"));
    assert.ok(!body.standards.some((standard) => standard.id === "PINS-6"));
    for (const id of INDEXER_STANDARD_IDS) assert.ok(STANDARDS.some((standard) => standard.id === id), id);
  });
});

test("an answer for one tip is kept, and a new block or a reorg drops it", async () => {
  await withApi(async (api, store) => {
    const before = await json<Page>(`${api.url}/inscriptions`);
    assert.equal(before.body.total, 5);
    const afterFirst = api.cacheStats();
    await json<Page>(`${api.url}/inscriptions?limit=1`);
    await json<Page>(`${api.url}/output/t1:0`);
    // Same tip: no further computation for the list or the outputs.
    assert.deepEqual(api.cacheStats(), { hits: afterFirst.hits + 2, misses: afterFirst.misses });

    // A new block shows its P2MR Inscription at once.
    store.commit(block({ hash: "c", height: 3, txs: [coinbase("c3"), reveal("t3", "02", KEY_A, OWNER_A, 1, 3)] }));
    const grown = await json<Page>(`${api.url}/inscriptions`);
    assert.equal(grown.body.total, 6);
    assert.equal(grown.tip?.split(":")[0], "3");
    assert.equal((await json<{ total: number }>(`${api.url}/output/t3:0`)).body.total, 1);

    // A reorg: the block at height 3 is replaced by another block at height 3 with another transaction.
    store.disconnect();
    const shrunk = await json<Page>(`${api.url}/inscriptions`);
    assert.equal(shrunk.body.total, 5);
    assert.equal((await json<{ total: number }>(`${api.url}/output/t3:0`)).body.total, 0);
    store.commit(block({ hash: "c2", height: 3, txs: [coinbase("c3b"), reveal("t3b", "02", KEY_B, OWNER_B, 2, 4)] }));
    const replaced = await json<Page>(`${api.url}/inscriptions`);
    assert.equal(replaced.body.total, 7);
    assert.equal(replaced.tip?.split(":")[1], "c2");
    assert.equal((await json<{ total: number }>(`${api.url}/output/t3:0`)).body.total, 0);
    assert.equal((await json<{ total: number }>(`${api.url}/output/t3b:0`)).body.total, 2);
  });
});

test("the collection view is kept for a tip and recomputed for the next one", async () => {
  const body = Uint8Array.of(9, 8, 7);
  // CBOR { meta: { name: "#1", attributes: [] } }, the name matching the genesis prefix.
  const metadata = Buffer.from("a1646d657461a2646e616d656223316a6174747269627574657380", "hex");
  const preimage = Buffer.alloc(68);
  preimage.writeUInt32BE(1, 0);
  createHash("sha256").update(body).digest().copy(preimage, 4);
  createHash("sha256").update(metadata).digest().copy(preimage, 36);
  const leaf = createHash("sha256").update(preimage).digest();
  const field5 = await encodeGenesisField({
    schema: "pins-collection/1",
    name: "Set",
    supply: 1,
    first: 1,
    namePrefix: "#",
    itemType: "application/octet-stream",
    root: Buffer.from(leaf).toString("hex"),
    issuer: Buffer.from(KEY_A).toString("hex"),
    saleCommitment: "11".repeat(32),
  });
  const dir = mkdtempSync(join(tmpdir(), "api-view-cache-"));
  const store = new Store(join(dir, "a.sqlite"), { network: "regtest" });
  store.commit(block({
    hash: "g",
    height: 1,
    txs: [coinbase("c1"), {
      txid: "genesis",
      inputs: [{
        prevTxid: "00",
        prevVout: 0,
        value: 20_000n,
        leafScript: itemsLeaf(KEY_A, [
          { body: new TextEncoder().encode("{\"name\":\"Set\"}"), contentType: "application/json", metadata: field5 },
          { body: new Uint8Array(leaf), contentType: "application/octet-stream" },
        ]),
      }],
      outputs: [{ value: 10_000n, script: OWNER_A }, { value: 10_000n, script: OWNER_A }],
    }],
  }));
  store.commit(block({
    hash: "p",
    height: 2,
    txs: [coinbase("c2"), {
      txid: "piece",
      inputs: [{ prevTxid: "01", prevVout: 0, value: 10_000n, leafScript: itemsLeaf(KEY_A, [{ body, contentType: "application/octet-stream", metadata }]) }],
      outputs: [{ value: 10_000n, script: OWNER_A }],
    }],
  }));
  const api = await startApi(store, 0, "regtest");
  try {
    type View = { status: string; authentic: number };
    type Piece = { authentic: boolean; confirmations: number };
    assert.equal((await json<View>(`${api.url}/collection`)).body.authentic, 1);
    assert.equal((await json<Piece>(`${api.url}/pieces/1`)).body.confirmations, 1);
    const kept = api.cacheStats();
    assert.equal((await json<{ total: number }>(`${api.url}/pieces?authentic=1`)).body.total, 1);
    assert.deepEqual(api.cacheStats(), { hits: kept.hits + 1, misses: kept.misses });
    // The next block raises the confirmations of the piece, so the view has to be computed again.
    store.commit(block({ hash: "n", height: 3, txs: [coinbase("c3")] }));
    assert.equal((await json<Piece>(`${api.url}/pieces/1`)).body.confirmations, 2);
    assert.equal(api.cacheStats().misses, kept.misses + 1);
  } finally {
    await api.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
