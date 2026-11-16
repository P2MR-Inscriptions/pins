// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { parseRawBlock, rawBlockHex, rawBlockNeedsPrevouts, rpcBlockFromRaw, type RpcBlock } from "./chain.ts";

function coinbaseHex(tag: number): string {
  const script = Buffer.from([0x03, tag, 0x00, 0x00]);
  const value = Buffer.alloc(8);
  value.writeBigUInt64LE(50n);
  return Buffer.concat([
    Buffer.from([0x01, 0x00, 0x00, 0x00]),
    Buffer.from([0x01]),
    Buffer.alloc(32),
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    Buffer.from([script.length]),
    script,
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    Buffer.from([0x01]),
    value,
    Buffer.from([0x00]),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
  ]).toString("hex");
}

test("parseRawBlock reads transactions written by rawBlockHex", () => {
  const prev = "11".repeat(32);
  const hex = coinbaseHex(7);
  const block: RpcBlock = {
    hash: "22".repeat(32),
    height: 3,
    previousblockhash: prev,
    tx: [{ txid: "00", hex, vin: [{ coinbase: "03070000" }], vout: [{ scriptPubKey: { hex: "" } }] }],
  };
  const raw = parseRawBlock(Buffer.from(rawBlockHex(block), "hex"));
  assert.equal(raw.previousblockhash, prev);
  assert.equal(raw.txs.length, 1);
  assert.equal(raw.txs[0].hex, hex);
  assert.equal(rawBlockNeedsPrevouts(raw, () => undefined), false);
  const rpc = rpcBlockFromRaw(raw, block.hash, block.height);
  assert.equal(rpc.previousblockhash, prev);
  assert.equal(rpc.tx[0].hex, hex);
  assert.equal(rpc.tx[0].vin[0]?.coinbase, "00");
});

test("bytesFromRpcHex matches Buffer.from and refuses an invalid body", async () => {
  const { bytesFromRpcHex, parseRawBlock } = await import("./chain.ts");
  const hex = "ab".repeat(16);
  assert.deepEqual(bytesFromRpcHex(hex), Buffer.from(hex, "hex"));
  assert.throws(() => bytesFromRpcHex("abc"), /odd length/);
  assert.throws(() => bytesFromRpcHex("zz"), /not hexadecimal/);
  const prev = "11".repeat(32);
  const body = rawBlockHex({
    previousblockhash: prev,
    tx: [{ txid: "00", hex: coinbaseHex(1), vin: [{ coinbase: "00" }], vout: [{ scriptPubKey: { hex: "" } }] }],
  });
  const raw = parseRawBlock(bytesFromRpcHex(body), { includeHex: false });
  assert.equal(raw.previousblockhash, prev);
  assert.equal(raw.txs[0].hex, "");
  assert.equal(raw.txs.length, 1);
});
