// SPDX-License-Identifier: Apache-2.0

/**
 * Offline signing. This module does not open a socket. It checks the frozen
 * Merkle root, the reveal weights, postage, and the reserve assignment, then
 * signs the fan-out and the reveals with the issuer key.
 */
import { createHash } from "node:crypto";
import { addressToScriptPubKey, p2mrLeafHash, p2mrScriptPubKey, p2mrSighash, verifyControlBlock, P2MR_LEAF_VERSION_V1, SIGHASH_DEFAULT, type P2mrTransaction } from "@qbit-oss/protocol";
import { sign } from "@qbit-oss/pqc";
import { parseTransaction } from "../indexer/chain.ts";
import { commitTree, rawWitnessTransaction, recoveryFor, revealWitness } from "./reveal.ts";
import { isPinsMarker, parseMarker } from "./marker.ts";
import { assertRevealWeight, assertRoot, assertSeparateChange, POSTAGE_BITS } from "./verify.ts";
import type { MintPlan, RevealPlan } from "./plan.ts";

/**
 * Values the operator supplies beside the plan. They are not read from the plan.
 * Copying them out of the plan does not make them independent.
 */
export type SignExpectations = {
  fundingTxid: string;
  fundingVout: number;
  creator: string;
  sale: string;
  change: string;
};

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

