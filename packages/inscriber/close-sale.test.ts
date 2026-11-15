// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { p2mrAddressFromPubkey, p2mrLeafHash, p2mrScriptPubKey, P2MR_LEAF_VERSION_V1 } from "@qbit-oss/protocol";
import { init } from "@qbit-oss/pqc";
import { parseTransaction } from "../indexer/chain.ts";
import { signedRecordPlan, recordPlan, type RecordRequest } from "./close-sale.ts";
import { writeKeyfile } from "./keyfile.ts";
import { fastKeyfile } from "./keyfile-test-support.ts";
import { PINS_MARKER } from "./marker.ts";
import { recordChecks, recordOfPlan } from "./record-checks.ts";
import { recordInscription, type RecordInput } from "./records.ts";
import { recoveryFor } from "./reveal.ts";
import { buildSinglePlan, type MintPlan } from "./plan.ts";
import { signPlan } from "./sign.ts";

const PASS = "disposable-passphrase";
const ROOT = "cd".repeat(32);
const hash = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

let cached: ReturnType<typeof build> | undefined;
/** One keyfile for the whole file: creating and signing with SLH-DSA is slow. */
function setup(): ReturnType<typeof build> {
  cached ??= build();
  return cached;
}

async function build() {
  await init();
  const keys = fastKeyfile(Buffer.from(PASS));
  const issuer = Buffer.from(keys.secrets.issuerPublic, "hex");
  const recovery = Buffer.from(keys.secrets.recoveryPublic, "hex");
  const secret = keys.secrets.saleSecret as Uint8Array;
  const funding = p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, recoveryFor(issuer)));
  const creator = p2mrAddressFromPubkey(issuer, "regtest");
  const change = p2mrAddressFromPubkey(Buffer.alloc(32, 3), "regtest");
  const unsold = p2mrAddressFromPubkey(Buffer.alloc(32, 9), "regtest");
  const utxo = { txid: "11".repeat(32), vout: 0, value: 50_000_000_000n, script: funding };
  const request = (input: RecordInput): RecordRequest => ({ input, network: "regtest", marker: PINS_MARKER, feeRate: 1, issuerPublic: issuer, recoveryPublic: recovery, creator, change, utxo });
  return { keys, issuer, secret, creator, change, unsold, utxo, request, fundingAddress: p2mrAddressFromPubkey(issuer, "regtest") };
}
type Setup = Awaited<ReturnType<typeof build>>;

const inputs = (f: Setup): RecordInput[] => [
  { kind: "unsold-address", root: ROOT, address: f.unsold, network: "regtest" },
  { kind: "sale-reveal", root: ROOT, saleSecret: f.secret },
  { kind: "close", root: ROOT, count: 3 },
];

test("each record is signed as one stand-alone P2MR Inscription that reads back as the record", async () => {
  const f = await setup();
  for (const input of inputs(f)) {
    const signed = signedRecordPlan(f.request(input), f.keys.secrets.issuerSecret);
    assert.equal(signed.signed, true);
    assert.equal(signed.single, true);
    assert.equal(signed.root, "");
    assert.equal(signed.reveals.length, 1);
    assert.equal(recordOfPlan(signed)?.kind, input.kind);
    const reveal = parseTransaction(Buffer.from(signed.reveals[0].raw, "hex"));
    assert.equal(reveal.inputs[0].witness.length, 3, "the reveal spends the leaf with a signature, the leaf and the control block");
    assert.equal(reveal.outputs[0].value, 10_000n);
  }
});

test("a record plan is deterministic: the same inputs give the same plan", async () => {
  const f = await setup();
  const [input] = inputs(f);
  assert.deepEqual(recordPlan(f.request(input)), recordPlan(f.request(input)));
});

test("sign refuses a record plan whose leaf is not the record it is told to sign", async () => {
  const f = await setup();
  const plan = recordPlan(f.request({ kind: "close", root: ROOT, count: 3 }));
  const other = recordInscription({ kind: "close", root: ROOT, count: 4 });
  const expected = { fundingTxid: f.utxo.txid, fundingVout: 0, creator: f.creator, sale: null, holder: null, change: f.change };
  assert.throws(() => signPlan(plan, f.keys.secrets.issuerSecret, new Set(), expected, undefined, undefined, { single: other }), /./);
});

