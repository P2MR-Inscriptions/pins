// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { p2mrAddressFromPubkey, p2mrLeafHash, p2mrScriptPubKey, P2MR_LEAF_VERSION_V1 } from "@qbit-oss/protocol";
import { init } from "@qbit-oss/pqc";
import { encodeCbor } from "../collection/canonical.mjs";
import { parseCollectionProfile } from "../protocol/profile.mjs";
import { createKeyfile } from "./keyfile.ts";
import { buildPlan, type MintPlan, type PlanContent } from "./plan.ts";
import { recoveryFor } from "./reveal.ts";
import { signPlan, verifyPlan, type SignExpectations } from "./sign.ts";
import { assertReserveSize, leafPreimage, merkleRoot } from "./verify.ts";

// Three items. Item 2 is the only reserved one that appears in the plan.
const BODIES = [1, 2, 3].map((n) => Uint8Array.of(n, n));
const METAS = [1, 2, 3].map((n) => encodeCbor({ meta: { name: `Item#${n}`, attributes: [] } }));
const ROOT = merkleRoot([1, 2, 3].map((n) => leafPreimage(n, BODIES[n - 1], METAS[n - 1])));

async function fixture() {
  await init();
  const made = createKeyfile(Buffer.from("disposable-passphrase"));
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

/** What the zip makes, for `sign` to rebuild and compare. */
const CONTENT: PlanContent = {
  genesis: { body: new TextEncoder().encode("{}"), leafList: new Uint8Array(0) },
  batches: [{ name: "batch-0", items: [1, 2, 3].map((n) => ({ number: n, body: BODIES[n - 1], contentType: "image/png", metadata: METAS[n - 1] })) }],
};

function salePlan(f: Fixture, reserve: number[] = [2]): MintPlan {
  return buildPlan({
    network: "regtest",
    feeRate: 1,
    issuerPublic: f.issuer,
    recoveryPublic: f.recovery,
    creator: f.creator,
    sale: f.sale,
    change: f.change,
    root: ROOT,
    utxo: { txid: "11".repeat(32), vout: 0, value: 50_000_000_000n, script: f.funding },
    ...CONTENT,
    reserve: new Set(reserve),
  });
}

const expects = (f: Fixture): SignExpectations => ({ fundingTxid: "11".repeat(32), fundingVout: 0, creator: f.creator, sale: f.sale, change: f.change });

// A reserve of 500 ids. Item 2 is in it. The other 499 are numbers the plan does not contain.
const reserve500 = (): Set<number> => new Set([2, ...Array.from({ length: 499 }, (_, i) => 1000 + i)]);

test("a plan with a sale is refused when its reserve count is not declared", async () => {
  const f = await fixture();
  const plan = salePlan(f);
  for (const reserve of [new Set([2]), new Set<number>(), reserve500()]) {
    assert.throws(() => verifyPlan(plan, reserve, expects(f), ROOT, undefined, CONTENT), /needs its reserve count/);
    assert.throws(() => verifyPlan(plan, reserve, expects(f), ROOT, undefined, CONTENT), /needs its reserve count/);
    assert.throws(() => signPlan(plan, f.made.secrets.issuerSecret, reserve, expects(f), ROOT, undefined, CONTENT), /needs its reserve count/);
  }
  f.made.secrets.issuerSecret.fill(0);
});

test("the declared reserve count is the one that is checked, 500 included", async () => {
  const f = await fixture();
  const plan = salePlan(f);
  assert.doesNotThrow(() => verifyPlan(plan, new Set([2]), expects(f), ROOT, 1, CONTENT));
  assert.doesNotThrow(() => verifyPlan(plan, reserve500(), expects(f), ROOT, 500, CONTENT));
  assert.throws(() => verifyPlan(plan, reserve500(), expects(f), ROOT, 1, CONTENT), /reserve has 500 ids, not 1/);
  assert.throws(() => verifyPlan(plan, new Set([2]), expects(f), ROOT, 500, CONTENT), /reserve has 1 ids, not 500/);
  // A sale with a declared count of zero is a count, not a missing one.
  assert.doesNotThrow(() => verifyPlan(salePlan(f, []), new Set(), expects(f), ROOT, 0, CONTENT));
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => verifyPlan(plan, new Set([2]), expects(f), ROOT, bad, CONTENT), /non-negative integer/);
  }
  f.made.secrets.issuerSecret.fill(0);
});

