// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { addressToScriptPubKey, p2mrAddressFromPubkey, p2mrLeafHash, p2mrScriptPubKey, P2MR_LEAF_VERSION_V1 } from "@qbit-oss/protocol";
import { init } from "@qbit-oss/pqc";
import { encodeCbor } from "../collection/canonical.mjs";
import { parseTransaction, toChainBlock, type RpcBlock } from "../indexer/chain.ts";
import { collectionView } from "../indexer/collection.ts";
import { Indexer } from "../indexer/pins.ts";
import { destinationsOf, itemAddress } from "./destination.ts";
import { createKeyfile } from "./keyfile.ts";
import { buildPlan, type MintPlan } from "./plan.ts";
import { addressChecks, encodeGenesisField, signedBodyChecks } from "./preflight.ts";
import { recoveryFor } from "./reveal.ts";
import { signPlan, verifyPlan, type SignExpectations } from "./sign.ts";
import { holderFlag, leafPreimage, merkleRoot } from "./verify.ts";

const NAMES = [1, 2, 3];
const BODIES = NAMES.map((n) => Uint8Array.of(n, n));
const METAS = NAMES.map((n) => encodeCbor({ meta: { name: `Item#${n}`, attributes: [] } }));
const LEAVES = NAMES.map((n) => leafPreimage(n, BODIES[n - 1], METAS[n - 1]));
const ROOT = merkleRoot(LEAVES);
const ITEMS = NAMES.map((n) => ({ number: n, body: BODIES[n - 1], contentType: "image/png", metadata: METAS[n - 1] }));

async function fixture() {
  await init();
  const made = createKeyfile(Buffer.from("disposable-passphrase"));
  const issuer = Buffer.from(made.secrets.issuerPublic, "hex");
  const recovery = Buffer.from(made.secrets.recoveryPublic, "hex");
  return {
    made,
    issuer,
    recovery,
    secret: made.secrets.issuerSecret,
    creator: p2mrAddressFromPubkey(issuer, "regtest"),
    holder: p2mrAddressFromPubkey(recovery, "regtest"),
    sale: p2mrAddressFromPubkey(Buffer.alloc(32, 5), "regtest"),
    change: p2mrAddressFromPubkey(Buffer.alloc(32, 3), "regtest"),
    funding: p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, recoveryFor(issuer))),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function build(f: Fixture, over: { sale: string | null; holder?: string; reserve?: number[]; field5?: Uint8Array }): MintPlan {
  return buildPlan({
    network: "regtest",
    feeRate: 1,
    issuerPublic: f.issuer,
    recoveryPublic: f.recovery,
    creator: f.creator,
    sale: over.sale,
    holder: over.holder,
    change: f.change,
    root: ROOT,
    utxo: { txid: "11".repeat(32), vout: 0, value: 50_000_000_000n, script: f.funding },
    genesis: { body: new TextEncoder().encode("{\"name\":\"Example\"}"), leafList: Buffer.concat(LEAVES), field5: over.field5 },
    batches: [{ name: "batch-0", items: ITEMS }],
    reserve: new Set(over.reserve ?? []),
  });
}

const expects = (f: Fixture, sale: string | null, holder?: string | null): SignExpectations => ({ fundingTxid: "11".repeat(32), fundingVout: 0, creator: f.creator, sale, holder, change: f.change });
const hex = (address: string): string => Buffer.from(addressToScriptPubKey(address, "regtest")).toString("hex");

test("the destination rule: the genesis and the reserve go to the creator, the other items to the holder", () => {
  const d = { creator: "c", holder: "h", reserve: new Set([2]) };
  assert.equal(itemAddress(d, null), "c");
  assert.equal(itemAddress(d, 1), "h");
  assert.equal(itemAddress(d, 2), "c");
  const sale = destinationsOf({ creator: "c", sale: "s", noSale: undefined, holder: undefined }, new Set([2]));
  assert.deepEqual([itemAddress(sale, 1), itemAddress(sale, 2), itemAddress(sale, null)], ["s", "c", "c"]);
  const none = destinationsOf({ creator: "c", sale: "c", noSale: true, holder: undefined }, new Set([2]));
  assert.deepEqual([itemAddress(none, 1), itemAddress(none, 2), itemAddress(none, null)], ["c", "c", "c"]);
  const held = destinationsOf({ creator: "c", sale: "c", noSale: true, holder: "h" }, new Set());
  assert.deepEqual([itemAddress(held, 1), itemAddress(held, 2), itemAddress(held, null)], ["h", "h", "c"]);
});

