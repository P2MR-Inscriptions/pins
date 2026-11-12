// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeCompactSize } from "../inscriber/compact.ts";
import { buildEnvelope, concatBytes, contentTypeField, revealLeaf } from "../inscriber/script.ts";
import { toChainBlock, type RpcBlock } from "./chain.ts";
import { follow, type Rpc } from "./follow.ts";
import { Indexer } from "./pins.ts";
import { Store } from "./store.ts";

const PUBKEY = new Uint8Array(32).fill(7);
const P2MR = Uint8Array.of(0x52, 0x20, ...new Uint8Array(32).fill(1));
const ANCHOR = Uint8Array.of(0x51, 0x02, 0x4e, 0x73);
const LEAF = revealLeaf(PUBKEY, [buildEnvelope([contentTypeField("text/plain")], Uint8Array.of(1))]);
const SIGNATURE = new Uint8Array(64).fill(9);
const PARENT = "aa".repeat(32);
const SPEND = "bb".repeat(32);
const COINBASE = "cc".repeat(32);
const HASH = "11".repeat(32);

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

/** A transaction with one input. `witness` null is the form without witness data. */
function rawTx(input: { coinbase: true } | { txid: string; vout: number }, outputs: { value: number; script: Uint8Array }[], witness: Uint8Array[] | null): string {
  const coinbase = "coinbase" in input;
  const parts: Uint8Array[] = [le(1, 4)];
  if (witness) parts.push(Uint8Array.of(0, 1));
  parts.push(Uint8Array.of(1), coinbase ? new Uint8Array(32) : Buffer.from(input.txid, "hex").reverse(), coinbase ? le(0xffffffff, 4) : le(input.vout, 4), Uint8Array.of(0), le(0xffffffff, 4));
  parts.push(writeCompactSize(outputs.length));
  for (const output of outputs) parts.push(le(output.value, 8), vector(output.script));
  if (witness) parts.push(writeCompactSize(witness.length), ...witness.map(vector));
  parts.push(le(0, 4));
  return Buffer.from(concatBytes(parts)).toString("hex");
}

const coinbaseTx = (outputs = [{ value: 50, script: P2MR }]) => ({ txid: COINBASE, hex: rawTx({ coinbase: true }, outputs, null), vin: [], vout: [] });

function reveal(witness: Uint8Array[] | null, txid = SPEND) {
  return { txid, hex: rawTx({ txid: PARENT, vout: 0 }, [{ value: 10_000, script: P2MR }], witness), vin: [], vout: [] };
}

function block(...tx: RpcBlock["tx"]): RpcBlock {
  return { hash: HASH, height: 1, tx: [coinbaseTx(), ...tx] };
}

/** The reveal spends an output worth 10,000 bits that `kind` describes. */
function apply(rpcBlock: RpcBlock, kind: boolean | undefined): Indexer {
  const indexer = new Indexer();
  indexer.applyBlock(toChainBlock(rpcBlock, () => 10_000n, () => kind));
  return indexer;
}

const control = (first: number) => Uint8Array.of(first, ...new Uint8Array(32).fill(3));
const annex = Uint8Array.of(0x50, 1, 2, 3);

test("a control block with leaf version 0xc0 carries inscriptions", () => {
  for (const first of [0xc0, 0xc1]) {
    assert.equal(apply(block(reveal([SIGNATURE, LEAF, control(first)])), true).get(`${SPEND}i0`)?.number, 0);
  }
});

test("a reserved leaf version is not an inscription", () => {
  for (const first of [0x00, 0x02, 0xc2, 0xc3, 0xe1, 0xfe, 0xff]) {
    assert.equal(apply(block(reveal([SIGNATURE, LEAF, control(first)])), true).inscriptions.size, 0, `control byte ${first.toString(16)}`);
  }
  assert.equal(apply(block(reveal([SIGNATURE, LEAF, new Uint8Array()])), true).inscriptions.size, 0);
});

