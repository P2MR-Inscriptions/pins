// SPDX-License-Identifier: Apache-2.0

/**
 * Follow a local node and serve the read-only indexer API on 127.0.0.1.
 * `npm run indexer:serve` and `npm run indexer:run` are the same process.
 * After the first catch-up it keeps polling getblockcount and getbestblockhash.
 * Pass `--no-follow` to stop after that first catch-up. `--poll` is the gap in
 * seconds (default 15). Regtest is the default network. Testnet4 and mainnet
 * need --network and the same word typed as --confirm-network.
 * Omitted --activation uses 161948 on mainnet and 0 on regtest and testnet4.
 * This process does not broadcast.
 */
import { readFileSync } from "node:fs";
import { startApi } from "../packages/indexer/api.ts";
import type { CollectionProfile } from "../packages/indexer/collection.ts";
import { ACTIVATION_HEIGHT } from "../packages/indexer/chains.ts";
import { follow, httpRpc, pollChain } from "../packages/indexer/follow.ts";
import { Store } from "../packages/indexer/store.ts";
import { assertMarkerForNetwork, parseMarker } from "../packages/inscriber/marker.ts";
import { assertBroadcastNetwork, parseNetwork } from "../packages/inscriber/network.ts";

function flags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[name] = true;
    else {
      out[name] = next;
      i += 1;
    }
  }
  return out;
}

function text(flag: Record<string, string | boolean>, name: string): string {
  const value = flag[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing --${name}`);
  return value;
}

async function main(): Promise<void> {
  const flag = flags(process.argv.slice(2));
  const network = parseNetwork(typeof flag.network === "string" ? flag.network : undefined);
  assertBroadcastNetwork(network, typeof flag["confirm-network"] === "string" ? flag["confirm-network"] : undefined);
  const port = flag.port === undefined ? 8787 : Number(flag.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be a number from 1 to 65535");
  const activation = flag.activation === undefined ? ACTIVATION_HEIGHT[network] : Number(flag.activation);
  if (!Number.isInteger(activation) || activation < 0) throw new Error("--activation must be a block height, or omitted");
  const marker = parseMarker(typeof flag.marker === "string" ? flag.marker : undefined);
  assertMarkerForNetwork(marker, network);
  // The price schema is derived from this (`c/1` becomes `p/1`). Mainnet keeps the launch pair.
  const schema = typeof flag.schema === "string" ? flag.schema : "pins-collection/1";
  if (network === "mainnet" && schema !== "pins-collection/1") throw new Error("mainnet refuses a rehearsal schema");
  const pollSeconds = flag.poll === undefined ? 15 : Number(flag.poll);
  if (!Number.isFinite(pollSeconds) || pollSeconds <= 0) throw new Error("--poll must be a positive number of seconds");
  let profile: CollectionProfile | null = null;
  if (typeof flag.collection === "string") {
    const specifier = "../packages/protocol/profile.mjs";
    const parsed = JSON.parse(readFileSync(flag.collection, "utf8")) as unknown;
    const loaded = await import(specifier) as { parseCollectionProfile: (value: unknown) => CollectionProfile };
    profile = loaded.parseCollectionProfile(parsed);
  }
  const store = new Store(text(flag, "db"), { network, marker, schema, profile });
  const rpcUser = typeof flag["rpc-user"] === "string" && flag["rpc-user"].length > 0 ? flag["rpc-user"] : process.env.QBIT_RPC_USER;
  const rpcPassword = typeof flag["rpc-password"] === "string" && flag["rpc-password"].length > 0 ? flag["rpc-password"] : process.env.QBIT_RPC_PASSWORD;
  if (!rpcUser) throw new Error("missing --rpc-user (or QBIT_RPC_USER)");
  if (!rpcPassword) throw new Error("missing --rpc-password (or QBIT_RPC_PASSWORD)");
  const rpc = httpRpc(text(flag, "rpc"), rpcUser, rpcPassword);
  const synced = await follow(store, rpc, activation, network);
  const api = await startApi(store, port, network);
  // Follow is the default. `--no-follow` keeps today's one-shot catch-up and still serves the API.
  if (flag["no-follow"] === true) {
    process.stdout.write(`Indexer caught up on ${network} at ${api.url}\nHeight ${synced.height}. Not following new blocks (--no-follow). Leave this running and open the checks in another terminal.\n`);
    await new Promise(() => undefined);
    return;
  }
  process.stdout.write(`Indexer is following ${network} at ${api.url}\nHeight ${synced.height}. Polling every ${pollSeconds}s for new blocks and reorgs. Leave this running and open the checks in another terminal.\n`);
  void pollChain(store, rpc, activation, network, { intervalMs: pollSeconds * 1000 }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "indexer follow failed";
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
  await new Promise(() => undefined);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "indexer failed";
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
