// SPDX-License-Identifier: Apache-2.0

/**
 * The JSON-RPC client for a Qbit Core node: Node's built-in `fetch`, no dependency.
 *
 * Two kinds of credentials, as in `@qbit-oss/rpc`: a user and a password, or the node's cookie file
 * (`<datadir>/.cookie`, with the network's own subdirectory for regtest and testnet4). The cookie is read again
 * for every call, so a node that restarts and writes a new cookie needs no restart here. A cookie is accepted
 * only for a loopback URL. Credentials go in the `Authorization` header only: never in the URL, in an argument,
 * in a log line or in an error.
 */
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { FollowNetwork } from "./chains.ts";

export type RpcAuth = { user: string; password: string } | { cookieFile: string };

/**
 * A node call that failed. `retry` is false only when repeating the call cannot help: bad credentials, a cookie
 * file that cannot be read, a refused URL. `pollChain` waits and retries every other `RpcError`, because a node
 * that restarts, answers late, or is still loading its block index recovers by itself.
 */
export class RpcError extends Error {
  readonly retry: boolean;
  constructor(message: string, retry = true) {
    super(message);
    this.name = "RpcError";
    this.retry = retry;
  }
}

/** Total time one call may take. */
export const RPC_TIMEOUT_MS = 180_000;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
/** The node's cookie is `__cookie__:` and 64 hex digits. Anything larger is not one. */
const MAX_COOKIE_BYTES = 1024;
/** A character that cannot be in a header value or a one-line credential: C0 controls and DEL. */
const CONTROL = { test: (text: string): boolean => [...text].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) };

function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

function isLoopback(url: URL): boolean {
  const host = hostOf(url);
  return host === "localhost" || /^127(\.\d{1,3}){3}$/.test(host) || host === "::1" || host === "::ffff:127.0.0.1";
}

export function assertRpcEndpoint(url: string, auth?: RpcAuth): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("RPC URL is not valid");
  }
  if (parsed.username || parsed.password) throw new Error("RPC URL must not contain credentials");
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("RPC URL must be http or https");
  if (auth && "cookieFile" in auth && !isLoopback(parsed)) throw new Error("a cookie file is accepted only for an RPC URL on this machine (127.0.0.1, ::1 or localhost)");
}

/** The user and password of an RPC login, checked. A user cannot hold `:` (Basic authentication splits there). */
export function checkLogin(user: string, password: string): void {
  if (user === "" || user.includes(":") || CONTROL.test(user)) throw new Error('the RPC user must be a non-empty single line without ":"');
  if (password === "" || CONTROL.test(password)) throw new Error("the RPC password must be a non-empty single line");
}

/** Where a node keeps its cookie: the data directory for mainnet, a subdirectory named for the network otherwise. */
export function cookieFileIn(datadir: string, network: FollowNetwork): string {
  return join(datadir, network === "mainnet" ? "" : network, ".cookie");
}

/**
 * Read the cookie file: `user:password` and at most one line end, up to 1 KiB. The error names the cause
 * (`ENOENT`, `EACCES`, `ETOOBIG`, `EMALFORMED`) and never the content. A missing or half-written file is retried,
 * because a node writes it a moment after it starts.
 */
export async function readCookie(path: string): Promise<{ user: string; password: string }> {
  let text: string;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(MAX_COOKIE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_COOKIE_BYTES) throw new RpcError("the RPC cookie file could not be used (ETOOBIG)", false);
    text = buffer.subarray(0, bytesRead).toString("utf8");
  } catch (error) {
    if (error instanceof RpcError) throw error;
    const code = (error as NodeJS.ErrnoException).code ?? "EREAD";
    throw new RpcError(`the RPC cookie file could not be read (${code})`, code === "ENOENT");
  } finally {
    await handle?.close();
  }
  const line = text.replace(/\r?\n$/, "");
  const at = line.indexOf(":");
  const user = line.slice(0, at);
  const password = line.slice(at + 1);
  if (at <= 0 || password === "" || CONTROL.test(line)) throw new RpcError("the RPC cookie file could not be used (EMALFORMED)", true);
  return { user, password };
}

