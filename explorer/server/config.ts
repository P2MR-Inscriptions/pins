// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseQbitConf } from "../scripts/credentials.ts";
import { assertHttpUrl, isLoopbackHost } from "./net.ts";
import { profile } from "./profile.ts";

export type Manifest = {
  note?: string;
  name: string;
  supply: number;
  first: number;
  genesisId: string;
  merkleRoot: string;
  itemType: string;
  image?: { width: number; height: number };
};

export type RpcConfig = { url: string; user: string; password: string };

export type ExplorerConfig = {
  host: string;
  port: number;
  indexerUrl: string;
  pollMs: number;
  manifest: Manifest | null;
  manifestPath: string;
  rpc: RpcConfig | null;
  externalExplorer: string | null;
  trustedHosts: string[];
  trustProxy: boolean;
  contentMaxBytes: number;
  contentTimeoutMs: number;
  snapshotTimeoutMs: number;
  ratePerMinute: number;
  maxConcurrency: number;
  maxInscriptions: number;
  version: string;
};

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} is out of range`);
  return value;
}

function loadManifest(path: string): Manifest | null {
  try {
    return JSON.parse(readFileSync(resolve(path), "utf8")) as Manifest;
  } catch {
    return null;
  }
}

function rpcFrom(env: NodeJS.ProcessEnv): RpcConfig | null {
  let user = env.QBIT_RPC_USER ?? "";
  let password = env.QBIT_RPC_PASSWORD ?? "";
  let url = env.QBIT_RPC_URL ?? "";
  if ((!user || !password || !url) && env.QBIT_CONF) {
    const conf = parseQbitConf(readFileSync(resolve(env.QBIT_CONF), "utf8"));
    if (!user) user = conf.rpcuser ?? "";
    if (!password) password = conf.rpcpassword ?? "";
    if (!url) url = `http://${conf.rpcbind && isLoopbackHost(conf.rpcbind) ? conf.rpcbind : "127.0.0.1"}:${conf.rpcport || "8352"}/`;
  }
  if (!url && !user && !password) return null;
  if (!url || !user || !password) throw new Error("set QBIT_RPC_URL, QBIT_RPC_USER, and QBIT_RPC_PASSWORD together, or point QBIT_CONF at a qbit.conf");
  assertHttpUrl(url, "QBIT_RPC_URL", true);
  if (/[\r\n\0]/.test(user) || /[\r\n\0]/.test(password)) throw new Error("RPC credentials must be a single line");
  return { url, user, password };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ExplorerConfig {
  const host = env.HOST || "127.0.0.1";
  if (profile.forceLoopbackBind && !isLoopbackHost(host)) {
    throw new Error("this build only listens on loopback");
  }
  const indexerUrl = (env.INDEXER_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
  assertHttpUrl(indexerUrl, "INDEXER_URL", true);
  let externalExplorer: string | null = null;
  if (env.EXPLORER_URL) {
    assertHttpUrl(env.EXPLORER_URL, "EXPLORER_URL", false);
    externalExplorer = env.EXPLORER_URL.replace(/\/+$/, "");
  }
  const manifestPath = env.MANIFEST || profile.defaultManifest;
  return {
    host,
    port: int(env, "PORT", 8080, 1, 65535),
    indexerUrl,
    pollMs: Math.max(1000, int(env, "POLL_MS", 5000, 1000, 3_600_000)),
    manifest: loadManifest(manifestPath),
    manifestPath,
    rpc: rpcFrom(env),
    externalExplorer,
    trustedHosts: (env.TRUSTED_HOSTS || "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean),
    trustProxy: env.TRUST_PROXY === "1",
    contentMaxBytes: int(env, "CONTENT_MAX_BYTES", 2_000_000, 1, 32_000_000),
    contentTimeoutMs: int(env, "CONTENT_TIMEOUT_MS", 30_000, 1000, 120_000),
    snapshotTimeoutMs: int(env, "SNAPSHOT_TIMEOUT_MS", 180_000, 1000, 600_000),
    ratePerMinute: int(env, "RATE_PER_MINUTE", 240, 1, 100_000),
    maxConcurrency: int(env, "MAX_CONCURRENCY", 8, 1, 1000),
    maxInscriptions: int(env, "MAX_INSCRIPTIONS", 200_000, 1, 5_000_000),
    version: "1.0.0",
  };
}

export const config = loadConfig();
