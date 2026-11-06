// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { follow, pollChain, type Rpc } from "./follow.ts";
import type { RpcBlock } from "./chain.ts";
import { Store } from "./store.ts";

function rpc(chain: string): Rpc {
  return {
    call: async <T>(method: string): Promise<T> => {
      if (method === "getblockchaininfo") return { chain, blocks: 0, bestblockhash: "aa" } as T;
      if (method === "getblockcount") return 0 as T;
      throw new Error(method);
    },
  };
}

/** A coinbase whose script tag makes the raw bytes differ between the two tips. */
function coinbaseHex(tag: number): string {
  const script = Buffer.from([0x03, tag, 0x00, 0x00]);
  const value = Buffer.alloc(8);
  value.writeBigUInt64LE(50n);
  return Buffer.concat([
    Buffer.from([0x01, 0x00, 0x00, 0x00]),
    Buffer.from([0x01]),
    Buffer.alloc(32),
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    Buffer.from([script.length]),
    script,
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    Buffer.from([0x01]),
    value,
    Buffer.from([0x00]),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
  ]).toString("hex");
}

function block(hash: string, height: number, tag: number): RpcBlock {
  return {
    hash,
    height,
    tx: [{
      txid: `${hash.slice(0, 62)}${height.toString(16).padStart(2, "0")}`,
      hex: coinbaseHex(tag),
      vin: [{ coinbase: "030000" }],
      vout: [{ scriptPubKey: { hex: "" } }],
    }],
  };
}

test("follow stays on regtest unless another network is named", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pins-follow-"));
  const store = new Store(join(dir, "index.sqlite"));
  try {
    await assert.rejects(() => follow(store, rpc("main"), 1), /refusing chain main/);
    const synced = await follow(store, rpc("main"), 1, "mainnet");
    assert.equal(synced.height, -1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pollChain replaces the tip when the best hash changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pins-follow-"));
  const store = new Store(join(dir, "index.sqlite"));
  const first = "aa".repeat(32);
  const second = "bb".repeat(32);
  let tip = first;
  let blocksFetched = 0;
  const rpc: Rpc = {
    call: async <T>(method: string): Promise<T> => {
      if (method === "getblockchaininfo") return { chain: "regtest", blocks: 0, bestblockhash: tip } as T;
      if (method === "getblockcount") return 0 as T;
      if (method === "getbestblockhash" || method === "getblockhash") return tip as T;
      if (method === "getblock") {
        blocksFetched += 1;
        return block(tip, 0, tip === first ? 1 : 2) as T;
      }
      throw new Error(method);
    },
  };
  try {
    await follow(store, rpc, 0, "regtest");
    assert.equal(store.tip()?.hash, first);
    tip = second;
    const stop = new AbortController();
    await pollChain(store, rpc, 0, "regtest", {
      intervalMs: 1,
      signal: stop.signal,
      sleep: async () => stop.abort(),
      log: () => undefined,
    });
    assert.equal(store.tip()?.hash, second);
    assert.equal(store.tip()?.height, 0);
    assert.ok(blocksFetched >= 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pollChain indexes a block that arrives after the first catch-up", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pins-follow-"));
  const store = new Store(join(dir, "index.sqlite"));
  const hashes = ["11".repeat(32), "22".repeat(32)];
  let height = 0;
  const rpc: Rpc = {
    call: async <T>(method: string, params?: unknown[]): Promise<T> => {
      if (method === "getblockchaininfo") return { chain: "regtest", blocks: height, bestblockhash: hashes[height] } as T;
      if (method === "getblockcount") return height as T;
      if (method === "getbestblockhash") return hashes[height] as T;
      if (method === "getblockhash") return hashes[Number(params?.[0])] as T;
      if (method === "getblock") {
        const hash = String(params?.[0]);
        const at = hashes.indexOf(hash);
        return block(hash, at, at + 1) as T;
      }
      throw new Error(method);
    },
  };
  try {
    await follow(store, rpc, 0, "regtest");
    assert.equal(store.tip()?.height, 0);
    height = 1;
    const stop = new AbortController();
    await pollChain(store, rpc, 0, "regtest", {
      intervalMs: 1,
      signal: stop.signal,
      sleep: async () => stop.abort(),
      log: () => undefined,
    });
    assert.equal(store.tip()?.height, 1);
    assert.equal(store.tip()?.hash, hashes[1]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
