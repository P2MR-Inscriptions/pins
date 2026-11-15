// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { broadcastPlan, confirmTimeoutMs, PUBLIC_CONFIRM_TIMEOUT_MS, REGTEST_CONFIRM_TIMEOUT_MS } from "./broadcast.ts";
import type { MintPlan } from "./plan.ts";
import type { Rpc } from "../indexer/follow.ts";

function plan(network: MintPlan["network"], marker = "70696e73"): MintPlan {
  const reveal = (name: string, txid: string) => ({
    name,
    txid,
    weight: 1,
    fee: "1",
    commitValue: "1",
    commitAddress: "x",
    leaf: "00",
    control: "00",
    spentScript: "00",
    raw: txid,
    outputs: [],
  });
  return {
    version: 1,
    network,
    feeRate: 1,
    issuerPublic: "11".repeat(32),
    recoveryPublic: "22".repeat(32),
    creator: "c",
    sale: "s",
    change: "change",
    marker,
    root: "00".repeat(32),
    fanout: { raw: "fan", txid: "fan", fee: "1", spentValue: "1", spentScript: "00", leaf: "00", control: "00" },
    reveals: [reveal("genesis", "genesis"), reveal("batch-0", "batch")],
    signed: true,
  };
}

function node(chain: string, mode: "confirm-on-send" | "mine"): { rpc: Rpc; events: string[] } {
  const mempool = new Set<string>();
  const confirmed = new Set<string>();
  const events: string[] = [];
  const rpc: Rpc = {
    call: async <T>(method: string, params?: unknown[]): Promise<T> => {
      const first = String(params?.[0] ?? "");
      events.push(`${method}:${first}`);
      if (method === "getblockchaininfo") return { chain } as T;
      if (method === "getrawtransaction") {
        if (confirmed.has(first)) return { blockhash: "bb" } as T;
        if (mempool.has(first)) return {} as T;
        throw new Error("No such mempool transaction");
      }
      if (method === "testmempoolaccept") return [{ allowed: true }] as T;
      if (method === "sendrawtransaction") {
        if (mode === "confirm-on-send") confirmed.add(first);
        else mempool.add(first);
        return first as T;
      }
      if (method === "getmempoolinfo") return { size: mode === "confirm-on-send" ? confirmed.size : mempool.size } as T;
      if (method === "prioritisetransaction") return true as T;
      if (method === "getnewaddress") return "qbrt1qmint" as T;
      if (method === "generatetoaddress") {
        for (const txid of mempool) confirmed.add(txid);
        mempool.clear();
        return ["cc"] as T;
      }
      throw new Error(method);
    },
  };
  return { rpc, events };
}

test("a public broadcast confirms genesis before it sends the next reveal", async () => {
  const { rpc, events } = node("testnet4", "confirm-on-send");
  await broadcastPlan(plan("testnet4", "aabbccdd"), rpc, { network: "testnet4", typed: "testnet4", log: () => undefined });
  const genesisSent = events.indexOf("sendrawtransaction:genesis");
  const batchSent = events.indexOf("sendrawtransaction:batch");
  const genesisConfirmed = events.findIndex((event, index) => index > genesisSent && event === "getrawtransaction:genesis");
  assert.ok(genesisSent > events.indexOf("sendrawtransaction:fan"));
  assert.ok(genesisConfirmed > genesisSent);
  assert.ok(batchSent > genesisConfirmed);
});

test("regtest mining submits every reveal before it prioritises one", async () => {
  const { rpc, events } = node("regtest", "mine");
  const result = await broadcastPlan(plan("regtest"), rpc, { network: "regtest", mine: true, log: () => undefined });
  const priority = events.indexOf("prioritisetransaction:genesis");
  assert.ok(events.indexOf("sendrawtransaction:batch") < priority);
  assert.equal(result.mempool, 2);
});

test("mainnet broadcast requires the node to report chain main", async () => {
  const wrong = node("mainnet", "confirm-on-send");
  await assert.rejects(
    () => broadcastPlan(plan("mainnet"), wrong.rpc, { network: "mainnet", typed: "mainnet" }),
    /node chain is mainnet, not main/,
  );
  const right = node("main", "confirm-on-send");
  const result = await broadcastPlan(plan("mainnet"), right.rpc, { network: "mainnet", typed: "mainnet", log: () => undefined });
  assert.equal(result.reveals.length, 2);
});

test("public networks wait up to an hour and regtest keeps the short bound", () => {
  assert.equal(confirmTimeoutMs("regtest", false), REGTEST_CONFIRM_TIMEOUT_MS);
  assert.equal(confirmTimeoutMs("regtest", true), REGTEST_CONFIRM_TIMEOUT_MS);
  assert.equal(confirmTimeoutMs("testnet4", false), PUBLIC_CONFIRM_TIMEOUT_MS);
  assert.equal(confirmTimeoutMs("mainnet", false), PUBLIC_CONFIRM_TIMEOUT_MS);
  assert.equal(PUBLIC_CONFIRM_TIMEOUT_MS, 60 * 60 * 1000);
  assert.equal(confirmTimeoutMs("testnet4", false, 120), 120_000);
  assert.throws(() => confirmTimeoutMs("testnet4", false, 0), /confirm-timeout/);
});

test("a public wait polls, prints progress, and stops at the timeout", async () => {
  const { rpc, events } = node("testnet4", "mine");
  const lines: string[] = [];
  const slept: number[] = [];
  await assert.rejects(
    () => broadcastPlan(plan("testnet4", "aabbccdd"), rpc, {
      network: "testnet4",
      typed: "testnet4",
      confirmTimeoutSeconds: 2,
      confirmPollMs: 1_000,
      sleep: async (ms) => { slept.push(ms); },
      log: (line) => lines.push(line),
    }),
    /fan was not confirmed within 2s/,
  );
  assert.deepEqual(slept, [1_000, 1_000]);
  assert.ok(lines.some((line) => line.includes("waiting fan") && line.includes("mempool")));
  assert.equal(events.some((event) => event.startsWith("sendrawtransaction:genesis")), false);
});

test("broadcast skips a transaction that is already in a block", async () => {
  const { rpc, events } = node("regtest", "confirm-on-send");
  await rpc.call("sendrawtransaction", ["fan"]);
  await rpc.call("sendrawtransaction", ["genesis"]);
  await rpc.call("sendrawtransaction", ["batch"]);
  events.length = 0;
  await broadcastPlan(plan("regtest"), rpc, { network: "regtest", log: () => undefined });
  assert.equal(events.some((event) => event.startsWith("sendrawtransaction:")), false);
  assert.equal(events.some((event) => event.startsWith("testmempoolaccept:")), false);
});
