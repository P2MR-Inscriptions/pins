// SPDX-License-Identifier: Apache-2.0

/**
 * `follow` checks the tip against the node before it fetches the next block. The chain can move in between.
 * A fetched block that does not build on the stored tip belongs to another chain, so the tip is unwound first.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RpcBlock } from "./chain.ts";
import { follow, type Rpc } from "./follow.ts";
import { Store } from "./store.ts";

/** A coinbase whose script tag makes the bytes, and so the txid, differ between two blocks. */
function coinbaseHex(tag: number): string {
  const script = Buffer.from([0x03, tag, 0x00, 0x00]);
  const value = Buffer.alloc(8);
  value.writeBigUInt64LE(50n);
  return Buffer.concat([
    Buffer.from([0x01, 0x00, 0x00, 0x00, 0x01]), Buffer.alloc(32), Buffer.from([0xff, 0xff, 0xff, 0xff, script.length]),
    script, Buffer.from([0xff, 0xff, 0xff, 0xff, 0x01]), value, Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]),
  ]).toString("hex");
}

function block(hash: string, height: number, tag: number, previousblockhash?: string): RpcBlock {
  return {
    hash,
    height,
    ...(previousblockhash === undefined ? {} : { previousblockhash }),
    tx: [{ txid: `${hash.slice(0, 62)}${height.toString(16).padStart(2, "0")}`, hex: coinbaseHex(tag), vin: [{ coinbase: "030000" }], vout: [{ scriptPubKey: { hex: "" } }] }],
  };
}

const G = "10".repeat(32);
const A1 = "a1".repeat(32);
const B1 = "b1".repeat(32);
const B2 = "b2".repeat(32);

test("a block whose parent is not the stored tip unwinds the tip instead of being stored on it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pins-parent-"));
  const store = new Store(join(dir, "index.sqlite"));
  // Chain 1: G, A1. Then the node moves to G, B1, B2. For one round it still names A1 at height 1 but serves B2 for height 2.
  let moved = false;
  let stale = false;
  const calls: string[] = [];
  const node: Rpc = {
    call: async <T>(method: string, params?: unknown[]): Promise<T> => {
      calls.push(method);
      const chain = moved ? [G, B1, B2] : [G, A1];
      if (method === "getblockchaininfo") return { chain: "regtest", blocks: chain.length - 1, bestblockhash: chain[chain.length - 1] } as T;
      if (method === "getblockcount") return (chain.length - 1) as T;
      if (method === "getblockhash") {
        const height = Number(params?.[0]);
        if (stale && height === 1) return A1 as T;
        return chain[height] as T;
      }
      if (method === "getblock") {
        const hash = String(params?.[0]);
        stale = false;
        if (hash === G) return block(G, 0, 1) as T;
        if (hash === A1) return block(A1, 1, 2, G) as T;
        if (hash === B1) return block(B1, 1, 3, G) as T;
        if (hash === B2) return block(B2, 2, 4, B1) as T;
      }
      throw new Error(method);
    },
  };
  try {
    await follow(store, node, 0, "regtest");
    assert.equal(store.tip()?.hash, A1);
    moved = true;
    stale = true;
    const synced = await follow(store, node, 0, "regtest");
    assert.equal(synced.height, 2);
    assert.equal(store.hashAt(0), G);
    assert.equal(store.hashAt(1), B1, "height 1 is the block B2 builds on, not the old A1");
    assert.equal(store.hashAt(2), B2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a block that builds on the tip is stored, and a node that gives no parent hash is still followed", async () => {
  const chain = [G, A1, B2];
  for (const withParent of [true, false]) {
    const dir = mkdtempSync(join(tmpdir(), "pins-parent-"));
    const store = new Store(join(dir, "index.sqlite"));
    let blockCalls = 0;
    const node: Rpc = {
      call: async <T>(method: string, params?: unknown[]): Promise<T> => {
        if (method === "getblockchaininfo") return { chain: "regtest", blocks: 2, bestblockhash: B2 } as T;
        if (method === "getblockcount") return 2 as T;
        if (method === "getblockhash") return chain[Number(params?.[0])] as T;
        if (method === "getblock") {
          blockCalls += 1;
          const at = chain.indexOf(String(params?.[0]));
          return block(chain[at], at, at + 1, withParent && at > 0 ? chain[at - 1] : undefined) as T;
        }
        throw new Error(method);
      },
    };
    try {
      const synced = await follow(store, node, 0, "regtest");
      assert.equal(synced.height, 2, `withParent ${withParent}`);
      assert.equal(store.tip()?.hash, B2);
      assert.equal(blockCalls, 3, "each block is fetched once: a matching parent costs no extra round");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
