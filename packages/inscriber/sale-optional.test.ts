// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addressToScriptPubKey, p2mrAddressFromPubkey, p2mrLeafHash, p2mrScriptPubKey, P2MR_LEAF_VERSION_V1 } from "@qbit-oss/protocol";
import { init } from "@qbit-oss/pqc";
import { encodeCbor } from "../collection/canonical.mjs";
import { parseTransaction, toChainBlock, type RpcBlock } from "../indexer/chain.ts";
import { collectionView } from "../indexer/collection.ts";
import { Indexer } from "../indexer/pins.ts";
import { parseCollectionProfile } from "../protocol/profile.mjs";
import { createKeyfile, openKeyfile, writeKeyfile, zeroSecrets } from "./keyfile.ts";
import { buildPlan, type MintPlan } from "./plan.ts";
import { addressChecks, encodeGenesisField, genesisChecks, genesisFieldFromLeaf, quotaChecks, signedBodyChecks } from "./preflight.ts";
import { recoveryFor } from "./reveal.ts";
import { signPlan, verifyPlan, type SignExpectations } from "./sign.ts";
import { leafPreimage, merkleRoot } from "./verify.ts";

const PROFILE = { name: "Example", namePrefix: "Item#", supply: 3, first: 1, schema: "pins-collection/1", itemType: "image/png", root: "ab".repeat(32) };
const GROUPS = [{ trait_type: "a", value: "b", count: 1 }];

test("a profile may declare no sale, and then it has no reserve", () => {
  const none = parseCollectionProfile({ ...PROFILE, sale: false });
  assert.equal(none.sale, false);
  assert.deepEqual(none.reserveGroups, []);
  assert.equal(none.reserveExtra, 0);
  assert.equal(none.reserveCount, 0);
  assert.throws(() => parseCollectionProfile({ ...PROFILE, sale: false, reserveGroups: GROUPS, reserveExtra: 0 }), /sale false/);
  assert.throws(() => parseCollectionProfile({ ...PROFILE, sale: false, reserveExtra: 0 }), /sale false/);
  assert.throws(() => parseCollectionProfile({ ...PROFILE, sale: "no" }), /true or false/);
});

test("a profile that says nothing about the sale, or says true, reads as before", () => {
  const plain = parseCollectionProfile({ ...PROFILE, reserveGroups: GROUPS, reserveExtra: 1 });
  const said = parseCollectionProfile({ ...PROFILE, sale: true, reserveGroups: GROUPS, reserveExtra: 1 });
  assert.deepEqual(plain, said);
  assert.equal(plain.sale, true);
  assert.equal(plain.reserveCount, 2);
  assert.equal(plain.saleCount, 1);
  assert.throws(() => parseCollectionProfile({ ...PROFILE }), /reserveExtra must be a non-negative integer/);
  assert.throws(() => parseCollectionProfile({ ...PROFILE, sale: true }), /reserveExtra must be a non-negative integer/);
});

const GENESIS = {
  schema: "pins-collection/1",
  name: "Example",
  supply: 3,
  first: 1,
  namePrefix: "Item#",
  itemType: "image/png",
  root: "ab".repeat(32),
  issuer: "90".repeat(32),
};

test("the genesis field has the nine keys with a commitment and the eight base keys without one", async () => {
  const sale = await encodeGenesisField({ ...GENESIS, saleCommitment: "cd".repeat(32) });
  const none = await encodeGenesisField(GENESIS);
  const base = { schema: GENESIS.schema, name: GENESIS.name, supply: 3, first: 1, name_prefix: "Item#", root: GENESIS.root, issuer: GENESIS.issuer, item_type: "image/png" };
  assert.deepEqual(Buffer.from(none), Buffer.from(encodeCbor(base)));
  assert.deepEqual(Buffer.from(sale), Buffer.from(encodeCbor({ ...base, sale_commitment: "cd".repeat(32) })));
  assert.equal(Buffer.from(none)[0], 0xa8);
  assert.equal(Buffer.from(sale)[0], 0xa9);
});

