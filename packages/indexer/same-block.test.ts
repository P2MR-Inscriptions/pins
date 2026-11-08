// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { follow, type Rpc } from "./follow.ts";
import { Store } from "./store.ts";

const txidA = "aa".repeat(32);
const txidB = "bb".repeat(32);

function le(value: number, bytes: number): string {
  let out = "";
  let rest = value;
  for (let i = 0; i < bytes; i += 1) {
    out += (rest & 0xff).toString(16).padStart(2, "0");
    rest = Math.floor(rest / 256);
  }
  return out;
}

/** Minimal legacy transaction. An all-aa txid is unchanged when reversed. */
function rawTx(input: { coinbase: true } | { txid: string; vout: number }, value: number): string {
  const prev = "coinbase" in input ? "00".repeat(32) : input.txid;
  const vout = "coinbase" in input ? "ffffffff" : le(input.vout, 4);
  return `0100000001${prev}${vout}00ffffffff01${le(value, 8)}0000000000`;
}

test("follow commits a same-block spend without fetching that parent", async () => {
  const asked: string[] = [];
  const hash = "11".repeat(32);
  const rpc: Rpc = {
    call: async <T>(method: string): Promise<T> => {
      if (method === "getblockchaininfo") return { chain: "regtest", blocks: 0, bestblockhash: hash } as T;
      if (method === "getblockcount") return 0 as T;
      if (method === "getblockhash") return hash as T;
      if (method === "getrawtransaction") {
        asked.push(method);
        throw new Error("same-block parent must not be fetched");
      }
      if (method === "getblock") {
        return {
          hash,
          height: 0,
          tx: [
            { txid: "33".repeat(32), hex: rawTx({ coinbase: true }, 50), vin: [{ coinbase: "00" }], vout: [] },
            { txid: txidA, hex: rawTx({ coinbase: true }, 5), vin: [{ coinbase: "00" }], vout: [] },
            { txid: txidB, hex: rawTx({ txid: txidA, vout: 0 }, 5), vin: [{ txid: txidA, vout: 0 }], vout: [] },
          ],
        } as T;
      }
      throw new Error(method);
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "pins-same-"));
  const store = new Store(join(dir, "index.sqlite"), { network: "regtest" });
  try {
    const synced = await follow(store, rpc, 0, "regtest");
    assert.deepEqual(asked, []);
    assert.equal(synced.height, 0);
    assert.equal(store.outputValue(txidA, 0), 5n);
    assert.equal(store.tip()?.hash, hash);
  } finally {
    store.close();
  }
});
