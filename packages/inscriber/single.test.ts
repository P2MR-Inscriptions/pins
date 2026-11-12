// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { p2mrAddressFromPubkey, p2mrLeafHash, p2mrScriptPubKey, P2MR_LEAF_VERSION_V1 } from "@qbit-oss/protocol";
import { init } from "@qbit-oss/pqc";
import { parseTransaction } from "../indexer/chain.ts";
import { encodeCbor } from "../collection/canonical.mjs";
import { createKeyfile, writeKeyfile, zeroSecrets } from "./keyfile.ts";
import { PINS_MARKER } from "./marker.ts";
import { buildPlan, buildSinglePlan, type MintPlan, type PlanContent, type SingleContent } from "./plan.ts";
import { encodeGenesisField, signedBodyChecks, singleChecks } from "./preflight.ts";
import { recoveryFor } from "./reveal.ts";
import { parseEnvelopes } from "./script.ts";
import { assertContentType, assertSingleFlags } from "./single.ts";
import { signPlan, verifyPlan, type SignExpectations } from "./sign.ts";
import { leafPreimage, merkleRoot } from "./verify.ts";

const PASS = "disposable-passphrase";
const text = (value: string) => new TextEncoder().encode(value);
const META = encodeCbor({ meta: { name: "Example", attributes: [{ trait_type: "kind", value: "note" }] } });
const BODY = text("hello, a single inscription");

function content(over: { body?: Uint8Array; contentType?: string; metadata?: Uint8Array | null } = {}): SingleContent {
  const metadata = over.metadata === undefined ? new Uint8Array(META) : over.metadata ?? undefined;
  return { single: { body: over.body ?? BODY, contentType: over.contentType ?? "text/plain;charset=utf-8", ...(metadata ? { metadata } : {}) } };
}

async function setup() {
  await init();
  const keys = createKeyfile(Buffer.from(PASS));
  const issuer = Buffer.from(keys.secrets.issuerPublic, "hex");
  const recovery = Buffer.from(keys.secrets.recoveryPublic, "hex");
  const creator = p2mrAddressFromPubkey(issuer, "regtest");
  const change = p2mrAddressFromPubkey(Buffer.alloc(32, 3), "regtest");
  const funding = p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, recoveryFor(issuer)));
  const utxo = { txid: "11".repeat(32), vout: 0, value: 50_000_000_000n, script: funding };
  const plan = buildSinglePlan({ network: "regtest", feeRate: 1, issuerPublic: issuer, recoveryPublic: recovery, creator, change, utxo, inscription: content().single });
  const expected: SignExpectations = { fundingTxid: utxo.txid, fundingVout: 0, creator, sale: null, holder: null, change };
  return { keys, issuer, recovery, creator, change, funding, utxo, plan, expected, secret: keys.secrets.issuerSecret };
}

test("a single inscription plan is one reveal with one inscription, paid to the creator, and signs from its files", async () => {
  const f = await setup();
  assert.equal(f.plan.single, true);
  assert.equal(f.plan.noSale, true);
  assert.equal(f.plan.root, "");
  assert.deepEqual(f.plan.reveals.map((reveal) => reveal.name), ["inscription"]);
  const reveal = f.plan.reveals[0];
  assert.deepEqual(reveal.outputs.map((output) => [output.item, output.address]), [[null, f.creator], [null, f.change]]);
  assert.equal(reveal.outputs[0].value, "10000");
  verifyPlan(f.plan, new Set(), f.expected, undefined, undefined, content());
  const signed = signPlan(f.plan, f.secret, new Set(), f.expected, undefined, undefined, content());
  assert.equal(signed.signed, true);
  assert.equal(signed.single, true);
  assert.deepEqual(signedBodyChecks(f.plan, signed).map((check) => check.pass), [true]);
  // The signed reveal carries the body, the content type and the metadata exactly as given.
  const envelopes = parseEnvelopes(Buffer.from(signed.reveals[0].leaf, "hex"), PINS_MARKER);
  assert.equal(envelopes.length, 1);
  assert.deepEqual(Buffer.from(envelopes[0].body), Buffer.from(BODY));
  assert.equal(Buffer.from(envelopes[0].fields.find((field) => field.tag === 1)?.value ?? []).toString(), "text/plain;charset=utf-8");
  assert.deepEqual(Buffer.from(envelopes[0].fields.find((field) => field.tag === 5)?.value ?? []), Buffer.from(META));
  assert.equal(parseTransaction(Buffer.from(signed.reveals[0].raw, "hex")).outputs[0].value, 10_000n);
  zeroSecrets(f.keys.secrets);
});

