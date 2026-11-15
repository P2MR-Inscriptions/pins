// SPDX-License-Identifier: Apache-2.0
/** Read-only access to the local Qbit node. Only the methods below can be called. */
import { readCookie } from "../../packages/indexer/rpc.ts";
import { config } from "./config.ts";
import { redactSecrets } from "./redact.ts";

const ALLOWED = new Set(["getblockcount", "getblockhash", "getblockheader", "getrawtransaction"]);

export const rpcEnabled = (): boolean => config.rpc !== null;

/** The cookie of the latest call, kept only so that an error text can be scrubbed of it. */
let cookieSecrets: string[] = [];

/** Every secret of the login in use. An error text goes through `redactSecrets` with these before the browser sees it. */
export function rpcSecrets(): string[] {
  if (!config.rpc) return [];
  return [config.rpc.user, config.rpc.password, ...cookieSecrets].filter((secret) => secret !== "");
}

export function assertRpcMethod(method: string): void {
  if (!ALLOWED.has(method)) throw new Error("RPC method is not allowed");
}

export async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  if (!config.rpc) throw new Error("node RPC is not configured");
  assertRpcMethod(method);
  // A cookie is read again for every call, so a node that restarts and writes a new one needs no restart here.
  const login = config.rpc.cookieFile !== undefined ? await readCookie(config.rpc.cookieFile) : config.rpc;
  if (config.rpc.cookieFile !== undefined) cookieSecrets = [login.user, login.password];
  const secrets = [login.user, login.password];
  const auth = Buffer.from(`${login.user}:${login.password}`).toString("base64");
  let response: Response;
  try {
    response = await fetch(config.rpc.url, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
      body: JSON.stringify({ jsonrpc: "1.0", id: "pins-explorer", method, params }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    // No `cause`: the original error can hold the login, and only the scrubbed text goes on.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(redactSecrets(error instanceof Error ? error.message : "node unreachable", secrets) || "node unreachable");
  }
  const text = await response.text();
  let body: { result?: T; error?: { message?: string } | null };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`node answered HTTP ${response.status} without JSON`);
  }
  if (body.error) throw new Error("node RPC rejected the call");
  return body.result as T;
}

let probe: { at: number; ok: boolean; height?: number; error?: string } | null = null;

/** Cached for 15 seconds. The browser only sees a short status, never the node text. */
export async function rpcProbe(): Promise<{ enabled: boolean; reachable?: boolean; height?: number; error?: string }> {
  if (!config.rpc) return { enabled: false };
  if (!probe || Date.now() - probe.at > 15_000) {
    try {
      probe = { at: Date.now(), ok: true, height: await rpc<number>("getblockcount") };
    } catch {
      probe = { at: Date.now(), ok: false, error: "node RPC failed" };
    }
  }
  return { enabled: true, reachable: probe.ok, height: probe.height, error: probe.error };
}
