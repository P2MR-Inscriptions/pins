// SPDX-License-Identifier: Apache-2.0

/**
 * Checks for a PSBT trade, PINS-6 (Draft) section 4.1 and section 4.4.
 *
 * This module only reads. It never signs, never talks to a node or an indexer, and it
 * is not a consensus rule: the indexer decides ownership by FIFO (PINS-3 section 3)
 * whatever these checks say. They exist so that a builder refuses to make a bad trade
 * and a buyer can refuse to sign one.
 *
 * `fifoLanding` repeats the placement rule of the indexer (`Indexer.place` in
 * `packages/indexer/pins.ts`) for one bit. A test runs both on the same transactions
 * and requires the same answer.
 */
import {
  decodePsbt,
  isRestrictedOutputModeOutput,
  parsePsbt,
  psbtUnsignedTransaction,
  type P2mrTransactionOutput,
  type Psbt,
} from "@qbit-oss/protocol";
import { isP2mr } from "../indexer/address.ts";

/** Dust threshold of a P2MR output in bits (PINS-1 F14, PINS-3 section 5). */
export const DUST_BITS = 2_855n;

/** `PSBT_IN_SIGHASH_TYPE` value of the seller listing: SIGHASH_SINGLE | SIGHASH_ANYONECANPAY. */
export const SELLER_SIGHASH_TYPE = 0x83;

/** `SIGHASH_DEFAULT`, what a buyer input must require. */
const SIGHASH_DEFAULT = 0;
const OP_RETURN = 0x6a;
/** PayToAnchor, `OP_1 <0x4e73>` (PINS-3 section 7). */
const PAY_TO_ANCHOR = Uint8Array.of(0x51, 0x02, 0x4e, 0x73);

export type SaleProblem = {
  /** Stable short name, for a program to branch on. */
  code: string;
  /** One sentence for a person. */
  message: string;
};

/** Where one bit of the input space ends up (PINS-3 section 3). */
export type FifoLanding =
  | { kind: "output"; output: number; offset: bigint }
  | { kind: "burned"; output: number; offset: bigint }
  | { kind: "fee"; offset: bigint }
  | { kind: "unbound" };

/**
 * FIFO for one bit. `position` counts bits from the start of the input space, so an
 * input starts where the inputs before it end. A bit past the inputs is `unbound`, a bit
 * past the outputs is paid as fee, a bit in an `OP_RETURN` output is `burned`.
 */
export function fifoLanding(
  inputValues: readonly bigint[],
  outputs: readonly P2mrTransactionOutput[],
  position: bigint,
): FifoLanding {
  if (position < 0n) throw new RangeError("position must not be negative");
  const inputTotal = inputValues.reduce((sum, value) => sum + value, 0n);
  const outputTotal = outputs.reduce((sum, output) => sum + output.value, 0n);
  if (position >= inputTotal) return { kind: "unbound" };
  if (position >= outputTotal) return { kind: "fee", offset: position - outputTotal };
  let covered = 0n;
  for (let output = 0; output < outputs.length; output += 1) {
    const { value, scriptPubKey } = outputs[output];
    if (position < covered + value) {
      const offset = position - covered;
      if (scriptPubKey.length > 0 && scriptPubKey[0] === OP_RETURN) return { kind: "burned", output, offset };
      return { kind: "output", output, offset };
    }
    covered += value;
  }
  return { kind: "unbound" };
}