test("preflight reads the sale commitment row by the profile", async () => {
  const withCommitment = { schema: GENESIS.schema, name: "Example", supply: 3, first: 1, name_prefix: "Item#", root: GENESIS.root, issuer: GENESIS.issuer, item_type: "image/png", sale_commitment: "cd".repeat(32) };
  const { sale_commitment: _commitment, ...without } = withCommitment;
  const profile = { schema: GENESIS.schema, name: "Example", supply: 3, first: 1, namePrefix: "Item#", itemType: "image/png", root: GENESIS.root };
  const row = (field: Record<string, unknown>, sale?: boolean) => genesisChecks(field, { ...profile, sale }).find((check) => check.name === "sale commitment");
  assert.equal(row(withCommitment)?.pass, true);
  assert.equal(row(withCommitment, true)?.pass, true);
  assert.equal(row(without)?.pass, false);
  assert.equal(row(without, false)?.pass, true);
  assert.equal(row(withCommitment, false)?.pass, false);
  assert.deepEqual(addressChecks("regtest", "x", null, "y", "z").map((check) => check.name), ["creator address", "change address", "funding address", "addresses distinct"]);
  assert.equal(addressChecks("regtest", "x", "w", "y", "z").length, 5);
});

function legacyKeyfile(path: string, passphrase: Buffer, body: Record<string, string>): void {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(body))), cipher.final()]);
  writeFileSync(path, JSON.stringify({ version: 1, kdf: "scrypt", salt: salt.toString("hex"), n: 16384, r: 8, p: 1, iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("hex") }));
}

test("the keyfile reader keeps an existing sale secret and accepts a keyfile with none", async () => {
  await init();
  const dir = mkdtempSync(join(tmpdir(), "pins-sale-key-"));
  const pass = Buffer.from("disposable-passphrase");
  const made = createKeyfile(pass);
  assert.equal(made.secrets.saleSecret?.length, 32);
  const body = { issuerPublic: "aa", recoveryPublic: "bb", issuerSecret: "cc", recoverySecret: "dd" };
  legacyKeyfile(join(dir, "with.key"), pass, { ...body, saleSecret: "11".repeat(32) });
  legacyKeyfile(join(dir, "without.key"), pass, body);
  const withSecret = openKeyfile(join(dir, "with.key"), pass);
  assert.equal(Buffer.from(withSecret.saleSecret ?? []).toString("hex"), "11".repeat(32));
  const withoutSecret = openKeyfile(join(dir, "without.key"), pass);
  assert.equal(withoutSecret.saleSecret, null);
  const noSale = createKeyfile(pass, undefined, false);
  assert.equal(noSale.secrets.saleSecret, null);
  writeKeyfile(join(dir, "made.key"), noSale.body, { issuerPublic: noSale.secrets.issuerPublic, recoveryPublic: noSale.secrets.recoveryPublic });
  const reopened = openKeyfile(join(dir, "made.key"), pass);
  assert.equal(reopened.saleSecret, null);
  assert.equal(reopened.issuerPublic, noSale.secrets.issuerPublic);
  for (const secrets of [withSecret, withoutSecret, reopened, made.secrets, noSale.secrets]) zeroSecrets(secrets);
});

type Fixture = {
  issuer: Buffer;
  recovery: Buffer;
  secret: Uint8Array;
  creator: string;
  sale: string;
  change: string;
  funding: Uint8Array;
};

async function fixture(entropy?: Uint8Array): Promise<Fixture> {
  await init();
  const made = createKeyfile(Buffer.from("disposable-passphrase"), entropy);
  const issuer = Buffer.from(made.secrets.issuerPublic, "hex");
  const recovery = Buffer.from(made.secrets.recoveryPublic, "hex");
  return {
    issuer,
    recovery,
    secret: made.secrets.issuerSecret,
    creator: p2mrAddressFromPubkey(issuer, "regtest"),
    sale: p2mrAddressFromPubkey(recovery, "regtest"),
    change: p2mrAddressFromPubkey(Buffer.alloc(32, 3), "regtest"),
    funding: p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, recoveryFor(issuer))),
  };
}

