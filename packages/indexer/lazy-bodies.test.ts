// SPDX-License-Identifier: Apache-2.0

/**
 * The indexer keeps no content body in memory once a block is committed, reads field 1 as the bytes the envelope
 * carries, prepares each SQL statement once, and applies a block entirely or not at all.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildEnvelope, revealLeaf } from "../inscriber/script.ts";
import { startApi } from "./api.ts";
import { stateHash } from "./hash.ts";
import { contentTypeBytes, hasContentType, Indexer, type ChainBlock, type ChainTx } from "./pins.ts";
import { Store } from "./store.ts";

const PUBKEY = new Uint8Array(32).fill(9);
const SCRIPT = Uint8Array.of(0x52, 0x20, ...new Uint8Array(32).fill(4));
const OTHER = Uint8Array.of(0x52, 0x20, ...new Uint8Array(32).fill(5));

const coinbase = (txid: string): ChainTx => ({ txid, inputs: [{ coinbase: true, value: 50n }], outputs: [{ value: 50n, script: SCRIPT }] });

/** A transaction that reveals one P2MR Inscription whose field 1 is exactly `contentType`. */
function reveal(txid: string, contentType: Uint8Array, body: Uint8Array): ChainTx {
  const leafScript = revealLeaf(PUBKEY, [buildEnvelope([{ tag: 1, value: contentType }], body)]);
  return {
    txid,
    inputs: [{ prevTxid: "00".repeat(32), prevVout: 0, value: 10_000n, leafScript }],
    outputs: [{ value: 10_000n, script: SCRIPT }],
  };
}

/** A transaction that spends the output `prevTxid`:0 and pays it to `script`. */
function spend(txid: string, prevTxid: string, script: Uint8Array): ChainTx {
  return {
    txid,
    inputs: [{ prevTxid, prevVout: 0, value: 10_000n, p2mr: true, witnessItems: 3 }],
    outputs: [{ value: 10_000n, script }],
  };
}

const block = (height: number, txs: ChainTx[]): ChainBlock => ({ hash: (height + 1).toString(16).padStart(64, "0"), height, subsidy: 50n, txs });
const text = (value: string) => new TextEncoder().encode(value);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

