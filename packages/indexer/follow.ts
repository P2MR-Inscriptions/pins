// SPDX-License-Identifier: Apache-2.0

/**
 * Follow a node of the chain the caller names: regtest unless the caller names testnet4 or mainnet.
 * The node's chain must match that name, and any other chain is refused.
 * A reorg is detected when the stored hash at a height is not the node's hash, or when a fetched
 * block does not build on the stored tip. The indexer disconnects back to the fork and applies the new blocks.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hexToBytes } from "@qbit-oss/protocol";
import { isP2mr } from "./address.ts";
import { parseTransaction, toChainBlock, type RpcBlock } from "./chain.ts";
import { rpcChainName, type FollowNetwork } from "./chains.ts";
import { curlRpcInvocation, redactSecrets, CURL_TIMEOUT_SECONDS } from "./rpc-curl.ts";
import { Store } from "./store.ts";

export type Rpc = {
  call<T>(method: string, params?: unknown[]): Promise<T>;
};

/**
 * A node call that failed. `retry` is false only when repeating the call cannot
 * help: curl is missing, or it refused the URL or the protocol. `pollChain`
 * waits and retries every other `RpcError`, because a node that restarts,
 * answers late, or is still loading its block index recovers by itself.
 */
export class RpcError extends Error {
  readonly retry: boolean;
  constructor(message: string, retry = true) {
    super(message);
    this.name = "RpcError";
    this.retry = retry;
  }
}

type ChainInfo = { chain: string; blocks: number; bestblockhash: string };

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
/** curl exit codes for an unsupported protocol, a failed init, and a malformed URL. */
const CURL_FATAL = new Set([1, 2, 3]);

type CurlRun = { status: number | null; stdout: string; stderr: string; error?: Error };

/** Run curl without blocking the event loop. The credentials go to its stdin, never to its arguments. */
function runCurl(args: string[], input: string, timeoutSeconds: number): Promise<CurlRun> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("curl", args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ status: null, stdout: "", stderr: "", error: error as Error });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let failure: Error | undefined;
    let settled = false;
    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve({ status, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), error: failure });
    };
    // curl has its own limit (-m). This one only catches a curl that hangs past it.
    const guard = setTimeout(() => {
      failure = new Error("curl did not stop");
      child.kill("SIGKILL");
    }, (timeoutSeconds + 10) * 1000);
    child.on("error", (error) => {
      failure = error;
      finish(null);
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > MAX_RESPONSE_BYTES) {
        failure = new Error("response is larger than 64 MiB");
        child.kill("SIGKILL");
        return;
      }
      out.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (errBytes < MAX_STDERR_BYTES) err.push(chunk);
      errBytes += chunk.length;
    });
    child.on("close", (status) => finish(status));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
  });
}

