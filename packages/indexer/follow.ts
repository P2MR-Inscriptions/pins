// SPDX-License-Identifier: Apache-2.0

/**
 * Follow a node of the chain the caller names: regtest unless the caller names testnet4 or mainnet.
 * The node's chain must match that name, and any other chain is refused.
 * A reorg is detected when the stored hash at a height is not the node's hash, or when a fetched
 * block does not build on the stored tip. The indexer disconnects back to the fork and applies the new blocks.
 *
 * Blocks are fetched with getblock verbosity 0 (raw bytes) and applied in height order. A bounded
 * window of later blocks may be prefetched in parallel; on a reorg or error that window is dropped.
 * Prevouts come from outputs this indexer has already stored. A block that spends an unknown output
 * is fetched again at verbosity 3 (undo data). A missing prevout is an error: there is no
 * getrawtransaction fallback. A pruned node may not have undo data. Catch-up writes blocks in
 * bounded SQLite transactions (default 64). An incomplete batch is not durable; follow resumes from
 * the last committed tip.
 */
import { hexToBytes } from "@qbit-oss/protocol";
import { isP2mr } from "./address.ts";
import { bitsFromRpcAmount } from "./amount.ts";
import { bytesFromRpcHex, chainBlockFromRaw, parseRawBlock, parseTransaction, rawBlockNeedsPrevouts, toChainBlock, type RawBlock, type RpcBlock } from "./chain.ts";
import { rpcChainName, type FollowNetwork } from "./chains.ts";
import { DEFAULT_PREFETCH, parsePrefetch } from "./prefetch.ts";
import { formatSyncLine, PROGRESS_INTERVAL_MS } from "./progress.ts";
import { httpRpc, rpcCall, RpcError, type Rpc } from "./rpc.ts";
import { DEFAULT_COMMIT_BATCH, Store } from "./store.ts";

export { httpRpc, rpcCall, RpcError, parsePrefetch, type Rpc };
export { DEFAULT_PREFETCH, MIN_PREFETCH, MAX_PREFETCH } from "./prefetch.ts";
export { DEFAULT_COMMIT_BATCH } from "./store.ts";

type ChainInfo = { chain: string; blocks: number; bestblockhash: string };

export type FollowOptions = {
  /** Blocks to fetch ahead of the next height. Default 8, range 1 to 32. */
  prefetch?: number;
  /** Blocks written in one SQLite transaction during catch-up. Default 64. */
  commitBatch?: number;
  log?: (line: string) => void;
  now?: () => number;
  /** Minimum gap between two progress lines, in milliseconds. Default 5,000. */
  progressIntervalMs?: number;
};

/**
 * Index from `activationHeight` through the node's tip.
 * Blocks below the activation height are not fetched.
 * The default network is regtest. Testnet4 and mainnet are followed only when
 * `network` names them, and the node's `chain` must match (`main` for mainnet).
 */