test("a plan with no sale and a holder sends the items to the holder and the rest where it did", async () => {
  const f = await fixture();
  const plain = build(f, { sale: null });
  const held = build(f, { sale: null, holder: f.holder });
  assert.equal("holder" in plain, false);
  assert.equal(held.holder, f.holder);
  assert.equal(held.noSale, true);
  assert.equal(held.sale, held.creator);
  // Nothing else in the plan differs in shape. Only the item outputs and what depends on them (txids) move.
  assert.deepEqual(Object.keys(held), [...Object.keys(plain).slice(0, 8), "holder", ...Object.keys(plain).slice(8)]);
  for (const reveal of held.reveals) {
    const parsed = parseTransaction(Buffer.from(reveal.raw, "hex"));
    reveal.outputs.forEach((meta, i) => {
      const want = i === reveal.outputs.length - 1 ? f.change : meta.item === null ? f.creator : f.holder;
      assert.equal(meta.address, want);
      assert.equal(Buffer.from(parsed.outputs[i].script).toString("hex"), hex(want));
    });
  }
  assert.equal(held.reveals.find((reveal) => reveal.name === "genesis")?.outputs[0].address, f.creator);
  f.secret.fill(0);
});

test("a holder is refused with a sale, and when it is the creator or the change address", async () => {
  const f = await fixture();
  assert.throws(() => build(f, { sale: f.sale, holder: f.holder, reserve: [2] }), /holder is for a collection with no sale/);
  assert.throws(() => build(f, { sale: null, holder: f.creator }), /holder must be its own address/);
  assert.throws(() => build(f, { sale: null, holder: f.change }), /holder must be its own address/);
  assert.throws(() => build(f, { sale: null, holder: "" }), /holder must be its own address/);
  f.secret.fill(0);
});

test("sign takes the holder from the operator, and a plan whose holder was moved, added or dropped is refused", async () => {
  const f = await fixture();
  const held = build(f, { sale: null, holder: f.holder });
  const plain = build(f, { sale: null });
  assert.doesNotThrow(() => verifyPlan(held, new Set(), expects(f, null, f.holder), ROOT, 0));
  assert.doesNotThrow(() => verifyPlan(plain, new Set(), expects(f, null), ROOT, 0));
  assert.doesNotThrow(() => verifyPlan(plain, new Set(), expects(f, null, null), ROOT, 0));
  // The operator names no holder and the plan has one, or the reverse, or another one.
  assert.throws(() => verifyPlan(held, new Set(), expects(f, null), ROOT, 0), /addresses do not match/);
  assert.throws(() => verifyPlan(plain, new Set(), expects(f, null, f.holder), ROOT, 0), /addresses do not match/);
  assert.throws(() => verifyPlan(held, new Set(), expects(f, null, f.sale), ROOT, 0), /addresses do not match/);
  // A rewritten holder in the plan does not move the outputs.
  assert.throws(() => verifyPlan({ ...held, holder: f.sale }, new Set(), expects(f, null, f.sale), ROOT, 0), /is not/);
  // Dropping the holder from the plan while the outputs go to it.
  const dropped: Partial<MintPlan> = { ...held };
  delete dropped.holder;
  assert.throws(() => verifyPlan(dropped as MintPlan, new Set(), expects(f, null), ROOT, 0), /is not/);
  // A holder on a plan with a sale.
  const sale = build(f, { sale: f.sale, reserve: [2] });
  assert.throws(() => verifyPlan({ ...sale, holder: f.holder }, new Set([2]), expects(f, f.sale, f.holder), ROOT, 1), /holder is for a collection with no sale/);
  assert.throws(() => verifyPlan({ ...sale, holder: f.holder }, new Set([2]), expects(f, f.sale), ROOT, 1), /addresses do not match/);
  f.secret.fill(0);
});