const NAMES = [1, 2, 3];
const BODIES = NAMES.map((n) => Uint8Array.of(n, n));
const METAS = NAMES.map((n) => encodeCbor({ meta: { name: `Item#${n}`, attributes: [] } }));
const LEAVES = NAMES.map((n) => leafPreimage(n, BODIES[n - 1], METAS[n - 1]));
const ROOT = merkleRoot(LEAVES);
const ITEMS = NAMES.map((n) => ({ number: n, body: BODIES[n - 1], contentType: "image/png", metadata: METAS[n - 1] }));

function build(f: Fixture, over: { sale: string | null; reserve?: number[]; field5?: Uint8Array; leaves?: boolean }): MintPlan {
  return buildPlan({
    network: "regtest",
    feeRate: 1,
    issuerPublic: f.issuer,
    recoveryPublic: f.recovery,
    creator: f.creator,
    sale: over.sale,
    change: f.change,
    root: ROOT,
    utxo: { txid: "11".repeat(32), vout: 0, value: 50_000_000_000n, script: f.funding },
    genesis: { body: new TextEncoder().encode("{\"name\":\"Example\"}"), leafList: Buffer.concat(LEAVES), field5: over.field5 },
    batches: [{ name: "batch-0", items: ITEMS }],
    reserve: new Set(over.reserve ?? []),
  });
}

const expects = (f: Fixture, sale: string | null): SignExpectations => ({ fundingTxid: "11".repeat(32), fundingVout: 0, creator: f.creator, sale, change: f.change });

test("a plan with a sale is the same bytes as before, and has no noSale key", async () => {
  const f = await fixture(Uint8Array.from({ length: 128 }, (_, i) => (i * 7 + 3) & 255));
  const field = await encodeGenesisField({ schema: "pins-collection/1", name: "Example", supply: 3, first: 1, namePrefix: "Item#", itemType: "image/png", root: "ab".repeat(32), issuer: f.issuer.toString("hex"), saleCommitment: "cd".repeat(32) });
  assert.equal(createHash("sha256").update(field).digest("hex"), "48d26b04868a560bdf232ea25f74940eab9e8bf0a75117a62c329fa93bbef33a");
  const plan = buildPlan({
    network: "regtest",
    feeRate: 1,
    issuerPublic: f.issuer,
    recoveryPublic: f.recovery,
    creator: f.creator,
    sale: f.sale,
    change: f.change,
    root: "ab".repeat(32),
    utxo: { txid: "11".repeat(32), vout: 0, value: 50_000_000_000n, script: f.funding },
    genesis: { body: new TextEncoder().encode("{}"), leafList: new Uint8Array(96), field5: field },
    batches: [{ name: "batch-0", items: [1, 2, 3].map((n) => ({ number: n, body: Uint8Array.of(n, n), contentType: "image/png", metadata: Uint8Array.of(0xa0) })) }],
    reserve: new Set([2]),
  });
  // Recorded from the tree before this change, with the same inputs.
  assert.equal(createHash("sha256").update(JSON.stringify(plan)).digest("hex"), "2a46c79378b1ff2f919797fec8aaaa8e4c5ed4b67e9bad99f256dd250d49c17c");
  assert.equal("noSale" in plan, false);
  f.secret.fill(0);
});

test("a plan with no sale sends every item to the creator and refuses a reserve", async () => {
  const f = await fixture();
  const plan = build(f, { sale: null });
  assert.equal(plan.noSale, true);
  assert.equal(plan.sale, plan.creator);
  const creator = Buffer.from(addressToScriptPubKey(f.creator, "regtest")).toString("hex");
  for (const reveal of plan.reveals) {
    const parsed = parseTransaction(Buffer.from(reveal.raw, "hex"));
    parsed.outputs.slice(0, -1).forEach((output) => assert.equal(Buffer.from(output.script).toString("hex"), creator));
    assert.ok(reveal.outputs.slice(0, -1).every((output) => output.address === f.creator));
  }
  assert.throws(() => build(f, { sale: null, reserve: [2] }), /no sale has no reserve/);
  assert.throws(() => verifyPlan(plan, new Set([2]), expects(f, null), undefined, 0), /no sale has no reserve/);
  assert.throws(() => verifyPlan(plan, new Set(), expects(f, null), undefined, 1), /no sale has no reserve/);
  f.secret.fill(0);
});

