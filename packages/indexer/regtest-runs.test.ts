// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hexToBytes } from "@qbit-oss/protocol";
import { parseTransaction, toChainBlock } from "./chain.ts";
import { Indexer } from "./pins.ts";

/**
 * Offline check of docs/specs/vectors/regtest/runs.json. The file records runs on a private regtest
 * node. This test needs no node: it parses each recorded reveal transaction, runs the reference
 * rules engine on it, and compares the P2MR Inscriptions with the ones the indexer reported then.
 */
const FILE = join(dirname(fileURLToPath(import.meta.url)), "../../docs/specs/vectors/regtest/runs.json");
const runs = JSON.parse(readFileSync(FILE, "utf8"));
test("every recorded reveal transaction gives the P2MR Inscriptions that were recorded", () => {
  assert.ok(runs.reveal_runs.length >= 20);
  for (const run of runs.reveal_runs) {
    if (!run.accepted) {
      // The node refused it, so it never reached a block and the indexer never saw it.
      assert.equal(run.p2mr_inscriptions.length, 0, run.name);
      assert.equal(typeof run.reject_reason, "string", run.name);
      continue;
    }
    const raw = hexToBytes(run.raw_hex);
    const parsed = parseTransaction(raw);
    assert.equal(parsed.inputs.length, 1, run.name);
    const block = toChainBlock(
      { hash: "11".repeat(32), height: 1200, tx: [{ txid: run.txid, hex: run.raw_hex, vin: [{ txid: run.commit.txid, vout: run.commit.vout }], vout: parsed.outputs.map((output) => ({ scriptPubKey: { hex: Buffer.from(output.script).toString("hex") } })) }] },
      () => BigInt(run.commit.value_bits),
      "regtest",
      () => true,
    );
    block.txs.unshift({ txid: "ee".repeat(32), inputs: [{ coinbase: true, value: 0n }], outputs: [{ value: block.subsidy, script: Uint8Array.from([0x52, 0x20, ...new Uint8Array(32).fill(7)]) }] });
    const indexer = new Indexer("regtest");
    indexer.applyBlock(block);
    const got = [...indexer.inscriptions.values()].sort((a, b) => a.number - b.number).map((item) => ({
      id: item.id,
      flags: [...item.flags].sort(),
      content_type: item.contentType,
      body_bytes: item.bodyLength,
      body_sha256: item.bodySha256,
      metadata_sha256: item.metadata ? createHash("sha256").update(item.metadata).digest("hex") : null,
      location: item.location.state === "located" ? `${item.location.vout}:${item.location.offset}` : item.location.state,
    }));
    const want = run.p2mr_inscriptions.map((item: Record<string, unknown>) => ({
      id: item.id,
      flags: [...(item.flags as string[])].sort(),
      content_type: item.content_type,
      body_bytes: item.body_bytes,
      body_sha256: item.body_sha256,
      metadata_sha256: item.metadata_sha256,
      location: `${item.vout}:${item.offset}`,
    }));
    assert.deepEqual(got, want, `${run.vector} ${run.name}`);
    assert.ok(Number.isInteger(run.mined_height), run.name);
  }
});

test("the recorded trade is a completed clean template with one SINGLE|ANYONECANPAY input", () => {
  const trade = runs.trade;
  const parsed = parseTransaction(hexToBytes(trade.trade_tx_hex));
  assert.equal(parsed.inputs.length, trade.input_witness_item_lengths.length);
  assert.equal(parsed.outputs.length, trade.outputs.length);
  parsed.outputs.forEach((output, index) => {
    assert.equal(String(output.value), trade.outputs[index].value_bits);
    assert.equal(Buffer.from(output.script).toString("hex"), trade.outputs[index].script);
  });
  parsed.inputs.forEach((input, index) => {
    assert.deepEqual(input.witness.map((item) => item.length), trade.input_witness_item_lengths[index]);
  });
  const types = parsed.inputs.map((input) => {
    const signature = input.witness[0];
    return signature.length === 3681 ? signature[signature.length - 1].toString(16) : "default";
  });
  assert.deepEqual(types, trade.input_sighash_types);
  assert.equal(trade.input_sighash_types.filter((type: string) => type === "83").length, 1);
  assert.equal(trade.new_location.vout, 1);
  assert.equal(trade.new_location.offset, "0");
});

test("the recorded reorganisation ends in the state of a fresh run", () => {
  const { states, fresh } = runs.reorg;
  assert.equal(states.at(-1).stateHash, fresh.stateHash);
  assert.equal(states.at(-1).p2mr_inscriptions, fresh.p2mr_inscriptions);
  assert.notEqual(states[1].stateHash, states.at(-1).stateHash);
  assert.equal(states[0].stateHash.length, 64);
});

test("the recorded listing check ends in missing-inputs once the spend is mined", () => {
  const listing = runs.listing_invalidated;
  assert.equal(listing.before_spend.allowed, true);
  assert.equal(listing.after_spend_mined.allowed, false);
  assert.equal(listing.after_spend_mined["reject-reason"], "missing-inputs");
});
