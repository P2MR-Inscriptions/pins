// SPDX-License-Identifier: Apache-2.0

/**
 * Names the operator types, and the `chain` string `getblockchaininfo` returns.
 * Mainnet's RPC name is `main`, not `mainnet`.
 */
export type FollowNetwork = "regtest" | "testnet4" | "mainnet";

/**
 * Default height `follow` starts at when the operator does not pass one.
 * Mainnet is PINS-2 §3: the block that contains P2MR Inscription number 0.
 * Regtest and testnet4 are 0, as PINS-2 §3 states: the indexer starts at the first block.
 */
export const ACTIVATION_HEIGHT: Record<FollowNetwork, number> = {
  mainnet: 161948,
  testnet4: 0,
  regtest: 0,
};

export function rpcChainName(network: FollowNetwork): "regtest" | "testnet4" | "main" {
  if (network === "mainnet") return "main";
  return network;
}
