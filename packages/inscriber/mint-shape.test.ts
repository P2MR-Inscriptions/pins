// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { p2mrAddressFromPubkey, p2mrLeafHash, p2mrScriptPubKey, P2MR_LEAF_VERSION_V1 } from "@qbit-oss/protocol";
import { init } from "@qbit-oss/pqc";
import { encodeCanonicalPng } from "../collection/canonical.mjs";
import { parseCollectionProfile } from "../protocol/profile.mjs";
import { parseTransaction, toChainBlock, type RpcBlock } from "../indexer/chain.ts";
import { collectionView } from "../indexer/collection.ts";
import { Indexer } from "../indexer/pins.ts";
import { groupsOf, loadCanonicalDir } from "../../scripts/canonical-batch.ts";
import { createKeyfile } from "./keyfile.ts";
import { buildPlan, type PlanContent } from "./plan.ts";
import { encodeGenesisField } from "./preflight.ts";
import { recoveryFor } from "./reveal.ts";
import { signPlan, type SignExpectations } from "./sign.ts";
import { leafPreimage, merkleRoot } from "./verify.ts";

/** A collection that is not the reference one: 100 items of 8 by 8 pixels, in reveals of 25. */
const SUPPLY = 100;
const BATCH = 25;

function writeCollection(supply: number, side: number): string {
  const dir = mkdtempSync(join(tmpdir(), "pins-shape-"));
  mkdirSync(join(dir, "images"));
  mkdirSync(join(dir, "json"));
  for (let id = 1; id <= supply; id += 1) {
    const rgba = Buffer.alloc(side * side * 4);
    for (let i = 0; i < side * side; i += 1) {
      rgba[i * 4] = (id * 7 + i) & 255;
      rgba[i * 4 + 1] = (id * 13 + i * 3) & 255;
      rgba[i * 4 + 2] = id & 255;
      rgba[i * 4 + 3] = 255;
    }
    writeFileSync(join(dir, "images", `${id}.png`), Buffer.from(encodeCanonicalPng(rgba, side, side).bytes));
    writeFileSync(join(dir, "json", `${id}.json`), JSON.stringify([{ meta: { name: `Item#${id}`, attributes: [{ trait_type: "Tone", value: String(id % 4) }] } }]));
  }
  writeFileSync(join(dir, "collection.json"), JSON.stringify({ name: "Example" }));
  return dir;
}

async function fixture() {
  await init();
  const made = createKeyfile(Buffer.from("disposable-passphrase"));
  const issuer = Buffer.from(made.secrets.issuerPublic, "hex");
  return {
    issuer,
    recovery: Buffer.from(made.secrets.recoveryPublic, "hex"),
    secret: made.secrets.issuerSecret,
    creator: p2mrAddressFromPubkey(issuer, "regtest"),
    sale: p2mrAddressFromPubkey(Buffer.alloc(32, 5), "regtest"),
    change: p2mrAddressFromPubkey(Buffer.alloc(32, 3), "regtest"),
    funding: p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, recoveryFor(issuer))),
  };
}

async function mintAndRead(sale: boolean) {
  const dir = writeCollection(SUPPLY, 8);
  const f = await fixture();
  try {
    const canonical = await loadCanonicalDir(dir, { supply: SUPPLY });
    const leaves = canonical.items.map((item, index) => leafPreimage(index + 1, item.body, item.metadata ?? new Uint8Array()));
    const root = merkleRoot(leaves);
    assert.equal(Buffer.compare(Buffer.concat(leaves), Buffer.from(canonical.leafList)), 0);
    const reserve = sale ? [3, 50, 99] : [];
    const field5 = await encodeGenesisField({
      schema: "pins-collection/1", name: "Example", supply: SUPPLY, first: 1, namePrefix: "Item#", itemType: "image/png", root,
      issuer: f.issuer.toString("hex"), ...(sale ? { saleCommitment: "ab".repeat(32) } : {}),
    });
    const groups = groupsOf(canonical.items, BATCH);
    const content: PlanContent = {
      genesis: { body: canonical.collectionJson, leafList: canonical.leafList, field5 },
      batches: groups.map((group, index) => ({
        name: `batch-${index}`,
        items: canonical.items.slice(group.start, group.start + group.count).map((item, offset) => ({ ...item, number: group.start + offset + 1 })),
      })),
    };
    const plan = buildPlan({
      network: "regtest",
      feeRate: 1,
      issuerPublic: f.issuer,
      recoveryPublic: f.recovery,
      creator: f.creator,
      sale: sale ? f.sale : null,
      change: f.change,
      root,
      utxo: { txid: "11".repeat(32), vout: 0, value: 50_000_000_000n, script: f.funding },
      ...content,
      reserve: new Set(reserve),
    });
    const expects: SignExpectations = { fundingTxid: "11".repeat(32), fundingVout: 0, creator: f.creator, sale: sale ? f.sale : null, change: f.change };
    const signed = signPlan(plan, f.secret, new Set(reserve), expects, root, reserve.length, content);
    const coinbase = { txid: "cc".repeat(32), hex: "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff00ffffffff0100e1f50500000000015100000000", vin: [], vout: [] };
    const fan = { txid: signed.fanout.txid, hex: signed.fanout.raw, vin: [], vout: [] };
    const known = new Map<string, bigint>([[`${"11".repeat(32)}:0`, BigInt(signed.fanout.spentValue)]]);
    parseTransaction(Buffer.from(signed.fanout.raw, "hex")).outputs.forEach((output, vout) => known.set(`${fan.txid}:${vout}`, output.value));
    const lookup = (id: string, vout: number) => known.get(`${id}:${vout}`);
    const indexer = new Indexer();
    const first: RpcBlock = { hash: "22".repeat(32), height: 1, tx: [coinbase, fan] };
    const second: RpcBlock = { hash: "33".repeat(32), height: 2, tx: [coinbase, ...signed.reveals.map((reveal) => ({ txid: reveal.txid, hex: reveal.raw, vin: [], vout: [] }))] };
    indexer.applyBlock(toChainBlock(first, lookup, "regtest", () => true));
    indexer.applyBlock(toChainBlock(second, lookup, "regtest", () => true));
    const view = await collectionView(indexer, { tipHeight: 20, blockHash: () => null });
    return { f, groups, signed, view, reserve };
  } finally {
    f.secret.fill(0);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a collection of 100 items of 8 by 8 pixels, in reveals of 25, plans, signs and is read by the indexer", async () => {
  const { groups, signed, view } = await mintAndRead(false);
  assert.deepEqual(groups.map((group) => [group.start, group.count]), [[0, 25], [25, 25], [50, 25], [75, 25]]);
  assert.deepEqual(signed.reveals.map((reveal) => reveal.name), ["genesis", "batch-0", "batch-1", "batch-2", "batch-3"]);
  assert.equal(view.status, "present");
  assert.equal(view.supply, SUPPLY);
  assert.equal(view.pieces?.length, SUPPLY);
  assert.equal(view.pieces?.filter((piece) => piece.authentic).length, SUPPLY);
});

