// SPDX-License-Identifier: Apache-2.0

/**
 * `/pieces/N` must not JSON-encode a script as {"0":82,"1":32,…}.
 * The owner address is the address of that same output script.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encodeGenesisField } from "../inscriber/preflight.ts";
import { itemsLeaf } from "../inscriber/reveal.ts";
import { startApi } from "./api.ts";
import { addressOf } from "./address.ts";
import type { ChainBlock, ChainTx } from "./pins.ts";
import { Store } from "./store.ts";

function leafOf(number: number, body: Uint8Array, metadata: Uint8Array): Buffer {
  const preimage = Buffer.alloc(68);
  preimage.writeUInt32BE(number, 0);
  createHash("sha256").update(body).digest().copy(preimage, 4);
  createHash("sha256").update(metadata).digest().copy(preimage, 36);
  return createHash("sha256").update(preimage).digest();
}

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

test("/pieces/1 returns a hex location script and the address of that script", async () => {
  const body = Uint8Array.of(9, 8, 7);
  // CBOR { meta: { name: "#1", attributes: [] } }. The name must match the genesis prefix.
  // Kept as bytes so this test does not import the collection encoder.
  const metadata = Buffer.from("a1646d657461a2646e616d656223316a6174747269627574657380", "hex");
  const leaf = leafOf(1, body, metadata);
  // One leaf: the Merkle root is that leaf, not a hash of it.
  const root = Buffer.from(leaf).toString("hex");
  const genesis = new TextEncoder().encode("{\"name\":\"Shadow\"}");
  const field5 = await encodeGenesisField({
    schema: "pins-collection/1",
    name: "Set",
    supply: 1,
    first: 1,
    namePrefix: "#",
    itemType: "application/octet-stream",
    root,
    issuer: Buffer.from(PUBKEY).toString("hex"),
    saleCommitment: "11".repeat(32),
  });
  const dir = mkdtempSync(join(tmpdir(), "piece-hex-"));
  const store = new Store(join(dir, "a.sqlite"), { network: "regtest" });
  store.commit(block({
    hash: "g",
    height: 1,
    txs: [coinbase("c1"), {
      txid: "genesis",
      inputs: [{
        prevTxid: "00",
        prevVout: 0,
        value: 20_000n,
        leafScript: itemsLeaf(PUBKEY, [
          { body: genesis, contentType: "application/json", metadata: field5 },
          { body: new Uint8Array(leaf), contentType: "application/octet-stream" },
        ]),
      }],
      outputs: [{ value: 10_000n, script: SCRIPT }, { value: 10_000n, script: SCRIPT }],
    }],
  }));
  store.commit(block({
    hash: "p",
    height: 2,
    txs: [coinbase("c2"), {
      txid: "piece",
      inputs: [{
        prevTxid: "01",
        prevVout: 0,
        value: 10_000n,
        leafScript: itemsLeaf(PUBKEY, [{ body, contentType: "application/octet-stream", metadata }]),
      }],
      outputs: [{ value: 10_000n, script: SCRIPT }],
    }],
  }));
  const api = await startApi(store, 0, "regtest");
  try {
    const response = await fetch(`${api.url}/pieces/1`);
    assert.equal(response.status, 200);
    const piece = await response.json() as {
      authentic: boolean;
      inscriptionId: string;
      ownerAddress: string;
      ownerScript: string;
      location: { state: string; script?: unknown };
    };
    const scriptHex = Buffer.from(SCRIPT).toString("hex");
    assert.equal(piece.authentic, true);
    assert.equal(piece.location.state, "located");
    assert.equal(typeof piece.location.script, "string");
    assert.equal(piece.location.script, scriptHex);
    assert.match(String(piece.location.script), /^[0-9a-f]+$/);
    assert.equal(piece.ownerScript, scriptHex);
    assert.equal(piece.ownerAddress, addressOf(SCRIPT, "regtest"));
    const row = await (await fetch(`${api.url}/inscription/${piece.inscriptionId}`)).json() as {
      location: { script: string };
      ownerScript: string;
      ownerAddress: string;
    };
    assert.equal(row.location.script, scriptHex);
    assert.equal(row.ownerScript, scriptHex);
    assert.equal(row.ownerAddress, piece.ownerAddress);
  } finally {
    await api.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
