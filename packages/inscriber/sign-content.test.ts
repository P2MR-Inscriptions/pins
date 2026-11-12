// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { p2mrAddressFromPubkey, p2mrLeafHash, p2mrScriptPubKey, P2MR_LEAF_VERSION_V1 } from "@qbit-oss/protocol";
import { init } from "@qbit-oss/pqc";
import { parseTransaction } from "../indexer/chain.ts";
import { createKeyfile } from "./keyfile.ts";
import { PINS_MARKER } from "./marker.ts";
import { buildPlan, type MintPlan, type PlanContent } from "./plan.ts";
import { encodeGenesisField, encodePriceField } from "./preflight.ts";
import { PRICE_BODY } from "./price.ts";
import { recoveryFor } from "./reveal.ts";
import { signPlan, verifyPlan, type SignExpectations } from "./sign.ts";

const TEST_MARKER = Uint8Array.of(0x74, 0x65, 0x73, 0x74);
const ROOT = "ab".repeat(32);
const text = (value: string) => new TextEncoder().encode(value);

type Over = { genesisBody?: string; field5?: Uint8Array; item2?: string; metadata?: Uint8Array; swap?: boolean };

/** Five items in two reveals. The size of the reveals is whatever the content says. */
function content(over: Over = {}): PlanContent {
  const item = (number: number, body: string, metadata?: Uint8Array) => ({ number, body: text(body), contentType: "image/png", metadata });
  const first = [item(1, "one", Uint8Array.of(0xa0)), item(2, over.item2 ?? "two", over.metadata), item(3, "three")];
  if (over.swap) [first[0], first[1]] = [first[1], first[0]];
  return {
    genesis: { body: text(over.genesisBody ?? "{\"name\":\"n\"}"), leafList: Uint8Array.of(1, 2, 3, 4), field5: over.field5 ?? Uint8Array.of(0xa0) },
    batches: [
      { name: "batch-0", items: first },
      { name: "batch-1", items: [item(4, "four"), item(5, "five")] },
    ],
  };
}

async function setup(marker: Uint8Array, reserve: Set<number>, made: PlanContent, kind: { sale: boolean; holder?: boolean } = { sale: true }) {
  await init();
  const keys = createKeyfile(Buffer.from("disposable-passphrase"));
  const issuer = Buffer.from(keys.secrets.issuerPublic, "hex");
  const recovery = Buffer.from(keys.secrets.recoveryPublic, "hex");
  const creator = p2mrAddressFromPubkey(issuer, "regtest");
  const sale = p2mrAddressFromPubkey(recovery, "regtest");
  const holder = p2mrAddressFromPubkey(Buffer.alloc(32, 9), "regtest");
  const change = p2mrAddressFromPubkey(Buffer.alloc(32, 3), "regtest");
  const funding = p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, recoveryFor(issuer)));
  const plan = buildPlan({
    network: "regtest",
    feeRate: 1,
    issuerPublic: issuer,
    recoveryPublic: recovery,
    creator,
    sale: kind.sale ? sale : null,
    ...(kind.holder ? { holder } : {}),
    change,
    root: ROOT,
    utxo: { txid: "11".repeat(32), vout: 0, value: 50_000_000_000n, script: funding },
    marker,
    reserve,
    ...made,
  });
  const expected: SignExpectations = { fundingTxid: "11".repeat(32), fundingVout: 0, creator, sale: kind.sale ? sale : null, ...(kind.holder ? { holder } : {}), change };
  return { plan, secret: keys.secrets.issuerSecret, expected, issuer, creator, sale, holder, change, funding, recovery };
}

const reserve = new Set([2, 5]);

test("a plan built from the same files is accepted and signs", async () => {
  const built = await setup(PINS_MARKER, reserve, content());
  verifyPlan(built.plan, reserve, built.expected, ROOT, 2, content());
  const signed = signPlan(built.plan, built.secret, reserve, built.expected, ROOT, 2, content());
  assert.equal(signed.signed, true);
  assert.equal(signed.reveals.length, 3);
  assert.equal(parseTransaction(Buffer.from(signed.reveals[1].raw, "hex")).inputs[0].witness.length, 3);
});

test("a plan whose item bytes differ from the files is refused", async () => {
  const built = await setup(PINS_MARKER, reserve, content({ item2: "tw0" }));
  assert.throws(() => signPlan(built.plan, built.secret, reserve, built.expected, ROOT, 2, content()), /batch-0 leaf does not match the canonical zip/);
});

