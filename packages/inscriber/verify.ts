// SPDX-License-Identifier: Apache-2.0

/**
 * Checks that must pass before any issuer signature is produced.
 * The expected Merkle root comes from the collection profile, not from this file.
 */
export const POSTAGE_BITS = 10_000n;
export const MAX_REVEAL_WEIGHT = 400_000;

// The tree and the leaf are the shared implementation of PINS-5 §5.1. `leafPreimage` keeps its old
// name for the callers of this module. It returns the leaf hash.
export { leafHash as leafPreimage, merkleRoot } from "../protocol/merkle.mjs";

export function assertRoot(root: string, expected: string): void {
  if (root !== expected) throw new Error(`merkle root ${root} is not the collection root`);
}

export function assertRevealWeight(weight: number, name: string): void {
  if (weight > MAX_REVEAL_WEIGHT) throw new Error(`${name} weighs ${weight}, above ${MAX_REVEAL_WEIGHT}`);
}

export function assertPostage(value: bigint, name: string): void {
  if (value !== POSTAGE_BITS) throw new Error(`${name} postage is ${value}, not ${POSTAGE_BITS}`);
}

/** Reserve, sale, and mint change are three addresses. Change is plain QBT. A collection with no sale has no sale address (`null`). */
export function assertSeparateChange(creator: string, sale: string | null, change: string): void {
  if (!change || change === creator || change === sale) throw new Error("mint change must be its own address");
}

/**
 * A holder is an address for the items of a collection with no sale. It is not allowed with a sale, whose items
 * go to the sale address. It is neither the creator nor the change address, so it names a different place.
 */
export function assertHolder(creator: string, sale: string | null, holder: string | undefined, change: string): void {
  if (holder === undefined) return;
  if (sale !== null) throw new Error("a holder is for a collection with no sale; with a sale, the items go to the sale address");
  if (!holder || holder === creator || holder === change) throw new Error("the holder must be its own address, not the creator or the change address");
}

/**
 * `--holder` names where the items of a collection with no sale go, when not to the creator. With a sale the items
 * go to `--sale`, so a holder is refused. A flag with no value is refused.
 */
export function holderFlag(value: string | boolean | undefined, noSale: boolean, command: string): string | undefined {
  if (value === undefined) return undefined;
  if (!noSale) throw new Error(`--holder is for a collection with no sale, so ${command} takes none here; with a sale, the items go to --sale`);
  if (typeof value !== "string" || value.length === 0) throw new Error("missing --holder");
  return value;
}

/** The reserve an assignment carries must be the size the collection profile declares. Repeated ids count once. */
export function assertReserveSize(reserve: readonly number[], declared: number): void {
  const size = new Set(reserve).size;
  if (size !== declared) throw new Error(`the assignment reserves ${size} items, but the collection profile declares ${declared}`);
}