export async function follow(store: Store, rpc: Rpc, activationHeight = 0, network: FollowNetwork = "regtest", options: FollowOptions = {}): Promise<{ height: number; stateHash: string | null; blocks: number }> {
  if (store.indexer.network !== network) throw new Error(`this store indexes ${store.indexer.network}; it was asked to follow ${network}`);
  const info = await rpc.call<ChainInfo>("getblockchaininfo");
  const expected = rpcChainName(network);
  if (info.chain !== expected) throw new Error(`refusing chain ${info.chain}; this indexer was asked to follow ${network} (node chain ${expected})`);
  store.bindActivation(activationHeight);
  const prefetch = options.prefetch ?? DEFAULT_PREFETCH;
  if (prefetch !== parsePrefetch(String(prefetch))) throw new Error(`--prefetch must be an integer from 1 to 32`);
  const commitBatch = options.commitBatch ?? DEFAULT_COMMIT_BATCH;
  if (!Number.isInteger(commitBatch) || commitBatch < 1) throw new Error("commit batch must be a positive integer");
  const log = options.log;
  const now = options.now ?? Date.now;
  const progressEvery = options.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
  const startingHeight = store.tip()?.height ?? activationHeight - 1;
  if (log && info.blocks - startingHeight >= 100) {
    log("First sync can take several hours on mainnet. The HTTP API does not listen until this catch-up finishes.");
  }
  let disconnects = 0;
  let parentMisses = 0;
  const byHex = new Map<string, string>();
  const byVerbose = new Map<string, RpcBlock>();
  const hashAt = new Map<number, string>();
  const inflight = new Map<number, Promise<void>>();
  const discardPrefetch = () => {
    byHex.clear();
    byVerbose.clear();
    hashAt.clear();
    inflight.clear();
  };
  const preload = (from: number, tipHeight: number) => {
    const last = Math.min(from + prefetch - 1, tipHeight);
    for (let height = from; height <= last; height += 1) {
      if (inflight.has(height)) continue;
      inflight.set(height, (async () => {
        const hash = await rpc.call<string>("getblockhash", [height]);
        hashAt.set(height, hash);
        if (byHex.has(hash) || byVerbose.has(hash)) return;
        const got = await rpc.call<string | RpcBlock>("getblock", [hash, 0]);
        if (typeof got === "string") byHex.set(hash, got);
        else byVerbose.set(hash, got);
      })());
    }
  };
  store.startCommitBatch(commitBatch);
  let applied = 0;
  const startedAt = now();
  let lastProgress = startedAt;
  const report = (height: number, tipHeight: number, force = false) => {
    if (!log) return;
    const at = now();
    if (!force && at - lastProgress < progressEvery) return;
    const elapsed = (at - startedAt) / 1000;
    const rate = elapsed > 0 ? applied / elapsed : 0;
    const left = Math.max(0, tipHeight - height);
    const eta = rate > 0 ? left / rate : Number.POSITIVE_INFINITY;
    log(formatSyncLine(height, tipHeight, rate, eta, startingHeight + 1));
    lastProgress = at;
  };
  let nodeHeight = info.blocks;
  let checkTipHash = true;
  try {
  while (true) {
    const tip = store.tip();
    if (tip && tip.height > nodeHeight) {
      nodeHeight = await rpc.call<number>("getblockcount");
      if (tip.height > nodeHeight) {
        store.disconnect();
        discardPrefetch();
        disconnects += 1;
        checkTipHash = true;
        if (disconnects > 1_000) throw new Error("reorg did not settle after 1000 disconnects");
        continue;
      }
    }
    if (tip && checkTipHash) {
      const nodeHash = await rpc.call<string>("getblockhash", [tip.height]);
      if (nodeHash !== tip.hash) {
        store.disconnect();
        discardPrefetch();
        disconnects += 1;
        checkTipHash = true;
        if (disconnects > 1_000) throw new Error("reorg did not settle after 1000 disconnects");
        continue;
      }
      checkTipHash = false;
    }
    disconnects = 0;
    const next = (tip?.height ?? activationHeight - 1) + 1;
    if (next > nodeHeight) {
      nodeHeight = await rpc.call<number>("getblockcount");
      if (next > nodeHeight) break;
    }
    preload(next, nodeHeight);
    const inflightNext = inflight.get(next);
    if (inflightNext) {
      try {
        await inflightNext;
      } catch (error) {
        discardPrefetch();
        throw error;
      }
    }
    const hash = hashAt.get(next) ?? await rpc.call<string>("getblockhash", [next]);
    const loaded = await loadBlock(rpc, store, hash, next, byHex, byVerbose);
    byHex.delete(hash);
    byVerbose.delete(hash);
    hashAt.delete(next);
    inflight.delete(next);
    // The tip was checked against the node a moment ago, and the chain can move before this block arrives.
    // A block that does not build on the stored tip is part of another chain: unwind and ask again.
    if (tip && loaded.previousblockhash !== undefined && loaded.previousblockhash !== tip.hash) {
      store.disconnect();
      discardPrefetch();
      parentMisses += 1;
      checkTipHash = true;
      if (parentMisses > 1_000) throw new Error("reorg did not settle after 1000 disconnects");
      continue;
    }
    if (loaded.raw) {
      applyPrevoutsFromRaw(loaded.raw, store, loaded.rpc, loaded.hash, loaded.height);
      store.commit(chainBlockFromRaw(loaded.raw, loaded.hash, loaded.height, (txid, vout) => store.outputValue(txid, vout), network, (txid, vout) => store.outputIsP2mr(txid, vout)));
    } else {
      const block = loaded.rpc;
      if (!block) throw new Error(`block ${loaded.height} (${loaded.hash}) did not load`);
      applyPrevouts(block, store);
      store.commit(toChainBlock(block, (txid, vout) => store.outputValue(txid, vout), network, (txid, vout) => store.outputIsP2mr(txid, vout)));
    }
    parentMisses = 0;
    applied += 1;
    report(loaded.height, nodeHeight);
    }
    store.endCommitBatch();
    const tip = store.tip();
    if (applied > 0) report(tip?.height ?? startingHeight, tip?.height ?? startingHeight, true);
    return { height: tip?.height ?? -1, stateHash: tip?.stateHash ?? null, blocks: tip ? tip.height - activationHeight + 1 : 0 };
  } catch (error) {
    // Keep blocks already written in this catch-up. An incomplete open batch is committed first so a
    // later failure (a missing prevout, a node error) does not drop work that already applied.
    try {
      store.flushCommitBatch();
    } catch {
      store.abortCommitBatch();
    }
    store.endCommitBatch();
    throw error;
  }
}

/**
 * Load one block. Production nodes are asked for verbosity 0 (raw hex). Tests may
 * already return a verbosity-3 object. If a raw block spends an output this
 * store has not seen, verbosity 3 is fetched for that block only.
 */
