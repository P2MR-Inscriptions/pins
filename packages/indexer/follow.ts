// SPDX-License-Identifier: Apache-2.0

/**
 * Follow a local regtest node. Any other chain name is refused.
 * A reorg is detected when the stored hash at a height is not the node's hash.
 * The indexer disconnects back to the fork and applies the new blocks.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hexToBytes } from "@qbit-oss/protocol";
import { isP2mr } from "./address.ts";
import { parseTransaction, toChainBlock, type RpcBlock } from "./chain.ts";
import { rpcChainName, type FollowNetwork } from "./chains.ts";
import { curlRpcInvocation, redactSecrets } from "./rpc-curl.ts";
import { Store } from "./store.ts";

export type Rpc = {
  call<T>(method: string, params?: unknown[]): Promise<T>;
};

type ChainInfo = { chain: string; blocks: number; bestblockhash: string };

export async function rpcCall(url: string, user: string, password: string, method: string, params: unknown[] = []): Promise<unknown> {
  const dir = mkdtempSync(join(tmpdir(), "pins-rpc-"));
  const file = join(dir, "body.json");
  try {
    writeFileSync(file, JSON.stringify({ jsonrpc: "1.0", id: "indexer", method, params }), { mode: 0o600 });
    const invocation = curlRpcInvocation(url, user, password, file);
    const run = spawnSync("curl", invocation.args, {
      input: invocation.input,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const failed = redactSecrets(run.stderr || run.error?.message || run.stdout || "no response", [user, password]);
    if (run.error || run.status !== 0 || !run.stdout) throw new Error(`${method} failed: ${failed}`);
    let body: { result: unknown; error: { message: string } | null };
    try {
      body = JSON.parse(run.stdout) as { result: unknown; error: { message: string } | null };
    } catch {
      throw new Error(`${method} failed: response was not JSON`);
    }
    if (body.error) throw new Error(`${method} failed: ${redactSecrets(body.error.message || "RPC error", [user, password])}`);
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
  const info = await rpc.call<ChainInfo>("getblockchaininfo");
  const expected = rpcChainName(network);
  if (info.chain !== expected) throw new Error(`refusing chain ${info.chain}; this indexer was asked to follow ${network} (node chain ${expected})`);
  let disconnects = 0;
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
    const chainBlock = toChainBlock(block, (txid, vout) => store.outputValue(txid, vout), (txid, vout) => store.outputIsP2mr(txid, vout));
    store.commit(chainBlock);
  }
  const tip = store.tip();
  return { height: tip?.height ?? -1, stateHash: tip?.stateHash ?? null, blocks: tip ? tip.height - activationHeight + 1 : 0 };
}

/**
 * After the first catch-up, keep polling. A new height or a new tip hash
 * calls `follow` again, which uses the undo log for a reorg.
 * `getblockcount` and `getbestblockhash` are the only calls while the tip is still.
 */
export async function pollChain(store: Store, rpc: Rpc, activationHeight = 0, network: FollowNetwork = "regtest", options: {
  intervalMs: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  onIdle?: (tip: { height: number; hash: string } | null) => void;
  log?: (line: string) => void;
} ): Promise<void> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  while (!options.signal?.aborted) {
    const height = await rpc.call<number>("getblockcount");
    const best = await rpc.call<string>("getbestblockhash");
    const tip = store.tip();
    if (!tip || tip.height !== height || tip.hash !== best) {
      log(`chain moved to ${best} at height ${height}; syncing`);
      await follow(store, rpc, activationHeight, network);
      const next = store.tip();
      log(`indexer height ${next?.height ?? -1}`);
    }
    const current = store.tip();
    options.onIdle?.(current ? { height: current.height, hash: current.hash } : null);
    if (options.signal?.aborted) return;
    await sleep(options.intervalMs);
  }
}