test("the control block is read after an annex is removed", () => {
  assert.equal(apply(block(reveal([SIGNATURE, LEAF, control(0xc1), annex])), true).get(`${SPEND}i0`)?.number, 0);
  assert.equal(apply(block(reveal([SIGNATURE, LEAF, control(0xc3), annex])), true).inscriptions.size, 0);
  assert.equal(apply(block(reveal([LEAF, annex])), true).inscriptions.size, 0);
});

test("an input that spends an output known not to be P2MR carries no inscription", () => {
  const spend = block(reveal([SIGNATURE, LEAF, control(0xc1)]));
  assert.equal(apply(spend, false).inscriptions.size, 0);
  assert.equal(apply(spend, true).inscriptions.size, 1);
  assert.equal(apply(spend, undefined).inscriptions.size, 1);
});

test("an output created earlier in the same block is checked by its script", () => {
  const witness = [SIGNATURE, LEAF, control(0xc1)];
  const create = (script: Uint8Array) => ({ txid: PARENT, hex: rawTx({ txid: "dd".repeat(32), vout: 0 }, [{ value: 10_000, script }], null), vin: [], vout: [] });
  const run = (script: Uint8Array) => {
    const indexer = new Indexer();
    const rpcBlock: RpcBlock = { hash: HASH, height: 1, tx: [coinbaseTx(), create(script), reveal(witness)] };
    indexer.applyBlock(toChainBlock(rpcBlock, () => 10_000n));
    return indexer.inscriptions.size;
  };
  assert.equal(run(P2MR), 1);
  assert.equal(run(ANCHOR), 0);
  assert.equal(run(Uint8Array.of(0x51, 0x20, ...new Uint8Array(32))), 0);
});

test("a P2MR spend without a witness stops the indexer", () => {
  const stripped = block(reveal(null));
  assert.throws(() => apply(stripped, true), /witness pruned/);
  const indexer = new Indexer();
  assert.throws(() => indexer.applyBlock(toChainBlock(stripped, () => 10_000n, () => true)), /witness pruned/);
  assert.equal(indexer.tipNumber, -1);
  assert.equal(indexer.inscriptions.size, 0);
});

test("an input with a witness but no leaf is not a pruned witness", () => {
  assert.doesNotThrow(() => apply(block(reveal([SIGNATURE, LEAF, control(0xc3)])), true));
});

test("an empty witness is not a gap when the spent output is not P2MR or is not known", () => {
  assert.doesNotThrow(() => apply(block(reveal(null)), false));
  assert.doesNotThrow(() => apply(block(reveal(null)), undefined));
  assert.doesNotThrow(() => apply(block(reveal([])), false));
});

test("the witness guard names a hand-built transaction too", () => {
  const input = { prevTxid: PARENT, prevVout: 0, value: 10_000n, p2mr: true, witnessItems: 0 };
  assert.throws(() => Indexer.requireWitness({ txid: "tx", inputs: [input], outputs: [] }), /witness pruned.*tx/);
  assert.doesNotThrow(() => Indexer.requireWitness({ txid: "tx", inputs: [{ ...input, witnessItems: 2 }], outputs: [] }));
  assert.doesNotThrow(() => Indexer.requireWitness({ txid: "tx", inputs: [{ ...input, p2mr: false }], outputs: [] }));
  assert.doesNotThrow(() => Indexer.requireWitness({ txid: "tx", inputs: [{ value: 0n, coinbase: true, witnessItems: 0, p2mr: true }], outputs: [] }));
});

function rpcFor(blocks: RpcBlock[], parents: Record<string, string> = {}): Rpc {
  return {
    call: async <T>(method: string, params: unknown[] = []): Promise<T> => {
      if (method === "getblockchaininfo") return { chain: "regtest", blocks: blocks.length - 1, bestblockhash: blocks.at(-1)?.hash } as T;
      if (method === "getblockcount") return (blocks.length - 1) as T;
      if (method === "getblockhash") return blocks[params[0] as number].hash as T;
      if (method === "getblock") return blocks.find((entry) => entry.hash === params[0]) as T;
      if (method === "getrawtransaction") return { hex: parents[params[0] as string] } as T;
      throw new Error(method);
    },
  };
}

