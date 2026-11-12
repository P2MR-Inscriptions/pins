// SPDX-License-Identifier: Apache-2.0

/**
 * Checks that must pass before any issuer signature is produced.
 * The expected Merkle root comes from the collection profile, not from this file.
 */
import { createHash } from "node:crypto";

export const POSTAGE_BITS = 10_000n;
export const MAX_REVEAL_WEIGHT = 400_000;

export function merkleRoot(leaves: Uint8Array[]): string {
  let level: Uint8Array[] = leaves.map((leaf) => Uint8Array.from(leaf));
  if (!level.length) throw new Error("empty merkle tree");
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(createHash("sha256").update(level[i]).update(level[i + 1]).digest());
    }
    level = next;
  }
  return Buffer.from(level[0]).toString("hex");
}

export function leafPreimage(number: number, body: Uint8Array, metadata: Uint8Array): Buffer {
  const preimage = Buffer.alloc(68);
  preimage.writeUInt32BE(number, 0);
  createHash("sha256").update(body).digest().copy(preimage, 4);
  createHash("sha256").update(metadata).digest().copy(preimage, 36);
  return createHash("sha256").update(preimage).digest();
}

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