test("the unsold address cannot be the creator or the change address of its own record", async () => {
  const f = await setup();
  const input: RecordInput = { kind: "unsold-address", root: ROOT, address: f.unsold, network: "regtest" };
  assert.throws(() => recordPlan({ ...f.request(input), creator: f.unsold }), /only for the unsold items/);
  assert.throws(() => recordPlan({ ...f.request(input), change: f.unsold }), /only for the unsold items/);
  assert.throws(() => recordPlan(f.request({ ...input, address: p2mrAddressFromPubkey(Buffer.alloc(32, 9), "mainnet") } as RecordInput)), /HRP/);
});

// Signing with SLH-DSA is slow, so each kind is signed once.
const signedOnce = new Map<string, MintPlan>();

function checks(f: Setup, input: RecordInput, over: Partial<Parameters<typeof recordChecks>[0]> = {}) {
  const signed = signedOnce.get(input.kind) ?? signedRecordPlan(f.request(input), f.keys.secrets.issuerSecret);
  signedOnce.set(input.kind, signed);
  return recordChecks({ kind: input.kind, signed, issuerPublicHex: f.keys.secrets.issuerPublic, network: "regtest", root: ROOT, supply: 3, saleCommitment: hash(f.secret), funding: f.fundingAddress, ...over });
}

test("preflight --record passes each record against the files", async () => {
  const f = await setup();
  for (const input of inputs(f)) {
    const rows = checks(f, input);
    assert.ok(rows.every((row) => row.pass), JSON.stringify(rows.filter((row) => !row.pass)));
  }
});

test("preflight --record fails a wrong root, count, secret, key, kind and a reused address", async () => {
  const f = await setup();
  const [unsold, reveal, close] = inputs(f);
  const failing = (rows: ReturnType<typeof checks>, pattern: RegExp) => assert.ok(rows.some((row) => !row.pass && pattern.test(row.detail)), JSON.stringify(rows));
  failing(checks(f, close, { root: "ee".repeat(32) }), /root of the collection profile/);
  failing(checks(f, close, { supply: 4 }), /is not the supply 4/);
  failing(checks(f, reveal, { saleCommitment: hash(Buffer.alloc(32, 1)) }), /is not the sale commitment/);
  failing(checks(f, reveal, { saleCommitment: undefined }), /no sale commitment/);
  failing(checks(f, close, { issuerPublicHex: "00".repeat(32) }), /issuer key differs/);
  failing(checks(f, close, { kind: "sale-reveal" }), /not pins-sale-reveal\/1/);
  failing(checks(f, unsold, { funding: f.unsold }), /used only for the unsold items/);
  failing(checks(f, unsold, { network: "mainnet" }), /HRP/);
});

test("a plan that holds no record reads as none", async () => {
  const f = await setup();
  const plain = buildSinglePlan({
    network: "regtest", feeRate: 1, issuerPublic: f.issuer, recoveryPublic: Buffer.from(f.keys.secrets.recoveryPublic, "hex"),
    creator: f.creator, change: f.change, utxo: f.utxo, inscription: { body: new TextEncoder().encode("note"), contentType: "text/plain" },
  });
  assert.equal(recordOfPlan(plain), null);
  assert.equal(recordOfPlan({ marker: plain.marker, reveals: [] }), null);
});

function cli(args: string[]): { status: number | null; out: string } {
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "packages/inscriber/cli.ts", ...args], { encoding: "utf8", env: { ...process.env, PINS_KEY_PASSPHRASE: PASS } });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

