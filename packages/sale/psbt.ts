// SPDX-License-Identifier: Apache-2.0

/**
 * Primary-sale PSBT, PINS-6 §4.1 and §6.
 * The receive output is whatever script the caller supplies. Restricted-output
 * mode still applies, so a script qbit would not relay is rejected by
 * `createP2mrPsbt`. This module does not decide which address that script is.
 */
import {
  PSBT_IN_SIGHASH_TYPE,
  SIGHASH_ANYONECANPAY,
  SIGHASH_SINGLE,
  buildControlBlock,
  createP2mrPsbt,
  p2mrLeafHash,
  P2MR_LEAF_VERSION_V1,
  type P2mrPsbtInput,
  type Psbt,
} from "@qbit-oss/protocol";

export const SELLER_SIGHASH = SIGHASH_SINGLE | SIGHASH_ANYONECANPAY;

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
  /** Output 1. Any script restricted-output mode accepts. */
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

/**
 * Clean template. Output 1 pays `receiveScript` exactly `postage` bits.
 * Inputs 0, 1 and 3 omit `PSBT_IN_SIGHASH_TYPE`, so the buyer signs them
 * `SIGHASH_DEFAULT` and that signature commits to every output, including the
 * receive output. Input 2 is the seller's `0x83` listing and commits only to
 * the seller-payment output at the same index.
 */
export function primarySalePsbt(sale: PrimarySale): Psbt {
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
  return psbt;
}