test("a plan whose items are in another order than the files is refused", async () => {
  // The reveal is consistent with itself and with the reserve the operator passed. Only the files give the order.
  const built = await setup(PINS_MARKER, reserve, content({ swap: true }));
  assert.throws(() => verifyPlan(built.plan, reserve, built.expected, ROOT, 2, content()), /batch-0 leaf does not match the canonical zip/);
});

test("a plan whose item metadata differs from the files is refused", async () => {
  const built = await setup(PINS_MARKER, reserve, content({ metadata: Uint8Array.of(0xa0) }));
  assert.throws(() => verifyPlan(built.plan, reserve, built.expected, ROOT, 2, content()), /batch-0 leaf does not match/);
});

test("a plan whose genesis body or field 5 differs from the files is refused", async () => {
  const body = await setup(PINS_MARKER, reserve, content({ genesisBody: "{\"name\":\"x\"}" }));
  assert.throws(() => verifyPlan(body.plan, reserve, body.expected, ROOT, 2, content()), /genesis leaf does not match/);
  const field = await setup(PINS_MARKER, reserve, content({ field5: Uint8Array.of(0xa1, 0x61, 0x61, 0x01) }));
  assert.throws(() => verifyPlan(field.plan, reserve, field.expected, ROOT, 2, content()), /genesis leaf does not match/);
});

test("a plan whose genesis carries another sale commitment than the one `sign` is given is refused", async () => {
  const issuer = "90".repeat(32);
  const genesis = (saleCommitment?: string) => encodeGenesisField({ schema: "pins-collection/1", name: "Example", supply: 5, first: 1, namePrefix: "Item#", itemType: "image/png", root: ROOT, issuer, saleCommitment });
  const planned = await genesis("cd".repeat(32));
  const built = await setup(PINS_MARKER, reserve, content({ field5: planned }));
  // The commitment `sign` takes is the hash of the keyfile's own secret. The plan was made with another.
  assert.doesNotThrow(() => verifyPlan(built.plan, reserve, built.expected, ROOT, 2, content({ field5: planned })));
  const other = await genesis("ce".repeat(32));
  assert.throws(() => verifyPlan(built.plan, reserve, built.expected, ROOT, 2, content({ field5: other })), /genesis leaf does not match/);
  // A plan with no commitment is not the plan of a collection that has one, and the reverse.
  const none = await genesis();
  assert.throws(() => verifyPlan(built.plan, reserve, built.expected, ROOT, 2, content({ field5: none })), /genesis leaf does not match/);
});

test("a plan that declares another marker than its leaves use is refused", async () => {
  const built = await setup(TEST_MARKER, reserve, content());
  const swapped: MintPlan = { ...built.plan, marker: "70696e73" };
  assert.throws(() => verifyPlan(swapped, reserve, built.expected, ROOT, 2, content()), /leaf does not match/);
});

test("a plan with an extra, missing, or renamed reveal is refused", async () => {
  const extra = content();
  extra.batches.push({ name: "batch-2", items: [{ number: 6, body: text("six"), contentType: "image/png" }] });
  const more = await setup(PINS_MARKER, reserve, extra);
  assert.throws(() => verifyPlan(more.plan, reserve, more.expected, ROOT, 2, content()), /plan has 4 reveals, the canonical zip makes 3/);
  const fewer = content();
  fewer.batches.pop();
  const less = await setup(PINS_MARKER, reserve, fewer);
  assert.throws(() => verifyPlan(less.plan, reserve, less.expected, ROOT, 2, content()), /plan has 2 reveals/);
  const named = content();
  named.batches[1].name = "batch-9";
  const renamed = await setup(PINS_MARKER, reserve, named);
  assert.throws(() => verifyPlan(renamed.plan, reserve, renamed.expected, ROOT, 2, content()), /named batch-9/);
});

test("outputs that carry other item numbers than the envelopes are refused", async () => {
  // The planner pays item 2 as if it were item 3: both are consistent with the reserve set
  // the operator passed, so only the comparison with the files can see it.
  const built = await setup(PINS_MARKER, reserve, content());
  const outputs = built.plan.reveals[1].outputs.map((output) => ({ ...output }));
  outputs[1].item = 3;
  const bent: MintPlan = { ...built.plan, reveals: built.plan.reveals.map((reveal, index) => (index === 1 ? { ...reveal, outputs } : reveal)) };
  assert.throws(() => verifyPlan(bent, reserve, built.expected, ROOT, 2, content()), /outputs do not carry the items/);
  const dropped = built.plan.reveals[1].outputs.map((output, at) => ({ ...output, item: at === 0 ? null : output.item }));
  const nulled: MintPlan = { ...built.plan, reveals: built.plan.reveals.map((reveal, index) => (index === 1 ? { ...reveal, outputs: dropped } : reveal)) };
  assert.throws(() => verifyPlan(nulled, reserve, built.expected, ROOT, 2, content()), /outputs do not carry the items/);
});

