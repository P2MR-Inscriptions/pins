// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { p2mrAddressFromPubkey, p2mrLeafHash, p2mrScriptPubKey, P2MR_LEAF_VERSION_V1 } from "@qbit-oss/protocol";
import { init } from "@qbit-oss/pqc";
import { encodeCbor } from "../collection/canonical.mjs";
import { createKeyfile, openKeyfile, writeKeyfile, zeroSecrets } from "./keyfile.ts";
import { buildPlan, type MintPlan } from "./plan.ts";
import { encodeGenesisField, encodePriceField, pricePlanField, priceSigningChecks, signedBodyChecks } from "./preflight.ts";
import { PRICE_BODY } from "./price.ts";
import { recoveryFor } from "./reveal.ts";
import { leafPreimage, merkleRoot } from "./verify.ts";

const PASS = "disposable-passphrase";
const PRICE = { price_bits: 1000, price_sources: ["Example source 1.00 USD"], price_time: "2026-01-01T00:00:00Z" };
const GENESIS_ID = `${"ab".repeat(32)}i0`;
const BODIES = [1, 2, 3].map((n) => Uint8Array.of(n, n));
const METAS = [1, 2, 3].map((n) => encodeCbor({ meta: { name: `Item#${n}`, attributes: [] } }));
const ROOT = merkleRoot([1, 2, 3].map((n) => leafPreimage(n, BODIES[n - 1], METAS[n - 1])));
const hashOf = (seed: Uint8Array): string => createHash("sha256").update(seed).digest("hex");

async function fixture() {
  await init();
  const made = createKeyfile(Buffer.from(PASS));
  const issuer = Buffer.from(made.secrets.issuerPublic, "hex");
  const recovery = Buffer.from(made.secrets.recoveryPublic, "hex");
  return {
    made,
    issuer,
    recovery,
    creator: p2mrAddressFromPubkey(issuer, "regtest"),
    sale: p2mrAddressFromPubkey(recovery, "regtest"),
    change: p2mrAddressFromPubkey(Buffer.alloc(32, 3), "regtest"),
    funding: p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, recoveryFor(issuer))),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function plan(f: Fixture, over: { price?: boolean; withItems?: boolean } = {}): Promise<MintPlan> | MintPlan {
  const common = {
    network: "regtest" as const,
    feeRate: 1,
    issuerPublic: f.issuer,
    recoveryPublic: f.recovery,
    creator: f.creator,
    sale: f.sale,
    change: f.change,
    root: ROOT,
    utxo: { txid: "11".repeat(32), vout: 0, value: 50_000_000_000n, script: f.funding },
  };
  if (over.price === false) {
    return encodeGenesisField({ schema: "pins-collection/1", name: "Example", supply: 3, first: 1, namePrefix: "Item#", itemType: "image/png", root: ROOT, issuer: f.issuer.toString("hex"), saleCommitment: "cd".repeat(32) }).then((field5) => buildPlan({
      ...common,
      genesis: { body: new TextEncoder().encode("{}"), leafList: new Uint8Array(0), field5 },
      batches: [{ name: "batch-0", items: [1, 2, 3].map((n) => ({ number: n, body: BODIES[n - 1], contentType: "image/png", metadata: METAS[n - 1] })) }],
      reserve: new Set([2]),
    }));
  }
  return encodePriceField({ genesis: GENESIS_ID, price: PRICE }).then((field5) => buildPlan({
    ...common,
    genesis: { body: PRICE_BODY, leafList: new Uint8Array(), field5, bodyType: "text/plain" },
    batches: over.withItems ? [{ name: "batch-0", items: [{ number: 1, body: BODIES[0], contentType: "image/png", metadata: METAS[0] }] }] : [],
    reserve: new Set(),
  }));
}

test("a plan that inscribes only a price is recognised, and no other plan is", async () => {
  const f = await fixture();
  const price = await plan(f);
  const field = pricePlanField(price);
  assert.equal(field?.schema, "pins-price/1");
  assert.equal(field?.genesis, GENESIS_ID);
  assert.equal(pricePlanField(await plan(f, { price: false })), null);
  assert.equal(pricePlanField(await plan(f, { withItems: true })), null);
  assert.equal(pricePlanField({ ...price, reveals: [] }), null);
  assert.equal(pricePlanField({ ...price, reveals: [{ ...price.reveals[0], name: "batch-0" }] }), null);
  zeroSecrets(f.made.secrets);
});

