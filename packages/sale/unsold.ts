// SPDX-License-Identifier: Apache-2.0

/**
 * The unsold transfer of PINS-5 section 8.5: after the sale is closed, the sale items nobody bought move to the
 * committed `unsold_address`. This module builds that transfer as an unsigned PSBT, and reads the commitment from the
 * rows of an indexer. It opens no socket and holds no key. A wallet that holds the sale key signs the PSBT.
 *
 * Shape of a transfer (PINS-3 section 3, first in, first out). Inputs `0 .. n-1` are the n sale items, each an output
 * of the sale address. Input `n` is a plain fee coin that carries no P2MR Inscription. Output `i` pays the unsold
 * address exactly the value of input `i`, for `i < n`, and the last output is the change of the fee coin. The bits of
 * input `i` are the bits `[sum of the first i values, ...)` of the input space, and output `i` takes exactly those, so
 * every P2MR Inscription of item `i` keeps its offset in output `i`. The fee coin comes last, so none of its bits
 * reaches an item output, and the fee is paid out of its bits.
 */
import {
  P2MR_LEAF_VERSION_V1,
  buildControlBlock,
  createP2mrPsbt,
  decodePsbt,
  hexToBytes,
  p2mrLeafHash,
  p2mrScriptPubKey,
  parsePsbt,
  psbtUnsignedTransaction,
  singleKeyLeafScript,
  type Psbt,
} from "@qbit-oss/protocol";
import { parseRecord, saleCommitmentOf, unsoldAddressScript } from "../inscriber/records.ts";
import type { MintNetwork } from "../inscriber/network.ts";
import { DUST_BITS, type SaleProblem } from "./checks.ts";
import { coin, type SaleCoin } from "./psbt.ts";

/**
 * The size of a signed transaction. Weight equals the serialized size on Qbit, because WITNESS_SCALE_FACTOR is 1
 * (`packages/inscriber/weight.ts`), so the fee is the size times the rate. The pieces: version, marker and flag, the
 * counts of inputs and outputs, locktime; for each input 41 bytes and its witness; for each output 43 bytes.
 */
const OVERHEAD_BYTES = 4 + 2 + 4;
const INPUT_BYTES = 41;
const OUTPUT_BYTES = 43;
/** Witness of one single-key input: the item count, the 3,680-byte signature (3-byte length), the 34-byte leaf script and the 1-byte control block, each with its length. */
const INPUT_WITNESS_BYTES = 1 + 3 + 3_680 + 1 + 34 + 1 + 1;
/** Standard transaction weight (PINS-1 F10). */
const STANDARD_WEIGHT = 400_000;

function compactSize(value: number): number {
  return value < 0xfd ? 1 : value <= 0xffff ? 3 : 5;
}

/** The weight of a signed transfer of `items` sale items, with its fee input and its change output. Measured on Qbit Core v1.0.1: 19,037 for 4 items. */
export function unsoldTransferWeight(items: number): number {
  const inputs = items + 1;
  const outputs = items + 1;
  return OVERHEAD_BYTES + compactSize(inputs) + compactSize(outputs) + inputs * (INPUT_BYTES + INPUT_WITNESS_BYTES) + outputs * OUTPUT_BYTES;
}

/** How many sale items one standard transaction moves. Larger sets are split over several transactions. */
export const UNSOLD_MAX_ITEMS = ((): number => {
  let items = 1;
  while (unsoldTransferWeight(items + 1) <= STANDARD_WEIGHT) items += 1;
  return items;
})();

/** The fee of a transfer of `items` sale items at `feeRate` bits per byte of its signed size. */
export function unsoldTransferFee(items: number, feeRate: number): bigint {
  if (!Number.isFinite(feeRate) || feeRate <= 0) throw new Error("fee rate must be a positive finite number");
  return BigInt(Math.ceil(unsoldTransferWeight(items) * feeRate));
}

