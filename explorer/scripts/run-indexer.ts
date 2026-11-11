// SPDX-License-Identifier: Apache-2.0
/**
 * Start the PINS indexer of the repository that contains this directory
 * (scripts/indexer-run.ts). Credentials are read from .env or qbit.conf
 * and placed in the child environment. They are not shell-evaluated and not
 * passed as process arguments. npm is invoked with --silent; that only hides
 * npm's own log line. The password is omitted from the argument list entirely.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { profile } from "../server/profile.ts";
import { parseEnvFile, parseQbitConf } from "./credentials.ts";
import { buildIndexerLaunch } from "./indexer-launch.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(ROOT, "..");

function fileEnv(): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(resolve(ROOT, ".env"), "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    throw error;
  }
}

const merged = { ...fileEnv(), ...process.env };
let user = merged.QBIT_RPC_USER ?? "";
let password = merged.QBIT_RPC_PASSWORD ?? "";
let rpcUrl = merged.QBIT_RPC_URL ?? "";
if (merged.QBIT_CONF) {
  const conf = parseQbitConf(readFileSync(resolve(String(merged.QBIT_CONF)), "utf8"));
  if (!user) user = conf.rpcuser ?? "";
  if (!password) password = conf.rpcpassword ?? "";
  if (!rpcUrl) rpcUrl = `http://127.0.0.1:${conf.rpcport || "8352"}/`;
}
if (!rpcUrl) throw new Error("set QBIT_RPC_URL (loopback) or QBIT_CONF");

let genesisId = "";
const manifestPath = merged.MANIFEST || profile.defaultManifest;
try {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, manifestPath), "utf8")) as { genesisId?: string };
  genesisId = manifest.genesisId ?? "";
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

if (!existsSync(resolve(REPO, "scripts/indexer-run.ts"))) throw new Error("the indexer is in the PINS repository that contains explorer/; run the explorer from that checkout");
if (!existsSync(resolve(REPO, "node_modules"))) throw new Error("run npm ci in the repository root first; the indexer uses its packages");

mkdirSync(resolve(ROOT, "data"), { recursive: true });

const launch = buildIndexerLaunch({
  rpcUrl,
  user,
  password,
  genesisId,
  db: resolve(ROOT, "data/index.sqlite"),
  port: Number(merged.INDEXER_PORT || "8787"),
  network: (merged.PINS_NETWORK as "mainnet" | "testnet4" | "regtest") || "mainnet",
  env: process.env,
});

const child = spawn(launch.command, launch.args, { cwd: REPO, env: launch.env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
