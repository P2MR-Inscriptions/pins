// SPDX-License-Identifier: Apache-2.0

/**
 * The read-only API answers a bad request with a 4xx, refuses a Host header that is not a loopback name,
 * and serves an inscription whose recorded content type is not a plain header value.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { itemsLeaf } from "../inscriber/reveal.ts";
import { hostAllowed, servedContentType, startApi } from "./api.ts";
import type { ChainBlock, ChainTx } from "./pins.ts";
import { Store } from "./store.ts";

const PUBKEY = new Uint8Array(32).fill(9);
const SCRIPT = (() => {
  const script = new Uint8Array(34);
  script[0] = 0x52;
  script[1] = 0x20;
  script.set(new Uint8Array(32).fill(4), 2);
  return script;
})();

function block(partial: Omit<ChainBlock, "subsidy">): ChainBlock {
  return { subsidy: 50n, ...partial };
}

function coinbase(txid: string): ChainTx {
  return { txid, inputs: [{ coinbase: true, value: 50n }], outputs: [{ value: 50n, script: SCRIPT }] };
}

test("hostAllowed takes loopback names with any port, and the names the operator adds", () => {
  for (const host of ["127.0.0.1", "127.0.0.1:8787", "localhost", "LOCALHOST:80", "[::1]", "[::1]:8787"]) assert.equal(hostAllowed(host), true, host);
  assert.equal(hostAllowed(undefined), true);
  for (const host of ["example.com", "example.com:8787", "127.0.0.1.example.com", "localhost.evil.test", "10.0.0.5", "", "127.0.0.1:"]) assert.equal(hostAllowed(host), false, host);
  assert.equal(hostAllowed("indexer.internal:8787", ["indexer.internal"]), true);
  assert.equal(hostAllowed("other.internal", ["indexer.internal"]), false);
});

test("servedContentType keeps a plain value and turns anything else into bytes", () => {
  assert.equal(servedContentType("image/png"), "image/png");
  assert.equal(servedContentType("text/plain; charset=utf-8"), "text/plain; charset=utf-8");
  for (const value of ["", "image/png\r\nx-a: b", "text/\u0001plain", "text/é", "a\u007fb"]) assert.equal(servedContentType(value), "application/octet-stream", JSON.stringify(value));
});

function get(url: string, host?: string): Promise<{ status: number; contentType: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = request({ hostname: target.hostname, port: target.port, path: target.pathname + target.search, headers: host === undefined ? {} : { host } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, contentType: response.headers["content-type"], body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("the API refuses a foreign Host, answers a bad escape with 400, and reads an item with an odd content type", async () => {
  const dir = mkdtempSync(join(tmpdir(), "api-robust-"));
  const store = new Store(join(dir, "a.sqlite"), { network: "regtest" });
  store.bindActivation(1);
  store.commit(block({
    hash: "a",
    height: 1,
    txs: [coinbase("c1"), {
      txid: "t1",
      inputs: [{ prevTxid: "00", prevVout: 0, value: 20_000n, leafScript: itemsLeaf(PUBKEY, [{ body: Uint8Array.of(1, 2, 3), contentType: "image/png\u0001x" }]) }],
      outputs: [{ value: 10_000n, script: SCRIPT }],
    }],
  }));
  const api = await startApi(store, 0, "regtest", { allowedHosts: ["indexer.internal"] });
  try {
    const status = await get(`${api.url}/status`);
    assert.equal(status.status, 200);
    assert.equal((JSON.parse(status.body) as { activationHeight: number }).activationHeight, 1);

    const foreign = await get(`${api.url}/status`, "attacker.example:8787");
    assert.equal(foreign.status, 403);
    assert.equal((await get(`${api.url}/status`, "indexer.internal:8787")).status, 200);
    assert.equal((await get(`${api.url}/status`, "localhost:8787")).status, 200);

    for (const path of ["/inscription/%zz", "/content/%", "/output/%E0%A4%A"]) assert.equal((await get(`${api.url}${path}`)).status, 400, path);
    assert.equal((await get(`${api.url}/inscription/${"ab".repeat(32)}i0`)).status, 404);

    const rows = JSON.parse((await get(`${api.url}/inscriptions`)).body) as { inscriptions: { id: string; contentType: string }[] };
    assert.equal(rows.inscriptions.length, 1);
    assert.equal(rows.inscriptions[0].contentType, "image/png\u0001x");
    const content = await get(`${api.url}/content/${rows.inscriptions[0].id}`);
    assert.equal(content.status, 200);
    assert.equal(content.contentType, "application/octet-stream");
  } finally {
    await api.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