/** Text made safe to show: each secret and a `user:password@` in a URL are replaced, and the text is cut short. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  const unique = [...secrets].filter((secret) => secret.length > 0).sort((a, b) => b.length - a.length);
  for (const secret of unique) out = out.split(secret).join("[redacted]");
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*:[^\s/@]*@/gi, "$1[redacted]@");
  return out.slice(0, 240);
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}

/** The whole body, or an error once it passes `MAX_RESPONSE_BYTES`. */
async function readBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new RpcError("the node's answer is too large");
  if (!response.body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) {
      await response.body.cancel().catch(() => undefined);
      throw new RpcError("the node's answer is too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function rpcCall(url: string, auth: RpcAuth, method: string, params: unknown[] = []): Promise<unknown> {
  assertRpcEndpoint(url, auth);
  const cookie = "cookieFile" in auth;
  const login = cookie ? await readCookie(auth.cookieFile) : auth;
  if (!cookie) checkLogin(login.user, login.password);
  const secrets = [login.user, login.password, Buffer.from(`${login.user}:${login.password}`, "utf8").toString("base64")];
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", authorization: basic(login.user, login.password) },
      body: JSON.stringify({ jsonrpc: "1.0", id: "indexer", method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    text = await readBody(response);
  } catch (error) {
    if (error instanceof RpcError) throw new RpcError(`${method} failed: ${error.message}`, error.retry);
    const named = error as { name?: string; message?: string; cause?: { code?: string; message?: string } };
    const why = named.name === "TimeoutError" ? `timed out after ${RPC_TIMEOUT_MS / 1000} s` : named.cause?.code ?? named.cause?.message ?? named.message ?? "no response";
    throw new RpcError(`${method} failed: ${redactSecrets(why, secrets)}`);
  }
  let body: { result?: unknown; error?: { message?: string } | null } | undefined;
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    body = undefined;
  }
  if (body && typeof body === "object" && body.error) throw new RpcError(`${method} failed: ${redactSecrets(body.error.message || "RPC error", secrets)}`);
  if (response.status === 401) {
    // A cookie changes when the node restarts, and the next call reads the new one. A wrong password stays wrong.
    throw new RpcError(`${method} failed: HTTP 401 (credentials rejected)`, cookie);
  }
  if (!response.ok) throw new RpcError(`${method} failed: HTTP ${response.status}`);
  if (!body || typeof body !== "object") throw new RpcError(`${method} failed: response was not JSON`);
  return body.result;
}

export type Rpc = {
  call<T>(method: string, params?: unknown[]): Promise<T>;
};

export function httpRpc(url: string, auth: RpcAuth): Rpc {
  assertRpcEndpoint(url, auth);
  return { call: (method, params) => rpcCall(url, auth, method, params) as Promise<never> };
}

/**
 * The login a command-line tool was given. Exactly one way: `--rpc-user` with `--rpc-password`, `--rpc-cookie-file`,
 * or `--rpc-datadir` (the node's data directory; the cookie in it is the one of `network`). Each has an
 * environment variable as a fallback: `QBIT_RPC_USER` with `QBIT_RPC_PASSWORD`, `QBIT_RPC_COOKIE_FILE`,
 * `QBIT_RPC_DATADIR`. A flag wins over the variable of the same kind. Two kinds at once is an error.
 */
export function rpcAuthFromFlags(flag: Record<string, string | boolean | undefined>, network: FollowNetwork, env: Record<string, string | undefined> = process.env): RpcAuth {
  const pick = (name: string, variable: string): string | undefined => {
    const value = flag[name];
    if (value !== undefined && typeof value !== "string") throw new Error(`--${name} needs a value`);
    return value !== undefined && value.length > 0 ? value : env[variable] || undefined;
  };
  const user = pick("rpc-user", "QBIT_RPC_USER");
  const password = pick("rpc-password", "QBIT_RPC_PASSWORD");
  const cookieFile = pick("rpc-cookie-file", "QBIT_RPC_COOKIE_FILE");
  const datadir = pick("rpc-datadir", "QBIT_RPC_DATADIR");
  const kinds = [user !== undefined || password !== undefined, cookieFile !== undefined, datadir !== undefined].filter(Boolean).length;
  if (kinds === 0) throw new Error("missing the RPC login: give --rpc-user and --rpc-password, or --rpc-cookie-file, or --rpc-datadir (or QBIT_RPC_USER and QBIT_RPC_PASSWORD, QBIT_RPC_COOKIE_FILE, QBIT_RPC_DATADIR)");
  if (kinds > 1) throw new Error("give one RPC login: --rpc-user with --rpc-password, or --rpc-cookie-file, or --rpc-datadir, not a mix");
  if (cookieFile !== undefined) return { cookieFile };
  if (datadir !== undefined) return { cookieFile: cookieFileIn(datadir, network) };
  if (!user) throw new Error("missing --rpc-user (or QBIT_RPC_USER)");
  if (!password) throw new Error("missing --rpc-password (or QBIT_RPC_PASSWORD)");
  checkLogin(user, password);
  return { user, password };
}
