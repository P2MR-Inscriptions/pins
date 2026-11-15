// SPDX-License-Identifier: Apache-2.0

/**
 * The plan and signature of a record P2MR Inscription (PINS-5 sections 7 and 8.5): the unsold-address commitment,
 * the sale reveal and the closing. Each is one stand-alone P2MR Inscription signed by the issuer key, so it uses the
 * single plan of `buildSinglePlan`, `signPlan` and the same `broadcast`. This module reads no file and opens no socket.
 */
import type { MintNetwork } from "./network.ts";
import { buildSinglePlan, type MintPlan, type Utxo } from "./plan.ts";
import { recordInscription, unsoldAddressScript, type RecordInput } from "./records.ts";
import { signPlan } from "./sign.ts";

export type RecordRequest = {
  input: RecordInput;
  network: MintNetwork;
  marker: Uint8Array;
  feeRate: number;
  issuerPublic: Uint8Array;
  recoveryPublic: Uint8Array;
  /** Receives the postage output of the record. */
  creator: string;
  change: string;
  utxo: Utxo;
};

/** The unsigned plan of a record. Refuses an unsold address that is also the creator or the change address. */
export function recordPlan(request: RecordRequest): MintPlan {
  if (request.input.kind === "unsold-address") {
    unsoldAddressScript(request.input.address, request.network);
    if (request.input.address === request.creator || request.input.address === request.change) {
      throw new Error("the unsold address is used only for the unsold items: it cannot be the creator or the change address");
    }
  }
  return buildSinglePlan({
    network: request.network,
    marker: request.marker,
    feeRate: request.feeRate,
    issuerPublic: request.issuerPublic,
    recoveryPublic: request.recoveryPublic,
    creator: request.creator,
    change: request.change,
    utxo: request.utxo,
    inscription: recordInscription(request.input),
  });
}

/**
 * The signed plan of a record. `signPlan` rebuilds the leaf from the same record and compares it with the plan's own,
 * so the issuer key signs exactly this record. The caller zeros the secret.
 */
export function signedRecordPlan(request: RecordRequest, issuerSecret: Uint8Array): MintPlan {
  const plan = recordPlan(request);
  return signPlan(plan, issuerSecret, new Set(), {
    fundingTxid: request.utxo.txid,
    fundingVout: request.utxo.vout,
    creator: request.creator,
    sale: null,
    holder: null,
    change: request.change,
  }, undefined, undefined, { single: recordInscription(request.input) });
}
