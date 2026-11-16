// SPDX-License-Identifier: Apache-2.0

/**
 * Checks for a PSBT trade, PINS-6 section 4.1 and section 4.4.
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
  PQC_SIGNATURE_BYTES,
  PSBT_IN_FINAL_SCRIPTWITNESS,
  decodeP2mrWitnessSignature,
  decodePsbt,
  hexToBytes,
  isRestrictedOutputModeOutput,
  p2mrLeafHash,
  parsePsbt,
  psbtUnsignedTransaction,
  verifyControlBlock,
  type P2mrTransactionOutput,
  type Psbt,
} from "@qbit-oss/protocol";
import { isP2mr } from "../indexer/address.ts";
import { bitsFromRpcAmount } from "../indexer/amount.ts";

/** Dust threshold of a P2MR output in bits (PINS-1 F14, PINS-3 section 5). */
export const DUST_BITS = 2_855n;

/** `PSBT_IN_SIGHASH_TYPE` value of the seller listing: SIGHASH_SINGLE | SIGHASH_ANYONECANPAY. */
export const SELLER_SIGHASH_TYPE = 0x83;

/** `SIGHASH_DEFAULT`, what a buyer input must require. */
const SIGHASH_DEFAULT = 0;
const OP_RETURN = 0x6a;
/** PayToAnchor, `OP_1 <0x4e73>` (PINS-3 section 7). */
const PAY_TO_ANCHOR = Uint8Array.of(0x51, 0x02, 0x4e, 0x73);

/** An unspent output as a node reports it: its amount in bits and its script. */
export type ChainUtxo = { value: bigint; scriptPubKey: Uint8Array };

/** Whole bits of a QBT amount a node printed with eight decimals (1 QBT is 100,000,000 bits). */
export function bitsOf(amount: number | string): bigint {
  let bits: bigint;
  try {
    bits = bitsFromRpcAmount(amount);
  } catch {
    throw new RangeError("an amount must be a finite number of QBT, not negative");
  }
  if (bits < 0n) throw new RangeError("an amount must be a finite number of QBT, not negative");
  return bits;
}

/**
 * The unspent output in the JSON answer of the node's `gettxout <txid> <vout> true` (include the mempool), to fill
 * `utxoAt`. `null`, which the node answers for an output that is spent or that it does not know, gives `undefined`.
 * Anything else that is not `{ value, scriptPubKey: { hex } }` is a `TypeError`, so an error page is never read as a
 * coin.
 */
export function utxoFromGetTxOut(answer: unknown): ChainUtxo | undefined {
  if (answer === null) return undefined;
  const { value, scriptPubKey } = (answer ?? {}) as { value?: unknown; scriptPubKey?: { hex?: unknown } | null };
  const hex = scriptPubKey?.hex;
  if (typeof hex !== "string" || !/^([0-9a-f]{2})+$/.test(hex)) {
    throw new TypeError("not a gettxout answer: it has no QBT `value` and `scriptPubKey.hex`");
  }
  let bits: bigint;
  try {
    bits = bitsFromRpcAmount(value);
  } catch {
    throw new TypeError("not a gettxout answer: it has no QBT `value` and `scriptPubKey.hex`");
  }
  if (bits < 0n) throw new TypeError("not a gettxout answer: it has no QBT `value` and `scriptPubKey.hex`");
  return { value: bits, scriptPubKey: hexToBytes(hex) };
}

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

/**
 * The sighash type a P2MR witness signature carries. A signature of 3680 bytes is `SIGHASH_DEFAULT` (0) and has no
 * type byte; one of 3681 bytes is the 3680-byte signature followed by its type byte, which is never 0x00. Any other
 * length, or a type byte the protocol does not define, throws.
 */
export function sighashTypeOfSignature(item: Uint8Array): number {
  return decodeP2mrWitnessSignature(item).hashType;
}

type InputRecords = Psbt["inputs"][number];

