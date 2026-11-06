// SPDX-License-Identifier: Apache-2.0

/**
 * The address Qbit Wallet sends the mint funding to. It is the single-key
 * P2MR address of the issuer public key, the same script the offline keyfile
 * spends. The wallet does not hold that key and cannot spend this address.
 */
import { p2mrAddressFromPubkey } from "@qbit-oss/protocol";
import type { MintNetwork } from "./network.ts";

export function fundingAddress(issuerPublic: Uint8Array, network: MintNetwork): string {
  if (issuerPublic.length !== 32) throw new Error("issuer public key must be 32 bytes");
  return p2mrAddressFromPubkey(issuerPublic, network);
}