/** Split `items` into transactions of at most `perTransaction`, in order. */
export function unsoldChunks<T>(items: readonly T[], perTransaction: number): T[][] {
  if (!Number.isInteger(perTransaction) || perTransaction < 1 || perTransaction > UNSOLD_MAX_ITEMS) {
    throw new Error(`a transfer moves 1 to ${UNSOLD_MAX_ITEMS} items per transaction, not ${perTransaction}`);
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += perTransaction) out.push(items.slice(i, i + perTransaction));
  return out;
}

export type UnsoldTransfer = {
  /** The sale items, in the order of the inputs. Each is an output of the sale address. */
  items: readonly SaleCoin[];
  /** The fee coin. It must carry no P2MR Inscription. */
  funding: SaleCoin;
  /** The script of the committed unsold address. */
  unsoldScript: Uint8Array;
  changeScript: Uint8Array;
  fee: bigint;
};

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function isP2mrScript(script: Uint8Array): boolean {
  return script.length === 34 && script[0] === 0x52 && script[1] === 0x20;
}

/** The numbers and shapes of a transfer, before anything is built. Empty when it is fine. */
export function checkUnsoldTransfer(transfer: UnsoldTransfer): SaleProblem[] {
  const problems: SaleProblem[] = [];
  const problem = (code: string, message: string): number => problems.push({ code, message });
  const { items, funding } = transfer;
  if (items.length < 1) problem("no-items", "a transfer moves at least one sale item");
  if (items.length > UNSOLD_MAX_ITEMS) problem("too-many-items", `a transfer moves at most ${UNSOLD_MAX_ITEMS} items in one standard transaction, not ${items.length}; split it`);
  if (!isP2mrScript(transfer.unsoldScript)) problem("unsold-script", "the unsold address must be a P2MR script");
  if (!isP2mrScript(transfer.changeScript)) problem("change-script", "the change must go to a P2MR script");
  if (sameBytes(transfer.unsoldScript, transfer.changeScript)) problem("change-is-unsold", "the change must not go to the unsold address: it is used only for the unsold items");
  if (sameBytes(transfer.unsoldScript, funding.scriptPubKey)) problem("funding-is-unsold", "the fee coin must not be an output of the unsold address");
  const seen = new Set<string>();
  [...items, funding].forEach((entry, index) => {
    const name = index < items.length ? `item ${index}` : "the fee coin";
    const key = `${Buffer.from(entry.txid).toString("hex")}:${entry.vout}`;
    if (seen.has(key)) problem("duplicate-input", `${name} spends an output that an earlier input already spends`);
    seen.add(key);
    if (entry.value < DUST_BITS) problem("dust", `${name} holds ${entry.value} bits, below the dust threshold of ${DUST_BITS} bits`);
    if (index < items.length && sameBytes(entry.scriptPubKey, transfer.unsoldScript)) problem("already-unsold", `${name} is already an output of the unsold address`);
  });
  if (transfer.fee < 0n) problem("fee", "the fee must not be negative");
  const change = funding.value - transfer.fee;
  if (change < DUST_BITS) problem("dust", `the change would be ${change} bits, below the dust threshold of ${DUST_BITS} bits; use a larger fee coin or a lower fee`);
  return problems;
}

/**
 * The unsigned transfer. Throws, naming every problem, when `checkUnsoldTransfer` finds one or when the PSBT it made
 * does not read back as the shape above (`verifyUnsoldTransferPsbt`).
 */
export function unsoldTransferPsbt(transfer: UnsoldTransfer): Psbt {
  const problems = checkUnsoldTransfer(transfer);
  if (problems.length > 0) throw new Error(`the transfer is not valid: ${problems.map((entry) => entry.message).join("; ")}`);
  const psbt = createP2mrPsbt({
    version: 2,
    locktime: 0,
    inputs: [...transfer.items, transfer.funding].map(coin),
    outputs: [
      ...transfer.items.map((item) => ({ value: item.value, scriptPubKey: transfer.unsoldScript })),
      { value: transfer.funding.value - transfer.fee, scriptPubKey: transfer.changeScript },
    ],
  });
  const read = verifyUnsoldTransferPsbt(psbt, { unsoldScript: transfer.unsoldScript, items: transfer.items.length });
  if (read.length > 0) throw new Error(`the transfer built does not have the shape of PINS-5 section 8.5: ${read.map((entry) => entry.message).join("; ")}`);
  return psbt;
}