type LoadedBlock = {
  hash: string;
  height: number;
  previousblockhash?: string;
  raw?: RawBlock;
  rpc?: RpcBlock;
};

async function loadBlock(rpc: Rpc, store: Store, hash: string, height: number, byHex: Map<string, string>, byVerbose: Map<string, RpcBlock>): Promise<LoadedBlock> {
  const cachedVerbose = byVerbose.get(hash);
  if (cachedVerbose) return { hash, height, previousblockhash: cachedVerbose.previousblockhash, rpc: cachedVerbose };
  let hex = byHex.get(hash);
  if (hex === undefined) {
    const got = await rpc.call<string | RpcBlock>("getblock", [hash, 0]);
    if (typeof got !== "string") return { hash, height, previousblockhash: got.previousblockhash, rpc: got };
    hex = got;
  }
  const raw = parseRawBlock(bytesFromRpcHex(hex), { includeHex: false });
  if (!rawBlockNeedsPrevouts(raw, (txid, vout) => store.outputValue(txid, vout))) {
    return { hash, height, previousblockhash: raw.previousblockhash, raw };
  }
  const verbose = await rpc.call<RpcBlock>("getblock", [hash, 3]);
  return { hash, height, previousblockhash: raw.previousblockhash, raw, rpc: verbose };
}

/**
 * Copy parent value and script from `vin[].prevout` into the store. A non-coinbase
 * input without a complete prevout fails, unless this store already has that output
 * or this block created it. There is no getrawtransaction fallback.
 */
/**
 * Seed the output map from verbosity-3 prevouts when a raw block spends an
 * output this store has not seen. Same rules as `applyPrevouts`.
 */
function applyPrevoutsFromRaw(raw: RawBlock, store: Store, verbose: RpcBlock | undefined, hash: string, height: number): void {
  const createdHere = new Set(raw.txs.map((item) => item.txid));
  for (let txIndex = 0; txIndex < raw.txs.length; txIndex += 1) {
    const tx = raw.txs[txIndex];
    for (let index = 0; index < tx.inputs.length; index += 1) {
      const input = tx.inputs[index];
      if (input.coinbase || !input.prevTxid || input.prevVout === undefined) continue;
      if (createdHere.has(input.prevTxid)) continue;
      const stored = store.outputValue(input.prevTxid, input.prevVout);
      const prev = verbose?.tx[txIndex]?.vin[index]?.prevout;
      const scriptHex = prev?.scriptPubKey?.hex;
      if (stored !== undefined) {
        if (prev && prev.value !== undefined) {
          const value = bitsFromRpcAmount(prev.value);
          if (stored !== value) throw new Error(`prevout value for ${input.prevTxid}:${input.prevVout} does not match the stored value`);
        }
        continue;
      }
      if (!prev || prev.value === undefined || typeof scriptHex !== "string") {
        throw new Error(`getblock verbosity 3 has no prevout for input ${input.prevTxid}:${input.prevVout} in block ${height} (${hash}). Undo data is required, which a pruned node may not have.`);
      }
      store.saveOutput(input.prevTxid, input.prevVout, bitsFromRpcAmount(prev.value), isP2mr(hexToBytes(scriptHex)));
    }
  }
}

export function applyPrevouts(block: RpcBlock, store: Store): void {
  const createdHere = new Set(block.tx.map((item) => item.txid));
  for (const tx of block.tx) {
    const parsed = parseTransaction(hexToBytes(tx.hex));
    for (let index = 0; index < parsed.inputs.length; index += 1) {
      const input = parsed.inputs[index];
      if (input.coinbase || !input.prevTxid || input.prevVout === undefined) continue;
      if (createdHere.has(input.prevTxid)) continue;
      const stored = store.outputValue(input.prevTxid, input.prevVout);
      const prev = tx.vin[index]?.prevout;
      const scriptHex = prev?.scriptPubKey?.hex;
      if (stored !== undefined) {
        if (prev && prev.value !== undefined) {
          const value = bitsFromRpcAmount(prev.value);
          if (stored !== value) throw new Error(`prevout value for ${input.prevTxid}:${input.prevVout} does not match the stored value`);
        }
        continue;
      }
      if (!prev || prev.value === undefined || typeof scriptHex !== "string") {
        throw new Error(`getblock verbosity 3 has no prevout for input ${input.prevTxid}:${input.prevVout} in block ${block.height} (${block.hash}). Undo data is required, which a pruned node may not have.`);
      }
      store.saveOutput(input.prevTxid, input.prevVout, bitsFromRpcAmount(prev.value), isP2mr(hexToBytes(scriptHex)));
    }
  }
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
  prefetch?: number;
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
        await follow(store, rpc, activationHeight, network, { prefetch: options.prefetch });
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
