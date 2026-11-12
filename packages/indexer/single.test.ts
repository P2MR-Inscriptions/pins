// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addressToScriptPubKey, p2mrAddressFromPubkey, p2mrLeafHash, p2mrScriptPubKey, P2MR_LEAF_VERSION_V1 } from "@qbit-oss/protocol";
import { init } from "@qbit-oss/pqc";
import { encodeCbor } from "../collection/canonical.mjs";
import { createKeyfile, zeroSecrets } from "../inscriber/keyfile.ts";
import { buildPlan, buildSinglePlan, type MintPlan, type PlanContent, type SingleInscription } from "../inscriber/plan.ts";
import { encodeGenesisField } from "../inscriber/preflight.ts";
import { recoveryFor } from "../inscriber/reveal.ts";
import { signPlan, type SignExpectations } from "../inscriber/sign.ts";
import { leafPreimage, merkleRoot } from "../inscriber/verify.ts";
import { collectionView } from "./collection.ts";
import { follow, type Rpc } from "./follow.ts";
import { Store } from "./store.ts";

const text = (value: string) => new TextEncoder().encode(value);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest();

function le(value: bigint | number, size: number): string {
  let rest = BigInt(value);
  let out = "";
  for (let i = 0; i < size; i += 1) {
    out += Number(rest & 0xffn).toString(16).padStart(2, "0");
    rest >>= 8n;
  }
  return out;
}

/** A legacy transaction without witnesses. The indexer does not check signatures. */
function legacyTx(inputs: { txid: string; vout: number }[] | "coinbase", outputs: { value: bigint; script: Uint8Array }[], tag = 0, witness = false): { txid: string; hex: string } {
  const ins = inputs === "coinbase"
    ? [`${"00".repeat(32)}ffffffff04${le(tag, 4)}ffffffff`]
    : inputs.map((input) => `${Buffer.from(input.txid, "hex").reverse().toString("hex")}${le(input.vout, 4)}00ffffffff`);
  const outs = outputs.map((output) => `${le(output.value, 8)}${le(output.script.length, 1)}${hex(output.script)}`);
  const raw = `01000000${le(ins.length, 1)}${ins.join("")}${le(outs.length, 1)}${outs.join("")}00000000`;
  const txid = Buffer.from(sha256(sha256(Buffer.from(raw, "hex")))).reverse().toString("hex");
  if (!witness) return { txid, hex: raw };
  // BIP144: a marker and flag after the version, and one stack per input before the locktime. The txid is unchanged.
  const stacks = (inputs as unknown[]).map(() => "01" + "01" + "00").join("");
  return { txid, hex: `01000000 0001${raw.slice(8, -8)}${stacks}00000000`.replace(" ", "") };
}

type Tx = { txid: string; hex: string };

