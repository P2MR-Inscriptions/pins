// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RpcBlock } from "./chain.ts";
import { pollChain, RpcError, type Rpc } from "./follow.ts";
import { Store } from "./store.ts";

const INTERVAL = 7;

function scratch(): { store: Store; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pins-poll-"));
  const store = new Store(join(dir, "index.sqlite"));
  return { store, done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** A node with no blocks. `script` says, for each poll, whether the poll's call to `getbestblockhash` fails. */
function emptyNode(script: ("fail" | "ok")[], failure: () => Error = () => new RpcError("getbestblockhash failed: connection refused")): { rpc: Rpc; polls: () => number } {
  let polls = 0;
  const rpc: Rpc = {
    call: async <T>(method: string): Promise<T> => {
      if (method === "getblockchaininfo") return { chain: "regtest", blocks: -1, bestblockhash: "00" } as T;
      if (method === "getblockcount") return -1 as T;
      if (method === "getbestblockhash") {
        // Called once per poll and nowhere else.
        const step = script[polls] ?? "ok";
        polls += 1;
        if (step === "fail") throw failure();
        return "00" as T;
      }
      throw new Error(method);
    },
  };
  return { rpc, polls: () => polls };
}

function run(store: Store, rpc: Rpc, stopAfterIdle: number, retry?: { initialMs?: number; maxMs?: number; maxFailures?: number }): Promise<{ sleeps: number[]; lines: string[] }> {
  const sleeps: number[] = [];
  const lines: string[] = [];
  const stop = new AbortController();
  let idles = 0;
  return pollChain(store, rpc, 0, "regtest", {
    intervalMs: INTERVAL,
    signal: stop.signal,
    retry,
    sleep: async (ms) => { sleeps.push(ms); },
    onIdle: () => { idles += 1; if (idles >= stopAfterIdle) stop.abort(); },
    log: (line) => lines.push(line),
  }).then(() => ({ sleeps, lines }));
}

test("pollChain waits and tries again when the node does not answer", async () => {
  const { store, done } = scratch();
  try {
    const { rpc } = emptyNode(["fail", "fail", "fail"]);
    const { sleeps, lines } = await run(store, rpc, 1, { initialMs: 10, maxMs: 1_000 });
    assert.deepEqual(sleeps, [10, 20, 40]);
    assert.equal(lines.filter((line) => line.startsWith("node call failed")).length, 3);
    assert.ok(lines.some((line) => /node answers again after 3 failed calls/.test(line)));
  } finally {
    done();
  }
});

test("the wait between tries stops growing at the maximum", async () => {
  const { store, done } = scratch();
  try {
    const { rpc } = emptyNode(["fail", "fail", "fail", "fail"]);
    const { sleeps } = await run(store, rpc, 1, { initialMs: 10, maxMs: 25, maxFailures: 10 });
    assert.deepEqual(sleeps, [10, 20, 25, 25]);
  } finally {
    done();
  }
});

test("pollChain gives up after the allowed number of failures in a row", async () => {
  const { store, done } = scratch();
  try {
    const { rpc, polls } = emptyNode(Array.from({ length: 10 }, () => "fail" as const));
    const sleeps: number[] = [];
    await assert.rejects(
      pollChain(store, rpc, 0, "regtest", { intervalMs: INTERVAL, sleep: async (ms) => { sleeps.push(ms); }, log: () => undefined, retry: { initialMs: 1, maxMs: 4, maxFailures: 4 } }),
      /getbestblockhash failed: connection refused/,
    );
    assert.equal(polls(), 4);
    assert.deepEqual(sleeps, [1, 2, 4]);
  } finally {
    done();
  }
});

test("a success clears the count of failures in a row", async () => {
  const { store, done } = scratch();
  try {
    const { rpc } = emptyNode(["fail", "ok", "fail", "ok", "fail", "ok"]);
    const { sleeps } = await run(store, rpc, 3, { initialMs: 10, maxFailures: 2 });
    assert.deepEqual(sleeps, [10, INTERVAL, 10, INTERVAL, 10]);
  } finally {
    done();
  }
});

test("an error that is not a node call failure stops the poll at once", async () => {
  const { store, done } = scratch();
  try {
    const sleeps: number[] = [];
    const { rpc } = emptyNode(["fail"], () => new Error("witness pruned"));
    await assert.rejects(pollChain(store, rpc, 0, "regtest", { intervalMs: INTERVAL, sleep: async (ms) => { sleeps.push(ms); }, log: () => undefined }), /witness pruned/);
    assert.equal(sleeps.length, 0);
    const unfixable = emptyNode(["fail"], () => new RpcError("getblockcount failed: curl is not installed", false));
    await assert.rejects(pollChain(store, unfixable.rpc, 0, "regtest", { intervalMs: INTERVAL, sleep: async (ms) => { sleeps.push(ms); }, log: () => undefined }), /not installed/);
    assert.equal(sleeps.length, 0);
  } finally {
    done();
  }
});

test("a call that fails in the middle of a catch-up is repeated and the index ends complete", async () => {
  const { store, done } = scratch();
  const hashes = ["11".repeat(32), "22".repeat(32), "33".repeat(32)];
  let failNext = true;
  const rpc: Rpc = {
    call: async <T>(method: string, params?: unknown[]): Promise<T> => {
      if (method === "getblockchaininfo") return { chain: "regtest", blocks: 2, bestblockhash: hashes[2] } as T;
      if (method === "getblockcount") return 2 as T;
      if (method === "getbestblockhash") return hashes[2] as T;
      if (method === "getblockhash") return hashes[Number(params?.[0])] as T;
      if (method === "getblock") {
        const at = hashes.indexOf(String(params?.[0]));
        if (at === 1 && failNext) {
          failNext = false;
          throw new RpcError("getblock failed: timed out");
        }
        const block: RpcBlock = {
          hash: hashes[at],
          height: at,
          tx: [{ txid: `${hashes[at].slice(0, 60)}000${at}`, hex: coinbase(at), vin: [{ coinbase: "030000" }], vout: [{ scriptPubKey: { hex: "" } }] }],
        };
        return block as T;
      }
      throw new Error(method);
    },
  };
  try {
    const { lines } = await run(store, rpc, 1, { initialMs: 1 });
    assert.equal(store.tip()?.height, 2);
    assert.ok(lines.some((line) => /getblock failed: timed out/.test(line)));
  } finally {
    done();
  }
});

function coinbase(tag: number): string {
  const script = Buffer.from([0x03, tag, 0x00, 0x00]);
  const value = Buffer.alloc(8);
  value.writeBigUInt64LE(50n);
  return Buffer.concat([
    Buffer.from([0x01, 0x00, 0x00, 0x00, 0x01]),
    Buffer.alloc(32),
    Buffer.from([0xff, 0xff, 0xff, 0xff, script.length]),
    script,
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0x01]),
    value,
    Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]),
  ]).toString("hex");
}