test("a single inscription without metadata has no field 5, and the same files give the same plan", async () => {
  const f = await setup();
  const make = () => buildSinglePlan({ network: "regtest", feeRate: 1, issuerPublic: f.issuer, recoveryPublic: f.recovery, creator: f.creator, change: f.change, utxo: f.utxo, inscription: content({ metadata: null }).single });
  const a = make();
  assert.equal(JSON.stringify(a), JSON.stringify(make()));
  const envelopes = parseEnvelopes(Buffer.from(a.reveals[0].leaf, "hex"), PINS_MARKER);
  assert.equal(envelopes[0].fields.some((field) => field.tag === 5), false);
  verifyPlan(a, new Set(), f.expected, undefined, undefined, content({ metadata: null }));
  zeroSecrets(f.keys.secrets);
});

test("sign refuses a body, content type, or metadata that is not the one in the plan", async () => {
  const f = await setup();
  const sign = (made: SingleContent | undefined, plan: MintPlan = f.plan) => signPlan(plan, f.secret, new Set(), f.expected, undefined, undefined, made);
  assert.throws(() => sign(content({ body: text("another body") })), /leaf does not match the P2MR Inscription files/);
  assert.throws(() => sign(content({ contentType: "text/plain" })), /leaf does not match the P2MR Inscription files/);
  assert.throws(() => sign(content({ metadata: null })), /leaf does not match the P2MR Inscription files/);
  assert.throws(() => sign(content({ metadata: encodeCbor({ meta: { name: "Other", attributes: [] } }) })), /leaf does not match the P2MR Inscription files/);
  // A plan of another issuer key is not signed with this key, and its leaf is not the leaf of this key.
  const other = await setup();
  const foreign = { ...f.plan, issuerPublic: other.keys.secrets.issuerPublic, reveals: other.plan.reveals };
  assert.throws(() => sign(content(), foreign));
  zeroSecrets(other.keys.secrets);
  zeroSecrets(f.keys.secrets);
});

test("a single plan and the single flag must agree, and a single plan has no root, sale, or holder", async () => {
  const f = await setup();
  // A single plan signed without its files, or with a collection's.
  assert.throws(() => signPlan(f.plan, f.secret, new Set(), f.expected), /single P2MR Inscription/);
  // A plan that is not single cannot be signed as one, and cannot move itself into the single path by a flag.
  const collection = (await oneItemCollection(f)).plan;
  assert.throws(() => signPlan(collection, f.secret, new Set(), { ...f.expected }, undefined, undefined, content()), /not a single P2MR Inscription/);
  const { single: _single, ...stripped } = f.plan;
  assert.throws(() => signPlan(stripped as MintPlan, f.secret, new Set(), f.expected, undefined, undefined, content()), /not a single P2MR Inscription/);
  assert.throws(() => signPlan({ ...f.plan, single: false as unknown as true }, f.secret, new Set(), f.expected, undefined, undefined, content()), /single flag/);
  assert.throws(() => signPlan({ ...f.plan, root: "ab".repeat(32) }, f.secret, new Set(), f.expected, undefined, undefined, content()), /no collection root/);
  assert.throws(() => signPlan(f.plan, f.secret, new Set(), f.expected, "ab".repeat(32), undefined, content()), /no collection root/);
  assert.throws(() => signPlan({ ...f.plan, holder: f.change }, f.secret, new Set(), { ...f.expected, holder: f.change }, undefined, undefined, content()), /no holder/);
  assert.throws(() => signPlan(f.plan, f.secret, new Set(), { ...f.expected, creator: f.change }, undefined, undefined, content()));
  zeroSecrets(f.keys.secrets);
});

