// SPDX-License-Identifier: Apache-2.0

/**
 * Follow a local node and serve the read-only indexer API on 127.0.0.1.
 * `npm run indexer:serve` and `npm run indexer:run` are the same process.
 * After the first catch-up it keeps polling getblockcount and getbestblockhash.
 * A failed node call is retried with a growing wait; 30 failures in a row stop it.
 * Pass `--no-follow` to stop after that first catch-up. `--poll` is the gap in
 * seconds (default 15). Regtest is the default network. Testnet4 and mainnet
 * need --network and the same word typed as --confirm-network.
 * Omitted --activation uses 161948 on mainnet and 0 on regtest and testnet4.
 * `--genesis` takes a P2MR Inscription id; the collection view then accepts only that
 * P2MR Inscription as its genesis. Without it, the first valid genesis is used.
 * This process does not broadcast.
 */
import { readFileSync } from "node:fs";
import { startApi } from "../packages/indexer/api.ts";
import type { CollectionProfile } from "../packages/indexer/collection.ts";
import { ACTIVATION_HEIGHT } from "../packages/indexer/chains.ts";
import { follow, httpRpc, parsePrefetch, pollChain } from "../packages/indexer/follow.ts";
import { rpcAuthFromFlags } from "../packages/indexer/rpc.ts";
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

const HELP = `Usage: npm run indexer:serve -- --db <file> --rpc <url> [login] [options]

Follows a local Qbit node and serves the read-only indexer API on 127.0.0.1. This process does not broadcast.

Required
  --db <file>                 SQLite database. Created when missing. Fixes the network, marker, schema, activation and genesis.
  --rpc <url>                 The node's RPC URL, for example http://127.0.0.1:18452/ (no credentials in the URL).

Login (one kind; a flag wins over its variable)
  --rpc-user <name> --rpc-password <text>   or QBIT_RPC_USER and QBIT_RPC_PASSWORD (the variables keep them off the command line)
  --rpc-cookie-file <file>                  or QBIT_RPC_COOKIE_FILE (loopback RPC only)
  --rpc-datadir <dir>                       or QBIT_RPC_DATADIR: the node's data directory, its cookie for --network

Options
  --network <name>            regtest (default), testnet4 or mainnet.
  --confirm-network <name>    Required on testnet4 and mainnet: the same word as --network.
  --port <n>                  API port on 127.0.0.1. Default 8787.
  --activation <height>       First block to index. Default 161948 on mainnet, 0 on regtest and testnet4.
  --marker <text>             Envelope marker. Default pins. Mainnet accepts pins only.
  --schema <name>             Collection schema. Default pins-collection/1. Mainnet accepts it only.
  --poll <seconds>            Gap between checks for new blocks. Default 15.
  --collection <file>         A collection profile (JSON). Lets the indexer reproduce the creator reserve.
  --genesis <id>              Accept only this P2MR Inscription id as the genesis of the collection.
  --allow-host <names>        Comma-separated Host header values the API accepts besides loopback names.
  --prefetch <n>              Blocks to fetch ahead during catch-up. Default 8, from 1 to 32. PINS_PREFETCH is the same.
  --no-follow                 Do one catch-up, keep serving, and do not poll for new blocks.
  --help                      This text.
`;

function text(flag: Record<string, string | boolean>, name: string): string {
  const value = flag[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing --${name}`);
  return value;
}

async function main(): Promise<void> {
  const flag = flags(process.argv.slice(2));
  if (flag.help === true) {
    process.stdout.write(HELP);
    return;
  }
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
  let genesisId: string | null = null;
  if (flag.genesis !== undefined) {
    if (typeof flag.genesis !== "string" || !/^[0-9a-f]{64}i\d+$/.test(flag.genesis)) throw new Error("--genesis must be a P2MR Inscription id: 64 hex characters, i, and the index");
    genesisId = flag.genesis;
  }
  const prefetch = parsePrefetch(typeof flag.prefetch === "string" ? flag.prefetch : process.env.PINS_PREFETCH);
  const store = new Store(text(flag, "db"), { network, marker, schema, profile, genesisId });
  const rpc = httpRpc(text(flag, "rpc"), rpcAuthFromFlags(flag, network));
  const log = (line: string) => process.stderr.write(`${line}\n`);
  const synced = await follow(store, rpc, activation, network, { prefetch, log });
  const allowedHosts = typeof flag["allow-host"] === "string" ? flag["allow-host"].split(",").map((name) => name.trim()).filter((name) => name.length > 0) : [];
  const api = await startApi(store, port, network, { allowedHosts });
  // Follow is the default. `--no-follow` does one catch-up and still serves the API.
  if (flag["no-follow"] === true) {
    process.stdout.write(`Indexer caught up on ${network} at ${api.url}\nHeight ${synced.height}. Not following new blocks (--no-follow). Leave this running and open the checks in another terminal.\n`);
    await new Promise(() => undefined);
    return;
  }
  process.stdout.write(`Indexer is following ${network} at ${api.url}\nHeight ${synced.height}. Polling every ${pollSeconds}s for new blocks and reorgs. Leave this running and open the checks in another terminal.\n`);
  void pollChain(store, rpc, activation, network, { intervalMs: pollSeconds * 1000, prefetch }).catch((error: unknown) => {
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