test("the seed check of a price plan accepts the committed secret and refuses any other", async () => {
  const f = await fixture();
  const field = pricePlanField(await plan(f)) as Record<string, unknown>;
  const seed = Buffer.from(f.made.secrets.saleSecret as Uint8Array);
  const other = Buffer.from(seed);
  other[0] ^= 1;
  const run = (secret: Buffer, commitment: string | undefined, schema = "pins-collection/1") => priceSigningChecks({ seed: secret, commitment, field, collectionSchema: schema });
  const failed = (checks: ReturnType<typeof run>) => checks.filter((check) => !check.pass).map((check) => check.name);
  assert.deepEqual(failed(run(seed, hashOf(seed))), []);
  assert.deepEqual(failed(run(other, hashOf(seed))), ["seed hash"]);
  assert.deepEqual(failed(run(seed, undefined)), ["seed hash"]);
  assert.deepEqual(failed(run(seed, hashOf(seed).toUpperCase())), ["seed hash"]);
  assert.deepEqual(failed(run(seed, hashOf(seed).slice(2))), ["seed hash"]);
  // The price text of a rehearsal schema is not the launch text.
  assert.deepEqual(failed(run(seed, hashOf(seed), "c/1")), ["price schema"]);
  // A failure message does not carry the hash of the secret.
  const message = run(other, hashOf(seed)).map((check) => check.detail).join(" ");
  assert.equal(message.includes(hashOf(other)), false);
  assert.equal(message.includes(hashOf(seed)), false);
  other.fill(0);
  zeroSecrets(f.made.secrets);
});

function cli(args: string[]): { status: number | null; out: string } {
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "packages/inscriber/cli.ts", ...args], { encoding: "utf8", env: { ...process.env, PINS_KEY_PASSPHRASE: PASS } });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

test("sign signs a price plan with the committed sale secret and refuses a wrong one", async () => {
  const f = await fixture();
  const dir = mkdtempSync(join(tmpdir(), "pins-price-sign-"));
  const write = (name: string, value: unknown): string => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  const key = join(dir, "issuer.key");
  writeKeyfile(key, f.made.body, { issuerPublic: f.made.secrets.issuerPublic, recoveryPublic: f.made.secrets.recoveryPublic });
  const reopened = openKeyfile(key, Buffer.from(PASS));
  const commitment = hashOf(reopened.saleSecret as Uint8Array);
  zeroSecrets(reopened);
  const profile = write("profile.json", { name: "Example", namePrefix: "Item#", supply: 3, first: 1, schema: "pins-collection/1", itemType: "image/png", root: ROOT, reserveGroups: [{ trait_type: "a", value: "b", count: 1 }], reserveExtra: 0 });
  const pub = write("pub.json", { issuerPublic: f.issuer.toString("hex"), recoveryPublic: f.recovery.toString("hex") });
  const utxo = write("utxo.json", { txid: "11".repeat(32), vout: 0, value: "50000000000", script: Buffer.from(f.funding).toString("hex") });
  const price = write("price.json", PRICE);
  const assignment = write("assignment.json", { reserve: [2], sale: [1, 3], saleCommitment: commitment });
  const wrong = write("wrong.json", { reserve: [2], sale: [1, 3], saleCommitment: hashOf(Buffer.alloc(32, 9)) });
  const unsigned = join(dir, "price-plan.json");
  const made = cli(["price", "--pub", pub, "--price", price, "--genesis", GENESIS_ID, "--utxo", utxo, "--creator", f.creator, "--sale", f.sale, "--change", f.change, "--fee-rate", "1", "--network", "regtest", "--collection", profile, "--out", unsigned]);
  assert.equal(made.status, 0, made.out);
  const common = ["sign", "--key", key, "--plan", unsigned, "--collection", profile, "--creator", f.creator, "--sale", f.sale, "--change", f.change, "--utxo", utxo];

  // The right secret. No zip is needed: a price has no item.
  const signedPath = join(dir, "price.signed.json");
  const ok = cli([...common, "--assignment", assignment, "--out", signedPath]);
  assert.equal(ok.status, 0, ok.out);
  const signed = JSON.parse(readFileSync(signedPath, "utf8")) as MintPlan;
  const before = JSON.parse(readFileSync(unsigned, "utf8")) as MintPlan;
  assert.equal(signed.signed, true);
  assert.deepEqual(signedBodyChecks(before, signed).map((check) => check.pass), [true]);
  assert.notEqual(signed.reveals[0].raw, before.reveals[0].raw);

  // A wrong secret, a missing record, or a keyfile of another collection: refused, nothing written.
  for (const [name, args, pattern] of [
    ["wrong commitment", ["--assignment", wrong], /seed hash/],
    ["no assignment", [], /needs --assignment/],
  ] as const) {
    const out = join(dir, `${name.replace(" ", "-")}.json`);
    const refused = cli([...common, ...args, "--out", out]);
    assert.notEqual(refused.status, 0, name);
    assert.match(refused.out, pattern, name);
    assert.equal(existsSync(out), false, name);
    assert.equal(refused.out.includes(commitment), false, name);
  }
  zeroSecrets(f.made.secrets);
});