test("preflight rows: the holder has its own row and must differ from the other addresses", () => {
  const rows = (holder?: string) => addressChecks("regtest", "x", null, "y", "z", holder).map((check) => check.name);
  assert.deepEqual(rows(), ["creator address", "change address", "funding address", "addresses distinct"]);
  assert.deepEqual(rows("w"), ["creator address", "holder address", "change address", "funding address", "addresses distinct"]);
  // The text of the other rows is the text they had.
  assert.equal(addressChecks("regtest", "x", null, "y", "z").at(-1)?.detail, "creator, change, and funding differ");
  assert.equal(addressChecks("regtest", "x", "s", "y", "z").at(-1)?.detail, "creator, sale, change, and funding differ");
  assert.equal(addressChecks("regtest", "x", "x", "y", "z").at(-1)?.detail, "two of creator, sale, change, and funding are the same");
  assert.equal(addressChecks("regtest", "x", null, "y", "z", "x").at(-1)?.pass, false);
  assert.equal(addressChecks("regtest", "x", null, "y", "z", "w").at(-1)?.detail, "creator, holder, change, and funding differ");
});

test("the signed plan with a holder is read by the indexer, and the holder owns every item", async () => {
  const f = await fixture();
  const field5 = await encodeGenesisField({ schema: "pins-collection/1", name: "Example", supply: 3, first: 1, namePrefix: "Item#", itemType: "image/png", root: ROOT, issuer: f.issuer.toString("hex") });
  const plan = build(f, { sale: null, holder: f.holder, field5 });
  const signed = signPlan(plan, f.secret, new Set(), expects(f, null, f.holder), ROOT);
  f.secret.fill(0);
  assert.equal(signed.holder, f.holder);
  assert.equal(signedBodyChecks(plan, signed)[0].pass, true);
  assert.equal(signedBodyChecks(plan, { ...signed, holder: f.sale })[0].pass, false);

  const coinbase = { txid: "cc".repeat(32), hex: "01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff00ffffffff0100e1f50500000000015100000000", vin: [], vout: [] };
  const fan = { txid: signed.fanout.txid, hex: signed.fanout.raw, vin: [], vout: [] };
  const reveals = signed.reveals.map((reveal) => ({ txid: reveal.txid, hex: reveal.raw, vin: [], vout: [] }));
  const known = new Map<string, bigint>([[`${"11".repeat(32)}:0`, BigInt(signed.fanout.spentValue)]]);
  parseTransaction(Buffer.from(signed.fanout.raw, "hex")).outputs.forEach((output, vout) => known.set(`${fan.txid}:${vout}`, output.value));
  const lookup = (id: string, vout: number) => known.get(`${id}:${vout}`);
  const indexer = new Indexer();
  const first: RpcBlock = { hash: "22".repeat(32), height: 1, tx: [coinbase, fan] };
  const second: RpcBlock = { hash: "33".repeat(32), height: 2, tx: [coinbase, ...reveals] };
  indexer.applyBlock(toChainBlock(first, lookup, "regtest", () => true));
  indexer.applyBlock(toChainBlock(second, lookup, "regtest", () => true));
  const view = await collectionView(indexer, { tipHeight: 20, blockHash: () => null });
  assert.equal(view.status, "present");
  assert.deepEqual(view.pieces?.map((piece) => piece.authentic), [true, true, true]);
  assert.deepEqual(view.pieces?.map((piece) => piece.ownerAddress), [f.holder, f.holder, f.holder]);
});

test("--holder is read for a collection with no sale and refused with a sale", () => {
  assert.equal(holderFlag(undefined, true, "plan"), undefined);
  assert.equal(holderFlag(undefined, false, "plan"), undefined);
  assert.equal(holderFlag("addr", true, "sign"), "addr");
  assert.throws(() => holderFlag("addr", false, "plan"), /--holder is for a collection with no sale, so plan takes none/);
  assert.throws(() => holderFlag("addr", false, "sign"), /so sign takes none/);
  assert.throws(() => holderFlag(true, true, "plan"), /missing --holder/);
  assert.throws(() => holderFlag("", true, "plan"), /missing --holder/);
});