/**
 * Reads a transfer PSBT and reports what is wrong with it. `items` is how many sale items it moves. Output `i` must
 * pay `unsoldScript` exactly the value of input `i`, the fee coin is input `items`, the one change output follows,
 * no output goes anywhere else and the fee is not negative. Run it on a PSBT before a key signs it.
 */
export function verifyUnsoldTransferPsbt(value: Psbt | Uint8Array, expected: { unsoldScript: Uint8Array; items: number }): SaleProblem[] {
  const problems: SaleProblem[] = [];
  const problem = (code: string, message: string): number => problems.push({ code, message });
  let parsed: Psbt;
  try {
    parsed = value instanceof Uint8Array ? parsePsbt(value, { maxBytes: 1_000_000, maxObjects: 10_000 }) : value;
  } catch (error) {
    return [{ code: "unreadable", message: `the PSBT cannot be read: ${(error as Error).message}` }];
  }
  let tx: ReturnType<typeof psbtUnsignedTransaction>;
  let summary: ReturnType<typeof decodePsbt>;
  try {
    tx = psbtUnsignedTransaction(parsed);
    summary = decodePsbt(parsed);
  } catch (error) {
    const code = (error as { code?: string }).code === "INVALID_AMOUNT" ? "fee" : "unreadable";
    return [{ code, message: `the PSBT cannot be checked: ${(error as Error).message}` }];
  }
  if (tx.inputs.length !== expected.items + 1) problem("inputs", `the PSBT has ${tx.inputs.length} inputs, expected ${expected.items} items and the fee coin`);
  if (tx.outputs.length !== expected.items + 1) problem("outputs", `the PSBT has ${tx.outputs.length} outputs, expected ${expected.items} item outputs and the change`);
  if (problems.length > 0) return problems;
  const seen = new Set<string>();
  tx.inputs.forEach((input, index) => {
    const key = `${Buffer.from(input.prevout.txid).toString("hex")}:${input.prevout.vout}`;
    if (seen.has(key)) problem("duplicate-input", `input ${index} spends an output that an earlier input already spends`);
    seen.add(key);
    if (!summary.inputs[index]?.witnessUtxo) problem("missing-utxo", `input ${index} has no witness UTXO`);
  });
  if (problems.length > 0) return problems;
  for (let index = 0; index < expected.items; index += 1) {
    const input = summary.inputs[index].witnessUtxo;
    const output = tx.outputs[index];
    if (!input) continue;
    if (!sameBytes(output.scriptPubKey, expected.unsoldScript)) problem("item-output", `output ${index} does not pay the unsold address`);
    if (output.value !== input.value) problem("item-value", `output ${index} holds ${output.value} bits, input ${index} holds ${input.value}: the item would not keep its offset`);
    if (sameBytes(input.scriptPubKey, expected.unsoldScript)) problem("already-unsold", `input ${index} is already an output of the unsold address`);
  }
  const change = tx.outputs[expected.items];
  if (sameBytes(change.scriptPubKey, expected.unsoldScript)) problem("change-is-unsold", "the change goes to the unsold address");
  const fee = summary.fee;
  if (fee === undefined || fee < 0n) problem("fee", "the outputs exceed the inputs, or the fee cannot be read");
  if (tx.version !== 2 || tx.locktime !== 0) problem("header", "the PSBT is not version 2 with locktime 0");
  return problems;
}

/** A row of an indexer's `/inscriptions` answer, as far as the commitment reader needs it. */
export type IndexerRow = {
  id: string;
  txid: string;
  n: number;
  createdHeight: number;
  createdIndex: number;
  leafIssuer: string;
  flags: string[];
  fields: { tag: number; value: string }[];
};

