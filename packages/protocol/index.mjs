// SPDX-License-Identifier: Apache-2.0

/**
 * Protocol core boundary.
 *
 * The public name is P2MR Inscriptions. The marker is the 4 bytes `pins`
 * (70 69 6e 73), specified in docs/specs/PINS-1.md. This module is configuration
 * only. It must not emit witness bytes.
 */

/** On-chain marker. Exactly the 4 ASCII bytes `pins`. The inscriber writes this value. This module does not. */
export const PROTOCOL_TAG = "pins";

/** Public name of the protocol. Not a Qbit consensus name. */
export const PROTOCOL_NAME = "P2MR Inscriptions";

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

/** Marketplace finality. A sale is final after this many confirmations. */
export const CONFIRMATIONS_FINAL = 6;

/**
 * The protocol repository is https://github.com/P2MR-Inscriptions/pins.
 * That URL is not a constant here, and it is not a collection account.
 */

/**
 * @param {string} feature
 */
export function notImplemented(feature) {
  throw new Error(`not_implemented:${feature}`);
}