/** A node that serves `blocks`, each a list of transactions, and the funding transactions by txid. */
function node(blocks: Tx[][], parents: Map<string, string>): Rpc {
  const hashes = blocks.map((_, height) => (height + 1).toString(16).padStart(64, "0"));
  return {
    call: async <T>(method: string, params: unknown[] = []): Promise<T> => {
      if (method === "getblockchaininfo") return { chain: "regtest", blocks: blocks.length - 1, bestblockhash: hashes[blocks.length - 1] } as T;
      if (method === "getblockcount") return (blocks.length - 1) as T;
      if (method === "getblockhash") return hashes[params[0] as number] as T;
      if (method === "getrawtransaction") {
        const found = parents.get(params[0] as string);
        if (!found) throw new Error("No such mempool or blockchain transaction");
        return { hex: found } as T;
      }
      if (method === "getblock") {
        const height = hashes.indexOf(params[0] as string);
        return { hash: hashes[height], height, previousblockhash: height > 0 ? hashes[height - 1] : undefined, tx: blocks[height].map((tx) => ({ ...tx, vin: [], vout: [] })) } as T;
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

async function keys() {
  await init();
  const made = createKeyfile(Buffer.from("disposable-passphrase"));
  const issuer = Buffer.from(made.secrets.issuerPublic, "hex");
  const recovery = Buffer.from(made.secrets.recoveryPublic, "hex");
  return {
    made,
    issuer,
    recovery,
    creator: p2mrAddressFromPubkey(issuer, "regtest"),
    change: p2mrAddressFromPubkey(Buffer.alloc(32, 3), "regtest"),
    funding: p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, recoveryFor(issuer))),
  };
}
type Keys = Awaited<ReturnType<typeof keys>>;

/** A funding transaction for the plan, so the node can answer for its parent. The plan names the outpoint it spends. */
function funded(k: Keys, tag: number): { txid: string; hex: string } {
  return legacyTx("coinbase", [{ value: 50_000_000_000n, script: k.funding }], tag);
}

function singlePlan(k: Keys, utxo: { txid: string }, inscription: SingleInscription): MintPlan {
  const fresh = buildSinglePlan({ network: "regtest", feeRate: 1, issuerPublic: k.issuer, recoveryPublic: k.recovery, creator: k.creator, change: k.change, utxo: { txid: utxo.txid, vout: 0, value: 50_000_000_000n, script: k.funding }, inscription });
  const expected: SignExpectations = { fundingTxid: utxo.txid, fundingVout: 0, creator: k.creator, sale: null, holder: null, change: k.change };
  return signPlan(fresh, k.made.secrets.issuerSecret, new Set(), expected, undefined, undefined, { single: inscription });
}

const cursor = { tipHeight: 100, blockHash: () => "22".repeat(32) };

test("a single inscription is numbered, owned, and moved like any inscription, and is not a collection", async () => {
  const k = await keys();
  const fundA = funded(k, 1);
  const fundB = funded(k, 2);
  const metaA = new Uint8Array(encodeCbor({ meta: { name: "First", attributes: [] } }));
  const first = singlePlan(k, fundA, { body: text("first body"), contentType: "text/plain", metadata: metaA });
  const second = singlePlan(k, fundB, { body: Uint8Array.of(0x89, 0x50, 0x4e, 0x47), contentType: "image/png" });
  const idA = `${first.reveals[0].txid}i0`;
  const idB = `${second.reveals[0].txid}i0`;
  const elsewhereAddress = p2mrAddressFromPubkey(Buffer.alloc(32, 9), "regtest");
  const elsewhere = addressToScriptPubKey(elsewhereAddress, "regtest");
  const move = legacyTx([{ txid: first.reveals[0].txid, vout: 0 }], [{ value: 10_000n, script: elsewhere }], 0, true);
  const tx = (plan: MintPlan): Tx[] => [{ txid: plan.fanout.txid, hex: plan.fanout.raw }, { txid: plan.reveals[0].txid, hex: plan.reveals[0].raw }];
  const parents = new Map([[fundA.txid, fundA.hex], [fundB.txid, fundB.hex]]);
  // The plans name the funding outpoint by txid. The node answers for that txid.
  const chain: Tx[][] = [
    [legacyTx("coinbase", [{ value: 50n, script: k.funding }], 10)],
    [legacyTx("coinbase", [{ value: 50n, script: k.funding }], 11), ...tx(first)],
    [legacyTx("coinbase", [{ value: 50n, script: k.funding }], 12), ...tx(second)],
    [legacyTx("coinbase", [{ value: 50n, script: k.funding }], 13), move],
  ];
  const dir = mkdtempSync(join(tmpdir(), "pins-single-index-"));
  const store = new Store(join(dir, "index.sqlite"), { network: "regtest" });
  try {
    await follow(store, node(chain, parents), 0, "regtest");
    const a = store.indexer.get(idA);
    const b = store.indexer.get(idB);
    assert.ok(a && b, "both inscriptions are indexed");
    // Numbered in chain order, with no genesis and no collection.
    assert.deepEqual([a.number, b.number], [0, 1]);
    assert.equal(a.createdHeight, 1);
    assert.equal(b.createdHeight, 2);
    assert.deepEqual(a.flags, []);
    assert.equal(a.contentType, "text/plain");
    assert.equal(a.bodySha256, hex(sha256(text("first body"))));
    assert.deepEqual(Buffer.from(a.metadata ?? []), Buffer.from(metaA));
    assert.equal(b.metadata, null);
    assert.equal(b.contentType, "image/png");
    // Owned by the creator address until it moves.
    assert.equal(b.ownerAddress, k.creator);
    assert.deepEqual(Buffer.from(b.ownerScript, "hex"), Buffer.from(addressToScriptPubKey(k.creator, "regtest")));
    // The first one moved in the last block, like any inscription.
    assert.equal(a.ownerAddress, elsewhereAddress);
    assert.equal(a.location.state, "located");
    if (a.location.state === "located") assert.equal(a.location.txid, move.txid);
    assert.equal(a.locationHeight, 3);
    // Nothing here is a collection.
    assert.equal((await collectionView(store.indexer, cursor)).status, "absent");
    assert.ok(store.tip()?.stateHash);
  } finally {
    store.close();
    zeroSecrets(k.made.secrets);
  }
});

test("a one-item collection with no sale is indexed as a collection with one authentic item", async () => {
  const k = await keys();
  const body = text("item one");
  const metadata = new Uint8Array(encodeCbor({ meta: { name: "Item#1", attributes: [] } }));
  const root = merkleRoot([leafPreimage(1, body, metadata)]);
  const field5 = await encodeGenesisField({ schema: "pins-collection/1", name: "Example", supply: 1, first: 1, namePrefix: "Item#", itemType: "image/png", root, issuer: k.made.secrets.issuerPublic });
  const made: PlanContent = {
    genesis: { body: text("{}"), leafList: new Uint8Array(leafPreimage(1, body, metadata)), field5 },
    batches: [{ name: "batch-0", items: [{ number: 1, body, contentType: "image/png", metadata }] }],
  };
  const fund = funded(k, 3);
  const plan = buildPlan({ network: "regtest", feeRate: 1, issuerPublic: k.issuer, recoveryPublic: k.recovery, creator: k.creator, sale: null, change: k.change, root, utxo: { txid: fund.txid, vout: 0, value: 50_000_000_000n, script: k.funding }, reserve: new Set(), ...made });
  const expected: SignExpectations = { fundingTxid: fund.txid, fundingVout: 0, creator: k.creator, sale: null, holder: null, change: k.change };
  const signed = signPlan(plan, k.made.secrets.issuerSecret, new Set(), expected, root, 0, made);
  const [genesis, batch] = signed.reveals;
  const chain: Tx[][] = [
    [legacyTx("coinbase", [{ value: 50n, script: k.funding }], 20)],
    [legacyTx("coinbase", [{ value: 50n, script: k.funding }], 21), { txid: signed.fanout.txid, hex: signed.fanout.raw }, { txid: genesis.txid, hex: genesis.raw }],
    [legacyTx("coinbase", [{ value: 50n, script: k.funding }], 22), { txid: batch.txid, hex: batch.raw }],
  ];
  const dir = mkdtempSync(join(tmpdir(), "pins-one-item-"));
  const store = new Store(join(dir, "index.sqlite"), { network: "regtest" });
  try {
    await follow(store, node(chain, new Map([[fund.txid, fund.hex]])), 0, "regtest");
    const view = await collectionView(store.indexer, cursor);
    assert.equal(view.status, "present");
    assert.equal(view.genesisId, `${genesis.txid}i0`);
    assert.deepEqual(view.pieces?.map((piece) => piece.authentic), [true]);
    const item = store.indexer.get(`${batch.txid}i0`);
    assert.equal(item?.ownerAddress, k.creator);
    assert.equal(view.reserveMode, "none");
  } finally {
    store.close();
    zeroSecrets(k.made.secrets);
  }
});