export async function rpcCall(url: string, user: string, password: string, method: string, params: unknown[] = []): Promise<unknown> {
  const dir = mkdtempSync(join(tmpdir(), "pins-rpc-"));
  const file = join(dir, "body.json");
  try {
    writeFileSync(file, JSON.stringify({ jsonrpc: "1.0", id: "indexer", method, params }), { mode: 0o600 });
    const invocation = curlRpcInvocation(url, user, password, file);
    const run = await runCurl(invocation.args, invocation.input, CURL_TIMEOUT_SECONDS);
    const failed = redactSecrets(run.stderr || run.error?.message || run.stdout || "no response", [user, password]);
    if (run.error || run.status !== 0 || !run.stdout) {
      const missing = (run.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
      throw new RpcError(`${method} failed: ${failed}`, !missing && !(run.status !== null && CURL_FATAL.has(run.status)));
    }
    let body: { result: unknown; error: { message: string } | null };
    try {
      body = JSON.parse(run.stdout) as { result: unknown; error: { message: string } | null };
    } catch {
      throw new RpcError(`${method} failed: response was not JSON`);
    }
    if (body.error) throw new RpcError(`${method} failed: ${redactSecrets(body.error.message || "RPC error", [user, password])}`);
    return body.result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function httpRpc(url: string, user: string, password: string): Rpc {
  return { call: (method, params) => rpcCall(url, user, password, method, params) as Promise<never> };
}

/**
 * Index from `activationHeight` through the node's tip.
 * Blocks below the activation height are not fetched.
 * The default network is regtest. Testnet4 and mainnet are followed only when
 * `network` names them, and the node's `chain` must match (`main` for mainnet).
 */
export async function follow(store: Store, rpc: Rpc, activationHeight = 0, network: FollowNetwork = "regtest"): Promise<{ height: number; stateHash: string | null; blocks: number }> {
  if (store.indexer.network !== network) throw new Error(`this store indexes ${store.indexer.network}; it was asked to follow ${network}`);
  const info = await rpc.call<ChainInfo>("getblockchaininfo");
  const expected = rpcChainName(network);
  if (info.chain !== expected) throw new Error(`refusing chain ${info.chain}; this indexer was asked to follow ${network} (node chain ${expected})`);
  store.bindActivation(activationHeight);
  let disconnects = 0;
  let parentMisses = 0;
  while (true) {
    const height = await rpc.call<number>("getblockcount");
    const tip = store.tip();
    if (tip && (tip.height > height)) {
      store.disconnect();
      disconnects += 1;
      if (disconnects > 1_000) throw new Error("reorg did not settle after 1000 disconnects");
      continue;
    }
    if (tip) {
      const nodeHash = await rpc.call<string>("getblockhash", [tip.height]);
      if (nodeHash !== tip.hash) {
        store.disconnect();
        disconnects += 1;
        if (disconnects > 1_000) throw new Error("reorg did not settle after 1000 disconnects");
        continue;
      }
    }
    disconnects = 0;
    const next = (tip?.height ?? activationHeight - 1) + 1;
    if (next > height) break;
    const hash = await rpc.call<string>("getblockhash", [next]);
    const block = await rpc.call<RpcBlock>("getblock", [hash, 3]);
    // The tip was checked against the node a moment ago, and the chain can move before this block arrives.
    // A block that does not build on the stored tip is part of another chain: unwind and ask again.
    if (tip && block.previousblockhash !== undefined && block.previousblockhash !== tip.hash) {
      store.disconnect();
      parentMisses += 1;
      if (parentMisses > 1_000) throw new Error("reorg did not settle after 1000 disconnects");
      continue;
    }
    // An output created earlier in this block is not a pre-activation output.
    // Saving it here would collide with the commit of that same outpoint.
    // toChainBlock reads it from the block as it walks the transactions.
    const createdHere = new Set(block.tx.map((item) => item.txid));
    for (const tx of block.tx) {
      const parsed = parseTransaction(hexToBytes(tx.hex));
      for (const input of parsed.inputs) {
        if (input.coinbase || !input.prevTxid || input.prevVout === undefined) continue;
        if (createdHere.has(input.prevTxid)) continue;
        if (store.outputValue(input.prevTxid, input.prevVout) !== undefined) continue;
        const prev = await rpc.call<{ hex: string }>("getrawtransaction", [input.prevTxid, true]);
        const parent = parseTransaction(hexToBytes(prev.hex));
        const output = parent.outputs[input.prevVout];
        if (!output) throw new Error(`output ${input.prevTxid}:${input.prevVout} is missing`);
        store.saveOutput(input.prevTxid, input.prevVout, output.value, isP2mr(output.script));
      }
    }
    const chainBlock = toChainBlock(block, (txid, vout) => store.outputValue(txid, vout), network, (txid, vout) => store.outputIsP2mr(txid, vout));
    store.commit(chainBlock);
    parentMisses = 0;
  }
  const tip = store.tip();
  return { height: tip?.height ?? -1, stateHash: tip?.stateHash ?? null, blocks: tip ? tip.height - activationHeight + 1 : 0 };
}

export type PollRetry = {
  /** First wait after a failed node call. Each further failure doubles it. Default 1,000 ms. */
  initialMs?: number;
  /** The longest wait between two tries. Default 60,000 ms. */
  maxMs?: number;
  /** Failures in a row after which `pollChain` gives up and throws. Default 30. */
  maxFailures?: number;
};

/**
 * After the first catch-up, keep polling. A new height or a new tip hash
 * calls `follow` again, which uses the undo log for a reorg.
 * `getblockcount` and `getbestblockhash` are the only calls while the tip is still.
 *
 * A node call that fails with an `RpcError` (the node restarts, a call times out,
 * the block index is still loading) is logged and tried again after a growing
 * wait. Any other error stops the poll: a chain the indexer refuses, a reorg
 * deeper than the undo log, a pruned witness, or a store that cannot be
 * written is not something a retry fixes. After `maxFailures` failed calls in a
 * row the last error is thrown, so a node that stays away is not hidden.
 */
export async function pollChain(store: Store, rpc: Rpc, activationHeight = 0, network: FollowNetwork = "regtest", options: {
  intervalMs: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  onIdle?: (tip: { height: number; hash: string } | null) => void;
  log?: (line: string) => void;
  retry?: PollRetry;
} ): Promise<void> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const initialMs = options.retry?.initialMs ?? 1_000;
  const maxMs = options.retry?.maxMs ?? 60_000;
  const maxFailures = options.retry?.maxFailures ?? 30;
  let failures = 0;
  while (!options.signal?.aborted) {
    try {
      const height = await rpc.call<number>("getblockcount");
      const best = await rpc.call<string>("getbestblockhash");
      const tip = store.tip();
      if (!tip || tip.height !== height || tip.hash !== best) {
        log(`chain moved to ${best} at height ${height}; syncing`);
        await follow(store, rpc, activationHeight, network);
        const next = store.tip();
        log(`indexer height ${next?.height ?? -1}`);
      }
    } catch (error) {
      if (!(error instanceof RpcError) || !error.retry) throw error;
      failures += 1;
      if (failures >= maxFailures) throw error;
      const wait = Math.min(maxMs, initialMs * 2 ** (failures - 1));
      log(`node call failed (${error.message}); try ${failures} of ${maxFailures}, next in ${Math.round(wait / 100) / 10}s`);
      if (options.signal?.aborted) return;
      await sleep(wait);
      continue;
    }
    if (failures > 0) log(`node answers again after ${failures} failed ${failures === 1 ? "call" : "calls"}`);
    failures = 0;
    const current = store.tip();
    options.onIdle?.(current ? { height: current.height, hash: current.hash } : null);
    if (options.signal?.aborted) return;
    await sleep(options.intervalMs);
  }
}
