// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeCompactSize } from "../inscriber/compact.ts";
import { buildEnvelope, contentTypeField, pointerField, revealLeaf } from "../inscriber/script.ts";
import { ACTIVATION_HEIGHT } from "./chains.ts";
import { follow, pollChain, type Rpc } from "./follow.ts";
import { fillBlockPrevouts, rawBlockHex, type RpcBlock } from "./chain.ts";
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
    await assert.rejects(() => follow(store, rpc("main"), 1, "mainnet"), /this store indexes regtest; it was asked to follow mainnet/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("follow takes mainnet only for a store built for mainnet", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pins-follow-"));
  const store = new Store(join(dir, "index.sqlite"), { network: "mainnet" });
  try {
    const synced = await follow(store, rpc("main"), 1, "mainnet");
    assert.equal(synced.height, -1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("follow refuses another activation height once the database holds blocks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pins-follow-"));
  const store = new Store(join(dir, "index.sqlite"));
  const hashes = ["11".repeat(32), "22".repeat(32)];
  const node: Rpc = {
    call: async <T>(method: string, params?: unknown[]): Promise<T> => {
      if (method === "getblockchaininfo") return { chain: "regtest", blocks: 1, bestblockhash: hashes[1] } as T;
      if (method === "getblockcount") return 1 as T;
      if (method === "getbestblockhash") return hashes[1] as T;
      if (method === "getblockhash") return hashes[Number(params?.[0])] as T;
      if (method === "getblock") {
        const at = hashes.indexOf(String(params?.[0]));
        return block(hashes[at], at, at + 1) as T;
      }
      throw new Error(method);
    },
  };
  try {
    await follow(store, node, 0, "regtest");
    assert.equal(store.tip()?.height, 1);
    await assert.rejects(() => follow(store, node, 1, "regtest"), /started at activation height 0, not 1/);
    await follow(store, node, 0, "regtest");
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

test("mainnet activation defaults to the first envelope block", () => {
  assert.equal(ACTIVATION_HEIGHT.mainnet, 161948);
  assert.equal(ACTIVATION_HEIGHT.regtest, 0);
  // Not a published testnet4 height. 0 means the reference indexer scans from genesis.
  assert.equal(ACTIVATION_HEIGHT.testnet4, 0);
});

/**
 * Same shape as mainnet blocks 161947 and 161948: a plain fan-out, then the first
 * envelope spending it. The bytes are synthetic.
 * stateHash covers the tip block and the inscription set, so an earlier start matches a
 * start at the envelope when the skipped blocks have none.
 */
test("an earlier activation matches a start at the first envelope", async () => {
  const scriptA = p2mr(0x11);
  const scriptB = p2mr(0x22);
  const pubkey = new Uint8Array(32).fill(7);
  const leaf = revealLeaf(pubkey, [
    buildEnvelope([contentTypeField("text/plain")], Uint8Array.of(1)),
    buildEnvelope([contentTypeField("text/plain"), pointerField(10_000n)], Uint8Array.of(2)),
  ]);
  // A spend of P2MR always has a witness. This one has no envelope.
  const spend = [Uint8Array.of(1), revealLeaf(pubkey, []), Uint8Array.of(0xc1)];
  const funding = coinbaseTx(1, 20_000n, scriptA);
  const fanout = payTx(funding.txid, 0, [{ value: 20_000n, script: scriptA }], spend);
  const reveal = payTx(fanout.txid, 0, [
    { value: 10_000n, script: scriptA },
    { value: 10_000n, script: scriptA },
  ], [Uint8Array.of(1), leaf, Uint8Array.of(0xc1)]);
  const transfer = payTx(reveal.txid, 0, [{ value: 10_000n, script: scriptB }], spend);
  const chain: RpcBlock[] = [
    rpcBlock("11".repeat(32), 161946, [funding]),
    rpcBlock("22".repeat(32), 161947, [coinbaseTx(2, 50n, scriptA), fanout]),
    rpcBlock("33".repeat(32), 161948, [coinbaseTx(3, 50n, scriptA), reveal]),
    rpcBlock("44".repeat(32), 161949, [coinbaseTx(4, 50n, scriptA), transfer]),
  ];
  const known = new Map([funding, fanout, reveal, transfer].map((tx) => [tx.txid, tx.hex]));
  const rpc = chainRpc(chain, known);
  const dirs = [161946, 161947, 161948].map(() => mkdtempSync(join(tmpdir(), "pins-activation-")));
  const stores = dirs.map((dir) => new Store(join(dir, "index.sqlite")));
  try {
    await follow(stores[0], rpc, 161946, "regtest");
    await follow(stores[1], rpc, 161947, "regtest");
    await follow(stores[2], rpc, 161948, "regtest");
    const views = stores.map(inscriptionView);
    assert.deepEqual(views[0], views[1]);
    assert.deepEqual(views[0], views[2]);
    assert.deepEqual(views[0]?.map((item) => item.number), [0, 1]);
    assert.equal(views[0]?.[0]?.createdHeight, 161948);
    assert.equal(views[0]?.[0]?.locationHeight, 161949);
    assert.equal(views[0]?.[1]?.locationHeight, 161948);
    assert.equal(views[0]?.[0]?.location.startsWith(`${transfer.txid}:0:`), true);
    assert.notEqual(views[0]?.[0]?.ownerAddress, views[0]?.[1]?.ownerAddress);
    assert.equal(stores[0]?.stateHashAt(161948), stores[2]?.stateHashAt(161948));
    assert.equal(stores[1]?.stateHashAt(161948), stores[2]?.stateHashAt(161948));
    assert.equal(stores[0]?.tip()?.stateHash, stores[2]?.tip()?.stateHash);
    assert.equal(stores[1]?.tip()?.stateHash, stores[2]?.tip()?.stateHash);
    assert.equal(typeof stores[0]?.stateHashAt(161946), "string");
    assert.equal(stores[2]?.stateHashAt(161946), null);
    assert.equal(stores[2]?.stateHashAt(161947), null);
  } finally {
    for (const store of stores) store.close();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});

function inscriptionView(store: Store) {
  return [...store.indexer.inscriptions.values()]
    .sort((left, right) => left.number - right.number)
    .map((item) => ({
      id: item.id,
      number: item.number,
      ownerAddress: item.ownerAddress,
      contentType: item.contentType,
      bodySha256: item.bodySha256,
      createdHeight: item.createdHeight,
      locationHeight: item.locationHeight,
      flags: [...item.flags].sort(),
      location: item.location.state === "located"
        ? `${item.location.txid}:${item.location.vout}:${item.location.offset}`
        : item.location.state,
    }));
}

function chainRpc(blocks: RpcBlock[], txs: Map<string, string>): Rpc {
  const byHash = new Map(blocks.map((block) => [block.hash, block]));
  const tip = blocks[blocks.length - 1];
  if (!tip) throw new Error("chain is empty");
  return {
    call: async <T>(method: string, params?: unknown[]): Promise<T> => {
      if (method === "getblockchaininfo") return { chain: "regtest", blocks: tip.height, bestblockhash: tip.hash } as T;
      if (method === "getblockcount") return tip.height as T;
      if (method === "getbestblockhash") return tip.hash as T;
      if (method === "getblockhash") {
        const height = Number(params?.[0]);
        const found = blocks.find((item) => item.height === height);
        if (!found) throw new Error(`no block ${height}`);
        return found.hash as T;
      }
      if (method === "getblock") {
        const found = byHash.get(String(params?.[0]));
        if (!found) throw new Error(`missing block ${String(params?.[0])}`);
        return fillBlockPrevouts(found, (txid) => txs.get(txid)) as T;
      }
      if (method === "getrawtransaction") throw new Error("prevout is required; no raw-transaction fallback");
      throw new Error(method);
    },
  };
}

function rpcBlock(hash: string, height: number, txs: { txid: string; hex: string }[]): RpcBlock {
  return {
    hash,
    height,
    tx: txs.map((tx) => ({
      txid: tx.txid,
      hex: tx.hex,
      vin: [{ coinbase: "00" }],
      vout: [{ scriptPubKey: { hex: "" } }],
    })),
  };
}

function p2mr(fill: number): Uint8Array {
  const script = new Uint8Array(34);
  script[0] = 0x52;
  script[1] = 0x20;
  script.fill(fill, 2);
  return script;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function u64(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

function txidOf(raw: Uint8Array): string {
  const hash = createHash("sha256").update(createHash("sha256").update(raw).digest()).digest();
  return Buffer.from(hash).reverse().toString("hex");
}

function outputBytes(outputs: { value: bigint; script: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [writeCompactSize(outputs.length)];
  for (const output of outputs) parts.push(u64(output.value), writeCompactSize(output.script.length), output.script);
  return concat(parts);
}

function coinbaseTx(tag: number, value: bigint, script: Uint8Array): { txid: string; hex: string } {
  const coinbase = Uint8Array.of(0x03, tag, 0x00, 0x00);
  const raw = concat([
    u32(2),
    writeCompactSize(1),
    new Uint8Array(32),
    u32(0xffffffff),
    writeCompactSize(coinbase.length),
    coinbase,
    u32(0xffffffff),
    outputBytes([{ value, script }]),
    u32(0),
  ]);
  return { txid: txidOf(raw), hex: Buffer.from(raw).toString("hex") };
}

function payTx(prev: string, vout: number, outputs: { value: bigint; script: Uint8Array }[], witness?: Uint8Array[]): { txid: string; hex: string } {
  const vin = concat([
    writeCompactSize(1),
    Uint8Array.from(Buffer.from(prev, "hex").reverse()),
    u32(vout),
    writeCompactSize(0),
    u32(0xffffffff),
  ]);
  const vouts = outputBytes(outputs);
  const bare = concat([u32(2), vin, vouts, u32(0)]);
  if (!witness) return { txid: txidOf(bare), hex: Buffer.from(bare).toString("hex") };
  const stack = concat([
    writeCompactSize(witness.length),
    ...witness.flatMap((item) => [writeCompactSize(item.length), item]),
  ]);
  const full = concat([u32(2), Uint8Array.of(0x00, 0x01), vin, vouts, stack, u32(0)]);
  return { txid: txidOf(bare), hex: Buffer.from(full).toString("hex") };
}


test("a missing prevout on a non-coinbase input fails and does not call getrawtransaction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pins-prevout-"));
  const store = new Store(join(dir, "index.sqlite"));
  const script = p2mr(0x11);
  const funding = coinbaseTx(1, 20_000n, script);
  const spend = payTx(funding.txid, 0, [{ value: 20_000n, script }]);
  const fundBlock = rpcBlock("11".repeat(32), 0, [funding]);
  const spendBlock: RpcBlock = {
    hash: "22".repeat(32),
    height: 1,
    previousblockhash: fundBlock.hash,
    tx: [{ txid: spend.txid, hex: spend.hex, vin: [{ txid: funding.txid, vout: 0 }], vout: [{ scriptPubKey: { hex: "" } }] }],
  };
  let rawCalls = 0;
  const rpc: Rpc = {
    call: async <T>(method: string, params?: unknown[]): Promise<T> => {
      if (method === "getblockchaininfo") return { chain: "regtest", blocks: 1, bestblockhash: spendBlock.hash } as T;
      if (method === "getblockcount") return 1 as T;
      if (method === "getblockhash") return (Number(params?.[0]) === 0 ? fundBlock.hash : spendBlock.hash) as T;
      if (method === "getblock") return (String(params?.[0]) === fundBlock.hash ? fillBlockPrevouts(fundBlock) : spendBlock) as T;
      if (method === "getrawtransaction") {
        rawCalls += 1;
        return { hex: funding.hex } as T;
      }
      throw new Error(method);
    },
  };
  try {
    await assert.rejects(() => follow(store, rpc, 1, "regtest"), /no prevout for input/);
    assert.equal(rawCalls, 0);
    assert.equal(store.tip()?.height, undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prefetch may finish out of order, but blocks are applied in height order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pins-prefetch-"));
  const store = new Store(join(dir, "index.sqlite"));
  const hashes = ["11".repeat(32), "22".repeat(32), "33".repeat(32)];
  const applied: number[] = [];
  const orig = store.commit.bind(store);
  store.commit = (block) => {
    applied.push(block.height);
    return orig(block);
  };
  let release0!: () => void;
  const wait0 = new Promise<void>((resolve) => {
    release0 = resolve;
  });
  const started: number[] = [];
  const rpc: Rpc = {
    call: async <T>(method: string, params?: unknown[]): Promise<T> => {
      if (method === "getblockchaininfo") return { chain: "regtest", blocks: 2, bestblockhash: hashes[2] } as T;
      if (method === "getblockcount") return 2 as T;
      if (method === "getblockhash") return hashes[Number(params?.[0])] as T;
      if (method === "getblock") {
        const at = hashes.indexOf(String(params?.[0]));
        started.push(at);
        if (started.includes(1) && started.includes(2)) release0();
        if (at === 0) await wait0;
        const item = block(hashes[at], at, at + 1);
        if (at > 0) item.previousblockhash = hashes[at - 1];
        return item as T;
      }
      throw new Error(method);
    },
  };
  try {
    await follow(store, rpc, 0, "regtest", { prefetch: 8 });
    assert.deepEqual(applied, [0, 1, 2]);
    assert.ok(started.indexOf(1) < started.indexOf(0) || started.indexOf(2) < started.indexOf(0) || started.includes(1));
    assert.equal(store.tip()?.hash, hashes[2]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reorg during prefetch discards the prefetched window", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pins-reorg-pref-"));
  const store = new Store(join(dir, "index.sqlite"));
  const chainA = ["aa".repeat(32), "a1".repeat(32), "a2".repeat(32)];
  const chainB = ["bb".repeat(32), "b1".repeat(32), "b2".repeat(32)];
  let chain = chainA;
  const committed: string[] = [];
  const orig = store.commit.bind(store);
  store.commit = (block) => {
    committed.push(block.hash);
    if (block.hash === chainA[0]) chain = chainB;
    return orig(block);
  };
  const rpc: Rpc = {
    call: async <T>(method: string, params?: unknown[]): Promise<T> => {
      if (method === "getblockchaininfo") return { chain: "regtest", blocks: 2, bestblockhash: chain[2] } as T;
      if (method === "getblockcount") return 2 as T;
      if (method === "getblockhash") return chain[Number(params?.[0])] as T;
      if (method === "getblock") {
        const hash = String(params?.[0]);
        const at = [...chainA, ...chainB].indexOf(hash) % 3;
        const item = block(hash, at, hash === chainA[at] ? at + 1 : at + 10);
        if (at > 0) {
          const parent = chainA.includes(hash) ? chainA[at - 1] : chainB[at - 1];
          item.previousblockhash = parent;
        }
        return item as T;
      }
      throw new Error(method);
    },
  };
  try {
    await follow(store, rpc, 0, "regtest", { prefetch: 8 });
    assert.equal(committed.includes(chainA[1]), false);
    assert.equal(committed.includes(chainA[2]), false);
    assert.deepEqual(committed.at(-3), chainB[0]);
    assert.deepEqual(committed.slice(-3), chainB);
    assert.equal(store.tip()?.hash, chainB[2]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("follow writes a throttled progress line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pins-progress-"));
  const store = new Store(join(dir, "index.sqlite"));
  const hashes = ["11".repeat(32), "22".repeat(32), "33".repeat(32)];
  let clock = 0;
  const rpc: Rpc = {
    call: async <T>(method: string, params?: unknown[]): Promise<T> => {
      if (method === "getblockchaininfo") return { chain: "regtest", blocks: 2, bestblockhash: hashes[2] } as T;
      if (method === "getblockcount") return 2 as T;
      if (method === "getblockhash") return hashes[Number(params?.[0])] as T;
      if (method === "getblock") {
        clock += 6_000;
        const at = hashes.indexOf(String(params?.[0]));
        return block(hashes[at], at, at + 1) as T;
      }
      throw new Error(method);
    },
  };
  const lines: string[] = [];
  try {
    await follow(store, rpc, 0, "regtest", { prefetch: 1, log: (line) => lines.push(line), now: () => clock, progressIntervalMs: 5_000 });
    assert.ok(lines.some((line) => /^sync 0\/2 \(\d+%\) /.test(line)), lines.join("\n"));
    assert.ok(lines.some((line) => /^sync 2\/2 \(100%\) /.test(line)), lines.join("\n"));
    assert.equal(lines.some((line) => /First sync can take several hours/.test(line)), false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a kill mid-batch drops only the open batch and follow resumes to the same tip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pins-batch-kill-"));
  const path = join(dir, "index.sqlite");
  const hashes = Array.from({ length: 10 }, (_, i) => i.toString(16).padStart(2, "0").repeat(32));
  const chainRpc = (tipHeight: number): Rpc => ({
    call: async <T>(method: string, params?: unknown[]): Promise<T> => {
      if (method === "getblockchaininfo") return { chain: "regtest", blocks: tipHeight, bestblockhash: hashes[tipHeight] } as T;
      if (method === "getblockcount") return tipHeight as T;
      if (method === "getblockhash") return hashes[Number(params?.[0])] as T;
      if (method === "getblock") {
        const at = hashes.indexOf(String(params?.[0]));
        const item = block(hashes[at], at, at + 1);
        if (at > 0) item.previousblockhash = hashes[at - 1];
        return item as T;
      }
      throw new Error(method);
    },
  });
  const controlDir = mkdtempSync(join(tmpdir(), "pins-batch-ctl-"));
  const control = new Store(join(controlDir, "index.sqlite"));
  const store = new Store(path);
  try {
    await follow(control, chainRpc(9), 0, "regtest", { prefetch: 1, commitBatch: 8 });
    const orig = store.commit.bind(store);
    store.commit = (block) => {
      const digest = orig(block);
      if (block.height === 9) {
        store.abandon();
        throw new Error("killed mid-batch");
      }
      return digest;
    };
    await assert.rejects(() => follow(store, chainRpc(9), 0, "regtest", { prefetch: 1, commitBatch: 8 }), /killed mid-batch/);
    store.close();
    const resumed = new Store(path);
    try {
      assert.equal(resumed.tip()?.height, 7, "the durable tip is the last committed batch");
      await follow(resumed, chainRpc(9), 0, "regtest", { prefetch: 1, commitBatch: 8 });
      assert.equal(resumed.tip()?.height, 9);
      assert.equal(resumed.tip()?.hash, hashes[9]);
      assert.equal(resumed.tip()?.stateHash, control.tip()?.stateHash);
    } finally {
      resumed.close();
    }
  } finally {
    store.close();
    control.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(controlDir, { recursive: true, force: true });
  }
});


test("follow uses getblock verbosity 0 and only asks for verbosity 3 when a parent is unknown", async () => {
  const fund = coinbaseTx(1, 20_000n, p2mr(0x11));
  const spend = payTx(fund.txid, 0, [{ value: 20_000n, script: p2mr(0x11) }]);
  const fundBlock = rpcBlock("11".repeat(32), 0, [fund]);
  fundBlock.previousblockhash = "00".repeat(32);
  const spendBlock: RpcBlock = {
    hash: "22".repeat(32),
    height: 1,
    previousblockhash: fundBlock.hash,
    tx: [{
      txid: spend.txid,
      hex: spend.hex,
      vin: [{ txid: fund.txid, vout: 0, prevout: { value: "0.00020000", scriptPubKey: { hex: Buffer.from(p2mr(0x11)).toString("hex") } } }],
      vout: [{ scriptPubKey: { hex: Buffer.from(p2mr(0x11)).toString("hex") } }],
    }],
  };
  const rpcFor = (requested: number[]): Rpc => ({
    call: async <T>(method: string, params?: unknown[]): Promise<T> => {
      if (method === "getblockchaininfo") return { chain: "regtest", blocks: 1, bestblockhash: spendBlock.hash } as T;
      if (method === "getblockcount") return 1 as T;
      if (method === "getblockhash") return (Number(params?.[0]) === 0 ? fundBlock.hash : spendBlock.hash) as T;
      if (method === "getblock") {
        const hash = String(params?.[0]);
        const verbosity = Number(params?.[1]);
        requested.push(verbosity);
        const item = hash === fundBlock.hash ? fundBlock : spendBlock;
        if (verbosity === 0) return rawBlockHex(item) as T;
        return (hash === fundBlock.hash ? fillBlockPrevouts(fundBlock) : spendBlock) as T;
      }
      throw new Error(method);
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "pins-v0-"));
  const store = new Store(join(dir, "index.sqlite"));
  const onlySpend = mkdtempSync(join(tmpdir(), "pins-v3-"));
  const store2 = new Store(join(onlySpend, "index.sqlite"));
  try {
    const warm: number[] = [];
    await follow(store, rpcFor(warm), 0, "regtest", { prefetch: 1 });
    assert.equal(store.tip()?.hash, spendBlock.hash);
    assert.deepEqual(warm, [0, 0]);
    const cold: number[] = [];
    await follow(store2, rpcFor(cold), 1, "regtest", { prefetch: 1 });
    assert.equal(store2.tip()?.hash, spendBlock.hash);
    assert.deepEqual(cold, [0, 3]);
  } finally {
    store.close();
    store2.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(onlySpend, { recursive: true, force: true });
  }
});
