// SPDX-License-Identifier: Apache-2.0

/**
 * Price P2MR Inscription schema.
 *
 * A price is optional. It belongs to a collection that declares a sale, and it is how that sale opens
 * (PINS-6 §5.1). A collection with no sale has none. This module holds no price, no price source and
 * no time: those three fields come from the file the operator gives to `price --price`, and nothing
 * here computes or checks them beyond their form (`parsePrice`).
 *
 * PINS-6 §5.1 fixes the launch text. The body is that text plus one newline,
 * and field 5 `schema` is the same text. Mainnet bytes use it and nothing else.
 *
 * A rehearsal masks it the way it already masks the collection schema. The
 * operator sets one schema (`c/1` in rehearsal.json, `--schema` on the indexer
 * and on `inscribe price`). The launch schema stays `pins-price/1`. Any other
 * schema derives a neutral stand-in: the version tail is kept and the rest is
 * replaced, so `c/1` becomes `p/1`. The derived text is what both the inscriber
 * and the indexer recognize. It does not copy the launch token.
 */
export const LAUNCH_COLLECTION_SCHEMA = "pins-collection/1";

/** Body text and field-5 schema of a mainnet price P2MR Inscription. PINS-6 §5.1. */
export const LAUNCH_PRICE_SCHEMA = "pins-price/1";

/**
 * Price schema that belongs with a collection schema.
 * The launch pair is exact. A rehearsal schema derives `p/<version>`.
 */
export function priceSchemaFor(collectionSchema: string): string {
  if (collectionSchema === LAUNCH_COLLECTION_SCHEMA) return LAUNCH_PRICE_SCHEMA;
  const version = /\/(\d+)$/.exec(collectionSchema);
  // Digits only. The source text is not copied, so a rehearsal schema cannot
  // leak the launch token into the price P2MR Inscription.
  return `p/${version?.[1] ?? "1"}`;
}

/** UTF-8 body: the schema text and one trailing newline. */
export function priceBody(schema: string): Uint8Array {
  return new TextEncoder().encode(`${schema}\n`);
}

/** Launch body. Identical to `pins-price/1` plus a newline. */
export const PRICE_BODY = priceBody(LAUNCH_PRICE_SCHEMA);
