// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChainBlock } from "./pins.ts";
import { DEFAULT_UNDO_DEPTH, Store } from "./store.ts";

const GENESIS_A = `${"aa".repeat(32)}i0`;
const GENESIS_B = `${"bb".repeat(32)}i0`;

function block(height: number): ChainBlock {
  const hash = height.toString(16).padStart(64, "0");
  return { hash, height, subsidy: 50n, txs: [{ txid: `${"cc".repeat(30)}${height.toString(16).padStart(4, "0")}`, inputs: [{ coinbase: true, value: 0n }], outputs: [] }] };
}

function scratch(): { path: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pins-store-"));
  return { path: join(dir, "index.sqlite"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

function metaRows(path: string): Record<string, string> {
  const db = new DatabaseSync(path);
  try {
    const rows = db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  } finally {
    db.close();
  }
}

test("the default undo depth is 1,000 blocks, the minimum PINS-2 recommends", () => {
  const { path, done } = scratch();
  const store = new Store(path);
  try {
    assert.equal(DEFAULT_UNDO_DEPTH, 1_000);
    assert.equal(store.undoDepth, 1_000);
    for (let height = 0; height < 1_005; height += 1) store.commit(block(height));
    assert.equal(store.undoCount(), 1_000);
  } finally {
    store.close();
    done();
  }
});

test("a reorg of 150 blocks is undone with the default depth", () => {
  const { path, done } = scratch();
  const store = new Store(path);
  try {
    for (let height = 0; height < 160; height += 1) store.commit(block(height));
    for (let i = 0; i < 150; i += 1) store.disconnect();
    assert.equal(store.tip()?.height, 9);
  } finally {
    store.close();
    done();
  }
});

test("an explicit undo depth still applies", () => {
  const { path, done } = scratch();
  const store = new Store(path, { undoDepth: 3 });
  try {
    for (let height = 0; height < 10; height += 1) store.commit(block(height));
    assert.equal(store.undoCount(), 3);
  } finally {
    store.close();
    done();
  }
});

test("a new database records the network, marker, schema and pinned genesis", () => {
  const { path, done } = scratch();
  new Store(path, { network: "testnet4", marker: Uint8Array.of(1, 2, 3, 4), schema: "c/1", genesisId: GENESIS_A }).close();
  try {
    const rows = metaRows(path);
    assert.equal(rows.network, "testnet4");
    assert.equal(rows.marker, "01020304");
    assert.equal(rows.collection_schema, "c/1");
    assert.equal(rows.genesis_id, GENESIS_A);
  } finally {
    done();
  }
});

test("a database is refused when it is opened for another network, marker, or schema", () => {
  const { path, done } = scratch();
  const first = new Store(path, { network: "testnet4", marker: Uint8Array.of(1, 2, 3, 4), schema: "c/1" });
  first.commit(block(0));
  first.close();
  try {
    assert.throws(() => new Store(path, { network: "regtest", marker: Uint8Array.of(1, 2, 3, 4), schema: "c/1" }), /built for network testnet4, not regtest/);
    assert.throws(() => new Store(path, { network: "testnet4", marker: Uint8Array.of(9, 9, 9, 9), schema: "c/1" }), (error: Error) => {
      assert.match(error.message, /another marker/);
      assert.doesNotMatch(error.message, /01020304|09090909/);
      return true;
    });
    assert.throws(() => new Store(path, { network: "testnet4", marker: Uint8Array.of(1, 2, 3, 4) }), /collection schema c\/1, not pins-collection\/1/);
    // The refusals changed nothing: the original options still open it, with its block.
    const again = new Store(path, { network: "testnet4", marker: Uint8Array.of(1, 2, 3, 4), schema: "c/1" });
    assert.equal(again.tip()?.height, 0);
    again.close();
  } finally {
    done();
  }
});

test("a pinned genesis can be added, but not changed or dropped", () => {
  const { path, done } = scratch();
  new Store(path).close();
  try {
    new Store(path, { genesisId: GENESIS_A }).close();
    assert.equal(metaRows(path).genesis_id, GENESIS_A);
    assert.throws(() => new Store(path, { genesisId: GENESIS_B }), /built with --genesis a+i0, not b+i0/);
    assert.throws(() => new Store(path), /built with --genesis a+i0\./);
    new Store(path, { genesisId: GENESIS_A }).close();
  } finally {
    done();
  }
});

test("a database from before the configuration was recorded is adopted", () => {
  const { path, done } = scratch();
  const old = new Store(path, { network: "testnet4" });
  for (let height = 0; height < 5; height += 1) old.commit(block(height));
  old.close();
  const raw = new DatabaseSync(path);
  raw.exec("DELETE FROM meta WHERE key != 'schema'");
  raw.close();
  try {
    const adopted = new Store(path, { network: "testnet4" });
    assert.equal(adopted.tip()?.height, 4);
    adopted.close();
    const rows = metaRows(path);
    assert.equal(rows.network, "testnet4");
    assert.equal(rows.collection_schema, "pins-collection/1");
    assert.equal(rows.genesis_id, "");
    assert.equal(rows.marker, "70696e73");
    assert.throws(() => new Store(path, { network: "regtest" }), /built for network testnet4/);
  } finally {
    done();
  }
});

test("a database with only some of the rows gets the missing ones and keeps the others", () => {
  const { path, done } = scratch();
  new Store(path, { network: "testnet4", schema: "c/1" }).close();
  const raw = new DatabaseSync(path);
  raw.exec("DELETE FROM meta WHERE key IN ('marker', 'genesis_id')");
  raw.close();
  try {
    new Store(path, { network: "testnet4", schema: "c/1" }).close();
    assert.equal(metaRows(path).marker, "70696e73");
    assert.throws(() => new Store(path, { network: "testnet4" }), /collection schema c\/1/);
  } finally {
    done();
  }
});

test("the activation height is recorded once and checked while the database holds blocks", () => {
  const { path, done } = scratch();
  const store = new Store(path);
  try {
    store.bindActivation(5);
    store.bindActivation(5);
    // Empty: the new height replaces it.
    store.bindActivation(6);
    store.commit(block(6));
    assert.throws(() => store.bindActivation(7), /started at activation height 6, not 7/);
    store.resync();
    store.bindActivation(7);
    assert.equal(metaRows(path).activation_height, "7");
  } finally {
    store.close();
    done();
  }
});

test("a database that holds blocks and no activation height adopts the first one given", () => {
  const { path, done } = scratch();
  const old = new Store(path);
  old.commit(block(3));
  old.close();
  const raw = new DatabaseSync(path);
  raw.exec("DELETE FROM meta WHERE key = 'activation_height'");
  raw.close();
  const store = new Store(path);
  try {
    store.bindActivation(3);
    assert.equal(metaRows(path).activation_height, "3");
    assert.throws(() => store.bindActivation(0), /started at activation height 3, not 0/);
  } finally {
    store.close();
    done();
  }
});