/** A one-item collection with no sale, built by the collection path. It is not a single inscription. */
async function oneItemCollection(f: Awaited<ReturnType<typeof setup>>) {
  const body = text("item one");
  const metadata = new Uint8Array(encodeCbor({ meta: { name: "Item#1", attributes: [] } }));
  const root = merkleRoot([leafPreimage(1, body, metadata)]);
  const field5 = await encodeGenesisField({ schema: "pins-collection/1", name: "Example", supply: 1, first: 1, namePrefix: "Item#", itemType: "image/png", root, issuer: f.keys.secrets.issuerPublic });
  const made: PlanContent = {
    genesis: { body: text("{}"), leafList: new Uint8Array(leafPreimage(1, body, metadata)), field5 },
    batches: [{ name: "batch-0", items: [{ number: 1, body, contentType: "image/png", metadata }] }],
  };
  const plan = buildPlan({
    network: "regtest", feeRate: 1, issuerPublic: f.issuer, recoveryPublic: f.recovery, creator: f.creator, sale: null, change: f.change, root, utxo: f.utxo,
    reserve: new Set(), ...made,
  });
  return { plan, root, made };
}

test("a one-item collection with no sale builds, verifies, and signs through the collection path", async () => {
  const f = await setup();
  const { plan, root, made } = await oneItemCollection(f);
  assert.equal(plan.single, undefined);
  assert.equal(plan.noSale, true);
  assert.deepEqual(plan.reveals.map((reveal) => reveal.name), ["genesis", "batch-0"]);
  assert.deepEqual(plan.reveals[1].outputs.map((output) => output.item), [1, null]);
  assert.equal(plan.reveals[1].outputs[0].address, f.creator);
  assert.equal(plan.root, root);
  verifyPlan(plan, new Set(), f.expected, root, 0, made);
  const signed = signPlan(plan, f.secret, new Set(), f.expected, root, 0, made);
  assert.equal(signed.signed, true);
  // The collection path and the single path are different plans of different shape.
  assert.notEqual(signed.reveals.length, f.plan.reveals.length);
  zeroSecrets(f.keys.secrets);
});

test("preflight rows pass for the files of the plan and fail for any other file", async () => {
  const f = await setup();
  const signed = signPlan(f.plan, f.secret, new Set(), f.expected, undefined, undefined, content());
  const rows = (made: SingleContent, plan: MintPlan = signed) => singleChecks(f.plan, plan, made, f.keys.secrets.issuerPublic);
  assert.deepEqual(rows(content()).map((row) => row.pass), [true, true]);
  assert.deepEqual(rows(content({ body: text("x") })).map((row) => row.pass), [true, false]);
  assert.deepEqual(rows(content({ contentType: "image/png" })).map((row) => row.pass), [true, false]);
  const notSingle = { ...signed, single: undefined } as unknown as MintPlan;
  assert.equal(rows(content(), notSingle)[0].pass, false);
  assert.equal(singleChecks(f.plan, signed, content(), "ab".repeat(32))[0].pass, false);
  zeroSecrets(f.keys.secrets);
});

test("content types and the single flags are checked", () => {
  assert.equal(assertContentType("image/png"), "image/png");
  assert.equal(assertContentType("text/plain;charset=utf-8"), "text/plain;charset=utf-8");
  for (const bad of ["", "png", "image/ png\n", "text/plain\u00e9", "x/".padEnd(300, "y")]) assert.throws(() => assertContentType(bad), /content type/, bad);
  assert.equal(assertSingleFlags("plan", { single: true, body: "b", "content-type": "text/plain" }), true);
  assert.equal(assertSingleFlags("plan", {}), false);
  assert.throws(() => assertSingleFlags("plan", { body: "b" }), /add --single/);
  assert.throws(() => assertSingleFlags("plan", { metadata: "m" }), /add --single/);
  assert.throws(() => assertSingleFlags("assign", { single: true }), /not assign/);
  for (const name of ["collection", "zip", "assignment", "sale", "holder", "root"]) {
    assert.throws(() => assertSingleFlags("sign", { single: true, [name]: "x" }), new RegExp(`--${name}`), name);
  }
});

