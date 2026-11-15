// SPDX-License-Identifier: Apache-2.0

/**
 * Serialized size of a PINS reveal. Weight equals this size because
 * WITNESS_SCALE_FACTOR is 1. The signature is the 3,680-byte SIGHASH_DEFAULT
 * encoding, and the control block is the 33-byte depth-1 block.
 */
import { p2mrScriptPubKey, type P2mrTransaction } from "@qbit-oss/protocol";
import { compactSizeLength } from "./compact.ts";
import { rawWitnessTransaction, revealWitness } from "./reveal.ts";

export const STANDARD_WEIGHT = 400_000;
const SIGNATURE = new Uint8Array(3680);
const CONTROL = Uint8Array.of(0xc1, ...new Uint8Array(32));
const SCRIPT = p2mrScriptPubKey(new Uint8Array(32).fill(2));

function varInt(value: number): number {
  return compactSizeLength(value);
}

/**
 * Byte length of a one-input reveal: `outputCount` postage outputs, an
 * optional change output, and a leaf script of `leafLength` bytes.
 */
export function revealWeight(leafLength: number, outputCount: number, change = true): number {
  const outputs = outputCount + (change ? 1 : 0);
  // version, marker, flag, one input (32+4+1+4), witness item count,
  // 3-byte signature length, 3680-byte signature, 33-byte control and its
  // length byte, locktime.
  const fixed = 4 + 2 + 1 + 41 + 1 + 3 + 3680 + 1 + 33 + 4;
  return fixed + varInt(outputs) + 43 * outputs + varInt(leafLength) + leafLength;
}

/** Same bytes the runner broadcasts, for a leaf of exactly `leafLength` bytes. */
export function revealSerialized(leafLength: number, outputCount: number, change = true): Uint8Array {
  const outputs = Array.from({ length: outputCount }, () => ({ value: 10_000n, scriptPubKey: SCRIPT }));
  if (change) outputs.push({ value: 1_000n, scriptPubKey: SCRIPT });
  const tx: P2mrTransaction = {
    version: 2,
    locktime: 0,
    inputs: [{ prevout: { txid: new Uint8Array(32), vout: 0 }, sequence: 0xfffffffe }],
    outputs,
  };
  return rawWitnessTransaction(tx, [revealWitness(SIGNATURE, new Uint8Array(leafLength), CONTROL)]);
}

export type Batch = { start: number; count: number; weight: number };

/** Pack envelope lengths in order. Each batch stays at or under `limit`. */
export function packEnvelopes(envelopeLengths: number[], limit = STANDARD_WEIGHT): Batch[] {
  const batches: Batch[] = [];
  let start = 0;
  let count = 0;
  let envelopeSum = 0;
  const flush = () => {
    if (count === 0) return;
    batches.push({ start, count, weight: revealWeight(34 + envelopeSum, count) });
    start += count;
    count = 0;
    envelopeSum = 0;
  };
  for (const length of envelopeLengths) {
    const nextWeight = revealWeight(34 + envelopeSum + length, count + 1);
    if (count > 0 && nextWeight > limit) flush();
    envelopeSum += length;
    count += 1;
    if (revealWeight(34 + envelopeSum, count) > limit) {
      throw new Error(`one item exceeds the standard weight limit (${length} byte envelope)`);
    }
  }
  flush();
  return batches;
}