function readCompactSize(bytes: Uint8Array, at: number): { value: number; next: number } {
  const first = bytes[at];
  if (first === undefined) throw new RangeError("the witness is cut short");
  if (first < 0xfd) return { value: first, next: at + 1 };
  const width = first === 0xfd ? 2 : first === 0xfe ? 4 : 0;
  if (width === 0 || at + 1 + width > bytes.length) throw new RangeError("the witness has a length that is not valid");
  let value = 0;
  for (let i = 0; i < width; i += 1) value += bytes[at + 1 + i] * 2 ** (8 * i);
  return { value, next: at + 1 + width };
}

/** The items of an input's final script witness (`PSBT_IN_FINAL_SCRIPTWITNESS`), or null when it has none. Throws when it is malformed. */
function finalWitnessOf(records: InputRecords | undefined): Uint8Array[] | null {
  const record = (records ?? []).find((entry) => entry.key.length === 1 && entry.key[0] === PSBT_IN_FINAL_SCRIPTWITNESS);
  if (!record) return null;
  const bytes = record.value;
  const count = readCompactSize(bytes, 0);
  let at = count.next;
  const items: Uint8Array[] = [];
  for (let index = 0; index < count.value; index += 1) {
    const length = readCompactSize(bytes, at);
    at = length.next;
    if (at + length.value > bytes.length) throw new RangeError("the witness has an item longer than the witness");
    items.push(bytes.subarray(at, at + length.value));
    at += length.value;
  }
  if (at !== bytes.length) throw new RangeError("the witness has bytes after its last item");
  return items;
}

/**
 * The sighash types an input is, or will be, signed with. If the input carries signatures (partial signatures, or the
 * final witness), the type is read from each signature itself, because a wallet that finalizes an input drops its
 * `PSBT_IN_SIGHASH_TYPE` field and the type is then only the last byte of a 3681-byte signature. Without a signature it
 * is the field, or the default when there is none. A field that disagrees with a signature is a problem.
 */
function sighashTypesOf(
  input: ReturnType<typeof decodePsbt>["inputs"][number],
  witness: Uint8Array[] | null,
  index: number,
  problem: (code: string, message: string) => void,
): number[] {
  const signed = new Set<number>(input.scriptSigs.map((entry) => entry.signature.hashType));
  for (const item of witness ?? []) {
    if (item.length !== PQC_SIGNATURE_BYTES && item.length !== PQC_SIGNATURE_BYTES + 1) continue;
    try {
      signed.add(sighashTypeOfSignature(item));
    } catch (error) {
      problem("signature", `input ${index} has a signature that is not valid: ${(error as Error).message}`);
    }
  }
  if (signed.size === 0) return [input.sighashType ?? SIGHASH_DEFAULT];
  const types = [...signed].sort((x, y) => x - y);
  if (input.sighashType !== undefined && types.some((type) => type !== input.sighashType)) {
    problem("sighash-conflict", `input ${index} requires sighash 0x${input.sighashType.toString(16)} but a signature on it uses ${types.map((type) => `0x${type.toString(16)}`).join(", ")}`);
  }
  return types;
}

/**
 * The script of an input must be in the tree of the output it spends: a leaf script of the PSBT (or the last two
 * items of its final witness: the script and the control block) must hash, along the path of its control block, to
 * the Merkle root that is the witness program of the witness UTXO. A PSBT can carry a script that its output does not
 * commit to; no signature on it would ever be spendable.
 */
