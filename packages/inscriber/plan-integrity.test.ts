// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { p2mrAddressFromPubkey, p2mrLeafHash, p2mrScriptPubKey, P2MR_LEAF_VERSION_V1 } from "@qbit-oss/protocol";
import { init } from "@qbit-oss/pqc";
import { parseTransaction } from "../indexer/chain.ts";
import { createKeyfile, zeroSecrets } from "./keyfile.ts";
import { buildPlan, type MintPlan } from "./plan.ts";
import { rawWitnessTransaction, recoveryFor } from "./reveal.ts";
import { signPlan, verifyPlan, type SignExpectations } from "./sign.ts";

const MARKER = Uint8Array.of(0x74, 0x65, 0x73, 0x74);

async function plan(): Promise<{ plan: MintPlan; secret: Uint8Array; expected: SignExpectations }> {
  await init();
  const made = createKeyfile(Buffer.from("disposable-passphrase"));
  const issuer = Buffer.from(made.secrets.issuerPublic, "hex");
  const recovery = Buffer.from(made.secrets.recoveryPublic, "hex");
  const creator = p2mrAddressFromPubkey(issuer, "regtest");
  const sale = p2mrAddressFromPubkey(recovery, "regtest");
  const change = p2mrAddressFromPubkey(Buffer.alloc(32, 3), "regtest");
  const funding = p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, recoveryFor(issuer)));
  const built = buildPlan({
    network: "regtest",
    feeRate: 1,
    issuerPublic: issuer,
    recoveryPublic: recovery,
    creator,
    sale,
    change,
    root: "ab".repeat(32),
    utxo: { txid: "11".repeat(32), vout: 0, value: 50_000_000_000n, script: funding },
    marker: MARKER,
    genesis: { body: new TextEncoder().encode("{\"name\":\"n\"}"), leafList: new Uint8Array() },
    batches: [],
    reserve: new Set(),
  });
  return {
    plan: built,
    secret: made.secrets.issuerSecret,
    expected: { fundingTxid: "11".repeat(32), fundingVout: 0, creator, sale, change },
  };
}

function bump(hex: string): string {
  const raw = Buffer.from(hex, "hex");
  const parsed = parseTransaction(raw);
  const value = parsed.outputs[0].value;
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(value);
  const at = raw.indexOf(le);
  const next = Buffer.alloc(8);
  next.writeBigUInt64LE(value + 1n);
  next.copy(raw, at);
  return raw.toString("hex");
}

test("a plan from buildPlan is accepted and signs", async () => {
  const built = await plan();
  verifyPlan(built.plan, new Set(), built.expected, undefined, 0);
  const signed = signPlan(built.plan, built.secret, new Set(), built.expected, undefined, 0);
  built.secret.fill(0);
  assert.equal(signed.signed, true);
  assert.equal(parseTransaction(Buffer.from(signed.reveals[0].raw, "hex")).outputs[0].value, 10_000n);
  zeroSecrets({ ...signed, issuerSecret: new Uint8Array(), recoverySecret: new Uint8Array(), saleSecret: new Uint8Array(), issuerPublic: "", recoveryPublic: "" });
});

test("raw amount, fan-out, fee, txid, and output order changes are rejected before signing", async () => {
  const built = await plan();
  const reserve = new Set<number>();
  const original = built.plan;
  const reveal = { ...original, reveals: [{ ...original.reveals[0], raw: bump(original.reveals[0].raw) }] };
  assert.throws(() => verifyPlan(reveal, reserve, built.expected, undefined, 0), /txid|postage|output/);
  const fan = { ...original, fanout: { ...original.fanout, raw: bump(original.fanout.raw) } };
  assert.throws(() => verifyPlan(fan, reserve, built.expected, undefined, 0), /txid|fan-out|funding/);
  const fee = { ...original, reveals: [{ ...original.reveals[0], fee: "1" }] };
  assert.throws(() => verifyPlan(fee, reserve, built.expected, undefined, 0), /commit value/);
  const txid = { ...original, reveals: [{ ...original.reveals[0], txid: "00".repeat(32) }] };
  assert.throws(() => verifyPlan(txid, reserve, built.expected, undefined, 0), /txid/);
  const meta = { ...original, reveals: [{ ...original.reveals[0], outputs: original.reveals[0].outputs.map((output) => ({ ...output, value: "1" })) }] };
  assert.throws(() => verifyPlan(meta, reserve, built.expected, undefined, 0), /postage/);
  const parsed = parseTransaction(Buffer.from(original.reveals[0].raw, "hex"));
  const swapped = rawWitnessTransaction({
    version: 2,
    locktime: 0,
    inputs: [{
      prevout: {
        txid: Uint8Array.from(Buffer.from(parsed.inputs[0].prevTxid ?? "", "hex").reverse()),
        vout: parsed.inputs[0].prevVout ?? 0,
      },
      sequence: 0xfffffffe,
    }],
    outputs: [...parsed.outputs].reverse().map((output) => ({ value: output.value, scriptPubKey: output.script })),
  }, [[]]);
  const reordered = { ...original, reveals: [{ ...original.reveals[0], raw: Buffer.from(swapped).toString("hex") }] };
  assert.throws(() => signPlan(reordered, built.secret, reserve, built.expected, undefined, 0), /txid|output|change/);
  built.secret.fill(0);
});

