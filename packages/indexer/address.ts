// SPDX-License-Identifier: Apache-2.0

/**
 * Owner display for an output script. P2MR becomes a bech32m address.
 * Every other script is `script:` plus its hex, so two indexers still agree.
 */
import { p2mrAddressFromRoot } from "@qbit-oss/protocol";

export function addressOf(script: Uint8Array, network: "regtest" | "testnet4" | "mainnet" = "regtest"): string {
  if (script.length === 34 && script[0] === 0x52 && script[1] === 0x20) {
    return p2mrAddressFromRoot(script.subarray(2), network);
  }
  if (script.length > 0 && script[0] === 0x6a) return "";
  return `script:${Buffer.from(script).toString("hex")}`;
}
