// SPDX-License-Identifier: Apache-2.0
/**
 * Qbit RPC amounts are decimal QBT with exactly 8 places (`ValueFromAmount` in
 * Qbit Core v1.0.1 writes them as JSON numbers). JSON.parse would turn those
 * into IEEE floats, which cannot hold every amount, so the raw decimal text is
 * kept and turned into bits with integer arithmetic only.
 */

export const BITS_PER_QBT = 100_000_000n;

const AMOUNT = /^(-?)(\d+)\.(\d{8})$/;

/**
 * Parse a Qbit RPC amount into bits. `value` must be the decimal text
 * (`"1.23456789"`), never a JSON number.
 */
export function bitsFromRpcAmount(value: unknown): bigint {
  if (typeof value !== "string") throw new Error("RPC amount must be the decimal text, not a JSON number");
  const match = AMOUNT.exec(value.trim());
  if (!match) throw new Error(`RPC amount is not an 8-decimal quantity: ${value}`);
  const bits = BigInt(match[2]) * BITS_PER_QBT + BigInt(match[3]);
  return match[1] === "-" ? -bits : bits;
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
 * Quote each 8-decimal `value` field in a JSON body so JSON.parse keeps the
 * text. Qbit Core always writes amounts as `%d.%08d`.
 */
export function quoteRpcAmounts(text: string): string {
  if (!text.includes('"value"')) return text;
  return text.replace(/("value"\s*:\s*)(-?\d+\.\d{8})(?=\s*[,}\]])/g, "$1\"$2\"");
}
