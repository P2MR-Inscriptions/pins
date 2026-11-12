// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChainBlock } from "./pins.ts";
import { Store } from "./store.ts";

const SCRIPT = Uint8Array.of(0x52, 0x20, ...new Uint8Array(32).fill(1));
const PRE = "ab".repeat(32);

const txid = (n: number) => `${"dd".repeat(30)}${n.toString(16).padStart(4, "0")}`;

/** Block `height` holds one transaction that spends the output of the one before it (the first spends `PRE`). */
function block(height: number): ChainBlock {
  const spends = height === 0 ? { prevTxid: PRE, prevVout: 0 } : { prevTxid: txid(height - 1), prevVout: 0 };
  return {
    hash: (height + 1).toString(16).padStart(64, "0"),
    height,
    subsidy: 50n,
    txs: [
      { txid: txid(1_000 + height), inputs: [{ coinbase: true, value: 0n }], outputs: [] },
      { txid: txid(height), inputs: [{ ...spends, value: 100n, p2mr: true, witnessItems: 3 }], outputs: [{ value: 100n, script: SCRIPT }] },
    ],
  };
}

function scratch(options: { undoDepth?: number } = {}): { store: Store; path: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pins-outputs-"));
  const path = join(dir, "index.sqlite");
  const store = new Store(path, options);
  store.saveOutput(PRE, 0, 100n, true);
  return { store, path, done: () => { try { store.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); } };
}

function rows(path: string): { txid: string; spent_height: number | null }[] {
  const db = new DatabaseSync(path);
  try {
    return db.prepare("SELECT txid, spent_height FROM outputs ORDER BY height, txid").all() as { txid: string; spent_height: number | null }[];
  } finally {
    db.close();
  }
}

test("a spent output is deleted once the undo of its spending block is", () => {
  const { store, path, done } = scratch({ undoDepth: 5 });
  try {
    for (let height = 0; height < 60; height += 1) store.commit(block(height));
    const left = rows(path);
    // The unspent output of the tip, and the outputs spent in the last 5 blocks (their undo is still kept).
    assert.ok(left.length <= 7, `${left.length} output rows after 60 blocks with an undo depth of 5`);
    assert.equal(left.filter((row) => row.spent_height === null).length, 1);
    assert.equal(store.outputValue(txid(59), 0), 100n);
    assert.equal(store.outputValue(txid(10), 0), undefined);
  } finally {
    done();
  }
});

test("a block inside the undo depth can be disconnected and its spends are open again", () => {
  const { store, path, done } = scratch({ undoDepth: 5 });
  try {
    for (let height = 0; height < 20; height += 1) store.commit(block(height));
    store.disconnect();
    store.disconnect();
    store.disconnect();
    assert.equal(store.tip()?.height, 16);
    assert.equal(store.outputValue(txid(16), 0), 100n);
    assert.equal(rows(path).find((row) => row.txid === txid(16))?.spent_height, null);
    // The new branch spends the same output again.
    store.commit({ ...block(17), hash: "ff".repeat(32) });
    assert.equal(rows(path).find((row) => row.txid === txid(16))?.spent_height, 17);
  } finally {
    done();
  }
});

test("an output spent in the same block it was created in is recorded as spent", () => {
  const { store, path, done } = scratch({ undoDepth: 2 });
  try {
    const first = block(0);
    first.txs.push({ txid: txid(500), inputs: [{ prevTxid: txid(0), prevVout: 0, value: 100n, p2mr: true, witnessItems: 3 }], outputs: [{ value: 100n, script: SCRIPT }] });
    store.commit(first);
    assert.equal(rows(path).find((row) => row.txid === txid(0))?.spent_height, 0);
    assert.equal(rows(path).find((row) => row.txid === txid(500))?.spent_height, null);
  } finally {
    done();
  }
});

test("a database from before spends were recorded is upgraded and keeps its old outputs", () => {
  const { store, path, done } = scratch({ undoDepth: 1_000 });
  for (let height = 0; height < 10; height += 1) store.commit(block(height));
  store.close();
  const raw = new DatabaseSync(path);
  raw.exec("DROP INDEX outputs_spent; ALTER TABLE outputs DROP COLUMN spent_height;");
  raw.close();
  const upgraded = new Store(path, { undoDepth: 5 });
  try {
    const before = rows(path);
    assert.equal(before.length, 11);
    assert.ok(before.every((row) => row.spent_height === null));
    for (let height = 10; height < 40; height += 1) upgraded.commit(block(height));
    const after = rows(path);
    // The ten old outputs are not known to be spent, so they stay. The new ones are pruned.
    assert.ok(after.length <= 11 + 7, `${after.length} rows`);
    assert.equal(upgraded.outputValue(txid(3), 0), 100n);
  } finally {
    upgraded.close();
    done();
  }
});
