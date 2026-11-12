// SPDX-License-Identifier: Apache-2.0

/**
 * Primary-sale PSBT, PINS-6 §4.1 and §6 (Draft).
 * The receive output is the script the caller supplies. `primarySalePsbt` refuses
 * a sale that breaks the numbers of PINS-6 §4.1 or §4.4 and a receive script that
 * is not P2MR (see `checkPrimarySale`); it does not decide which address that
 * script is, or whether it is on the right network or is the holding address
 * (PINS-6 §4.3): the caller checks that first, and a buyer re-checks the finished
 * PSBT with `checkPurchasePsbt` from `./checks.ts` before signing.
 */
import {
  PSBT_IN_SIGHASH_TYPE,
  buildControlBlock,
  createP2mrPsbt,
  p2mrLeafHash,
  P2MR_LEAF_VERSION_V1,
  type P2mrPsbtInput,
  type Psbt,
} from "@qbit-oss/protocol";
import { DUST_BITS, SELLER_SIGHASH_TYPE, assertPurchasePsbt, type SaleProblem } from "./checks.ts";

/** `SIGHASH_SINGLE | SIGHASH_ANYONECANPAY`, 0x83. Defined once, in `./checks.ts`. */
export const SELLER_SIGHASH = SELLER_SIGHASH_TYPE;

export type SaleCoin = {
  /** Internal byte order, as a PSBT outpoint stores it. */
  txid: Uint8Array;
  vout: number;
  value: bigint;
  scriptPubKey: Uint8Array;
  leafScript: Uint8Array;
  controlBlock?: Uint8Array;
};

export type PrimarySale = {
  paddingA: SaleCoin;
  paddingB: SaleCoin;
  /** The inscribed output `U`. */
  inscribed: SaleCoin;
  funding: SaleCoin;
  /** Output 1. Must be a P2MR script (PINS-6 §4.3). */
  receiveScript: Uint8Array;
  /** Output 0, the padding return. */
  paddingReturnScript: Uint8Array;
  /** Output 2, the seller payment. */
  sellerScript: Uint8Array;
  /** Last output. */
  changeScript: Uint8Array;
  price: bigint;
  postage: bigint;
  changeValue: bigint;
};

function coin(input: SaleCoin): P2mrPsbtInput {
  const leafScript = input.leafScript;
  return {
    prevout: { txid: input.txid, vout: input.vout },
    sequence: 0xfffffffe,
    witnessUtxo: { value: input.value, scriptPubKey: input.scriptPubKey },
    leafScript,
    controlBlock: input.controlBlock ?? buildControlBlock(P2MR_LEAF_VERSION_V1, []),
    merkleRoot: p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript),
  };
}

function sighashField(hashType: number): { key: Uint8Array; value: Uint8Array } {
  const value = new Uint8Array(4);
  new DataView(value.buffer).setUint32(0, hashType, true);
  return { key: Uint8Array.of(PSBT_IN_SIGHASH_TYPE), value };
}

const OUTPUT_NAMES = ["the padding return (a + b)", "the receive output", "the seller payment", "the change output"];

/**
 * The numbers of a clean-template primary sale, before anything is built (PINS-6 §4.1, §4.4):
 * the padding return `a + b` is not dust, the receive output pays exactly the value of `U`
 * and is not dust, the seller payment and the change are not dust, the fee is not negative,
 * every amount is a whole non-negative number of bits and no two inputs are the same output.
 * Returns the problems, empty when the sale is fine.
 */
export function checkPrimarySale(sale: PrimarySale): SaleProblem[] {
  const problems: SaleProblem[] = [];
  const problem = (code: string, message: string) => problems.push({ code, message });
  const coins = [sale.paddingA, sale.paddingB, sale.inscribed, sale.funding];
  const names = ["padding a", "padding b", "the inscribed output", "funding"];
  const amounts: [string, bigint][] = [
    ["price", sale.price],
    ["postage", sale.postage],
    ["changeValue", sale.changeValue],
    ...coins.map((entry, index): [string, bigint] => [`${names[index]} value`, entry.value]),
  ];
  for (const [label, amount] of amounts) {
    if (typeof amount !== "bigint" || amount < 0n) problem("amount", `${label} must be a whole number of bits, 0 or more`);
  }
  if (problems.length > 0) return problems;
  const seen = new Set<string>();
  coins.forEach((entry, index) => {
    const key = `${Buffer.from(entry.txid).toString("hex")}:${entry.vout}`;
    if (seen.has(key)) problem("duplicate-input", `${names[index]} spends an output that an earlier input already spends`);
    seen.add(key);
  });
  const padding = sale.paddingA.value + sale.paddingB.value;
  if (padding < DUST_BITS) problem("dust", `a + b is ${padding} bits, below the dust threshold of ${DUST_BITS} bits (PINS-6 §4.1)`);
  if (sale.postage !== sale.inscribed.value) {
    problem("postage", `the receive output must be exactly the value of the inscribed output, ${sale.inscribed.value} bits, not ${sale.postage} (PINS-6 §4.1)`);
  }
  if (sale.postage < DUST_BITS) problem("dust", `the receive output is ${sale.postage} bits, below the dust threshold of ${DUST_BITS} bits`);
  if (sale.price < DUST_BITS) problem("dust", `the seller payment is ${sale.price} bits, below the dust threshold of ${DUST_BITS} bits`);
  if (sale.changeValue < DUST_BITS) problem("dust", `the change output is ${sale.changeValue} bits, below the dust threshold of ${DUST_BITS} bits; add it to the fee or to the price instead`);
  const fee = coins.reduce((sum, entry) => sum + entry.value, 0n) - (padding + sale.postage + sale.price + sale.changeValue);
  if (fee < 0n) problem("fee", `the outputs exceed the inputs by ${-fee} bits (fee below 0)`);
  return problems;
}

/**
 * Clean template. Output 1 pays `receiveScript` exactly `postage` bits.
 * Inputs 0, 1 and 3 omit `PSBT_IN_SIGHASH_TYPE`, so the buyer signs them
 * `SIGHASH_DEFAULT` and that signature commits to every output, including the
 * receive output. Input 2 is the seller's `0x83` listing and commits only to
 * the seller-payment output at the same index.
 *
 * Throws, naming every problem, when `checkPrimarySale` finds one, and again when
 * the finished PSBT fails `checkPurchasePsbt` (for example when the bit would not
 * land in output 1). Whatever is returned passed both.
 */
export function primarySalePsbt(sale: PrimarySale): Psbt {
  const problems = checkPrimarySale(sale);
  if (problems.length > 0) throw new Error(`the sale is not valid: ${problems.map((entry) => entry.message).join("; ")}`);
  const psbt = createP2mrPsbt({
    version: 2,
    locktime: 0,
    inputs: [coin(sale.paddingA), coin(sale.paddingB), coin(sale.inscribed), coin(sale.funding)],
    outputs: [
      { value: sale.paddingA.value + sale.paddingB.value, scriptPubKey: sale.paddingReturnScript },
      { value: sale.postage, scriptPubKey: sale.receiveScript },
      { value: sale.price, scriptPubKey: sale.sellerScript },
      { value: sale.changeValue, scriptPubKey: sale.changeScript },
    ],
  });
  psbt.inputs[2].push(sighashField(SELLER_SIGHASH));
  assertPurchasePsbt(psbt, {
    sellerInput: 2,
    receiveOutput: 1,
    expectedReceiveScript: sale.receiveScript,
    expectedSellerPayment: sale.price,
    strict: true,
    outputNames: OUTPUT_NAMES,
  });
  return psbt;
}