function scratch(): { path: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pins-lazy-"));
  return { path: join(dir, "index.sqlite"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a committed P2MR Inscription holds no body; the body is read from the store when asked for", () => {
  const { path, done } = scratch();
  const body = text("hello, world");
  const store = new Store(path, { network: "regtest" });
  try {
    store.commit(block(1, [coinbase("c1"), reveal("aa", text("text/plain"), body)]));
    const item = store.indexer.get("aai0");
    assert.ok(item);
    assert.equal(item.body, undefined);
    assert.equal(item.bodyLength, body.length);
    assert.equal(item.bodySha256, createHash("sha256").update(body).digest("hex"));
    assert.deepEqual(store.indexer.bodyOf("aai0"), body);
    // Asking does not make the body resident.
    assert.equal(store.indexer.get("aai0")?.body, undefined);
    assert.equal(store.indexer.bodyOf("missing"), undefined);
  } finally {
    store.close();
  }
  const reopened = new Store(path, { network: "regtest" });
  try {
    const item = reopened.indexer.get("aai0");
    assert.equal(item?.body, undefined);
    assert.equal(item?.bodyLength, body.length);
    assert.deepEqual(reopened.indexer.bodyOf("aai0"), body);
  } finally {
    reopened.close();
    done();
  }
});

test("a body that is not committed yet is resident, and an undone block leaves no body behind", () => {
  const { path, done } = scratch();
  const store = new Store(path, { network: "regtest" });
  try {
    store.commit(block(1, [coinbase("c1")]));
    store.indexer.applyBlock(block(2, [coinbase("c2"), reveal("bb", text("text/plain"), Uint8Array.of(1, 2, 3))]));
    assert.deepEqual(store.indexer.get("bbi0")?.body, Uint8Array.of(1, 2, 3));
    assert.deepEqual(store.indexer.bodyOf("bbi0"), Uint8Array.of(1, 2, 3));
    store.indexer.disconnectTip(block(2, []).hash);
    assert.equal(store.indexer.bodyOf("bbi0"), undefined);

    store.commit(block(2, [coinbase("c2"), reveal("bb", text("text/plain"), Uint8Array.of(1, 2, 3))]));
    store.disconnect();
    assert.equal(store.indexer.get("bbi0"), undefined);
    assert.equal(store.indexer.bodyOf("bbi0"), undefined);
  } finally {
    store.close();
    done();
  }
});

test("moving a P2MR Inscription does not write its body again", () => {
  const { path, done } = scratch();
  const store = new Store(path, { network: "regtest" });
  const side = new DatabaseSync(path);
  try {
    store.commit(block(1, [coinbase("c1"), reveal("aa", text("text/plain"), Uint8Array.of(1, 2, 3))]));
    // Change the stored body behind the store's back: a write of the body by the move would undo this.
    side.prepare("UPDATE inscriptions SET body = ? WHERE id = ?").run(Uint8Array.of(7, 7, 7, 7), "aai0");
    store.commit(block(2, [coinbase("c2"), spend("bb", "aa", OTHER)]));
    assert.equal(store.indexer.get("aai0")?.ownerScript, hex(OTHER));
    const row = side.prepare("SELECT body FROM inscriptions WHERE id = ?").get("aai0") as { body: Uint8Array };
    assert.deepEqual(new Uint8Array(row.body), Uint8Array.of(7, 7, 7, 7));
  } finally {
    side.close();
    store.close();
    done();
  }
});

test("field 1 is kept, stored and served as the bytes of the envelope", async () => {
  const { path, done } = scratch();
  const cases: { id: string; type: Uint8Array; shown: string }[] = [
    { id: "a1i0", type: Uint8Array.of(0xff, 0x0a, 0x25, 0x61, 0x2f, 0x62), shown: "\ufffd\n%a/b" },
    { id: "a2i0", type: Uint8Array.of(0xef, 0xbb, 0xbf, ...text("text/plain")), shown: "\ufefftext/plain" },
    { id: "a3i0", type: Uint8Array.of(0xc3, 0x28), shown: "\ufffd(" },
    { id: "a4i0", type: new Uint8Array(), shown: "" },
  ];
  const store = new Store(path, { network: "regtest" });
  const seen: Record<string, string> = {};
  const hashBefore: string[] = [];
  try {
    cases.forEach((entry, index) => {
      store.commit(block(index + 1, [coinbase(`c${index}`), reveal(entry.id.slice(0, 2), entry.type, Uint8Array.of(index))]));
      hashBefore.push(store.tip()!.stateHash);
    });
    const api = await startApi(store, 0, "regtest");
    try {
      for (const entry of cases) {
        const item = store.indexer.get(entry.id)!;
        assert.equal(hex(contentTypeBytes(item)), hex(entry.type));
        assert.equal(item.contentType, entry.shown);
        const row = await (await fetch(`${api.url}/inscription/${entry.id}`)).json() as { contentType: string; contentTypeHex: string };
        assert.equal(row.contentTypeHex, hex(entry.type));
        assert.equal(row.contentType, entry.shown);
        seen[entry.id] = row.contentTypeHex;
      }
    } finally {
      await api.close();
    }
  } finally {
    store.close();
  }
  // Read again from disk: the same bytes, and the same state hash for every block.
  const reopened = new Store(path, { network: "regtest" });
  try {
    for (const entry of cases) {
      const item = reopened.indexer.get(entry.id)!;
      assert.equal(hex(contentTypeBytes(item)), seen[entry.id]);
      assert.equal(item.contentType, entry.shown);
    }
    const tip = reopened.tip()!;
    assert.equal(stateHash(reopened.indexer, tip), tip.stateHash);
    assert.equal(tip.stateHash, hashBefore.at(-1));
  } finally {
    reopened.close();
    done();
  }
});

test("a content type is compared by its bytes, not by the text shown for it", () => {
  const indexer = new Indexer("regtest");
  indexer.applyBlock(block(1, [coinbase("c1"), reveal("aa", Uint8Array.of(0xef, 0xbb, 0xbf, ...text("text/plain")), Uint8Array.of(1))]));
  const item = indexer.get("aai0")!;
  assert.equal(hasContentType(item, "text/plain"), false);
  assert.equal(hasContentType(item, "\ufefftext/plain"), true);
  const bare = new Indexer("regtest");
  bare.applyBlock(block(1, [coinbase("c1"), reveal("bb", text("text/plain"), Uint8Array.of(1))]));
  assert.equal(hasContentType(bare.get("bbi0")!, "text/plain"), true);
});

test("a block that fails half way leaves the indexer as it was", () => {
  const indexer = new Indexer("regtest");
  indexer.applyBlock(block(1, [coinbase("c1"), reveal("aa", text("text/plain"), Uint8Array.of(1))]));
  const before = stateHash(indexer, { height: 1, hash: block(1, []).hash });
  // The first transaction moves one P2MR Inscription and creates another; the second has no outputs list at all.
  const broken: ChainTx = { txid: "ee", inputs: [{ prevTxid: "ff".repeat(32), prevVout: 0, value: 1n, p2mr: true, witnessItems: 3 }], outputs: null as unknown as ChainTx["outputs"] };
  assert.throws(() => indexer.applyBlock(block(2, [coinbase("c2"), spend("bb", "aa", OTHER), reveal("cc", text("text/plain"), Uint8Array.of(2)), broken])), TypeError);
  // Nothing of the first two transactions is left, and no undo entry was written for the block.
  assert.throws(() => indexer.disconnectTip(block(2, []).hash), /not the tip/u);
  assert.equal(indexer.get("cci0"), undefined);
  assert.equal(indexer.get("aai0")?.ownerScript, hex(SCRIPT));
  assert.equal(stateHash(indexer, { height: 1, hash: block(1, []).hash }), before);
  // And it goes on: the same block without the broken transaction applies.
  indexer.applyBlock(block(2, [coinbase("c2"), spend("bb", "aa", OTHER), reveal("cc", text("text/plain"), Uint8Array.of(2))]));
  assert.equal(indexer.get("cci0")?.number, 1);
  assert.equal(indexer.get("aai0")?.ownerScript, hex(OTHER));
});

test("each SQL statement is prepared once per store", () => {
  const { path, done } = scratch();
  const store = new Store(path, { network: "regtest" });
  try {
    store.commit(block(1, [coinbase("c1"), reveal("aa", text("text/plain"), Uint8Array.of(1))]));
    store.commit(block(2, [coinbase("c2"), spend("bb", "aa", OTHER)]));
    const cache = (store as unknown as { statements: Map<string, unknown> }).statements;
    const first = [...cache.values()];
    assert.ok(first.length > 0);
    const run = (from: number, to: number) => {
      for (let height = from; height < to; height += 1) store.commit(block(height, [coinbase(`c${height}`), spend(`t${height}`, height === 3 ? "bb" : `t${height - 1}`, height % 2 ? SCRIPT : OTHER)]));
    };
    run(3, 40);
    store.disconnect();
    const warm = cache.size;
    run(39, 120);
    store.disconnect();
    assert.equal(cache.size, warm, "a statement set that does not grow with the number of blocks");
    for (const statement of first) assert.ok([...cache.values()].includes(statement), "the same prepared statement is reused");
  } finally {
    store.close();
    done();
  }
});

test("the stored row of a P2MR Inscription holds its fields and not its envelope, and an older row that does is read without it", () => {
  const { path, done } = scratch();
  const store = new Store(path, { network: "regtest" });
  const side = new DatabaseSync(path);
  try {
    store.commit(block(1, [coinbase("c1"), reveal("aa", text("text/plain"), new Uint8Array(100_000).fill(3))]));
    const row = side.prepare("SELECT payload, length(body) AS body FROM inscriptions WHERE id = ?").get("aai0") as { payload: string; body: number };
    assert.equal(row.body, 100_000);
    assert.ok(row.payload.length < 1_000, `a stored row of ${row.payload.length} characters for a 100,000-byte body`);
    const record = JSON.parse(row.payload) as Record<string, unknown>;
    assert.equal(record.envelope, undefined);
    assert.equal(record.inputIndex, undefined);
    assert.equal(record.body, undefined);
    // A row that carries both, and a `contentType`.
    side.prepare("UPDATE inscriptions SET payload = ? WHERE id = ?").run(JSON.stringify({ ...record, contentType: "x", inputIndex: 0, envelope: { fields: [], body: { 0: 3 }, flags: [] } }), "aai0");
  } finally {
    side.close();
    store.close();
  }
  const reopened = new Store(path, { network: "regtest" });
  try {
    const item = reopened.indexer.get("aai0") as unknown as Record<string, unknown>;
    assert.equal(item.envelope, undefined);
    assert.equal(item.inputIndex, undefined);
    assert.equal(item.contentType, "text/plain");
  } finally {
    reopened.close();
    done();
  }
});