function txidOf(raw: Uint8Array): string {
  const hash = createHash("sha256").update(createHash("sha256").update(raw).digest()).digest();
  return Buffer.from(hash).reverse().toString("hex");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

/** The control block must be a valid P2MR path from this leaf to this root. */
function assertControl(name: string, controlHex: string, leaf: Uint8Array, expectedRoot: Uint8Array): void {
  let root: Uint8Array;
  try {
    root = verifyControlBlock(bytes(controlHex), p2mrLeafHash(P2MR_LEAF_VERSION_V1, leaf), P2MR_LEAF_VERSION_V1);
  } catch {
    throw new Error(`${name} control block is not valid for its leaf`);
  }
  if (!sameBytes(root, expectedRoot)) throw new Error(`${name} control block does not match its commitment`);
}

function headerOf(raw: Uint8Array): { version: number; locktime: number } {
  if (raw.length < 10) throw new Error("transaction is truncated");
  const version = new DataView(raw.buffer, raw.byteOffset, 4).getUint32(0, true);
  const locktime = new DataView(raw.buffer, raw.byteOffset + raw.length - 4, 4).getUint32(0, true);
  return { version, locktime };
}

/**
 * Reject a raw transaction that does not match the plan before any signature.
 * Addresses are taken from `plan.creator`, `plan.sale`, and `plan.change`, and
 * from the reserve set. The address strings inside `reveal.outputs` are not trusted.
 * This cannot tell that those three addresses are the ones the operator wanted
 * if the whole plan, JSON and raw together, was replaced.
 * `expected` is the operator's own funding outpoint and three addresses.
 * A whole-plan rewrite fails when those values stay the ones the operator typed.
 */
function assertRaw(plan: MintPlan, reveal: RevealPlan, reserve: Set<number>, fanoutTxid: string, index: number): void {
  const raw = bytes(reveal.raw);
  const header = headerOf(raw);
  if (header.version !== 2 || header.locktime !== 0) throw new Error(`${reveal.name} version or locktime is not the unsigned plan`);
  if (txidOf(raw) !== reveal.txid) throw new Error(`${reveal.name} txid does not match its raw transaction`);
  const parsed = parseTransaction(raw);
  if (parsed.inputs.length !== 1) throw new Error(`${reveal.name} does not spend exactly one output`);
  const input = parsed.inputs[0];
  if (input.prevTxid !== fanoutTxid || input.prevVout !== index || input.sequence !== 0xfffffffe) {
    throw new Error(`${reveal.name} does not spend fan-out output ${index}`);
  }
  if (input.witness.length !== 0) throw new Error(`${reveal.name} unsigned raw already has a witness`);
  if (parsed.outputs.length !== reveal.outputs.length) throw new Error(`${reveal.name} output count does not match the plan`);
  const commitValue = POSTAGE_BITS * BigInt(reveal.outputs.length) + BigInt(reveal.fee);
  if (BigInt(reveal.commitValue) !== commitValue) throw new Error(`${reveal.name} commit value does not match postage and fee`);
  for (let i = 0; i < reveal.outputs.length; i += 1) {
    const meta = reveal.outputs[i];
    const output = parsed.outputs[i];
    if (BigInt(meta.value) !== POSTAGE_BITS || output.value !== POSTAGE_BITS) {
      throw new Error(`${reveal.name} output ${i} postage does not match the plan`);
    }
    const last = i === reveal.outputs.length - 1;
    if (last && meta.item !== null) throw new Error(`${reveal.name} change is not the change address`);
    const expectedAddress = last || meta.item === null
      ? (last ? plan.change : plan.creator)
      : reserve.has(meta.item) ? plan.creator : plan.sale;
    if (!sameBytes(output.script, addressToScriptPubKey(expectedAddress, plan.network))) {
      throw new Error(`${reveal.name} output ${i} is not ${expectedAddress}`);
    }
  }
}

function assertExpectations(plan: MintPlan, expected: SignExpectations): void {
  if (plan.creator !== expected.creator || plan.sale !== expected.sale || plan.change !== expected.change) {
    throw new Error("plan addresses do not match the addresses supplied to sign");
  }
  if (!/^[0-9a-f]{64}$/.test(expected.fundingTxid) || !Number.isInteger(expected.fundingVout) || expected.fundingVout < 0) {
    throw new Error("funding outpoint supplied to sign is not a txid and vout");
  }
  const fanout = parseTransaction(bytes(plan.fanout.raw));
  const input = fanout.inputs[0];
  if (!input || input.prevTxid !== expected.fundingTxid || input.prevVout !== expected.fundingVout) {
    throw new Error("fan-out does not spend the funding outpoint supplied to sign");
  }
}

export function verifyPlan(plan: MintPlan, reserve: Set<number>, expected: SignExpectations, expectedRoot?: string, reserveCount = 500): void {
  assertExpectations(plan, expected);
  const marker = parseMarker(plan.marker);
  if (isPinsMarker(marker)) {
    if (!expectedRoot) throw new Error("a pins plan needs the collection profile root");
    assertRoot(plan.root, expectedRoot);
    if (reserve.size !== reserveCount) throw new Error(`reserve has ${reserve.size} ids, not ${reserveCount}`);
  } else if (expectedRoot && plan.root === expectedRoot) {
    throw new Error("a rehearsal plan must not carry the collection root");
  }
  assertSeparateChange(plan.creator, plan.sale, plan.change);
  const fanRaw = bytes(plan.fanout.raw);
  const fanHeader = headerOf(fanRaw);
  if (fanHeader.version !== 2 || fanHeader.locktime !== 0) throw new Error("fan-out version or locktime is not the unsigned plan");
  const fanoutTxid = txidOf(fanRaw);
  if (fanoutTxid !== plan.fanout.txid) throw new Error("fan-out txid does not match its raw transaction");
  const fundingLeaf = recoveryFor(bytes(plan.issuerPublic));
  const fundingHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, fundingLeaf);
  const fundingScript = p2mrScriptPubKey(fundingHash);
  if (!sameBytes(fundingScript, bytes(plan.fanout.spentScript))) throw new Error("fan-out spent script is not the issuer key");
  if (!sameBytes(fundingLeaf, bytes(plan.fanout.leaf))) throw new Error("fan-out leaf is not the issuer recovery leaf");
  assertControl("fan-out", plan.fanout.control, fundingLeaf, fundingHash);
  const fanout = parseTransaction(fanRaw);
  if (fanout.inputs.length !== 1 || fanout.inputs[0].sequence !== 0xfffffffe || fanout.inputs[0].witness.length !== 0) {
    throw new Error("fan-out input is not the unsigned plan");
  }
  if (fanout.outputs.length !== plan.reveals.length + 1) throw new Error("fan-out output count does not match the reveals");
  let commits = 0n;
  for (let index = 0; index < plan.reveals.length; index += 1) {
    const reveal = plan.reveals[index];
    assertRevealWeight(reveal.weight, reveal.name);
    assertRaw(plan, reveal, reserve, fanoutTxid, index);
    const tree = commitTree(bytes(reveal.leaf), recoveryFor(bytes(plan.recoveryPublic)));
    assertControl(reveal.name, reveal.control, bytes(reveal.leaf), tree.root);
    const commitScript = p2mrScriptPubKey(tree.root);
    if (!sameBytes(fanout.outputs[index].script, commitScript) || fanout.outputs[index].value !== BigInt(reveal.commitValue)) {
      throw new Error(`fan-out output ${index} does not pay ${reveal.name}`);
    }
    commits += BigInt(reveal.commitValue);
  }
  const change = BigInt(plan.fanout.spentValue) - commits - BigInt(plan.fanout.fee);
  const fanChange = fanout.outputs.at(-1);
  const changeScript = addressToScriptPubKey(plan.change, plan.network);
  if (!fanChange || fanChange.value !== change || !sameBytes(fanChange.script, changeScript)) {
    throw new Error("fan-out change is not the change address");
  }
}

/** Returns a signed copy. The caller zeros the secret. */
export function signPlan(plan: MintPlan, issuerSecret: Uint8Array, reserve: Set<number>, expected: SignExpectations, expectedRoot?: string, reserveCount = 500): MintPlan {
  verifyPlan(plan, reserve, expected, expectedRoot, reserveCount);
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