function checkScript(
  input: ReturnType<typeof decodePsbt>["inputs"][number],
  index: number,
  witness: Uint8Array[] | null,
  problem: (code: string, message: string) => void,
  notChecked: string[],
): void {
  const utxo = input.witnessUtxo;
  if (!utxo) return;
  if (!isP2mr(utxo.scriptPubKey)) {
    problem("input-script", `input ${index} spends an output that is not P2MR, so no P2MR script can be checked against it`);
    return;
  }
  const root = utxo.scriptPubKey.subarray(2);
  if (input.merkleRoot && !sameBytes(input.merkleRoot, root)) {
    problem("script-mismatch", `input ${index} names a Merkle root that is not the program of the output it spends`);
  }
  const candidates = input.leafScripts.map((leaf) => ({ script: leaf.script, controlBlock: leaf.controlBlock, leafVersion: leaf.leafVersion }));
  if (witness && witness.length >= 2) {
    const controlBlock = witness[witness.length - 1];
    candidates.push({ script: witness[witness.length - 2], controlBlock, leafVersion: (controlBlock[0] ?? 0) & 0xfe });
  }
  if (candidates.length === 0) {
    notChecked.push(`input ${index}: the PSBT has no leaf script for it, so its script was not checked against its output`);
    return;
  }
  const matches = candidates.some((candidate) => {
    try {
      return sameBytes(verifyControlBlock(candidate.controlBlock, p2mrLeafHash(candidate.leafVersion, candidate.script), candidate.leafVersion), root);
    } catch {
      return false;
    }
  });
  if (!matches) problem("script-mismatch", `no leaf script of input ${index} hashes, along its control block, to the Merkle root of the output it spends`);
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
   * Return `undefined` when the indexer does not know the output (`known: false` in the
   * answer of `GET /output/{txid}:{vout}`, which `offsetsFromOutputAnswer` turns into
   * `undefined`); an empty list means the indexer knows the output and it holds none. With
   * it the check covers PINS-6 section 4.4 items 1 and 3. Without it, or for an output it
   * does not know, those items are reported in `notChecked` (docs/indexer/API.md).
   */
  heldAt?: (txid: string, vout: number) => readonly bigint[] | undefined;
  /**
   * What a node holds at an output: its amount and script, from `gettxout` (see
   * `utxoFromGetTxOut`). Return `undefined` when the node has no unspent output there. With it
   * every input's witness UTXO must be the unspent output the chain holds, so a PSBT cannot
   * state an amount or a script the chain does not have. Without it that comparison is
   * reported in `notChecked`.
   */
  utxoAt?: (txid: string, vout: number) => ChainUtxo | undefined;
  /**
   * Accept a trade whose checks were not all run (`notChecked` is not empty). Default false:
   * a report with anything in `notChecked` is `ok: false`. Set it only when the caller verifies
   * those facts another way. `complete` stays false, so the skipped checks remain visible.
   */
  allowNotChecked?: boolean;
  /** Make a receive value different from the value of `U` a problem instead of a warning. */
  strict?: boolean;
  /** Names for the outputs, used in messages. Default `output N`. */
  outputNames?: readonly string[];
};

