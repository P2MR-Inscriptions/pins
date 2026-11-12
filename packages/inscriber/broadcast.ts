// SPDX-License-Identifier: Apache-2.0

/**
 * Submit a signed plan. The fan-out is confirmed before any reveal is sent.
 * Repeating the command is safe: a transaction already in a block is skipped.
 */
import { type Rpc } from "../indexer/follow.ts";
import { assertMarkerForNetwork, isPinsMarker, parseMarker } from "./marker.ts";
import { assertBroadcastNetwork, rpcChainName, type MintNetwork } from "./network.ts";
import type { MintPlan } from "./plan.ts";

type Found = { blockhash?: string };

async function lookup(rpc: Rpc, txid: string): Promise<"confirmed" | "mempool" | "absent"> {
  try {
    const tx = await rpc.call<Found>("getrawtransaction", [txid, true]);
    return tx.blockhash ? "confirmed" : "mempool";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("No such")) return "absent";
    throw error;
  }
}

async function submit(rpc: Rpc, raw: string, txid: string): Promise<void> {
  if (await lookup(rpc, txid) !== "absent") return;
  const accepted = await rpc.call<{ allowed: boolean; "reject-reason"?: string }[]>("testmempoolaccept", [[raw]]);
  if (!accepted[0]?.allowed) throw new Error(`${txid} rejected: ${accepted[0]?.["reject-reason"] ?? "unknown"}`);
  await rpc.call("sendrawtransaction", [raw]);
}

/**
 * Modified-fee step in bits. Larger than a reveal fee, so an earlier reveal
 * has a higher modified feerate than every later one. PINS-5 requires the
 * genesis reveal before any item, and the batches in increasing number order.
 * The delta is not paid; it only changes which transaction the miner selects.
 */
export const REVEAL_PRIORITY_STEP = 20_000_000;

export function revealFeeDelta(index: number, count: number): number {
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error("reveal index out of range");
  }
  return (count - index) * REVEAL_PRIORITY_STEP;
}

async function preferChainOrder(rpc: Rpc, reveals: { txid: string }[]): Promise<void> {
  for (let index = 0; index < reveals.length; index += 1) {
    if (await lookup(rpc, reveals[index].txid) !== "mempool") continue;
    await rpc.call("prioritisetransaction", [reveals[index].txid, 0, revealFeeDelta(index, reveals.length)]);
  }
}

/** Regtest blocks are produced on demand. Public blocks are slower (~70 s on testnet4). */
export const REGTEST_CONFIRM_TIMEOUT_MS = 30_000;
export const PUBLIC_CONFIRM_TIMEOUT_MS = 60 * 60 * 1000;
const REGTEST_POLL_MS = 1_000;
const PUBLIC_POLL_MS = 15_000;

export function confirmTimeoutMs(network: MintNetwork, mine: boolean, overrideSeconds?: number): number {
  if (overrideSeconds !== undefined) {
    if (!Number.isFinite(overrideSeconds) || overrideSeconds <= 0) throw new Error("--confirm-timeout must be a positive number of seconds");
    return Math.round(overrideSeconds * 1000);
  }
  // Mining one regtest block per attempt used to stop after about 30 s. Keep that bound.
  if (mine || network === "regtest") return REGTEST_CONFIRM_TIMEOUT_MS;
  return PUBLIC_CONFIRM_TIMEOUT_MS;
}

function confirmPollMs(network: MintNetwork): number {
  return network === "regtest" ? REGTEST_POLL_MS : PUBLIC_POLL_MS;
}

async function waitConfirmed(rpc: Rpc, txid: string, options: {
  mine: boolean;
  timeoutMs: number;
  pollMs: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}): Promise<void> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  let elapsed = 0;
  while (elapsed < options.timeoutMs) {
    const state = await lookup(rpc, txid);
    if (state === "confirmed") {
      log(`${txid} confirmed after ${Math.round(elapsed / 1000)}s`);
      return;
    }
    log(`waiting ${txid} ${Math.round(elapsed / 1000)}s / ${Math.round(options.timeoutMs / 1000)}s (${state})`);
    if (options.mine) {
      const address = String(await rpc.call("getnewaddress", ["mint"]));
      await rpc.call("generatetoaddress", [1, address]);
    }
    const step = Math.min(options.pollMs, options.timeoutMs - elapsed);
    // Regtest mining is the wait. Public nodes are polled, not hammered.
    if (!options.mine) await sleep(step);
    elapsed += step;
  }
  throw new Error(`${txid} was not confirmed within ${Math.round(options.timeoutMs / 1000)}s`);
}

export async function broadcastPlan(plan: MintPlan, rpc: Rpc, options: {
  network: MintNetwork;
  typed?: string;
  mine?: boolean;
  /** Seconds. Omitted: 30 s on regtest, 60 min on testnet4 and mainnet. */
  confirmTimeoutSeconds?: number;
  /** Override the poll gap. Regtest defaults to 1 s, public networks to 15 s. */
  confirmPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}): Promise<{ fanout: string; reveals: string[]; mempool: number }> {
  assertBroadcastNetwork(options.network, options.typed);
  if (plan.network !== options.network) throw new Error(`plan is ${plan.network}, broadcast was asked for ${options.network}`);
  if (!plan.signed) throw new Error("plan is not signed");
  const marker = parseMarker(plan.marker);
  assertMarkerForNetwork(marker, options.network);
  if (options.network === "testnet4" && isPinsMarker(marker)) throw new Error("testnet4 refuses the launch marker");
  if (options.mine && options.network !== "regtest") throw new Error("mining from this tool is regtest only");
  const wait = {
    mine: Boolean(options.mine),
    timeoutMs: confirmTimeoutMs(options.network, Boolean(options.mine), options.confirmTimeoutSeconds),
    pollMs: options.confirmPollMs ?? confirmPollMs(options.network),
    sleep: options.sleep,
    log: options.log,
  };
  const info = await rpc.call<{ chain: string }>("getblockchaininfo");
  const expected = rpcChainName(options.network);
  if (info.chain !== expected) throw new Error(`node chain is ${info.chain}, not ${expected}`);
  await submit(rpc, plan.fanout.raw, plan.fanout.txid);
  await waitConfirmed(rpc, plan.fanout.txid, wait);
  // Regtest mining can hold every reveal and still order them. A public miner
  // cannot. Confirm the genesis reveal, then each batch, before the next send.
  if (!options.mine) {
    let waiting = 0;
    for (const reveal of plan.reveals) {
      await submit(rpc, reveal.raw, reveal.txid);
      waiting = (await rpc.call<{ size: number }>("getmempoolinfo")).size;
      await waitConfirmed(rpc, reveal.txid, { ...wait, mine: false });
    }
    return { fanout: plan.fanout.txid, reveals: plan.reveals.map((reveal) => reveal.txid), mempool: waiting };
  }
  for (const reveal of plan.reveals) await submit(rpc, reveal.raw, reveal.txid);
  const mempool = await rpc.call<{ size: number }>("getmempoolinfo");
  await preferChainOrder(rpc, plan.reveals);
  for (const reveal of plan.reveals) await waitConfirmed(rpc, reveal.txid, { ...wait, mine: true });
  return { fanout: plan.fanout.txid, reveals: plan.reveals.map((reveal) => reveal.txid), mempool: mempool.size };
}
