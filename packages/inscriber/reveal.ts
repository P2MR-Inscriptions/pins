// SPDX-License-Identifier: Apache-2.0

/**
 * Build a PINS reveal leaf and the P2MR commit that spends it.
 * Signing and broadcast stay with the regtest runner. This module does not
 * open a socket and does not accept a network name other than the types the
 * caller already chose.
 */
import {
  P2MR_LEAF_VERSION_V1,
  buildControlBlock,
  p2mrBranchHash,
  p2mrLeafHash,
  type P2mrTransaction,
} from "@qbit-oss/protocol";
import { writeCompactSize } from "./compact.ts";
import { buildEnvelope, concatBytes, contentTypeField, metadataField, pointerField, POSTAGE, revealLeaf, recoveryLeaf, type EnvelopeField } from "./script.ts";

export type RevealItem = {
  body: Uint8Array;
  contentType: string;
  metadata?: Uint8Array;
  /** When set, replaces the default pointer of index * postage. */
  pointer?: bigint | null;
};

export type CommitTree = {
  revealScript: Uint8Array;
  recoveryScript: Uint8Array;
  revealLeafHash: Uint8Array;
  recoveryLeafHash: Uint8Array;
  revealControl: Uint8Array;
  recoveryControl: Uint8Array;
  root: Uint8Array;
};

/** Two-leaf tree: the reveal and a recovery leaf that publishes no envelope. */
export function commitTree(revealScript: Uint8Array, recoveryScript: Uint8Array): CommitTree {
  const revealLeafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, revealScript);
  const recoveryLeafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, recoveryScript);
  return {
    revealScript,
    recoveryScript,
    revealLeafHash,
    recoveryLeafHash,
    revealControl: buildControlBlock(P2MR_LEAF_VERSION_V1, [recoveryLeafHash]),
    recoveryControl: buildControlBlock(P2MR_LEAF_VERSION_V1, [revealLeafHash]),
    root: p2mrBranchHash(revealLeafHash, recoveryLeafHash),
  };
}

export function itemEnvelope(item: RevealItem, index: number, postage = POSTAGE, minimal = true, marker?: Uint8Array): Uint8Array {
  const fields: EnvelopeField[] = [contentTypeField(item.contentType)];
  const pointer = item.pointer === undefined ? BigInt(index) * postage : item.pointer;
  if (pointer !== null && pointer > 0n) fields.push(pointerField(pointer));
  if (item.metadata) fields.push(metadataField(item.metadata));
  return buildEnvelope(fields, item.body, minimal, marker);
}

export function itemsLeaf(pubkey: Uint8Array, items: RevealItem[], postage = POSTAGE, minimal = true, marker?: Uint8Array): Uint8Array {
  return revealLeaf(
    pubkey,
    items.map((item, index) => itemEnvelope(item, index, postage, minimal, marker)),
  );
}

export function recoveryFor(pubkey: Uint8Array): Uint8Array {
  return recoveryLeaf(pubkey);
}

/** Witness order is signature, leaf script, control block. The signature is the initial stack. */
export function revealWitness(signature: Uint8Array, script: Uint8Array, control: Uint8Array): Uint8Array[] {
  return [signature, script, control];
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function i64(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, value, true);
  return out;
}

function varBytes(data: Uint8Array): Uint8Array {
  return concatBytes([writeCompactSize(data.length), data]);
}

/**
 * BIP144 witness transaction. A transaction whose witnesses are all empty must
 * use the legacy serialization. Core rejects a marker-and-flag wrapper when no
 * input has a witness. Weight equals the serialized size because WSF is 1.
 */
export function rawWitnessTransaction(tx: P2mrTransaction, witnesses: Uint8Array[][]): Uint8Array {
  const anyWitness = witnesses.some((stack) => stack.length > 0);
  const parts: Uint8Array[] = [u32(tx.version)];
  if (anyWitness) parts.push(Uint8Array.of(0x00, 0x01));
  parts.push(writeCompactSize(tx.inputs.length));
  for (const input of tx.inputs) {
    parts.push(input.prevout.txid, u32(input.prevout.vout), writeCompactSize(0), u32(input.sequence));
  }
  parts.push(writeCompactSize(tx.outputs.length));
  for (const output of tx.outputs) parts.push(i64(output.value), varBytes(output.scriptPubKey));
  if (anyWitness) {
    for (const stack of witnesses) {
      parts.push(writeCompactSize(stack.length));
      for (const item of stack) parts.push(varBytes(item));
    }
  }
  parts.push(u32(tx.locktime));
  return concatBytes(parts);
}

export { POSTAGE };
