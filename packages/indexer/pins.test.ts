// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { buildEnvelope, contentTypeField, parseEnvelopes, revealLeaf } from "../inscriber/script.ts";
import { itemsLeaf } from "../inscriber/reveal.ts";
import { Indexer, type ChainBlock, type ChainTx } from "./pins.ts";

const PUBKEY = new Uint8Array(32).fill(7);
const SCRIPT = new Uint8Array([0x52, 0x20, ...new Uint8Array(32).fill(1)]);
const BURN = new Uint8Array([0x6a, 0x01, 0x00]);

function block(partial: Omit<ChainBlock, "subsidy"> & { subsidy?: bigint }): ChainBlock {
  return { subsidy: 50n, ...partial };
}

test("an envelope round-trips through the leaf parser", () => {
  const leaf = revealLeaf(PUBKEY, [buildEnvelope([contentTypeField("text/plain")], new TextEncoder().encode("hello"))]);
  const envelopes = parseEnvelopes(leaf);
  assert.equal(envelopes.length, 1);
  assert.equal(new TextDecoder().decode(envelopes[0].body), "hello");
  assert.equal(new TextDecoder().decode(envelopes[0].fields[0].value), "text/plain");
});

test("two indexers agree on a reveal, a transfer, a burn, and a reorg", () => {
  const reveal: ChainTx = {
    txid: "aa",
    inputs: [{ prevTxid: "00", prevVout: 0, value: 20_000n, leafScript: itemsLeaf(PUBKEY, [
      { body: Uint8Array.of(1), contentType: "text/plain" },
      { body: Uint8Array.of(2), contentType: "text/plain" },
    ]) }],
    outputs: [
      { value: 10_000n, script: SCRIPT },
      { value: 10_000n, script: SCRIPT },
    ],
  };
  const transfer: ChainTx = {
    txid: "bb",
    inputs: [{ prevTxid: "aa", prevVout: 0, value: 10_000n }],
    outputs: [{ value: 10_000n, script: SCRIPT }],
  };
  const burn: ChainTx = {
    txid: "cc",
    inputs: [{ prevTxid: "bb", prevVout: 0, value: 10_000n }],
    outputs: [{ value: 10_000n, script: BURN }],
  };
  const chain = [
    block({ hash: "h1", height: 1, txs: [{ txid: "coin1", inputs: [{ coinbase: true, value: 50n }], outputs: [{ value: 50n, script: SCRIPT }] }, reveal] }),
    block({ hash: "h2", height: 2, txs: [{ txid: "coin2", inputs: [{ coinbase: true, value: 50n }], outputs: [{ value: 50n, script: SCRIPT }] }, transfer] }),
    block({ hash: "h3", height: 3, txs: [{ txid: "coin3", inputs: [{ coinbase: true, value: 50n }], outputs: [{ value: 50n, script: SCRIPT }] }, burn] }),
  ];
  const left = new Indexer();
  const right = new Indexer();
  for (const entry of chain) {
    left.applyBlock(entry);
    right.applyBlock(entry);
  }
  assert.equal(left.get("aai0")?.id, "aai0");
  assert.equal(left.get("aai0")?.number, 0);
  assert.equal(left.get("aai1")?.number, 1);
  assert.deepEqual(left.get("aai0")?.location, right.get("aai0")?.location);
  assert.equal(left.get("aai0")?.location.state, "burned");
  assert.equal(left.get("aai1")?.location.state, "located");
  left.disconnectTip("h3");
  left.disconnectTip("h2");
  const restored = left.get("aai0")?.location;
  assert.equal(restored?.state, "located");
  if (restored?.state === "located") assert.equal(restored.txid, "aa");
  right.disconnectTip("h3");
  right.disconnectTip("h2");
  assert.equal(left.get("aai0")?.location.state, right.get("aai0")?.location.state);
});

