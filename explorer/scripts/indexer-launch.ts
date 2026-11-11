// SPDX-License-Identifier: Apache-2.0

import { assertHttpUrl } from "../server/net.ts";

const ID = /^[0-9a-f]{64}i\d+$/;

export type Launch = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

/**
 * The npm command is silent so it does not echo its arguments.
 * Silence is not what hides the password: the password is absent from `args`
 * and is passed only in the child environment. The indexer then feeds
 * it to curl on stdin, not on curl's command line.
 */
export function buildIndexerLaunch(options: {
  rpcUrl: string;
  user: string;
  password: string;
  genesisId?: string;
  db: string;
  port: number;
  network: "mainnet" | "testnet4" | "regtest";
  env?: NodeJS.ProcessEnv;
}): Launch {
  assertHttpUrl(options.rpcUrl, "QBIT_RPC_URL", true);
  if (!options.user || !options.password) throw new Error("RPC user and password are required");
  if (/[\r\n\0]/.test(options.user) || /[\r\n\0]/.test(options.password)) throw new Error("RPC credentials must be a single line");
  if (options.genesisId !== undefined && options.genesisId !== "" && !ID.test(options.genesisId)) {
    throw new Error("genesis id must be 64 hex characters, i, and the index");
  }
  const args = [
    "run", "--silent", "indexer:serve", "--",
    "--db", options.db,
    "--rpc", options.rpcUrl,
    "--network", options.network,
    "--confirm-network", options.network,
    "--port", String(options.port),
  ];
  if (options.genesisId) args.push("--genesis", options.genesisId);
  const visible = args.join("\0");
  if (visible.includes(options.password) || visible.includes(`${options.user}:${options.password}`)) {
    throw new Error("refusing to place RPC credentials on the indexer command line");
  }
  return {
    command: "npm",
    args,
    env: { ...(options.env ?? process.env), QBIT_RPC_USER: options.user, QBIT_RPC_PASSWORD: options.password },
  };
}