test("a rehearsal plan with another marker keeps skipping the reserve size", async () => {
  const f = await fixture();
  const plan = { ...salePlan(f), marker: "61626364" };
  assert.doesNotThrow(() => verifyPlan(plan, new Set([2]), expects(f), undefined));
  f.made.secrets.issuerSecret.fill(0);
});

test("the size of the assignment reserve must be the one the profile declares", () => {
  const profile = parseCollectionProfile({ name: "Example", namePrefix: "Item#", supply: 1000, first: 1, schema: "pins-collection/1", itemType: "image/png", root: "ab".repeat(32), reserveGroups: [{ trait_type: "a", value: "b", count: 3 }], reserveExtra: 2 });
  assert.equal(profile.reserveCount, 5);
  assert.doesNotThrow(() => assertReserveSize([1, 2, 3, 4, 5], profile.reserveCount));
  assert.throws(() => assertReserveSize([1, 2, 3, 4], profile.reserveCount), /reserves 4 items, but the collection profile declares 5/);
  assert.throws(() => assertReserveSize([1, 2, 3, 4, 5, 6], profile.reserveCount), /reserves 6 items/);
  // A repeated id is not a second reserved item.
  assert.throws(() => assertReserveSize([1, 2, 3, 4, 4], profile.reserveCount), /reserves 4 items/);
  assert.doesNotThrow(() => assertReserveSize([], 0));
});

test("the profile is the only source of a reserve count and it is the sum of what the profile declares", () => {
  const base = { name: "Example", namePrefix: "Item#", supply: 1000, first: 1, schema: "pins-collection/1", itemType: "image/png", root: "ab".repeat(32) };
  const a = parseCollectionProfile({ ...base, reserveGroups: [{ trait_type: "a", value: "b", count: 7 }], reserveExtra: 0 });
  const b = parseCollectionProfile({ ...base, reserveGroups: [{ trait_type: "a", value: "b", count: 7 }, { trait_type: "c", value: "d", count: 3 }], reserveExtra: 20 });
  assert.equal(a.reserveCount, 7);
  assert.equal(b.reserveCount, 30);
  assert.throws(() => parseCollectionProfile({ ...base }), /reserveExtra/);
});

function cli(args: string[]): { status: number | null; out: string } {
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "packages/inscriber/cli.ts", ...args], { encoding: "utf8" });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

test("price builds a plan for a collection with a sale and refuses one with no sale", async () => {
  const f = await fixture();
  const dir = mkdtempSync(join(tmpdir(), "pins-price-"));
  const write = (name: string, value: unknown): string => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  const common = { name: "Example", namePrefix: "Item#", supply: 3, first: 1, schema: "pins-collection/1", itemType: "image/png", root: ROOT };
  const withSale = write("sale.json", { ...common, reserveGroups: [{ trait_type: "a", value: "b", count: 1 }], reserveExtra: 0 });
  const noSale = write("nosale.json", { ...common, sale: false });
  const pub = write("pub.json", { issuerPublic: f.issuer.toString("hex"), recoveryPublic: f.recovery.toString("hex") });
  const utxo = write("utxo.json", { txid: "11".repeat(32), vout: 0, value: "50000000000", script: Buffer.from(f.funding).toString("hex") });
  const price = write("price.json", { price_bits: 1000, price_sources: ["Example source 1.00 USD"], price_time: "2026-01-01T00:00:00Z" });
  const args = ["price", "--pub", pub, "--price", price, "--genesis", `${"ab".repeat(32)}i0`, "--utxo", utxo, "--creator", f.creator, "--sale", f.sale, "--change", f.change, "--fee-rate", "1", "--network", "regtest", "--dry-run"];
  const ok = cli([...args, "--collection", withSale]);
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.out, /price schema pins-price\/1/);
  const rootOnly = cli([...args, "--root", ROOT]);
  assert.equal(rootOnly.status, 0, rootOnly.out);
  const refused = cli([...args, "--collection", noSale]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.out, /declares no sale, so there is no price P2MR Inscription/);
  f.made.secrets.issuerSecret.fill(0);
});
