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
 * and is passed only in the child environment. The indexer sends it to the node
 * in an `Authorization` header, never on a command line or in a URL.
 * With a cookie login there is no password: the path of the cookie file is the
 * only thing passed (`--rpc-cookie-file`), and the indexer reads the file for every call.
 */
export function buildIndexerLaunch(options: {
  rpcUrl: string;
  user?: string;
  password?: string;
  cookieFile?: string;
  genesisId?: string;
  db: string;
  port: number;
  network: "mainnet" | "testnet4" | "regtest";
  env?: NodeJS.ProcessEnv;
}): Launch {
  assertHttpUrl(options.rpcUrl, "QBIT_RPC_URL", true);
  const { cookieFile } = options;
  const user = options.user ?? "";
  const password = options.password ?? "";
  if (cookieFile !== undefined && (user || password)) throw new Error("give one RPC login: user and password, or a cookie file, not both");
  if (cookieFile === undefined && (!user || !password)) throw new Error("an RPC login is required: a user and a password, or a cookie file (QBIT_RPC_COOKIE_FILE or QBIT_RPC_DATADIR)");
  if (/[\r\n\0]/.test(user) || /[\r\n\0]/.test(password) || (cookieFile !== undefined && /[\r\n\0]/.test(cookieFile))) throw new Error("RPC credentials must be a single line");
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
  if (cookieFile !== undefined) args.push("--rpc-cookie-file", cookieFile);
  const visible = args.join("\0");
  if (password && (visible.includes(password) || visible.includes(`${user}:${password}`))) {
    throw new Error("refusing to place RPC credentials on the indexer command line");
  }
  // The indexer takes exactly one kind of login, so the child gets one: any other kind in the environment is removed.
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  delete env.QBIT_RPC_USER;
  delete env.QBIT_RPC_PASSWORD;
  delete env.QBIT_RPC_COOKIE_FILE;
  delete env.QBIT_RPC_DATADIR;
  if (cookieFile === undefined) Object.assign(env, { QBIT_RPC_USER: user, QBIT_RPC_PASSWORD: password });
  return { command: "npm", args, env };
}