test("sign takes the addresses of the operator, and the sale flag of the plan must agree", async () => {
  const f = await fixture();
  const none = build(f, { sale: null });
  const withSale = build(f, { sale: f.sale, reserve: [2] });
  // A plan with no sale is signed with no reserve, and no 500 is applied when the count is left out.
  const pinsPlan = { ...none };
  assert.doesNotThrow(() => verifyPlan(pinsPlan, new Set(), expects(f, null), ROOT));
  const signed = signPlan(none, f.secret, new Set(), expects(f, null), ROOT);
  assert.equal(signed.signed, true);
  assert.equal(signed.noSale, true);
  assert.deepEqual(signedBodyChecks(none, signed).map((check) => check.pass), [true]);
  // A sale plan left without a reserve count still asks for 500, as before.
  assert.throws(() => verifyPlan(withSale, new Set([2]), expects(f, f.sale), ROOT), /reserve has 1 ids, not 500/);
  assert.doesNotThrow(() => verifyPlan(withSale, new Set([2]), expects(f, f.sale), ROOT, 1));
  // The operator says "no sale" and the plan has one, or the other way round.
  assert.throws(() => verifyPlan(withSale, new Set([2]), expects(f, null), ROOT, 1), /addresses do not match/);
  assert.throws(() => verifyPlan(none, new Set(), expects(f, f.creator), ROOT), /addresses do not match/);
  // Dropping the flag from a plan with no sale does not turn it into a plan with a sale.
  const flagless: Partial<MintPlan> = { ...none };
  delete flagless.noSale;
  assert.throws(() => verifyPlan(flagless as MintPlan, new Set(), expects(f, null), ROOT), /addresses do not match/);
  // Setting the flag on a plan with a sale moves no output.
  assert.throws(() => verifyPlan({ ...withSale, noSale: true }, new Set(), expects(f, null), ROOT, 0), /addresses do not match|is not/);
  assert.throws(() => verifyPlan({ ...build(f, { sale: f.sale }), noSale: true, sale: f.creator }, new Set(), expects(f, null), ROOT, 0), /is not/);
  f.secret.fill(0);
});

test("preflight sees a plan and a signed plan that differ in the sale flag", async () => {
  const f = await fixture();
  const none = build(f, { sale: null });
  const signed = signPlan(none, f.secret, new Set(), expects(f, null), ROOT);
  const flagless = { ...signed } as Partial<MintPlan>;
  delete flagless.noSale;
  assert.equal(signedBodyChecks(none, flagless as MintPlan)[0].pass, false);
  assert.equal(quotaChecks([], [], [], 0).every((check) => check.pass), true);
  f.secret.fill(0);
});

test("a small collection with no sale is minted and the indexer reads it as authentic with no sale", async () => {
  const f = await fixture();
  const field5 = await encodeGenesisField({ ...GENESIS, root: ROOT, issuer: f.issuer.toString("hex") });
  const plan = build(f, { sale: null, field5 });
  const signed = signPlan(plan, f.secret, new Set(), expects(f, null), ROOT);
  f.secret.fill(0);
  const genesis = signed.reveals.find((reveal) => reveal.name === "genesis");
  assert.ok(genesis);
  const field = genesisFieldFromLeaf(genesis.leaf, signed.marker);
  assert.deepEqual(Object.keys(field ?? {}), ["schema", "name", "supply", "first", "name_prefix", "root", "issuer", "item_type"]);
  const checks = genesisChecks(field, { ...GENESIS, root: ROOT, sale: false });
  assert.ok(checks.every((check) => check.pass), JSON.stringify(checks));
  assert.equal(signedBodyChecks(plan, signed)[0].pass, true);

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
  assert.equal(view.supply, 3);
  assert.equal(view.root, ROOT);
  assert.deepEqual(view.pieces?.map((piece) => piece.authentic), [true, true, true]);
  assert.equal(view.orderStatus, "none");
  assert.equal(view.priceStatus, "none");
  assert.equal(view.seedRevealed, false);
  assert.equal(view.reserveMode, "none");
});
