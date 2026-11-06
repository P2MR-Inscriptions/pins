// SPDX-License-Identifier: Apache-2.0

/**
 * Creator reserve and sale order for P2MR Inscriptions (PINS-5 §8).
 * The launch secret is never created here. RESERVE_TEST_SEED is a dummy.
 */
import { createHash } from "node:crypto";
import { RESERVE_DOMAIN, SALE_DOMAIN } from "./index.mjs";

/** 32 ASCII bytes. A test vector only. Not the launch secret. */
export const RESERVE_TEST_SEED = Buffer.from("PINS RESERVE TEST SEED!!NOT REAL", "ascii");

function assertSeed(seed) {
  if (!Buffer.isBuffer(seed) || seed.length !== 32) throw new Error("seed must be 32 bytes");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest();
}

/** SHA-256(seed || 0x01 || uint32be(n)). */
export function reserveRank(seed, n) {
  assertSeed(seed);
  if (!Number.isInteger(n) || n < 1) throw new Error("item number must be a positive integer");
  const preimage = Buffer.alloc(37);
  seed.copy(preimage, 0);
  preimage[32] = RESERVE_DOMAIN;
  preimage.writeUInt32BE(n, 33);
  return sha256(preimage);
}

function byRank(seed, ranks) {
  return (left, right) => {
    const order = Buffer.compare(ranks.get(left.id), ranks.get(right.id));
    if (order !== 0) return order;
    return left.id - right.id;
  };
}

function hasTrait(piece, group) {
  return piece.attributes.some((row) => row.trait_type === group.trait_type && row.value === group.value);
}

/**
 * @param {{ id: number, attributes: { trait_type: string, value: string }[] }[]} pieces
 * @param {Buffer} seed 32-byte secret. Genesis commits SHA-256 of these bytes.
 * @param {{ groups?: readonly { trait_type: string, value: string, count: number }[], extra?: number }} [options]
 */
export function selectReserve(pieces, seed, options = {}) {
  assertSeed(seed);
  if (!options.groups || options.extra === undefined) throw new Error("collection profile reserve groups are required");
  const groups = options.groups;
  const extraCount = options.extra;
  const ranks = new Map(pieces.map((piece) => [piece.id, reserveRank(seed, piece.id)]));
  const chosen = new Set();
  const byGroup = [];
  for (const group of groups) {
    const eligible = pieces.filter((piece) => !chosen.has(piece.id) && hasTrait(piece, group));
    eligible.sort(byRank(seed, ranks));
    if (eligible.length < group.count) {
      throw new Error(`Quota ${group.trait_type}=${group.value} needs ${group.count}, found ${eligible.length}.`);
    }
    const ids = eligible.slice(0, group.count).map((piece) => piece.id);
    for (const id of ids) chosen.add(id);
    byGroup.push({ trait_type: group.trait_type, value: group.value, count: group.count, ids });
  }
  const rest = pieces.filter((piece) => !chosen.has(piece.id)).sort(byRank(seed, ranks));
  if (rest.length < extraCount) throw new Error(`Need ${extraCount} extra pieces, found ${rest.length}.`);
  const extra = rest.slice(0, extraCount).map((piece) => piece.id);
  for (const id of extra) chosen.add(id);
  const sale = pieces
    .map((piece) => piece.id)
    .filter((id) => !chosen.has(id))
    .sort((left, right) => left - right);
  return { byGroup, extra, reserve: [...chosen], sale };
}

/** SHA-256(secret || blockHash). Block hash is 32 bytes in internal order. */
export function saleSeed(secret, blockHash) {
  assertSeed(secret);
  if (!Buffer.isBuffer(blockHash) || blockHash.length !== 32) throw new Error("block hash must be 32 bytes");
  return sha256(Buffer.concat([secret, blockHash]));
}

/**
 * PINS-5 §8.4 over the sale ids. Draw preimage is saleSeed || 0x02 || uint32be(counter).
 * @param {number[]} ids
 * @param {Buffer} mixedSeed
 */
export function saleOrder(ids, mixedSeed) {
  assertSeed(mixedSeed);
  const order = [...ids].sort((left, right) => left - right);
  let counter = 0;
  const draw = () => {
    const preimage = Buffer.alloc(37);
    mixedSeed.copy(preimage, 0);
    preimage[32] = SALE_DOMAIN;
    preimage.writeUInt32BE(counter, 33);
    counter += 1;
    return sha256(preimage).readBigUInt64BE(0);
  };
  for (let i = order.length - 1; i >= 1; i -= 1) {
    const modulus = BigInt(i + 1);
    const limit = (1n << 64n) - ((1n << 64n) % modulus);
    let sample = draw();
    while (sample >= limit) sample = draw();
    const j = Number(sample % modulus);
    const swap = order[i];
    order[i] = order[j];
    order[j] = swap;
  }
  return order;
}
