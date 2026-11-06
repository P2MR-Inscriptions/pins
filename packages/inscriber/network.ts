// SPDX-License-Identifier: Apache-2.0

/**
 * Broadcast network gate. Regtest is the default and needs no extra confirmation.
 * Mainnet and testnet4 are refused unless the operator typed that exact name.
 */
import { rpcChainName } from "../indexer/chains.ts";

export { rpcChainName };

export type MintNetwork = "regtest" | "testnet4" | "mainnet";

export function parseNetwork(value: string | undefined): MintNetwork {
  if (value === undefined || value === "regtest") return "regtest";
  if (value === "testnet4" || value === "mainnet") return value;
  throw new Error(`unknown network ${value}`);
}

/** Throws unless this broadcast is allowed. `typed` is what the operator typed. */
export function assertBroadcastNetwork(network: MintNetwork, typed: string | undefined): void {
  if (network === "regtest") return;
  if (typed !== network) {
    throw new Error(`refusing to broadcast on ${network} until that name is typed`);
  }
}
