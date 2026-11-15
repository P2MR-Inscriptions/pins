// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { decodePng, encodeCanonicalPng } from "../collection/canonical.mjs";
import { collectionView } from "../indexer/collection.ts";
import { stateHash } from "../indexer/hash.ts";
import { Indexer, bodyFacts, type ChainBlock, type ChainInput, type Inscription } from "../indexer/pins.ts";
import { VECTOR_DIR } from "../../scripts/vectors.ts";

const read = (name: string) => JSON.parse(readFileSync(join(VECTOR_DIR, name), "utf8"));
const bytes = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, "hex"));
const sha = (data: Buffer | Uint8Array): string => createHash("sha256").update(data).digest("hex");

type JsonBlock = { height: number; hash: string; subsidy: string; txs: { txid: string; inputs: Record<string, unknown>[]; outputs: { value: string; script_hex: string }[] }[] };

function chainBlock(block: JsonBlock): ChainBlock {
  return {
    height: block.height,
    hash: block.hash,
    subsidy: BigInt(block.subsidy),
    txs: block.txs.map((tx) => ({
      txid: tx.txid,
      inputs: tx.inputs.map((input): ChainInput => {
        if (input.coinbase) return { coinbase: true, value: 0n };
        const [prevTxid, vout] = String(input.prevout).split(":");
        return {
          prevTxid,
          prevVout: Number(vout),
          value: BigInt(String(input.value)),
          p2mr: input.p2mr as boolean,
          witnessItems: input.witness_items as number,
          ...(input.leaf_script_hex ? { leafScript: bytes(String(input.leaf_script_hex)) } : {}),
        };
      }),
      outputs: tx.outputs.map((output) => ({ value: BigInt(output.value), script: bytes(output.script_hex) })),
    })),
  };
}

function rows(indexer: Indexer) {
  return [...indexer.inscriptions.values()].sort((a, b) => a.number - b.number).map((item) => ({
    number: item.number,
    id: item.id,
    location: item.location.state === "located" ? `${item.location.txid}:${item.location.vout}:${item.location.offset}` : item.location.state,
    owner_script_hex: item.ownerScript,
    owner_address: item.ownerAddress,
    location_height: item.locationHeight,
    flags: [...item.flags].sort(),
    content_type: item.contentType,
    body_sha256: item.bodySha256,
  }));
}

// A second reading of PINS-2 §4.4, written for this test. It shares no code with hash.ts or the generator.
function referenceStateHash(height: number, hash: string, list: { number: number; id: string; body_sha256: string; field1_hex: string; place: string; owner_address: string; location_height: number; flags: string[] }[]): string {
  const parts: Buffer[] = [];
  const line = (buffer: Buffer) => { if (parts.length) parts.push(Buffer.from([0x0a])); parts.push(buffer); };
  line(Buffer.from(`block ${height} ${hash}`));
  for (const row of [...list].sort((a, b) => a.number - b.number)) {
    const raw = Buffer.from(row.field1_hex, "hex").toString("latin1").replace(/%/g, "%25").replace(/\n/g, "%0a");
    line(Buffer.concat([
      Buffer.from(`${row.number} ${row.id} ${row.body_sha256} `),
      Buffer.from(raw, "latin1"),
      Buffer.from(` ${row.place} ${row.owner_address} ${row.location_height} ${[...row.flags].sort().join(",")}`),
    ]));
  }
  return sha(Buffer.concat(parts));
}

test("ownership and numbering vectors: the rules engine reproduces the table and the state hash after every block", () => {
  for (const file of ["ownership.json", "numbering.json"]) {
    for (const entry of read(file).cases) {
      const indexer = new Indexer("mainnet");
      entry.blocks.forEach((block: JsonBlock, index: number) => {
        indexer.applyBlock(chainBlock(block));
        assert.equal(stateHash(indexer, { height: block.height, hash: block.hash }), entry.state_hashes[index].state_hash, `${entry.name}, block ${block.height}`);
      });
      assert.deepEqual(rows(indexer), entry.expected, entry.name);
    }
  }
});

test("TV2-2: a reorganisation of depth 2 ends in the state of a fresh run, and numbers are reused", () => {
  const vector = read("chain.json").reorg;
  const block = (label: string) => chainBlock(vector.blocks[label]);
  const indexer = new Indexer("mainnet");
  vector.steps.forEach((step: { action: string; block: string; table: unknown[]; state_hash?: string }) => {
    if (step.action === "connect") indexer.applyBlock(block(step.block));
    else indexer.disconnectTip(vector.blocks[step.block].hash);
    assert.deepEqual(rows(indexer), step.table, `${step.action} ${step.block}`);
    if (step.state_hash) assert.equal(stateHash(indexer, { height: vector.blocks[step.block].height, hash: vector.blocks[step.block].hash }), step.state_hash);
  });
  const fresh = new Indexer("mainnet");
  for (const label of ["tv2-2 common", "tv2-2 b701", "tv2-2 b702", "tv2-2 b703"]) fresh.applyBlock(block(label));
  const tip = vector.blocks["tv2-2 b703"];
  assert.equal(stateHash(fresh, { height: tip.height, hash: tip.hash }), stateHash(indexer, { height: tip.height, hash: tip.hash }));
  assert.deepEqual(rows(fresh), rows(indexer));
});

test("TV2-4: a block with a P2MR spend that has no witness is refused and changes nothing", () => {
  const vector = read("chain.json").missing_witness;
  const indexer = new Indexer("mainnet");
  indexer.applyBlock(chainBlock(vector.applied_before));
  assert.deepEqual(rows(indexer), vector.table_unchanged);
  assert.throws(() => indexer.applyBlock(chainBlock(vector.refused_block)), (error: Error) => error.message === vector.error);
  assert.deepEqual(rows(indexer), vector.table_unchanged);
});

