// SPDX-License-Identifier: Apache-2.0

/**
 * Protocol constants shared by the packages. The marker is the 4 bytes `pins`
 * (70 69 6e 73), specified in docs/specs/PINS-1.md, and the inscriber defines it
 * in `packages/inscriber/marker.ts`. This module is configuration only. It must
 * not emit witness bytes.
 */

/**
 * Reserve quotas are not a protocol default. Pass them from a collection profile
 * into `selectReserve`. A piece matches a row when its metadata has that
 * trait_type and value. This is not a numeric id range.
 */

/** Rank domain for the reserve. Sale draws use a different domain. */
export const RESERVE_DOMAIN = 0x01;

/** Domain byte inside the sale permutation draw. */
export const SALE_DOMAIN = 0x02;

/*
 * Sale terms (length, price) are not constants of this package. PINS-5 §8.5 and PINS-6 §5.1 specify
 * them. A collection's profile and its price inscription carry the values the tools use.
 */

/** Marketplace finality. A sale is final after this many confirmations (PINS-2 §4.3). The one definition: the indexer reads it from here. */
export const CONFIRMATIONS_FINAL = 6;

/**
 * The standards of docs/specs, by id, with the status each one states. A test compares this list with the
 * index and with the status line of every document, so it cannot drift. The indexer reports the ones it
 * implements in `/status`.
 */
export const STANDARDS = Object.freeze([
  Object.freeze({ id: "PINS-1", status: "draft" }),
  Object.freeze({ id: "PINS-2", status: "draft" }),
  Object.freeze({ id: "PINS-3", status: "draft" }),
  Object.freeze({ id: "PINS-4", status: "draft" }),
  Object.freeze({ id: "PINS-5", status: "draft" }),
  Object.freeze({ id: "PINS-6", status: "draft" }),
]);