const open = () => new Store(join(mkdtempSync(join(tmpdir(), "pins-spend-")), "index.sqlite"), { network: "regtest" });

test("follow records the type of each output and indexes a P2MR spend", async () => {
  const fund: RpcBlock = { hash: "22".repeat(32), height: 0, tx: [{ txid: PARENT, hex: rawTx({ coinbase: true }, [{ value: 10_000, script: P2MR }, { value: 10_000, script: ANCHOR }], null), vin: [], vout: [] }] };
  const spend: RpcBlock = { hash: "33".repeat(32), height: 1, tx: [coinbaseTx(), reveal([SIGNATURE, LEAF, control(0xc1)])] };
  const store = open();
  try {
    await follow(store, rpcFor([fund, spend]), 0, "regtest");
    assert.equal(store.outputIsP2mr(PARENT, 0), true);
    assert.equal(store.outputIsP2mr(PARENT, 1), false);
    assert.equal(store.outputIsP2mr("ee".repeat(32), 0), undefined);
    assert.equal(store.indexer.get(`${SPEND}i0`)?.number, 0);
  } finally {
    store.close();
  }
});

test("follow does not index an envelope spent from an output that is not P2MR", async () => {
  const fund: RpcBlock = { hash: "22".repeat(32), height: 0, tx: [{ txid: PARENT, hex: rawTx({ coinbase: true }, [{ value: 10_000, script: ANCHOR }], null), vin: [], vout: [] }] };
  const spend: RpcBlock = { hash: "33".repeat(32), height: 1, tx: [coinbaseTx(), reveal([SIGNATURE, LEAF, control(0xc1)])] };
  const store = open();
  try {
    await follow(store, rpcFor([fund, spend]), 0, "regtest");
    assert.equal(store.indexer.inscriptions.size, 0);
  } finally {
    store.close();
  }
});

test("follow stops at a P2MR spend whose witness was pruned", async () => {
  const fund: RpcBlock = { hash: "22".repeat(32), height: 0, tx: [{ txid: PARENT, hex: rawTx({ coinbase: true }, [{ value: 10_000, script: P2MR }], null), vin: [], vout: [] }] };
  const spend: RpcBlock = { hash: "33".repeat(32), height: 1, tx: [coinbaseTx(), reveal(null)] };
  const store = open();
  try {
    await assert.rejects(follow(store, rpcFor([fund, spend]), 0, "regtest"), /witness pruned/);
    assert.equal(store.tip()?.height, 0);
  } finally {
    store.close();
  }
});

test("follow reads the type of an output from before the activation height", async () => {
  const parent = rawTx({ coinbase: true }, [{ value: 10_000, script: P2MR }], null);
  const spend: RpcBlock = { hash: "33".repeat(32), height: 5, tx: [coinbaseTx(), reveal(null)] };
  const store = open();
  try {
    await assert.rejects(follow(store, rpcFor(Array.from({ length: 6 }, () => spend), { [PARENT]: parent }), 5, "regtest"), /witness pruned/);
    assert.equal(store.outputIsP2mr(PARENT, 0), true);
  } finally {
    store.close();
  }
});

test("a database from before the output type was stored is opened, and its rows stay unknown", () => {
  const path = join(mkdtempSync(join(tmpdir(), "pins-legacy-")), "index.sqlite");
  new Store(path, { network: "regtest" }).close();
  const raw = new DatabaseSync(path);
  raw.exec("ALTER TABLE outputs DROP COLUMN p2mr");
  raw.prepare("INSERT INTO outputs (txid, vout, value, height) VALUES (?, 0, '5', 3)").run(PARENT);
  raw.close();
  const store = new Store(path, { network: "regtest" });
  try {
    assert.equal(store.outputValue(PARENT, 0), 5n);
    assert.equal(store.outputIsP2mr(PARENT, 0), undefined);
    store.saveOutput(SPEND, 0, 7n, true);
    assert.equal(store.outputIsP2mr(SPEND, 0), true);
  } finally {
    store.close();
  }
  const again = new Store(path, { network: "regtest" });
  assert.equal(again.outputIsP2mr(SPEND, 0), true);
  again.close();
});
