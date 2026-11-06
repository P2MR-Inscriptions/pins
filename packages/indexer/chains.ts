// SPDX-License-Identifier: Apache-2.0

/**
 * Names the operator types, and the `chain` string `getblockchaininfo` returns.
 * Mainnet's RPC name is `main`, not `mainnet`.
 */
export type FollowNetwork = "regtest" | "testnet4" | "mainnet";

export function rpcChainName(network: FollowNetwork): "regtest" | "testnet4" | "main" {
  if (network === "mainnet") return "main";
  return network;
}
