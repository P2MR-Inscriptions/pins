// SPDX-License-Identifier: Apache-2.0

/**
 * Names the operator types, and the `chain` string `getblockchaininfo` returns.
 * Mainnet's RPC name is `main`, not `mainnet`.
 */
export type FollowNetwork = "regtest" | "testnet4" | "mainnet";

/**
 * Default height `follow` starts at when the operator does not pass one.
 * Mainnet is PINS-2: the block that contains inscription number 0.
 * Regtest stays 0, which PINS-2 recommends.
 * Testnet4 has no height in PINS-2. 0 here means the reference indexer scans
 * from genesis until a testnet4 constant is published. It is not that constant.
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