test("the same shape with a sale: the reserve goes to the creator and the other items to the sale address", async () => {
  const { f, signed, view, reserve } = await mintAndRead(true);
  assert.equal(view.pieces?.filter((piece) => piece.authentic).length, SUPPLY);
  for (const piece of view.pieces ?? []) {
    assert.equal(piece.ownerAddress, reserve.includes(piece.number) ? f.creator : f.sale);
  }
  assert.equal(signed.reveals.length, 5);
});

test("the batch size is the collection's own: the last reveal holds the rest, and nothing else is assumed", () => {
  const item = { body: Uint8Array.of(1), contentType: "image/png", metadata: Uint8Array.of(2) };
  const items = Array.from({ length: 10 }, () => item);
  assert.deepEqual(groupsOf(items, 4).map((group) => [group.start, group.count]), [[0, 4], [4, 4], [8, 2]]);
  assert.deepEqual(groupsOf(items, 10).map((group) => [group.start, group.count]), [[0, 10]]);
  assert.deepEqual(groupsOf(items, 99).map((group) => [group.start, group.count]), [[0, 10]]);
  assert.deepEqual(groupsOf(items, 1).length, 10);
  for (const bad of [0, -1, 2.5, Number.NaN]) assert.throws(() => groupsOf(items, bad), /batch size must be a positive integer/);
  // 10,000 items in groups of 625 are 16 reveals, as the reference collection is planned.
  const many = Array.from({ length: 10_000 }, () => item);
  const sixteen = groupsOf(many, 625);
  assert.equal(sixteen.length, 16);
  assert.ok(sixteen.every((group, index) => group.start === index * 625 && group.count === 625));
});

test("the supply is read from the declaration: a zip with fewer or more items is refused", async () => {
  const dir = writeCollection(6, 4);
  try {
    assert.equal((await loadCanonicalDir(dir, { supply: 6 })).items.length, 6);
    await assert.rejects(loadCanonicalDir(dir, { supply: 3 }), /more items than the supply of 3/);
    await assert.rejects(loadCanonicalDir(dir, { supply: 7 }), /ENOENT/);
    for (const bad of [0, -1, 1.5, Number.NaN]) await assert.rejects(loadCanonicalDir(dir, { supply: bad }), /supply must be a positive integer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("batchSize is an optional, validated field of the profile, and is not invented", () => {
  const base = { name: "Example", namePrefix: "Item#", supply: 100, first: 1, schema: "pins-collection/1", itemType: "image/png", root: "ab".repeat(32), sale: false };
  assert.equal("batchSize" in parseCollectionProfile(base), false);
  assert.equal(parseCollectionProfile({ ...base, batchSize: 25 }).batchSize, 25);
  const sale = { ...base, sale: true, reserveGroups: [{ trait_type: "Tone", value: "1", count: 3 }], reserveExtra: 0 };
  assert.equal("batchSize" in parseCollectionProfile(sale), false);
  assert.equal(parseCollectionProfile({ ...sale, batchSize: 625 }).batchSize, 625);
  for (const bad of [0, -5, 2.5, "25", null]) assert.throws(() => parseCollectionProfile({ ...base, batchSize: bad }), /batchSize must be a positive integer/);
});

test("the canonical set takes its size and its artwork from the caller", async () => {
  const { buildCanonicalSet } = await import("../collection/canonical.mjs");
  assert.throws(() => buildCanonicalSet({ zipPath: "x.zip" }), /edition is required/);
  assert.throws(() => buildCanonicalSet({ zipPath: "x.zip", edition: 0, artwork: null }), /edition is required/);
  assert.throws(() => buildCanonicalSet({ zipPath: "x.zip", edition: 10 }), /artwork is required/);
});