test("the command line writes each signed record plan, and refuses a keyfile of another collection", async () => {
  const f = await setup();
  const dir = mkdtempSync(join(tmpdir(), "pins-close-"));
  const write = (name: string, value: string): string => {
    const path = join(dir, name);
    writeFileSync(path, value);
    return path;
  };
  const key = join(dir, "issuer.keyfile.json");
  writeKeyfile(key, f.keys.body, { issuerPublic: f.keys.secrets.issuerPublic, recoveryPublic: f.keys.secrets.recoveryPublic });
  const pub = write("pub.json", JSON.stringify({ issuerPublic: f.keys.secrets.issuerPublic, recoveryPublic: f.keys.secrets.recoveryPublic }));
  const utxo = write("utxo.json", JSON.stringify({ txid: f.utxo.txid, vout: 0, value: f.utxo.value.toString(), script: Buffer.from(f.utxo.script).toString("hex") }));
  const profile = write("profile.json", JSON.stringify({ name: "Example", namePrefix: "Item#", supply: 3, first: 1, schema: "pins-collection/1", itemType: "image/png", root: ROOT, reserveExtra: 0, reserveGroups: [{ trait_type: "Tone", value: "1", count: 1 }] }));
  const noSale = write("profile-no-sale.json", JSON.stringify({ name: "Example", namePrefix: "Item#", supply: 3, first: 1, schema: "pins-collection/1", itemType: "image/png", root: ROOT, sale: false }));
  const assignment = write("assignment.json", JSON.stringify({ reserve: [1], sale: [2, 3], saleCommitment: hash(f.secret) }));
  const wrong = write("assignment-wrong.json", JSON.stringify({ reserve: [1], sale: [2, 3], saleCommitment: hash(Buffer.alloc(32, 5)) }));
  const common = ["--key", key, "--pub", pub, "--utxo", utxo, "--creator", f.creator, "--change", f.change, "--fee-rate", "1", "--network", "regtest"];

  const unsoldOut = join(dir, "unsold.signed.json");
  const unsold = cli(["unsold-address", ...common, "--collection", profile, "--unsold-address", f.unsold, "--out", unsoldOut]);
  assert.equal(unsold.status, 0, unsold.out);
  assert.match(unsold.out, /pins-unsold-address\/1/);
  assert.equal(recordOfPlan(JSON.parse(readFileSync(unsoldOut, "utf8")))?.kind, "unsold-address");

  const revealOut = join(dir, "reveal.signed.json");
  const reveal = cli(["sale-reveal", ...common, "--collection", profile, "--assignment", assignment, "--out", revealOut]);
  assert.equal(reveal.status, 0, reveal.out);
  assert.match(reveal.out, /holds the sale secret/);
  assert.equal(statSync(revealOut).mode & 0o777, 0o600, "a plan with the sale secret is not readable by others");
  assert.equal(recordOfPlan(JSON.parse(readFileSync(revealOut, "utf8")))?.kind, "sale-reveal");
  const stranger = cli(["sale-reveal", ...common, "--collection", profile, "--assignment", wrong, "--out", join(dir, "x.json")]);
  assert.notEqual(stranger.status, 0);
  assert.match(stranger.out, /not the one of the collection|is not the saleCommitment/);
  assert.equal(existsSync(join(dir, "x.json")), false);

  const closeOut = join(dir, "close.signed.json");
  const close = cli(["close", ...common, "--collection", profile, "--out", closeOut]);
  assert.equal(close.status, 0, close.out);
  assert.match(close.out, /count 3/);
  assert.deepEqual(recordOfPlan(JSON.parse(readFileSync(closeOut, "utf8"))), { kind: "close", root: ROOT, count: 3 });
  const closeNoSale = cli(["close", ...common, "--collection", noSale, "--dry-run"]);
  assert.equal(closeNoSale.status, 0, closeNoSale.out);

  const refused = [
    cli(["unsold-address", ...common, "--collection", noSale, "--unsold-address", f.unsold, "--dry-run"]),
    cli(["sale-reveal", ...common, "--collection", noSale, "--assignment", assignment, "--dry-run"]),
    cli(["close", ...common, "--collection", profile, "--unsold-address", f.unsold, "--dry-run"]),
    cli(["close", ...common, "--collection", profile, "--rpc", "http://127.0.0.1:1/", "--dry-run"]),
    cli(["unsold-address", ...common, "--collection", profile, "--unsold-address", f.creator, "--dry-run"]),
    cli(["preflight", "--record", "frobnicate", "--signed", closeOut]),
  ];
  for (const result of refused) assert.notEqual(result.status, 0, result.out);
  assert.match(refused[0].out, /declares no sale/);
  assert.match(refused[3].out, /offline/);
});