test("split, merge, a pointer into change, and a reinscription follow the FIFO rule", () => {
  const indexer = new Indexer();
  const leafA = itemsLeaf(PUBKEY, [{ body: Uint8Array.of(1), contentType: "text/plain" }]);
  const leafB = itemsLeaf(PUBKEY, [{ body: Uint8Array.of(2), contentType: "text/plain" }]);
  const changePointer = itemsLeaf(PUBKEY, [{ body: Uint8Array.of(3), contentType: "text/plain", pointer: 10_000n }]);
  const twice = itemsLeaf(PUBKEY, [
    { body: Uint8Array.of(4), contentType: "text/plain" },
    { body: Uint8Array.of(5), contentType: "text/plain" },
  ]);
  indexer.applyBlock(block({
    hash: "h1",
    height: 1,
    txs: [
      { txid: "c1", inputs: [{ coinbase: true, value: 50n }], outputs: [{ value: 50n, script: SCRIPT }] },
      { txid: "ra", inputs: [{ prevTxid: "f", prevVout: 0, value: 20_000n, leafScript: leafA }], outputs: [{ value: 10_000n, script: SCRIPT }, { value: 9_000n, script: SCRIPT }] },
      { txid: "rb", inputs: [{ prevTxid: "g", prevVout: 0, value: 20_000n, leafScript: leafB }], outputs: [{ value: 10_000n, script: SCRIPT }, { value: 9_000n, script: SCRIPT }] },
    ],
  }));
  indexer.applyBlock(block({
    hash: "h2",
    height: 2,
    txs: [
      { txid: "c2", inputs: [{ coinbase: true, value: 50n }], outputs: [{ value: 50n, script: SCRIPT }] },
      { txid: "split", inputs: [{ prevTxid: "ra", prevVout: 0, value: 10_000n }], outputs: [{ value: 6_000n, script: SCRIPT }, { value: 4_000n, script: SCRIPT }] },
    ],
  }));
  const splitLoc = indexer.get("rai0")?.location;
  assert.equal(splitLoc?.state, "located");
  if (splitLoc?.state === "located") {
    assert.equal(splitLoc.txid, "split");
    assert.equal(splitLoc.vout, 0);
    assert.equal(splitLoc.offset, 0n);
  }
  indexer.applyBlock(block({
    hash: "h3",
    height: 3,
    txs: [
      { txid: "c3", inputs: [{ coinbase: true, value: 50n }], outputs: [{ value: 50n, script: SCRIPT }] },
      {
        txid: "merge",
        inputs: [
          { prevTxid: "split", prevVout: 0, value: 6_000n },
          { prevTxid: "rb", prevVout: 0, value: 10_000n },
        ],
        outputs: [{ value: 16_000n, script: SCRIPT }],
      },
      { txid: "ptr", inputs: [{ prevTxid: "h", prevVout: 0, value: 30_000n, leafScript: changePointer }], outputs: [{ value: 10_000n, script: SCRIPT }, { value: 10_000n, script: SCRIPT }] },
      { txid: "re", inputs: [{ prevTxid: "i", prevVout: 0, value: 10_000n, leafScript: twice }], outputs: [{ value: 10_000n, script: SCRIPT }] },
    ],
  }));
  const mergedA = indexer.get("rai0")?.location;
  const mergedB = indexer.get("rbi0")?.location;
  assert.equal(mergedA?.state, "located");
  assert.equal(mergedB?.state, "located");
  if (mergedA?.state === "located" && mergedB?.state === "located") {
    assert.equal(mergedA.offset, 0n);
    assert.equal(mergedB.offset, 6_000n);
    assert.equal(mergedA.txid, "merge");
    assert.equal(mergedB.txid, "merge");
  }
  const pointed = indexer.get("ptri0")?.location;
  assert.equal(pointed?.state, "located");
  if (pointed?.state === "located") {
    assert.equal(pointed.vout, 1);
    assert.equal(pointed.offset, 0n);
  }
  assert.equal(indexer.get("rei0")?.flags.includes("reinscription"), false);
  assert.equal(indexer.get("rei1")?.flags.includes("reinscription"), true);
  assert.equal(indexer.get("rei1")?.location.state, "located");
});

test("a fee inscription lands in the coinbase after the subsidy", () => {
  const leaf = itemsLeaf(PUBKEY, [{ body: Uint8Array.of(9), contentType: "text/plain", pointer: null }]);
  const indexer = new Indexer();
  indexer.applyBlock(block({
    hash: "hf",
    height: 1,
    subsidy: 50n,
    txs: [
      { txid: "coin", inputs: [{ coinbase: true, value: 60n }], outputs: [{ value: 60n, script: SCRIPT }] },
      { txid: "fee", inputs: [{ prevTxid: "prev", prevVout: 0, value: 10n, leafScript: leaf }], outputs: [] },
    ],
  }));
  const item = indexer.get("feei0");
  assert.equal(item?.location.state, "located");
  if (item?.location.state === "located") {
    assert.equal(item.location.txid, "coin");
    assert.equal(item.location.offset, 50n);
  }
});