/** What the reader needs to know of the collection: the genesis, its root, its issuer key and its sale commitment. */
export type UnsoldCollection = {
  genesis: string;
  /** The `root` of the genesis, 64 hex characters. */
  root: string;
  /** The issuer key of the genesis: the `leafIssuer` of every record. */
  issuer: string;
  /** The `sale_commitment` of the genesis, 64 hex characters. */
  saleCommitment: string;
  network: MintNetwork;
};

export type UnsoldCommitment = { id: string; address: string; script: Uint8Array };

function order(left: IndexerRow, right: IndexerRow): number {
  return left.createdHeight - right.createdHeight || left.createdIndex - right.createdIndex || left.n - right.n;
}

function recordField(row: IndexerRow): Uint8Array | null {
  if (row.flags.includes("reinscription") || row.flags.includes("opaque")) return null;
  const field = row.fields.find((entry) => entry.tag === 5);
  if (!field || !/^([0-9a-f]{2})*$/.test(field.value)) return null;
  const bytes = hexToBytes(field.value);
  return bytes[0] === 0xa3 ? bytes : null;
}

/**
 * The unsold-address commitment of a collection by the rule of PINS-5 section 8.5: the first P2MR Inscription, in
 * chain order, that comes after the genesis, whose reveal leaf starts with `<issuer> OP_CHECKSIGPQC`, that is not a
 * `reinscription` and not `opaque`, and whose field 5 is `pins-unsold-address/1` with exactly the keys `schema`, `root`
 * and `address`, `root` the root of the genesis and `address` a witness-v2 P2MR address of the network, and that is
 * confirmed before the sale reveal. When no valid sale reveal is in `rows` the sale is not closed, and every
 * commitment is before the close. Null when there is none.
 */
export function unsoldCommitmentOf(rows: readonly IndexerRow[], collection: UnsoldCollection): UnsoldCommitment | null {
  const genesis = rows.find((row) => row.id === collection.genesis);
  if (!genesis) throw new Error(`the genesis ${collection.genesis} is not among the rows`);
  const candidates = rows
    .filter((row) => row !== genesis && row.leafIssuer === collection.issuer && order(genesis, row) < 0)
    .sort(order);
  const reveal = candidates.find((row) => {
    const field = recordField(row);
    const record = field ? parseRecord(field) : null;
    return record?.kind === "sale-reveal" && record.root === collection.root && saleCommitmentOf(record.saleSecret) === collection.saleCommitment;
  });
  for (const row of candidates) {
    if (reveal && order(row, reveal) >= 0) break;
    const field = recordField(row);
    const record = field ? parseRecord(field) : null;
    if (record?.kind !== "unsold-address" || record.root !== collection.root) continue;
    try {
      return { id: row.id, address: record.address, script: unsoldAddressScript(record.address, collection.network) };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * A coin held by the plain single-key P2MR output of `key`, the output a Qbit Core wallet makes with `mr(pk(key))`.
 * Its script, leaf script and control block come from the key, so nothing about it is taken on trust from a file.
 */
export function keyCoin(txid: string, vout: number, value: bigint, key: Uint8Array): SaleCoin {
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error("a txid is 64 lowercase hex characters");
  if (!Number.isSafeInteger(vout) || vout < 0) throw new Error("an output index is a whole number from 0");
  if (key.length !== 32) throw new Error("a key is 32 bytes");
  const leafScript = singleKeyLeafScript(key);
  return {
    txid: hexToBytes(txid).reverse(),
    vout,
    value,
    scriptPubKey: p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)),
    leafScript,
    controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
  };
}

/** The 32-byte key of a descriptor `mr(pk(<64 hex>))#checksum`, the plain single-key P2MR output of a Qbit Core wallet. */
export function keyOfDescriptor(descriptor: string): Uint8Array {
  const match = /^mr\(pk\(([0-9a-f]{64})\)\)(#[a-z0-9]{8})?$/.exec(descriptor);
  if (!match) throw new Error(`not a plain single-key P2MR descriptor: ${descriptor}`);
  return hexToBytes(match[1]);
}
