// SPDX-License-Identifier: Apache-2.0

/**
 * `/output/{txid}:{vout}` tells an output the indexer does not know from one that holds nothing, and refuses a
 * malformed outpoint instead of reading it as another one. docs/indexer/API.md describes the answer.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { itemsLeaf } from "../inscriber/reveal.ts";
import { startApi } from "./api.ts";
import type { ChainBlock, ChainTx } from "./pins.ts";
import { Store } from "./store.ts";

const T = (name: string): string => createHash("sha256").update(name).digest("hex");
const KEY = new Uint8Array(32).fill(9);
const OWNER = Uint8Array.of(0x52, 0x20, ...new Uint8Array(32).fill(4));

const block = (partial: Omit<ChainBlock, "subsidy">): ChainBlock => ({ subsidy: 50n, ...partial });
const coinbase = (txid: string): ChainTx => ({ txid, inputs: [{ coinbase: true, value: 50n }], outputs: [{ value: 50n, script: OWNER }] });

type Answer = { outpoint: string; known: boolean; spent: boolean | null; total: number; offset: number; limit: number | null; inscriptions: { id: string }[] };

async function get(url: string): Promise<{ status: number; body: Answer & { error?: string } }> {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() as Answer & { error?: string } };
}

async function withApi(run: (url: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "api-output-"));
  const store = new Store(join(dir, "a.sqlite"), { network: "regtest" });
  store.bindActivation(1);
  const reveal: ChainTx = {
    txid: T("reveal"),
    inputs: [{ prevTxid: T("funding"), prevVout: 0, value: 20_000n, leafScript: itemsLeaf(KEY, [{ body: Uint8Array.of(1), contentType: "application/octet-stream" }]) }],
    outputs: [{ value: 10_000n, script: OWNER }, { value: 5_000n, script: OWNER }],
  };
  store.commit(block({ hash: "a", height: 1, txs: [coinbase(T("cb1")), reveal] }));
  const spend: ChainTx = {
    txid: T("spend"),
    inputs: [{ prevTxid: T("cb1"), prevVout: 0, value: 50n, p2mr: true, witnessItems: 3 }],
    outputs: [{ value: 49n, script: OWNER }],
  };
  store.commit(block({ hash: "b", height: 2, txs: [coinbase(T("cb2")), spend] }));
  const api = await startApi(store, 0, "regtest");
  try {
    await run(api.url);
  } finally {
    await api.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an output that holds a P2MR Inscription is known, unspent and lists it", async () => {
  await withApi(async (url) => {
    const { status, body } = await get(`${url}/output/${T("reveal")}:0`);
    assert.equal(status, 200);
    assert.deepEqual([body.outpoint, body.known, body.spent, body.total, body.inscriptions.length], [`${T("reveal")}:0`, true, false, 1, 1]);
  });
});

test("an output the indexer knows that holds nothing is known and empty, not unknown", async () => {
  await withApi(async (url) => {
    for (const [name, vout, spent] of [["reveal", 1, false], ["cb2", 0, false], ["spend", 0, false], ["cb1", 0, true]] as const) {
      const { status, body } = await get(`${url}/output/${T(name)}:${vout}`);
      assert.equal(status, 200, name);
      assert.deepEqual([body.known, body.spent, body.total, body.inscriptions], [true, spent, 0, []], `${name}:${vout}`);
    }
  });
});

test("an output the indexer has no record of answers 200 with known false, and spent and the list say nothing", async () => {
  await withApi(async (url) => {
    for (const outpoint of [`${T("never")}:0`, `${T("reveal")}:2`, `${T("reveal")}:4294967294`, `${T("funding")}:0`]) {
      const { status, body } = await get(`${url}/output/${outpoint}`);
      assert.equal(status, 200, outpoint);
      assert.deepEqual([body.outpoint, body.known, body.spent, body.total, body.inscriptions], [outpoint, false, null, 0, []]);
    }
  });
});

test("a malformed outpoint is a 400 and is never read as another output", async () => {
  await withApi(async (url) => {
    const id = T("reveal");
    const bad = [
      "nothing", "t1:0", id, `${id}:`, `:0`, `${id}:00`, `${id}:01`, `${id}:+0`, `${id}:-0`, `${id}:-1`, `${id}:0x0`, `${id}:0e0`, `${id}:0.0`, `${id}:%200`,
      `${id}:4294967295`, `${id}:4294967296`, `${id}:99999999999`, `${id}:00000000000`, `${id}:0:0`, `${id}:%30%30`, `${id}:%2B0`,
      `${id.toUpperCase()}:0`, `${id.slice(0, 63)}:0`, `${id}0:0`, `${id.slice(0, 63)}g:0`, `0x${id.slice(2)}:0`,
    ];
    for (const outpoint of bad) {
      const { status, body } = await get(`${url}/output/${outpoint}`);
      assert.equal(status, 400, JSON.stringify(outpoint));
      assert.match(String(body.error), /^outpoint must be <txid>:<vout>/);
    }
    assert.equal((await get(`${url}/output/`)).status, 400);
    // The canonical form with an escaped colon is the same outpoint.
    const escaped = await get(`${url}/output/${id}%3A0`);
    assert.deepEqual([escaped.status, escaped.body.outpoint, escaped.body.known], [200, `${id}:0`, true]);
  });
});

test("a bad offset or limit is still a 400 on a good outpoint, and a good one pages", async () => {
  await withApi(async (url) => {
    const id = `${T("reveal")}:0`;
    assert.equal((await get(`${url}/output/${id}?limit=0`)).status, 400);
    const page = await get(`${url}/output/${id}?offset=1&limit=5`);
    assert.deepEqual([page.status, page.body.known, page.body.total, page.body.inscriptions.length, page.body.offset, page.body.limit], [200, true, 1, 0, 1, 5]);
  });
});