function cli(args: string[]): { status: number | null; out: string } {
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "packages/inscriber/cli.ts", ...args], { encoding: "utf8", env: { ...process.env, PINS_KEY_PASSPHRASE: PASS } });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

test("the command line plans and signs a single inscription offline, and refuses a changed body at sign", async () => {
  const f = await setup();
  const dir = mkdtempSync(join(tmpdir(), "pins-single-"));
  const write = (name: string, value: string | Uint8Array): string => {
    const path = join(dir, name);
    writeFileSync(path, value);
    return path;
  };
  const key = join(dir, "issuer.keyfile.json");
  writeKeyfile(key, f.keys.body, { issuerPublic: f.keys.secrets.issuerPublic, recoveryPublic: f.keys.secrets.recoveryPublic });
  const pub = write("pub.json", JSON.stringify({ issuerPublic: f.keys.secrets.issuerPublic, recoveryPublic: f.keys.secrets.recoveryPublic }));
  const utxo = write("utxo.json", JSON.stringify({ txid: f.utxo.txid, vout: 0, value: f.utxo.value.toString(), script: Buffer.from(f.funding).toString("hex") }));
  const body = write("body.txt", BODY);
  const other = write("other.txt", text("a different body"));
  const meta = write("meta.json", JSON.stringify({ meta: { name: "Example", attributes: [{ trait_type: "kind", value: "note" }] } }));
  const common = ["--network", "regtest", "--creator", f.creator, "--change", f.change, "--utxo", utxo];
  const files = ["--body", body, "--content-type", "text/plain;charset=utf-8", "--metadata", meta];

  const planPath = join(dir, "plan.json");
  const made = cli(["plan", "--single", ...files, ...common, "--pub", pub, "--fee-rate", "1", "--out", planPath]);
  assert.equal(made.status, 0, made.out);
  assert.match(made.out, /single P2MR Inscription/);
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as MintPlan;
  assert.match(made.out, new RegExp(`P2MR Inscription id ${plan.reveals[0].txid}i0`));
  // The same files give the same plan bytes as the library.
  assert.equal(plan.reveals[0].leaf, f.plan.reveals[0].leaf);

  const signedPath = join(dir, "signed.json");
  const signArgs = ["sign", "--single", "--key", key, "--plan", planPath, ...common];
  const ok = cli([...signArgs, ...files, "--out", signedPath]);
  assert.equal(ok.status, 0, ok.out);
  assert.equal((JSON.parse(readFileSync(signedPath, "utf8")) as MintPlan).signed, true);

  // A body file that is not the planned one: refused, nothing written.
  const refusedPath = join(dir, "refused.json");
  const refused = cli([...signArgs, "--body", other, "--content-type", "text/plain;charset=utf-8", "--metadata", meta, "--out", refusedPath]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.out, /leaf does not match the P2MR Inscription files/);
  assert.equal(existsSync(refusedPath), false);

  // Collection flags and a missing file are refused with a clear message.
  for (const [args, pattern] of [
    [["plan", "--single", ...files, ...common, "--pub", pub, "--fee-rate", "1", "--zip", "x.zip", "--out", join(dir, "a.json")], /--zip belongs to a collection/],
    [["plan", "--single", "--content-type", "text/plain", ...common, "--pub", pub, "--fee-rate", "1", "--out", join(dir, "b.json")], /missing --body/],
    [["plan", "--body", body, ...common, "--pub", pub, "--fee-rate", "1", "--out", join(dir, "c.json")], /add --single/],
    [["assign", "--single"], /not assign/],
  ] as const) {
    const run = cli([...args]);
    assert.notEqual(run.status, 0, pattern.source);
    assert.match(run.out, pattern);
  }
  // Sign without --single is a collection sign: it does not accept a single plan.
  const asCollection = cli(["sign", "--key", key, "--plan", planPath, ...common, "--out", join(dir, "d.json")]);
  assert.notEqual(asCollection.status, 0);
  zeroSecrets(f.keys.secrets);
});
