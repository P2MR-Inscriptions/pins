// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";
import { cookieFileIn } from "../../packages/indexer/rpc.ts";

/**
 * Read KEY=VALUE text literally. Nothing in the file is evaluated as a shell command.
 * A value such as $(...) stays the characters written in the file.
 */

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) throw new Error("env file has a line without a name");
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("env file has an invalid name");
    let value = line.slice(eq + 1);
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1);
    }
    if (/[\r\0]/.test(value)) throw new Error("env file value must be a single line");
    out[key] = value;
  }
  return out;
}

/** Bitcoin-style qbit.conf. Only rpcuser, rpcpassword, rpcbind, and rpcport are read. */
export function parseQbitConf(text: string): { rpcuser?: string; rpcpassword?: string; rpcbind?: string; rpcport?: string } {
  const out: { rpcuser?: string; rpcpassword?: string; rpcbind?: string; rpcport?: string } = {};
  for (const raw of text.split(/\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "rpcuser" || key === "rpcpassword" || key === "rpcbind" || key === "rpcport") out[key] = value;
  }
  return out;
}

export type PinsNetwork = "mainnet" | "testnet4" | "regtest";

/** `PINS_NETWORK`: the network of the node. Mainnet when it is not set. */
export function networkFromEnv(env: Record<string, string | undefined>): PinsNetwork {
  const value = env.PINS_NETWORK || "mainnet";
  if (value !== "mainnet" && value !== "testnet4" && value !== "regtest") throw new Error("PINS_NETWORK must be mainnet, testnet4 or regtest");
  return value;
}

/**
 * The node's cookie file, when the login is a cookie: `QBIT_RPC_COOKIE_FILE` names the file, or `QBIT_RPC_DATADIR`
 * names the node's data directory and the cookie of `PINS_NETWORK` in it is used. Undefined when neither is set.
 * The path is not a secret. The content is read for every call, never here.
 */
export function cookieFileFromEnv(env: Record<string, string | undefined>): string | undefined {
  const file = env.QBIT_RPC_COOKIE_FILE || undefined;
  const datadir = env.QBIT_RPC_DATADIR || undefined;
  if (file !== undefined && datadir !== undefined) throw new Error("give QBIT_RPC_COOKIE_FILE or QBIT_RPC_DATADIR, not both");
  if (file !== undefined) return resolve(file);
  if (datadir !== undefined) return cookieFileIn(resolve(datadir), networkFromEnv(env));
  return undefined;
}