test("the files and the destination rule agree: a plan with no sale, with a holder or without", async () => {
  for (const holder of [false, true]) {
    const built = await setup(PINS_MARKER, new Set(), content(), { sale: false, holder });
    assert.doesNotThrow(() => verifyPlan(built.plan, new Set(), built.expected, ROOT, 0, content()));
    // An output whose recorded address is not where the rule sends it is refused.
    const bent: MintPlan = {
      ...built.plan,
      reveals: built.plan.reveals.map((reveal, index) => (index === 1 ? { ...reveal, outputs: reveal.outputs.map((output, at) => (at === 0 ? { ...output, address: built.change } : output)) } : reveal)),
    };
    assert.throws(() => verifyPlan(bent, new Set(), built.expected, ROOT, 0, content()), /output 0 is not for/);
  }
  // With a sale, the reserve goes to the creator and the other items to the sale address, and the files agree.
  const sale = await setup(PINS_MARKER, reserve, content());
  const addresses = sale.plan.reveals[1].outputs.map((output) => output.address);
  assert.deepEqual(addresses, [sale.sale, sale.creator, sale.sale, sale.change]);
});

test("a pins plan is not signed without the files", async () => {
  const built = await setup(PINS_MARKER, reserve, content());
  assert.throws(() => signPlan(built.plan, built.secret, reserve, built.expected, ROOT, 2), /needs the canonical zip/);
});

test("a rehearsal plan still signs without the files", async () => {
  const built = await setup(TEST_MARKER, new Set(), content(), { sale: false });
  const signed = signPlan(built.plan, built.secret, new Set(), built.expected, undefined, 0);
  assert.equal(signed.signed, true);
});

test("a rehearsal plan is compared with the files when they are given", async () => {
  const built = await setup(TEST_MARKER, new Set(), content({ item2: "tw0" }), { sale: false });
  assert.throws(() => verifyPlan(built.plan, new Set(), built.expected, undefined, 0, content()), /batch-0 leaf does not match/);
});

test("the mainnet network does not take a marker other than pins", async () => {
  const built = await setup(TEST_MARKER, new Set(), content(), { sale: false });
  assert.throws(() => verifyPlan({ ...built.plan, network: "mainnet" }, new Set(), built.expected, undefined, 0, content()), /mainnet refuses a marker other than pins/);
});

const PRICE = { price_bits: 1000, price_sources: ["Example source 1.00 USD"], price_time: "2026-01-01T00:00:00Z" };

async function pricePlan(over: { body?: Uint8Array; bodyType?: string; extra?: boolean } = {}) {
  const base = await setup(PINS_MARKER, new Set(), content(), { sale: true });
  const field5 = await encodePriceField({ genesis: `${"ab".repeat(32)}i0`, price: PRICE });
  const plan = buildPlan({
    network: "regtest",
    feeRate: 1,
    issuerPublic: base.issuer,
    recoveryPublic: base.recovery,
    creator: base.creator,
    sale: base.sale,
    change: base.change,
    root: ROOT,
    utxo: { txid: "11".repeat(32), vout: 0, value: 50_000_000_000n, script: base.funding },
    genesis: { body: over.body ?? PRICE_BODY, leafList: new Uint8Array(), field5, bodyType: over.bodyType ?? "text/plain" },
    batches: [],
    reserve: new Set(),
  });
  return { ...base, plan };
}

test("a price plan is not rebuilt from a zip: it is rebuilt from its own price record, and signs without the files", async () => {
  const built = await pricePlan();
  assert.doesNotThrow(() => verifyPlan(built.plan, new Set(), built.expected, ROOT, 0));
  assert.equal(signPlan(built.plan, built.secret, new Set(), built.expected, ROOT, 0).signed, true);
  // The files of a mint are not what a price plan is compared with, even when they are given.
  assert.doesNotThrow(() => verifyPlan(built.plan, new Set(), built.expected, ROOT, 0, content()));
});

test("a price plan whose body or content type is not the price inscription is refused", async () => {
  const body = await pricePlan({ body: text("something else\n") });
  assert.throws(() => verifyPlan(body.plan, new Set(), body.expected, ROOT, 0), /genesis leaf does not match/);
  const type = await pricePlan({ bodyType: "image/png" });
  assert.throws(() => verifyPlan(type.plan, new Set(), type.expected, ROOT, 0), /genesis leaf does not match/);
});
