// SPDX-License-Identifier: Apache-2.0

/**
 * The parts of the regtest trade example that need no node: reading a wallet descriptor, rebuilding the leaf of a
 * plain single-key P2MR output, and choosing the buyer's three coins. The trade itself runs against a node (see the regtest guide).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { bytesToHex, p2mrLeafHash, p2mrScriptPubKey, singleKeyLeafScript, P2MR_LEAF_VERSION_V1 } from "@qbit-oss/protocol";
import { bitsOf, pickBuyerCoins, pubkeyFromDescriptor, saleCoin, type Unspent } from "./regtest-trade.ts";

const key = "ab".repeat(32);
const desc = `mr(pk(${key}))#abcd1234`;
const script = bytesToHex(p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, singleKeyLeafScript(Buffer.from(key, "hex")))));

function coin(n: number, amount: number): Unspent {
  return { txid: n.toString(16).padStart(64, "0"), vout: 0, amount, scriptPubKey: script, desc };
}

test("a descriptor gives its key, and only a plain single-key P2MR descriptor does", () => {
  assert.equal(bytesToHex(pubkeyFromDescriptor(desc)), key);
  assert.equal(bytesToHex(pubkeyFromDescriptor(`mr(pk(${key}))`)), key);
  assert.throws(() => pubkeyFromDescriptor(`wpkh(${key})`), /not a plain single-key/);
  assert.throws(() => pubkeyFromDescriptor(`mr(pk(${key.slice(2)}))`), /not a plain single-key/);
});

test("amounts in QBT become whole bits", () => {
  assert.equal(bitsOf(0.0001), 10_000n);
  assert.equal(bitsOf(1.23456789), 123_456_789n);
  assert.equal(bitsOf(0.00002855), 2_855n);
});

test("a coin is rebuilt from its descriptor and refused when the script is another one", () => {
  const built = saleCoin("01".repeat(32), 3, 10_000n, script, desc);
  assert.equal(built.vout, 3);
  assert.equal(built.value, 10_000n);
  assert.equal(bytesToHex(built.scriptPubKey), script);
  assert.equal(built.txid.length, 32);
  assert.throws(() => saleCoin("01".repeat(32), 0, 1n, `5220${"00".repeat(32)}`, desc), /not the plain single-key P2MR output/);
});

test("the buyer's coins: two smallest as padding, the largest as funding, none that carries a P2MR Inscription", () => {
  const coins = [coin(1, 0.01), coin(2, 0.0001), coin(3, 0.00012), coin(4, 0.005)];
  const picked = pickBuyerCoins(coins, 50_000n, 20_000n);
  assert.equal(bitsOf(picked.paddingA.amount), 10_000n);
  assert.equal(bitsOf(picked.paddingB.amount), 12_000n);
  assert.equal(bitsOf(picked.funding.amount), 1_000_000n);
  const carrying = new Set([`${coins[1].txid}:0`]);
  assert.equal(bitsOf(pickBuyerCoins(coins, 50_000n, 20_000n, carrying).paddingA.amount), 12_000n);
  assert.throws(() => pickBuyerCoins(coins, 50_000n, 20_000n, new Set([`${coins[1].txid}:0`, `${coins[2].txid}:0`])), /needs three plain coins.*has 2/);
  assert.throws(() => pickBuyerCoins([coin(1, 0.00001), coin(2, 0.00001), coin(3, 0.00002)], 1_000n, 1_000n), /dust threshold/);
  assert.throws(() => pickBuyerCoins(coins, 2_000_000n, 20_000n), /the price, the fee and a change output need/);
  assert.throws(() => pickBuyerCoins([{ ...coin(1, 0.01), desc: undefined }, coin(2, 0.01), coin(3, 0.01)], 1n, 1n), /has 2/);
});