function describe(landing: FifoLanding): string {
  switch (landing.kind) {
    case "output":
      return `output ${landing.output} at offset ${landing.offset}`;
    case "burned":
      return `the OP_RETURN output ${landing.output} (burned)`;
    case "fee":
      return "the fee (lost to the miner)";
    default:
      return "no output (the bit is past the inputs)";
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** Display-order hex of an internal-order txid, the form the indexer API uses. */
function displayTxid(txid: Uint8Array): string {
  return Buffer.from(txid).reverse().toString("hex");
}

function isAnchor(script: Uint8Array): boolean {
  return sameBytes(script, PAY_TO_ANCHOR);
}

function isOpReturn(script: Uint8Array): boolean {
  return script.length > 0 && script[0] === OP_RETURN;
}

export type PurchaseOptions = {
  /** Index of the seller input `U`. Default 2 (clean template, PINS-6 section 4.1). */
  sellerInput?: number;
  /** Index of the output that must receive the P2MR Inscription. Default 1 (clean template). */
  receiveOutput?: number;
  /**
   * Offset of the P2MR Inscription's bit inside `U`. Default 0 (PINS-6 section 4.4 item 1).
   */
  bitOffset?: bigint;
  /** Offset the bit must have inside the receive output. Default 0 (compact template: the padding `a`). */
  landingOffset?: bigint;
  /** The script the buyer chose. When given, the receive output must pay exactly this script. */
  expectedReceiveScript?: Uint8Array;
  /** Scripts that hold the unsold items (PINS-6 section 4.3). The receive output must not pay one. */
  holdingScripts?: readonly Uint8Array[];
  /** The value the seller payment output must have, when the listing fixes it. */
  expectedSellerPayment?: bigint;
  /**
   * What an indexer holds at an output: the offsets of the P2MR Inscription bits in it.
   * Return `undefined` when the indexer does not know the output. With it the check
   * covers PINS-6 section 4.4 items 1 and 3. Without it those two items are reported
   * in `notChecked`. Take the offsets from `location.offset` of the rows of
   * `GET /output/{txid}:{vout}` (docs/indexer/API.md).
   */
  heldAt?: (txid: string, vout: number) => readonly bigint[] | undefined;
  /** Make a receive value different from the value of `U` a problem instead of a warning. */
  strict?: boolean;
  /** Names for the outputs, used in messages. Default `output N`. */
  outputNames?: readonly string[];
};

export type PurchaseReport = {
  /** True when `problems` is empty. */
  ok: boolean;
  /** Reasons not to sign. */
  problems: SaleProblem[];
  /** Things to look at that are not by themselves a reason to refuse. */
  warnings: SaleProblem[];
  /** Checks that were skipped because the options did not give what they need. */
  notChecked: string[];
  /** Inputs minus outputs in bits, or null when the PSBT could not be read to the end. */
  fee: bigint | null;
  /** Where the bit of `U` lands, or null when it could not be computed. */
  landing: FifoLanding | null;
};

/** Thrown by `assertPurchasePsbt`. `report` has every problem. */
export class PurchaseCheckError extends Error {
  readonly report: PurchaseReport;
  constructor(report: PurchaseReport) {
    super(`the PSBT trade is not safe to sign: ${report.problems.map((problem) => problem.message).join("; ")}`);
    this.name = "PurchaseCheckError";
    this.report = report;
  }
}

/** A hostile PSBT is read with these limits (far above a clean trade, about 15 kB). */
const PARSE_LIMITS = { maxBytes: 1_000_000, maxObjects: 10_000 };

function assertIndex(value: number | undefined, label: string): asserts value is number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a whole number from 0`);
}

/**
 * The buyer-side checks of PINS-6 section 4.4, and the numbers of section 4.1, on one PSBT.
 * `psbt` is a parsed PSBT or its bytes. Bytes are parsed with a size limit.
 *
 * It checks, in this order of importance:
 * - the bit of `U` lands, by FIFO, in the receive output (and not in the fee, a burn or
 *   another output), at the expected offset;
 * - the receive output is P2MR, is not a holding script, and is the buyer's script when given;
 * - every output is P2MR, `OP_RETURN` or PayToAnchor, and no P2MR output is dust;
 * - the outputs do not exceed the inputs (fee at least 0), every input has its witness UTXO;
 * - the seller input requires `0x83` and has an output at its own index, and every
 *   other input requires the default sighash, so the buyer's signature covers every output;
 * - no two inputs spend the same output;
 * - with `heldAt`: `U` holds the P2MR Inscription at the offset and every other input holds none.
 *
 * Amounts and scripts of the inputs are read from the PSBT. Compare them with a node before
 * you sign: a PSBT can state an amount that the chain does not hold.
 */
export function checkPurchasePsbt(psbt: Psbt | Uint8Array, options: PurchaseOptions = {}): PurchaseReport {
  const sellerInput = options.sellerInput ?? 2;
  const receiveOutput = options.receiveOutput ?? 1;
  const bitOffset = options.bitOffset ?? 0n;
  const landingOffset = options.landingOffset ?? 0n;
  assertIndex(sellerInput, "sellerInput");
  assertIndex(receiveOutput, "receiveOutput");
  if (bitOffset < 0n || landingOffset < 0n) throw new RangeError("offsets must not be negative");

  const problems: SaleProblem[] = [];
  const warnings: SaleProblem[] = [];
  const notChecked: string[] = [];
  const problem = (code: string, message: string) => problems.push({ code, message });
  const warn = (code: string, message: string) => warnings.push({ code, message });
  const name = (index: number) => options.outputNames?.[index] ?? `output ${index}`;
  const finish = (fee: bigint | null, landing: FifoLanding | null): PurchaseReport => ({
    ok: problems.length === 0,
    problems,
    warnings,
    notChecked,
    fee,
    landing,
  });

  let parsed: Psbt;
  let tx: ReturnType<typeof psbtUnsignedTransaction>;
  try {
    parsed = psbt instanceof Uint8Array ? parsePsbt(psbt, PARSE_LIMITS) : psbt;
    tx = psbtUnsignedTransaction(parsed);
  } catch (error) {
    problem("unreadable", `the PSBT cannot be read: ${(error as Error).message}`);
    return finish(null, null);
  }

  if (sellerInput >= tx.inputs.length) {
    problem("seller-input", `there is no input ${sellerInput} for the seller (the PSBT has ${tx.inputs.length} inputs)`);
    return finish(null, null);
  }
  if (receiveOutput >= tx.outputs.length) {
    problem("receive-output", `there is no output ${receiveOutput} to receive the P2MR Inscription (the PSBT has ${tx.outputs.length} outputs)`);
    return finish(null, null);
  }

  const seen = new Set<string>();
  tx.inputs.forEach((input, index) => {
    const key = `${displayTxid(input.prevout.txid)}:${input.prevout.vout}`;
    if (seen.has(key)) problem("duplicate-input", `input ${index} spends ${key}, which an earlier input already spends`);
    seen.add(key);
  });

  let summary: ReturnType<typeof decodePsbt>;
  try {
    summary = decodePsbt(parsed);
  } catch (error) {
    const code = (error as { code?: string }).code === "INVALID_AMOUNT" ? "amounts" : "unreadable";
    problem(code, `the PSBT cannot be checked: ${(error as Error).message}`);
    return finish(null, null);
  }

  const inputValues: bigint[] = [];
  let everyUtxo = true;
  summary.inputs.forEach((input, index) => {
    if (!input.witnessUtxo) {
      everyUtxo = false;
      problem("missing-utxo", `input ${index} has no witness UTXO, so its amount cannot be checked`);
      return;
    }
    inputValues.push(input.witnessUtxo.value);
  });
  if (summary.fee !== undefined && summary.fee < 0n) problem("fee", "the outputs exceed the inputs (fee below 0)");
  const fee = summary.fee ?? null;

  // Sighash: the seller's listing is 0x83, nothing else may require anything but the default.
  summary.inputs.forEach((input, index) => {
    const type = input.sighashType ?? SIGHASH_DEFAULT;
    if (index === sellerInput) {
      if (type !== SELLER_SIGHASH_TYPE) {
        problem("seller-sighash", `input ${index} (the seller) requires sighash 0x${type.toString(16)}, the listing must be 0x83`);
      }
      if (sellerInput >= tx.outputs.length) {
        problem("seller-output", `the seller signs 0x83 and commits to the output at its own index, but there is no output ${index}`);
      }
    } else if (type !== SIGHASH_DEFAULT) {
      problem("buyer-sighash", `input ${index} requires sighash 0x${type.toString(16)}, so a buyer signature on it would not commit to every output`);
    }
  });

  // Outputs: shape and dust.
  tx.outputs.forEach((output, index) => {
    const script = output.scriptPubKey;
    if (isOpReturn(script)) {
      if (!isRestrictedOutputModeOutput(script)) problem("output-script", `${name(index)} is an OP_RETURN that restricted-output mode does not allow`);
      return;
    }
    if (isAnchor(script)) return;
    if (!isP2mr(script) || !isRestrictedOutputModeOutput(script)) {
      problem("output-script", `${name(index)} is not P2MR, OP_RETURN or PayToAnchor`);
      return;
    }
    if (output.value < DUST_BITS) problem("dust", `${name(index)} is ${output.value} bits, below the dust threshold of ${DUST_BITS} bits`);
  });

  // Seller payment.
  const paymentIndex = sellerInput;
  if (options.expectedSellerPayment !== undefined && paymentIndex < tx.outputs.length) {
    const paid = tx.outputs[paymentIndex].value;
    if (paid !== options.expectedSellerPayment) {
      problem("seller-payment", `${name(paymentIndex)} pays the seller ${paid} bits, the listing says ${options.expectedSellerPayment}`);
    }
  }

  // The receive output.
  const receive = tx.outputs[receiveOutput];
  if (!isP2mr(receive.scriptPubKey)) {
    problem("receive-script", `${name(receiveOutput)} is not a P2MR output, so it cannot receive a P2MR Inscription (PINS-6 section 4.3)`);
  }
  if (options.expectedReceiveScript && !sameBytes(receive.scriptPubKey, options.expectedReceiveScript)) {
    problem("receive-script", `${name(receiveOutput)} does not pay the script the buyer chose`);
  }
  for (const holding of options.holdingScripts ?? []) {
    if (sameBytes(receive.scriptPubKey, holding)) {
      problem("receive-holding", `${name(receiveOutput)} pays the sale holding address that holds the unsold items (PINS-6 section 4.3)`);
      break;
    }
  }

  // FIFO of the bit.
  let landing: FifoLanding | null = null;
  if (everyUtxo) {
    const seller = inputValues[sellerInput];
    if (bitOffset >= seller) {
      problem("seller-input", `the bit offset ${bitOffset} is outside input ${sellerInput}, which holds ${seller} bits`);
    } else {
      const start = inputValues.slice(0, sellerInput).reduce((sum, value) => sum + value, 0n);
      landing = fifoLanding(inputValues, tx.outputs, start + bitOffset);
      if (landing.kind !== "output" || landing.output !== receiveOutput) {
        problem("landing", `the bit of the P2MR Inscription lands in ${describe(landing)}, not in ${name(receiveOutput)}`);
      } else if (landing.offset !== landingOffset) {
        problem("landing", `the bit lands at offset ${landing.offset} of ${name(receiveOutput)}, expected offset ${landingOffset}`);
      }
      if (receive.value !== seller) {
        const text = `${name(receiveOutput)} is ${receive.value} bits and the seller output holds ${seller} bits: the value of the P2MR Inscription should travel with it`;
        if (options.strict) problem("receive-value", text);
        else warn("receive-value", text);
      }
    }
  }

  // Indexer facts.
  if (options.heldAt) {
    tx.inputs.forEach((input, index) => {
      const held = options.heldAt!(displayTxid(input.prevout.txid), input.prevout.vout);
      if (held === undefined) {
        notChecked.push(`input ${index}: the indexer does not know ${displayTxid(input.prevout.txid)}:${input.prevout.vout}`);
        return;
      }
      if (index !== sellerInput) {
        if (held.length > 0) problem("buyer-input-inscribed", `input ${index} holds ${held.length} P2MR Inscription(s); padding and funding inputs must be plain (PINS-6 section 4.4 item 3)`);
        return;
      }
      if (!held.includes(bitOffset)) {
        problem("seller-input-empty", `the indexer holds no P2MR Inscription at offset ${bitOffset} of input ${index} (PINS-6 section 4.4 item 1)`);
      }
      const others = held.filter((offset) => offset !== bitOffset);
      if (others.length > 0) {
        const where = everyUtxo
          ? others
              .map((offset) => {
                const start = inputValues.slice(0, sellerInput).reduce((sum, value) => sum + value, 0n);
                return `offset ${offset} lands in ${describe(fifoLanding(inputValues, tx.outputs, start + offset))}`;
              })
              .join("; ")
          : "their landing is unknown";
        warn("seller-input-extra", `input ${index} holds ${others.length} other P2MR Inscription(s) (${where})`);
      }
    });
  } else {
    notChecked.push("PINS-6 section 4.4 items 1 and 3 (the input holds the expected P2MR Inscription, the buyer inputs hold none): no indexer lookup was given");
  }

  return finish(fee, landing);
}

/** The outputs a PSBT spends, in input order, with the txid in display-order hex (what the indexer API takes). */
export function outpointsOf(psbt: Psbt): { txid: string; vout: number }[] {
  return psbtUnsignedTransaction(psbt).inputs.map((input) => ({ txid: displayTxid(input.prevout.txid), vout: input.prevout.vout }));
}

/**
 * The offsets of the P2MR Inscription bits in an output, read from the JSON answer of
 * `GET /output/{txid}:{vout}` of the reference indexer (docs/indexer/API.md). Use it to fill
 * `heldAt`. It keeps the rows that are located (a `location.state` of `located`), and
 * reads `location.offset`, which the API writes as a decimal string. It throws a
 * `TypeError` on an answer that does not have that shape, so a wrong URL or a proxy error
 * page is not read as "the output holds nothing".
 */
export function offsetsFromOutputAnswer(answer: unknown): bigint[] {
  const rows = (answer as { inscriptions?: unknown } | null)?.inscriptions;
  if (!Array.isArray(rows)) throw new TypeError("not an /output answer: it has no `inscriptions` list");
  const offsets: bigint[] = [];
  for (const row of rows) {
    const location = (row as { location?: { state?: unknown; offset?: unknown } | null } | null)?.location;
    if (!location || typeof location.state !== "string") throw new TypeError("not an /output answer: a row has no `location`");
    if (location.state !== "located") continue;
    if (typeof location.offset !== "string" || !/^[0-9]+$/.test(location.offset)) throw new TypeError("not an /output answer: a located row has no decimal `location.offset`");
    offsets.push(BigInt(location.offset));
  }
  return offsets;
}

/** `checkPurchasePsbt`, and throws a `PurchaseCheckError` when there is any problem. */
export function assertPurchasePsbt(psbt: Psbt | Uint8Array, options: PurchaseOptions = {}): PurchaseReport {
  const report = checkPurchasePsbt(psbt, options);
  if (!report.ok) throw new PurchaseCheckError(report);
  return report;
}