test("changing only the top-level destination is outside this check", async () => {
  const built = await plan();
  const moved = { ...built.plan, creator: built.plan.sale };
  assert.throws(() => verifyPlan(moved, new Set(), built.expected, undefined, 0));
  const rewritten = { ...built.plan, creator: built.plan.sale, sale: built.plan.creator, change: built.plan.creator };
  assert.throws(() => verifyPlan(rewritten, new Set(), built.expected, undefined, 0), /addresses/);
  built.secret.fill(0);
});

test("a mutated reveal or fan-out control block is rejected", async () => {
  const built = await plan();
  const flip = (hex: string) => hex.slice(0, -2) + (hex.endsWith("00") ? "ff" : "00");
  const reveal = built.plan.reveals[0];
  const badReveal = { ...built.plan, reveals: [{ ...reveal, control: flip(reveal.control) }, ...built.plan.reveals.slice(1)] };
  assert.throws(() => verifyPlan(badReveal, new Set(), built.expected, undefined, 0), /control/);
  const badFan = { ...built.plan, fanout: { ...built.plan.fanout, control: flip(built.plan.fanout.control) } };
  assert.throws(() => signPlan(badFan, built.secret, new Set(), built.expected, undefined, 0), /control/);
  const otherCoin = { ...built.expected, fundingTxid: "22".repeat(32), fundingVout: 4 };
  assert.throws(() => verifyPlan(built.plan, new Set(), otherCoin, undefined, 0), /funding/);
  const fan = parseTransaction(Buffer.from(built.plan.fanout.raw, "hex"));
  const movedRaw = rawWitnessTransaction({
    version: 2,
    locktime: 0,
    inputs: [{ prevout: { txid: Buffer.alloc(32, 0x22), vout: 7 }, sequence: 0xfffffffe }],
    outputs: fan.outputs.map((output) => ({ value: output.value, scriptPubKey: output.script })),
  }, [[]]);
  const movedTxid = Buffer.from(createHash("sha256").update(createHash("sha256").update(movedRaw).digest()).digest()).reverse().toString("hex");
  const relinked = {
    ...built.plan,
    fanout: { ...built.plan.fanout, raw: Buffer.from(movedRaw).toString("hex"), txid: movedTxid },
  };
  assert.throws(() => verifyPlan(relinked, new Set(), built.expected, undefined, 0), /funding/);
  built.secret.fill(0);
});

test("a non-numeric fee rate is rejected", async () => {
  await init();
  const made = createKeyfile(Buffer.from("disposable-passphrase"));
  const issuer = Buffer.from(made.secrets.issuerPublic, "hex");
  const recovery = Buffer.from(made.secrets.recoveryPublic, "hex");
  zeroSecrets(made.secrets);
  const funding = p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, recoveryFor(issuer)));
  assert.throws(() => buildPlan({
    network: "regtest",
    feeRate: Number("abc"),
    issuerPublic: issuer,
    recoveryPublic: recovery,
    creator: p2mrAddressFromPubkey(issuer, "regtest"),
    sale: p2mrAddressFromPubkey(recovery, "regtest"),
    change: p2mrAddressFromPubkey(Buffer.alloc(32, 4), "regtest"),
    root: "ab".repeat(32),
    utxo: { txid: "11".repeat(32), vout: 0, value: 50_000_000_000n, script: funding },
    marker: MARKER,
    genesis: { body: new TextEncoder().encode("{}"), leafList: new Uint8Array() },
    batches: [],
    reserve: new Set(),
  }), /positive finite/);
});
