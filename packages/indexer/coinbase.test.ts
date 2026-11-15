// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { writeCompactSize } from "../inscriber/compact.ts";
import { buildEnvelope, concatBytes, contentTypeField, revealLeaf } from "../inscriber/script.ts";
import { subsidyAt, toChainBlock, type RpcBlock } from "./chain.ts";
import { Indexer } from "./pins.ts";

const PUBKEY = new Uint8Array(32).fill(7);
const P2MR = Uint8Array.of(0x52, 0x20, ...new Uint8Array(32).fill(1));
const LEAF = revealLeaf(PUBKEY, [buildEnvelope([contentTypeField("text/plain")], Uint8Array.of(1))]);
const PARENT = "aa".repeat(32);
const REVEAL = "bb".repeat(32);
const COINBASE = "cc".repeat(32);
const HASH = "11".repeat(32);
const SUBSIDY = 21_000_000_000n;

function le(value: number | bigint, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let rest = BigInt(value);
  for (let i = 0; i < bytes; i += 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

function vector(item: Uint8Array): Uint8Array {
  return concatBytes([writeCompactSize(item.length), item]);
}

function outputs(list: { value: bigint; script: Uint8Array }[]): Uint8Array[] {
  return [writeCompactSize(list.length), ...list.flatMap((output) => [le(output.value, 8), vector(output.script)])];
}

function coinbaseHex(list: { value: bigint; script: Uint8Array }[]): string {
  return Buffer.from(concatBytes([le(1, 4), Uint8Array.of(1), new Uint8Array(32), le(0xffffffff, 4), Uint8Array.of(0), le(0xffffffff, 4), ...outputs(list), le(0, 4)])).toString("hex");
}

/** A reveal that spends 10,000 bits and pays `list`. Whatever it does not pay is its fee. */
function revealHex(list: { value: bigint; script: Uint8Array }[]): string {
  const witness = [new Uint8Array(64).fill(9), LEAF, Uint8Array.of(0xc1, ...new Uint8Array(32))];
  return Buffer.from(concatBytes([
    le(1, 4), Uint8Array.of(0, 1), Uint8Array.of(1), Buffer.from(PARENT, "hex"), le(0, 4), Uint8Array.of(0), le(0xffffffff, 4),
    ...outputs(list), writeCompactSize(witness.length), ...witness.map(vector), le(0, 4),
  ])).toString("hex");
}

/** The reveal's whole input is fee, so its inscription lands in the coinbase. */
function feeBlock(claimed: { value: bigint; script: Uint8Array }[], height = 1): RpcBlock {
  return {
    hash: HASH,
    height,
    tx: [
      { txid: COINBASE, hex: coinbaseHex(claimed), vin: [], vout: [] },
      { txid: REVEAL, hex: revealHex([]), vin: [], vout: [] },
    ],
  };
}

function located(block: RpcBlock) {
  const indexer = new Indexer();
  indexer.applyBlock(toChainBlock(block, () => 10_000n, "regtest"));
  return indexer.get(`${REVEAL}i0`)?.location;
}

test("the subsidy follows the schedule of PINS-2 section 5.1", () => {
  const rows: [number, bigint][] = [
    [0, 21_000_000_000n],
    [43_199, 21_000_000_000n],
    [43_200, 20_092_800_000n],
    [160_950, 18_394_280_067n],
    [20_735_999, 1n],
    [20_736_000, 0n],
    [30_000_000, 0n],
  ];
  for (const [height, expected] of rows) assert.equal(subsidyAt(height, "mainnet"), expected, `height ${height}`);
});

test("testnet4 steps down every 43,200 blocks and regtest every 150", () => {
  assert.equal(subsidyAt(160_950, "testnet4"), subsidyAt(160_950, "mainnet"));
  assert.equal(subsidyAt(149, "regtest"), SUBSIDY);
  assert.equal(subsidyAt(150, "regtest"), subsidyAt(43_200, "mainnet"));
  assert.equal(subsidyAt(300, "regtest"), subsidyAt(86_400, "mainnet"));
});

test("a block carries the subsidy of its height, not what the coinbase claims", () => {
  const claimed = [{ value: 5n, script: P2MR }];
  assert.equal(toChainBlock(feeBlock(claimed, 0), () => 10_000n, "regtest").subsidy, SUBSIDY);
  assert.equal(toChainBlock(feeBlock(claimed, 150), () => 10_000n, "regtest").subsidy, subsidyAt(43_200, "mainnet"));
  assert.equal(toChainBlock(feeBlock(claimed, 150), () => 10_000n, "mainnet").subsidy, SUBSIDY);
});

test("an inscription in a fee bit that the coinbase left unclaimed is lost", () => {
  const location = located(feeBlock([{ value: SUBSIDY, script: P2MR }]));
  assert.equal(location?.state, "lost");
});

test("a coinbase that claims part of the fees keeps the fee bits at their offset after the subsidy", () => {
  const location = located(feeBlock([{ value: SUBSIDY + 5n, script: P2MR }]));
  assert.equal(location?.state, "located");
  if (location?.state === "located") assert.equal(location.offset, SUBSIDY);
});

test("a coinbase that claims the subsidy and every fee places the fee bit after the subsidy", () => {
  const location = located(feeBlock([{ value: SUBSIDY + 10_000n, script: P2MR }]));
  assert.equal(location?.state, "located");
  if (location?.state === "located") assert.equal(location.offset, SUBSIDY);
});

test("a fee bit lands in the second coinbase output when the first holds the subsidy", () => {
  const location = located(feeBlock([{ value: SUBSIDY, script: P2MR }, { value: 10_000n, script: P2MR }]));
  assert.equal(location?.state, "located");
  if (location?.state === "located") {
    assert.equal(location.vout, 1);
    assert.equal(location.offset, 0n);
  }
});
