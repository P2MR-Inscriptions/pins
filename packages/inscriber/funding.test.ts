// SPDX-License-Identifier: Apache-2.0

/**
 * `utxo` writes the funding file from the node. The funding address is the issuer's own address, which no wallet holds,
 * so the answer comes from `getrawtransaction` or `scantxoutset`, never from a wallet.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { addressToScriptPubKey, bytesToHex, p2mrAddressFromPubkey } from "@qbit-oss/protocol";
import type { Rpc } from "../indexer/follow.ts";
import { findFunding } from "./funding.ts";

const address = p2mrAddressFromPubkey(new Uint8Array(32).fill(7), "regtest");
const other = p2mrAddressFromPubkey(new Uint8Array(32).fill(8), "regtest");
const script = bytesToHex(addressToScriptPubKey(address, "regtest"));
const otherScript = bytesToHex(addressToScriptPubKey(other, "regtest"));
const txid = "ab".repeat(32);

function node(handlers: Record<string, (params: unknown[]) => unknown>): Rpc {
  return {
    call: async <T>(method: string, params: unknown[] = []): Promise<T> => {
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected call ${method}`);
      return handler(params) as T;
    },
  };
}

test("with a txid, the output that pays the address is found, in whole bits", async () => {
  const rpc = node({
    getrawtransaction: () => ({ confirmations: 3, vout: [{ n: 0, value: 0.5, scriptPubKey: { hex: otherScript } }, { n: 1, value: 1.23456789, scriptPubKey: { hex: script } }] }),
    gettxout: () => ({ value: 1.23456789 }),
  });
  const found = await findFunding(rpc, address, "regtest", txid);
  assert.deepEqual(found.file, { txid, vout: 1, value: "123456789", script });
  assert.equal(found.confirmations, 3);
});

test("with a txid, nothing to the address, two payments, a spent output and an unknown transaction are refused", async () => {
  const output = (n: number, hex: string) => ({ n, value: 1, scriptPubKey: { hex } });
  await assert.rejects(findFunding(node({ getrawtransaction: () => ({ vout: [output(0, otherScript)] }) }), address, "regtest", txid), /pays nothing/);
  await assert.rejects(findFunding(node({ getrawtransaction: () => ({ vout: [output(0, script), output(1, script)] }) }), address, "regtest", txid), /2 outputs/);
  await assert.rejects(findFunding(node({ getrawtransaction: () => ({ vout: [output(0, script)] }), gettxout: () => null }), address, "regtest", txid), /already spent/);
  const unknown = node({ getrawtransaction: () => { throw new Error("No such mempool or blockchain transaction"); } });
  await assert.rejects(findFunding(unknown, address, "regtest", txid), /-txindex/);
  await assert.rejects(findFunding(node({}), address, "regtest", "xyz"), /64 lowercase hex/);
});

test("without a txid, the one unspent output of the scan is used, and confirmations come from the tip", async () => {
  const rpc = node({
    scantxoutset: (params) => {
      assert.deepEqual(params, ["start", [`addr(${address})`]]);
      return { success: true, unspents: [{ txid, vout: 0, scriptPubKey: script, amount: 2, height: 100 }] };
    },
    getblockcount: () => 105,
  });
  const found = await findFunding(rpc, address, "regtest");
  assert.deepEqual(found.file, { txid, vout: 0, value: "200000000", script });
  assert.equal(found.confirmations, 6);
});

test("without a txid, no output, several outputs and an unfinished scan are refused", async () => {
  const scan = (value: unknown) => node({ scantxoutset: () => value, getblockcount: () => 1 });
  await assert.rejects(findFunding(scan({ success: true, unspents: [] }), address, "regtest"), /no unspent output/);
  const two = { success: true, unspents: [{ txid, vout: 0, scriptPubKey: script, amount: 1, height: 1 }, { txid, vout: 1, scriptPubKey: script, amount: 1, height: 1 }] };
  await assert.rejects(findFunding(scan(two), address, "regtest"), /2 unspent outputs.*--txid/);
  await assert.rejects(findFunding(scan({ success: false }), address, "regtest"), /could not finish/);
});
