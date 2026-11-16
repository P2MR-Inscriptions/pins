// SPDX-License-Identifier: Apache-2.0
/**
 * Qbit RPC amounts are decimal QBT with exactly 8 places (`ValueFromAmount` in
 * Qbit Core v1.0.1 writes them as JSON numbers). JSON.parse would turn those
 * into IEEE floats, which cannot hold every amount, so the raw decimal text is
 * kept and turned into bits with integer arithmetic only.
 */

export const BITS_PER_QBT = 100_000_000n;

const AMOUNT = /^(-?)(\d+)\.(\d{8})$/;

/** JSON keys Qbit Core writes as 8-decimal amounts. */
const AMOUNT_KEY = /"(?:value|amount|fee|total_amount|totalfee)"/;
const QUOTE_AMOUNT = /("(value|amount|fee|total_amount|totalfee)"\s*:\s*)(-?\d+\.\d{8})(?=\s*[,}\]])/g;

/**
 * Parse a Qbit RPC amount into bits. Prefers the 8-decimal text
 * (`"1.23456789"`). A JSON number is accepted only when it is the unique
 * 8-decimal amount that number already represents; bits are never taken from
 * a rounded float product.
 */
export function bitsFromRpcAmount(value: unknown): bigint {
  if (typeof value === "string") {
    const match = AMOUNT.exec(value.trim());
    if (!match) throw new Error(`RPC amount is not an 8-decimal quantity: ${value}`);
    const bits = BigInt(match[2]) * BITS_PER_QBT + BigInt(match[3]);
    return match[1] === "-" ? -bits : bits;
  }
  if (typeof value === "number") return bitsFromRpcNumber(value);
  throw new Error("RPC amount must be the decimal text, not a JSON number");
}

/**
 * Recover the unique 8-decimal amount a JSON number already is. The nearby
 * 8-decimal texts are checked with integer formatting; the bits come from that
 * text, not from `amount * 1e8`.
 */
function bitsFromRpcNumber(value: number): bigint {
  if (!Number.isFinite(value)) throw new Error("RPC amount must be the decimal text, not a JSON number");
  const sign = value < 0 ? -1n : 1n;
  const abs = value < 0 ? -value : value;
  const approx = Math.round(abs * Number(BITS_PER_QBT));
  if (!Number.isSafeInteger(approx)) throw new Error("RPC amount must be the decimal text, not a JSON number");
  const found: bigint[] = [];
  const center = BigInt(approx);
  for (let delta = -2n; delta <= 2n; delta++) {
    const bits = center + delta;
    if (bits >= 0n && Number(rpcAmountFromBits(bits)) === abs) found.push(bits);
  }
  if (found.length !== 1) throw new Error("RPC amount must be the decimal text, not a JSON number");
  return sign * found[0];
}

/** The 8-decimal text Qbit Core writes for `bits` (the inverse of `bitsFromRpcAmount`). */
export function rpcAmountFromBits(bits: bigint): string {
  const sign = bits < 0n ? "-" : "";
  const abs = bits < 0n ? -bits : bits;
  const whole = abs / BITS_PER_QBT;
  const frac = abs % BITS_PER_QBT;
  return `${sign}${whole}.${frac.toString().padStart(8, "0")}`;
}

/**
 * Quote each 8-decimal amount field in a JSON body so JSON.parse keeps the
 * text. Qbit Core always writes amounts as `%d.%08d`.
 */
export function quoteRpcAmounts(text: string): string {
  if (!AMOUNT_KEY.test(text)) return text;
  return text.replace(QUOTE_AMOUNT, "$1\"$3\"");
}