test("state hash vectors agree with a separate reading of PINS-2 §4.4", () => {
  const vector = read("state-hash.json");
  const empty = vector.empty_state;
  assert.equal(referenceStateHash(empty.height, empty.block_hash, []), empty.state_hash);
  assert.equal(stateHash(new Indexer("mainnet"), { height: empty.height, hash: empty.block_hash }), empty.state_hash);
  for (const entry of vector.field1_cases) {
    const block: JsonBlock = entry.block;
    const indexer = new Indexer("mainnet");
    indexer.applyBlock(chainBlock(block));
    assert.equal(stateHash(indexer, { height: block.height, hash: block.hash }), entry.state_hash, entry.name);
    assert.equal(referenceStateHash(block.height, block.hash, [entry.row]), entry.state_hash, entry.name);
    assert.equal(sha(Buffer.from(entry.preimage_hex, "hex")), entry.state_hash, entry.name);
    const line = Buffer.from(entry.preimage_hex, "hex").toString("latin1").split("\n");
    assert.equal(line.length, 2, `${entry.name}: the field 1 value must not add a line`);
    if (entry.field1_hex !== null) {
      const raw = Buffer.from(entry.field1_hex, "hex").toString("latin1").replace(/%/g, "%25").replace(/\n/g, "%0a");
      assert.ok(line[1].includes(` ${raw} `) || entry.field1_hex === "", entry.name);
    }
  }
  const chain = vector.chain_case;
  assert.equal(referenceStateHash(chain.height, chain.block_hash, chain.rows), chain.state_hash);
  assert.equal(vector.mainnet_checkpoint.state_hash.length, 64);
});

test("authenticity vectors: the collection view gives the pieces the vector lists", async () => {
  const vector = read("authenticity.json");
  for (const entry of vector.cases) {
    const indexer = new Indexer("mainnet");
    entry.items.forEach((spec: Record<string, unknown>, index: number) => {
      const body = bytes(String(spec.body_hex));
      const item: Inscription = {
        id: String(spec.id), txid: String(spec.id).slice(0, 64), n: 0, number: index, location: { state: "unbound" }, flags: [],
        contentType: String(spec.content_type), ...bodyFacts(body), metadata: spec.field5_hex ? bytes(String(spec.field5_hex)) : null, fields: [],
        createdHeight: Number(spec.created_height), createdIndex: Number(spec.created_index), locationHeight: Number(spec.created_height),
        leafIssuer: String(spec.reveal_key), ownerScript: "", ownerAddress: "",
      };
      // The leaf list and the genesis share one transaction; its second P2MR Inscription has n 1.
      if (spec.label === "genesis") item.txid = "aa".repeat(32);
      if (spec.label === "leaf list") { item.txid = "aa".repeat(32); item.n = 1; }
      indexer.inscriptions.set(item.id, item);
    });
    const view = await collectionView(indexer, { tipHeight: 30, blockHash: () => null });
    const byLabel = new Map<string, string>(entry.items.map((spec: { label: string; id: string }) => [spec.id, spec.label]));
    const got = (view.pieces ?? []).map((piece) => ({ number: piece.number, authentic: piece.authentic, item: piece.inscriptionId ? byLabel.get(piece.inscriptionId) ?? null : null }));
    assert.deepEqual(got, entry.expected_pieces, entry.name);
    assert.equal(Boolean(view.closingId), entry.closing !== null, entry.name);
  }
  const set = vector.item_set_root;
  assert.equal(set.leaf_list_hex, set.items.map((item: { leaf: string }) => item.leaf).join(""));
});

test("TV4-2: the canonical PNG decodes to the pixels, and its scanlines hash is the rule's", () => {
  const vector = read("png.json");
  const png = Buffer.from(vector.png_hex, "hex");
  const pixels = Buffer.alloc(vector.width * vector.height * 4);
  for (let y = 0; y < vector.height; y += 1) {
    for (let x = 0; x < vector.width; x += 1) pixels.set(vector.palette[((x >> 2) + (y >> 2)) % 4], (y * vector.width + x) * 4);
  }
  assert.equal(sha(pixels), vector.rgba_sha256);
  assert.deepEqual(Buffer.from(decodePng(png).rgba), pixels);
  const idat: Buffer[] = [];
  const types: string[] = [];
  for (let offset = 8; offset < png.length; offset += 12 + png.readUInt32BE(offset)) {
    const type = png.toString("latin1", offset + 4, offset + 8);
    types.push(type);
    if (type === "IDAT") idat.push(png.subarray(offset + 8, offset + 8 + png.readUInt32BE(offset)));
  }
  assert.deepEqual(types, vector.chunk_types);
  assert.equal(sha(inflateSync(Buffer.concat(idat))), vector.scanlines_sha256);
  // The file hash holds for this zlib build. Another deflate stream is another file for the same pixels.
  assert.equal(sha(Buffer.from(encodeCanonicalPng(pixels, vector.width, vector.height).bytes)), vector.png_sha256);
});

test("TV6-2: the FIFO outcome of both trade templates", () => {
  for (const entry of read("trade.json").cases) {
    const indexer = new Indexer("mainnet");
    for (const block of entry.blocks as JsonBlock[]) indexer.applyBlock(chainBlock(block));
    assert.deepEqual(rows(indexer), entry.expected, entry.name);
  }
});