export type PurchaseReport = {
  /** True when `problems` is empty. A skipped check is a problem unless `allowNotChecked` was set. */
  ok: boolean;
  /** True when every check ran: nothing is in `notChecked` and the PSBT was read to the end. */
  complete: boolean;
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
 * - the script of every input is in the tree of the output it spends (the leaf script, along its control
 *   block, hashes to the Merkle root that is the program of the witness UTXO);
 * - with `utxoAt`: every witness UTXO is the unspent output the node holds (amount and script);
 * - with `heldAt`: `U` holds the P2MR Inscription at the offset and every other input holds none.
 *
 * The sighash type of an input is read from its signature when it has one (a 3680-byte signature is the
 * default, a 3681-byte one ends with its type byte), else from `PSBT_IN_SIGHASH_TYPE`.
 *
 * The check fails closed. Amounts and scripts of the inputs are read from the PSBT and a PSBT can state what the
 * chain does not hold, so a trade is `ok` only when `heldAt` and `utxoAt` were given and answered for every
 * input (`complete`). A skipped check is listed in `notChecked` and is a problem (`not-checked`) unless the caller
 * sets `allowNotChecked`.
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
  const finish = (fee: bigint | null, landing: FifoLanding | null, reachedEnd = false): PurchaseReport => {
    if (reachedEnd && notChecked.length > 0 && options.allowNotChecked !== true) {
      problem("not-checked", `checks were skipped, so the trade is not verified: ${notChecked.join("; ")}`);
    }
    return {
      ok: problems.length === 0,
      complete: reachedEnd && notChecked.length === 0,
      problems,
      warnings,
      notChecked,
      fee,
      landing,
    };
  };

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

  // The script of each input against the output it spends, and the node's view of that output.
  const witnesses: (Uint8Array[] | null)[] = [];
  summary.inputs.forEach((input, index) => {
    let witness: Uint8Array[] | null = null;
    try {
      witness = finalWitnessOf(parsed.inputs[index]);
    } catch (error) {
      problem("witness", `input ${index} has a final witness that cannot be read: ${(error as Error).message}`);
    }
    witnesses.push(witness);
    checkScript(input, index, witness, problem, notChecked);
  });
  if (options.utxoAt) {
    tx.inputs.forEach((input, index) => {
      const utxo = summary.inputs[index]?.witnessUtxo;
      if (!utxo) return;
      const txid = displayTxid(input.prevout.txid);
      const chain = options.utxoAt!(txid, input.prevout.vout);
      if (chain === undefined) {
        problem("utxo-missing", `input ${index} spends ${txid}:${input.prevout.vout}, which the node does not hold as an unspent output (spent, unknown or not yet seen)`);
        return;
      }
      if (chain.value !== utxo.value) problem("utxo-amount", `input ${index} states ${utxo.value} bits, the node holds ${chain.value} bits at ${txid}:${input.prevout.vout}`);
      if (!sameBytes(chain.scriptPubKey, utxo.scriptPubKey)) problem("utxo-script", `input ${index} states another script than the node holds at ${txid}:${input.prevout.vout}`);
    });
  } else {
    notChecked.push("the amounts and scripts of the inputs were not compared with a node: no utxoAt lookup was given");
  }

  // Sighash: the seller's listing is 0x83, nothing else may require anything but the default. The type is the one
  // the signature carries (a signed input has no sighash field once a wallet has finalized it), else the PSBT field.
  summary.inputs.forEach((input, index) => {
    const types = sighashTypesOf(input, witnesses[index], index, problem);
    const shown = types.map((type) => `0x${type.toString(16)}`).join(", ");
    if (index === sellerInput) {
      if (types.some((type) => type !== SELLER_SIGHASH_TYPE)) {
        problem("seller-sighash", `input ${index} (the seller) uses sighash ${shown}, the listing must be 0x83`);
      }
      if (sellerInput >= tx.outputs.length) {
        problem("seller-output", `the seller signs 0x83 and commits to the output at its own index, but there is no output ${index}`);
      }
    } else if (types.some((type) => type !== SIGHASH_DEFAULT)) {
      problem("buyer-sighash", `input ${index} uses sighash ${shown}, so a buyer signature on it would not commit to every output`);
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

  return finish(fee, landing, true);
}

/** The outputs a PSBT spends, in input order, with the txid in display-order hex (what the indexer API takes). */
export function outpointsOf(psbt: Psbt): { txid: string; vout: number }[] {
  return psbtUnsignedTransaction(psbt).inputs.map((input) => ({ txid: displayTxid(input.prevout.txid), vout: input.prevout.vout }));
}

/**
 * The offsets of the P2MR Inscription bits in an output, read from the JSON answer of
 * `GET /output/{txid}:{vout}` of the reference indexer (docs/indexer/API.md). Use it to fill
 * `heldAt`. It keeps the rows that are located (a `location.state` of `located`), and
 * reads `location.offset`, which the API writes as a decimal string.
 *
 * It returns `undefined` when the answer says `known: false`: the indexer has no record of
 * the output, which is not the same as an output that holds nothing (that is `[]`). It throws a
 * `TypeError` on an answer that does not have the shape (a wrong URL, a proxy error page, an
 * indexer that does not send `known`), and on a page that does not hold every row (`total` is
 * larger than the rows given), so none of those is read as "the output holds nothing".
 */
export function offsetsFromOutputAnswer(answer: unknown): bigint[] | undefined {
  const body = answer as { known?: unknown; total?: unknown; offset?: unknown; inscriptions?: unknown } | null;
  const rows = body?.inscriptions;
  if (!Array.isArray(rows)) throw new TypeError("not an /output answer: it has no `inscriptions` list");
  if (typeof body?.known !== "boolean") throw new TypeError("not an /output answer: it has no `known` flag");
  if (!body.known) {
    if (rows.length > 0) throw new TypeError("not an /output answer: an unknown output lists rows");
    return undefined;
  }
  if (typeof body.total !== "number" || typeof body.offset !== "number") throw new TypeError("not an /output answer: it has no `total` and `offset`");
  if (body.offset !== 0 || rows.length < body.total) {
    throw new TypeError("the /output answer is one page of a longer list (or starts after its first row); read the whole list with offset=0 and a limit that covers `total` (docs/indexer/API.md)");
  }
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
