// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  addressToScriptPubKey,
  buildControlBlock,
  decodePsbt,
  p2mrAddressFromPubkey,
  p2mrLeafHash,
  p2mrScriptPubKey,
  psbtUnsignedTransaction,
  singleKeyLeafScript,
  P2MR_LEAF_VERSION_V1,
} from "@qbit-oss/protocol";
import { SELLER_SIGHASH, primarySalePsbt, type SaleCoin } from "./psbt.ts";

const walletKey = new Uint8Array(32).fill(4);
const otherKey = new Uint8Array(32).fill(9);
const sellerKey = new Uint8Array(32).fill(5);
const walletScript = addressToScriptPubKey(p2mrAddressFromPubkey(walletKey, "regtest"), "regtest");
const otherScript = addressToScriptPubKey(p2mrAddressFromPubkey(otherKey, "regtest"), "regtest");
const sellerScript = addressToScriptPubKey(p2mrAddressFromPubkey(sellerKey, "regtest"), "regtest");

function coin(value: bigint, byte: number): SaleCoin {
  const leafScript = singleKeyLeafScript(new Uint8Array(32).fill(byte));
  return {
    txid: new Uint8Array(32).fill(byte),
    vout: 0,
    value,
    scriptPubKey: p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)),
    leafScript,
    controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
  };
}

function sale(receiveScript: Uint8Array) {
  return primarySalePsbt({
    paddingA: coin(20_000n, 1),
    paddingB: coin(20_000n, 2),
    inscribed: coin(10_000n, 3),
    funding: coin(200_000n, 4),
    receiveScript,
    paddingReturnScript: walletScript,
    sellerScript,
    changeScript: walletScript,
    price: 50_000n,
    postage: 10_000n,
    changeValue: 150_000n,
  });
}

test("the receive output is the signing wallet or any other valid script", () => {
  for (const receiveScript of [walletScript, otherScript]) {
    const decoded = decodePsbt(sale(receiveScript));
    const tx = psbtUnsignedTransaction(sale(receiveScript));
    assert.deepEqual(Buffer.from(tx.outputs[1].scriptPubKey), Buffer.from(receiveScript));
    assert.equal(tx.outputs[1].value, 10_000n);
    assert.equal(decoded.inputs[0].sighashType, undefined);
    assert.equal(decoded.inputs[1].sighashType, undefined);
    assert.equal(decoded.inputs[2].sighashType, SELLER_SIGHASH);
    assert.equal(decoded.inputs[3].sighashType, undefined);
  }
  assert.notDeepEqual(Buffer.from(walletScript), Buffer.from(otherScript));
});

test("a script restricted-output mode rejects is not a receive output", () => {
  assert.throws(() => sale(Uint8Array.of(0x51, 0x51)), /output/);
});
