// SPDX-License-Identifier: Apache-2.0

/**
 * Offline signing. This module does not open a socket. It checks the frozen
 * Merkle root, the reveal weights, postage, and the reserve assignment, then
 * signs the fan-out and the reveals with the issuer key.
 */
import { addressToScriptPubKey, p2mrLeafHash, p2mrSighash, P2MR_LEAF_VERSION_V1, SIGHASH_DEFAULT, type P2mrTransaction } from "@qbit-oss/protocol";
import { sign } from "@qbit-oss/pqc";
import { parseTransaction } from "../indexer/chain.ts";
import { rawWitnessTransaction, revealWitness } from "./reveal.ts";
import { isPinsMarker, parseMarker } from "./marker.ts";
import { assertPostage, assertRevealWeight, assertRoot, assertSeparateChange } from "./verify.ts";
import type { MintPlan } from "./plan.ts";

function bytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function internal(display: string): Uint8Array {
  return Uint8Array.from(Buffer.from(display, "hex").reverse());
}

function asTransaction(raw: Uint8Array): P2mrTransaction {
  const parsed = parseTransaction(raw);
  return {
    version: 2,
    locktime: 0,
    inputs: parsed.inputs.map((input) => ({
      prevout: { txid: internal(input.prevTxid ?? ""), vout: input.prevVout ?? 0 },
      sequence: 0xfffffffe,
    })),
    outputs: parsed.outputs.map((output) => ({ value: output.value, scriptPubKey: output.script })),
  };
}

function signInput(secret: Uint8Array, raw: Uint8Array, leaf: Uint8Array, control: Uint8Array, spentValue: bigint, spentScript: Uint8Array): Uint8Array {
  const tx = asTransaction(raw);
  const digest = p2mrSighash({
    tx,
    inputIndex: 0,
    spentOutputs: [{ value: spentValue, scriptPubKey: spentScript }],
    leafHash: p2mrLeafHash(P2MR_LEAF_VERSION_V1, leaf),
    hashType: SIGHASH_DEFAULT,
  });
  const signature = sign(secret, digest);
  return rawWitnessTransaction(tx, [revealWitness(signature, leaf, control)]);
}

export function verifyPlan(plan: MintPlan, reserve: Set<number>, expectedRoot?: string, reserveCount = 500): void {
  const marker = parseMarker(plan.marker);
  if (isPinsMarker(marker)) {
    if (!expectedRoot) throw new Error("a pins plan needs the collection profile root");
    assertRoot(plan.root, expectedRoot);
    if (reserve.size !== reserveCount) throw new Error(`reserve has ${reserve.size} ids, not ${reserveCount}`);
  } else if (expectedRoot && plan.root === expectedRoot) {
    throw new Error("a rehearsal plan must not carry the collection root");
  }
  assertSeparateChange(plan.creator, plan.sale, plan.change);
  const fanout = parseTransaction(Buffer.from(plan.fanout.raw, "hex"));
  const fanoutChange = fanout.outputs.at(-1);
  const changeScript = addressToScriptPubKey(plan.change, plan.network);
  if (!fanoutChange || Buffer.compare(fanoutChange.script, changeScript) !== 0) {
    throw new Error("fan-out change is not the change address");
  }
  for (const reveal of plan.reveals) {
    assertRevealWeight(reveal.weight, reveal.name);
    const change = reveal.outputs.at(-1);
    if (!change || change.item !== null || change.address !== plan.change) {
      throw new Error(`${reveal.name} change is not the change address`);
    }
    for (const output of reveal.outputs.slice(0, -1)) {
      assertPostage(BigInt(output.value), reveal.name);
      if (output.item === null) {
        if (output.address !== plan.creator) throw new Error(`${reveal.name} genesis output is not the reserve address`);
        continue;
      }
      const expected = reserve.has(output.item) ? plan.creator : plan.sale;
      if (output.address !== expected) throw new Error(`${reveal.name} item ${output.item} is not assigned to ${expected}`);
    }
  }
}

/** Returns a signed copy. The caller zeros the secret. */
export function signPlan(plan: MintPlan, issuerSecret: Uint8Array, reserve: Set<number>, expectedRoot?: string, reserveCount = 500): MintPlan {
  verifyPlan(plan, reserve, expectedRoot, reserveCount);
  const signed: MintPlan = { ...plan, reveals: plan.reveals.map((reveal) => ({ ...reveal })), signed: true };
  signed.fanout = { ...plan.fanout };
  signed.fanout.raw = Buffer.from(signInput(
    issuerSecret,
    bytes(plan.fanout.raw),
    bytes(plan.fanout.leaf),
    bytes(plan.fanout.control),
    BigInt(plan.fanout.spentValue),
    bytes(plan.fanout.spentScript),
  )).toString("hex");
  signed.reveals = plan.reveals.map((reveal) => ({
    ...reveal,
    raw: Buffer.from(signInput(
      issuerSecret,
      bytes(reveal.raw),
      bytes(reveal.leaf),
      bytes(reveal.control),
      BigInt(reveal.commitValue),
      bytes(reveal.spentScript),
    )).toString("hex"),
  }));
  return signed;
}
