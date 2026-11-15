// SPDX-License-Identifier: Apache-2.0

/**
 * Vectors that run the reference rules engine over small synthetic chains: ownership (TV3),
 * numbering and flags (TV2-3), reorganisation (TV2-2), a missing witness (TV2-4), the state hash
 * (PINS-2 §4.4) and the FIFO outcome of the two trade templates (TV6-2).
 * A synthetic chain is a list of blocks. A transaction lists its inputs (the spent outpoint, its
 * value, and the leaf script when the input is a reveal) and its outputs (value and script).
 * Every id is derived from a label, so the files are reproducible.
 */
import { createHash } from "node:crypto";
import { Indexer, type ChainBlock, type ChainInput, type ChainTx, type Inscription } from "../packages/indexer/pins.ts";
import { stateHash } from "../packages/indexer/hash.ts";
import { buildEnvelope, contentTypeField, pointerField, revealLeaf, type EnvelopeField } from "../packages/inscriber/script.ts";

type Json = Record<string, unknown>;

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const sha256 = (bytes: Uint8Array): Buffer => createHash("sha256").update(bytes).digest();
const tid = (label: string): string => sha256(text(label)).toString("hex");
const KEY = Buffer.alloc(32, 2);

/** A P2MR output script: OP_2 (0x52), push 32, the root. Roots here are filler bytes, not keys. */
const p2mr = (fill: number): Uint8Array => Uint8Array.from([0x52, 0x20, ...new Uint8Array(32).fill(fill)]);
const OPRET = Uint8Array.from([0x6a, 0x04, ...text("burn")]);
const ANCHOR = Uint8Array.from([0x51, 0x02, 0x4e, 0x73]);
const SUBSIDY = 21_000_000_000n;

const envelope = (label: string, extra: EnvelopeField[] = [], ct = "text/plain"): Uint8Array =>
  buildEnvelope([contentTypeField(ct), ...extra], text(label));
const leaf = (...envelopes: Uint8Array[]): Uint8Array => revealLeaf(KEY, envelopes);

type In = { from: string; vout: number; value: bigint; leaf?: Uint8Array };
type Out = { value: bigint; script: Uint8Array };
type Tx = { label: string; inputs: In[]; outputs: Out[] };
type Block = { height: number; label: string; txs: Tx[]; coinbase: Out[] };

const spend = (from: string, vout: number, value: bigint, scriptLeaf?: Uint8Array): In => ({ from, vout, value, leaf: scriptLeaf });
const out = (value: bigint, script: Uint8Array): Out => ({ value, script });
const txid = (label: string): string => tid(`tx ${label}`);
const blockHash = (label: string): string => tid(`block ${label}`);
const cbLabel = (block: Block): string => `coinbase of ${block.label}`;

function toChain(block: Block): ChainBlock {
  const cb: ChainTx = {
    txid: txid(cbLabel(block)),
    inputs: [{ coinbase: true, value: 0n }],
    outputs: block.coinbase,
  };
  const txs = block.txs.map((tx): ChainTx => ({
    txid: txid(tx.label),
    inputs: tx.inputs.map((input): ChainInput => ({
      prevTxid: txid(input.from),
      prevVout: input.vout,
      value: input.value,
      p2mr: true,
      witnessItems: input.leaf ? 3 : 2,
      ...(input.leaf ? { leafScript: input.leaf } : {}),
    })),
    outputs: tx.outputs,
  }));
  return { hash: blockHash(block.label), height: block.height, subsidy: SUBSIDY, txs: [cb, ...txs] };
}

function blockJson(block: Block): Json {
  const chain = toChain(block);
  return {
    height: chain.height,
    hash: chain.hash,
    subsidy: String(chain.subsidy),
    txs: chain.txs.map((tx) => ({
      txid: tx.txid,
      inputs: tx.inputs.map((input) => input.coinbase
        ? { coinbase: true }
        : {
            prevout: `${input.prevTxid}:${input.prevVout}`,
            value: String(input.value),
            p2mr: true,
            witness_items: input.witnessItems,
            ...(input.leafScript ? { leaf_script_hex: hex(input.leafScript) } : {}),
          }),
      outputs: tx.outputs.map((o) => ({ value: String(o.value), script_hex: hex(o.script) })),
    })),
  };
}

function snapshot(item: Inscription): Json {
  return {
    number: item.number,
    id: item.id,
    location: item.location.state === "located" ? `${item.location.txid}:${item.location.vout}:${item.location.offset}` : item.location.state,
    owner_script_hex: item.ownerScript,
    owner_address: item.ownerAddress,
    location_height: item.locationHeight,
    flags: [...item.flags].sort(),
    content_type: item.contentType,
    body_sha256: item.bodySha256,
  };
}

const table = (indexer: Indexer): Json[] => [...indexer.inscriptions.values()].sort((a, b) => a.number - b.number).map(snapshot);

/** What the author wrote down for one P2MR Inscription. The generator fails when the engine disagrees. */
type Want = { id: string; location: string; flags?: string[] };
const at = (label: string, vout: number, offset: number): string => `${txid(label)}:${vout}:${offset}`;
const id = (label: string, n: number): string => `${txid(label)}i${n}`;

function expectTable(name: string, indexer: Indexer, wants: Want[]): void {
  const rows = [...indexer.inscriptions.values()].sort((a, b) => a.number - b.number);
  if (rows.length !== wants.length) throw new Error(`${name}: ${rows.length} P2MR Inscriptions, expected ${wants.length}`);
  wants.forEach((want, index) => {
    const row = rows[index];
    const place = row.location.state === "located" ? `${row.location.txid}:${row.location.vout}:${row.location.offset}` : row.location.state;
    if (row.id !== want.id || place !== want.location || [...row.flags].sort().join(",") !== [...(want.flags ?? [])].sort().join(",")) {
      throw new Error(`${name}: number ${index} is ${row.id} at ${place} [${row.flags}], expected ${want.id} at ${want.location} [${want.flags ?? []}]`);
    }
  });
}

function runBlocks(blocks: Block[], indexer = new Indexer("mainnet")): Indexer {
  for (const block of blocks) indexer.applyBlock(toChain(block));
  return indexer;
}

const hashOf = (indexer: Indexer, block: Block): string => stateHash(indexer, { height: block.height, hash: blockHash(block.label) });

/** A chain case: blocks, the table after the last block, and the state hash after every block. */
function chainCase(name: string, description: string, blocks: Block[], wants: Want[]): Json {
  const indexer = new Indexer("mainnet");
  const hashes: Json[] = [];
  for (const block of blocks) {
    indexer.applyBlock(toChain(block));
    hashes.push({ height: block.height, block_hash: blockHash(block.label), state_hash: hashOf(indexer, block) });
  }
  expectTable(name, indexer, wants);
  return { name, description, blocks: blocks.map(blockJson), state_hashes: hashes, expected: table(indexer) };
}

// ---------------------------------------------------------------- TV3: ownership

const reveal = (label: string, value: bigint, envelopes: Uint8Array[], outputs: Out[], extra: In[] = []): Tx => ({
  label,
  inputs: [spend(`funding of ${label}`, 0, value, leaf(...envelopes)), ...extra],
  outputs,
});
const cbFor = (fees: bigint, ...scripts: Uint8Array[]): Out[] => (scripts.length === 1 ? [out(SUBSIDY + fees, scripts[0])] : []);

function ownershipVectors(): Json {
  const cases: Json[] = [];

  // TV3-1: a plain transfer, input 0 to output 0.
  cases.push(chainCase("TV3-1 transfer", "A reveal puts a P2MR Inscription on output 0, offset 0. A later transaction spends that output as input 0 and pays output 0. The P2MR Inscription follows its bit to the new output and owner.", [
    { height: 100, label: "tv3-1 reveal block", coinbase: cbFor(10_000n, p2mr(0xc0)), txs: [reveal("tv3-1 reveal", 20_000n, [envelope("tv3-1")], [out(10_000n, p2mr(0xa1))])] },
    { height: 101, label: "tv3-1 move block", coinbase: cbFor(5_000n, p2mr(0xc0)), txs: [{ label: "tv3-1 move", inputs: [spend("tv3-1 reveal", 0, 10_000n), spend("funding of tv3-1 move", 0, 5_000n)], outputs: [out(10_000n, p2mr(0xb1))] }] },
  ], [{ id: id("tv3-1 reveal", 0), location: at("tv3-1 move", 0, 0) }]));

  // TV3-2: two P2MR Inscriptions on one output, split, merge (input order wins), unequal split.
  cases.push(chainCase("TV3-2 split and merge", "Two P2MR Inscriptions X (offset 0) and Y (offset 10000) share output 0. A split sends each to its own output. A merge lists Y's output as input 0 and X's as input 1, so Y lands at offset 0 and X at offset 10000: input order decides, not output order. Two later splits show offsets counted from the start of the output.", [
    { height: 200, label: "tv3-2 reveal block", coinbase: cbFor(20_000n, p2mr(0xc0)), txs: [reveal("tv3-2 reveal", 40_000n, [envelope("X"), envelope("Y", [pointerField(10_000n)])], [out(20_000n, p2mr(0xa1))])] },
    { height: 201, label: "tv3-2 split block", coinbase: cbFor(0n, p2mr(0xc0)), txs: [{ label: "tv3-2 split", inputs: [spend("tv3-2 reveal", 0, 20_000n)], outputs: [out(10_000n, p2mr(0xa2)), out(10_000n, p2mr(0xa3))] }] },
    { height: 202, label: "tv3-2 merge block", coinbase: cbFor(0n, p2mr(0xc0)), txs: [{ label: "tv3-2 merge", inputs: [spend("tv3-2 split", 1, 10_000n), spend("tv3-2 split", 0, 10_000n)], outputs: [out(20_000n, p2mr(0xa4))] }] },
    { height: 203, label: "tv3-2 uneven block", coinbase: cbFor(0n, p2mr(0xc0)), txs: [{ label: "tv3-2 uneven", inputs: [spend("tv3-2 merge", 0, 20_000n)], outputs: [out(15_000n, p2mr(0xa5)), out(5_000n, p2mr(0xa6))] }] },
    { height: 204, label: "tv3-2 cut block", coinbase: cbFor(0n, p2mr(0xc0)), txs: [{ label: "tv3-2 cut", inputs: [spend("tv3-2 uneven", 0, 15_000n)], outputs: [out(4_000n, p2mr(0xa7)), out(11_000n, p2mr(0xa8))] }] },
  ], [
    { id: id("tv3-2 reveal", 0), location: at("tv3-2 cut", 1, 6_000) },
    { id: id("tv3-2 reveal", 1), location: at("tv3-2 cut", 0, 0) },
  ]));

  // TV3-3: fee and coinbase.
  cases.push(chainCase("TV3-3 fee and coinbase", "A bit that is not covered by the outputs becomes part of the fee. Fees are appended to the coinbase input space after the subsidy, in transaction order. A bit the coinbase outputs do not claim is lost for good.", [
    { height: 300, label: "tv3-3 first block", coinbase: [out(SUBSIDY, p2mr(0xc1)), out(10_000n, p2mr(0xc2))], txs: [reveal("tv3-3 fee reveal", 10_000n, [envelope("whole fee")], [])] },
    { height: 301, label: "tv3-3 second block", coinbase: [out(SUBSIDY + 8_000n, p2mr(0xc1)), out(10_000n, p2mr(0xc2))], txs: [
      { label: "tv3-3 plain", inputs: [spend("funding of tv3-3 plain", 0, 13_000n)], outputs: [out(10_000n, p2mr(0xa1))] },
      { label: "tv3-3 partial", inputs: [spend("funding of tv3-3 partial", 0, 20_000n), spend("commit of tv3-3 partial", 0, 10_000n, leaf(envelope("fee after 5000")))], outputs: [out(15_000n, p2mr(0xa2))] },
    ] },
    { height: 302, label: "tv3-3 third block", coinbase: [out(SUBSIDY, p2mr(0xc1))], txs: [reveal("tv3-3 lost reveal", 10_000n, [envelope("unclaimed")], [])] },
  ], [
    { id: id("tv3-3 fee reveal", 0), location: at("coinbase of tv3-3 first block", 1, 0) },
    { id: id("tv3-3 partial", 0), location: at("coinbase of tv3-3 second block", 1, 0) },
    { id: id("tv3-3 lost reveal", 0), location: "lost" },
  ]));

  // TV3-4: burn.
  cases.push(chainCase("TV3-4 burn", "An OP_RETURN output burns whatever lands on it, at reveal or by a later spend. A burned P2MR Inscription keeps its number and stays burned.", [
    { height: 400, label: "tv3-4 reveal block", coinbase: cbFor(0n, p2mr(0xc0)), txs: [reveal("tv3-4 reveal", 20_000n, [envelope("burned at reveal"), envelope("burned later", [pointerField(10_000n)])], [out(10_000n, OPRET), out(10_000n, p2mr(0xa1))])] },
    { height: 401, label: "tv3-4 burn block", coinbase: cbFor(0n, p2mr(0xc0)), txs: [{ label: "tv3-4 burn", inputs: [spend("tv3-4 reveal", 1, 10_000n)], outputs: [out(10_000n, OPRET)] }] },
  ], [
    { id: id("tv3-4 reveal", 0), location: "burned" },
    { id: id("tv3-4 reveal", 1), location: "burned" },
  ]));

  // TV3-5: unbound.
  cases.push(chainCase("TV3-5 unbound", "A P2MR Inscription whose first bit is at or after the total input value has no bit to sit on. It is numbered, it is unbound, and no later transaction moves it.", [
    { height: 500, label: "tv3-5 block", coinbase: cbFor(0n, p2mr(0xc0)), txs: [
      reveal("tv3-5 zero value", 0n, [envelope("input of zero bits")], []),
      { label: "tv3-5 second input", inputs: [spend("funding of tv3-5 second input", 0, 10_000n), spend("commit of tv3-5 second input", 0, 0n, leaf(envelope("starts at the end")))], outputs: [out(10_000n, p2mr(0xa1))] },
    ] },
  ], [
    { id: id("tv3-5 zero value", 0), location: "unbound" },
    { id: id("tv3-5 second input", 0), location: "unbound" },
  ]));

  return {
    description: "TV3 ownership vectors, PINS-3 §5 and PINS-2 §4. Each case is a short synthetic chain on mainnet rules (subsidy 21000000000 bits). `blocks` are the exact inputs of the rules engine. `state_hashes` is the PINS-2 §4.4 hash after each block. `expected` is the table of P2MR Inscriptions after the last block.",
    spec: "PINS-3 §5",
    cases,
  };
}

// ---------------------------------------------------------------- TV2-3: numbering and flags

const field = (tag: number, value: Uint8Array): EnvelopeField => ({ tag, value });

function numberingChain(): Block[] {
  return [
    { height: 600, label: "tv2-3 block 600", coinbase: cbFor(0n, p2mr(0xc0)), txs: [
      { label: "tv2-3 a", inputs: [
        spend("commit of tv2-3 a 0", 0, 30_000n, leaf(envelope("e0"), envelope("e1", [pointerField(10_000n)]))),
        spend("commit of tv2-3 a 1", 0, 20_000n, leaf(envelope("e2"), envelope("e3", [field(4, text("future")), pointerField(20_000n)]))),
      ], outputs: [10, 11, 12, 13, 14].map((fill) => out(10_000n, p2mr(fill))) },
      { label: "tv2-3 b", inputs: [spend("tv2-3 a", 0, 10_000n), spend("commit of tv2-3 b", 0, 10_000n, leaf(envelope("e4")))], outputs: [out(20_000n, p2mr(0x20))] },
      { label: "tv2-3 c", inputs: [spend("commit of tv2-3 c", 0, 10_000n, leaf(envelope("e5"), envelope("e6")))], outputs: [out(10_000n, p2mr(0x21))] },
    ] },
    { height: 601, label: "tv2-3 block 601", coinbase: cbFor(0n, p2mr(0xc0)), txs: [
      { label: "tv2-3 d", inputs: [spend("commit of tv2-3 d", 0, 40_000n, leaf(
        buildEnvelope([contentTypeField("text/plain"), contentTypeField("text/html")], text("e7")),
        buildEnvelope([contentTypeField("text/plain"), pointerField(10_000n)], text("e8")),
        buildEnvelope([contentTypeField("text/plain"), field(2, new Uint8Array(9))], text("e9")),
        buildEnvelope([contentTypeField("text/plain"), pointerField(99_999n)], text("e10")),
      ))], outputs: [30, 31, 32, 33].map((fill) => out(10_000n, p2mr(fill))) },
      { label: "tv2-3 e", inputs: [spend("commit of tv2-3 e", 0, 0n, leaf(envelope("e11")))], outputs: [] },
    ] },
    { height: 602, label: "tv2-3 block 602", coinbase: [out(SUBSIDY, p2mr(0xc1)), out(10_000n, p2mr(0xc2))], txs: [
      { label: "tv2-3 f", inputs: [spend("commit of tv2-3 f", 0, 10_000n, leaf(envelope("e12")))], outputs: [] },
      { label: "tv2-3 g", inputs: [spend("commit of tv2-3 g", 0, 10_000n, leaf(envelope("e13")))], outputs: [] },
    ] },
    { height: 603, label: "tv2-3 block 603", coinbase: cbFor(0n, p2mr(0xc0)), txs: [
      { label: "tv2-3 h", inputs: [spend("commit of tv2-3 h", 0, 30_000n, leaf(envelope("e14"), envelope("e15", [pointerField(10_000n)]), envelope("e16", [pointerField(20_000n)])))], outputs: [out(10_000n, OPRET), out(10_000n, ANCHOR), out(10_000n, p2mr(0x40))] },
    ] },
    { height: 604, label: "tv2-3 block 604", coinbase: cbFor(0n, p2mr(0xc0)), txs: [
      { label: "tv2-3 i", inputs: [spend("tv2-3 h", 1, 10_000n), spend("tv2-3 h", 2, 10_000n)], outputs: [out(20_000n, p2mr(0x41))] },
    ] },
  ];
}

function numberingVectors(): Json {
  const blocks = numberingChain();
  const wants: Want[] = [
    { id: id("tv2-3 a", 0), location: at("tv2-3 b", 0, 0) },
    { id: id("tv2-3 a", 1), location: at("tv2-3 a", 1, 0) },
    { id: id("tv2-3 a", 2), location: at("tv2-3 a", 3, 0) },
    { id: id("tv2-3 a", 3), location: at("tv2-3 a", 2, 0), flags: ["opaque"] },
    { id: id("tv2-3 b", 0), location: at("tv2-3 b", 0, 10_000) },
    { id: id("tv2-3 c", 0), location: at("tv2-3 c", 0, 0) },
    { id: id("tv2-3 c", 1), location: at("tv2-3 c", 0, 0), flags: ["reinscription"] },
    { id: id("tv2-3 d", 0), location: at("tv2-3 d", 0, 0), flags: ["duplicate_field"] },
    { id: id("tv2-3 d", 1), location: at("tv2-3 d", 1, 0) },
    { id: id("tv2-3 d", 2), location: at("tv2-3 d", 0, 0), flags: ["bad_pointer", "reinscription"] },
    { id: id("tv2-3 d", 3), location: at("tv2-3 d", 0, 0), flags: ["bad_pointer", "reinscription"] },
    { id: id("tv2-3 e", 0), location: "unbound" },
    { id: id("tv2-3 f", 0), location: at("coinbase of tv2-3 block 602", 1, 0) },
    { id: id("tv2-3 g", 0), location: "lost" },
    { id: id("tv2-3 h", 0), location: "burned" },
    { id: id("tv2-3 h", 1), location: at("tv2-3 i", 0, 0) },
    { id: id("tv2-3 h", 2), location: at("tv2-3 i", 0, 10_000) },
  ];
  const result = chainCase("TV2-3 numbering and flags", "Seventeen P2MR Inscriptions over five blocks: numbers run by block, transaction, input, then position in the leaf (a.0 to a.3 over two inputs); a pointer picks the bit; field flags (opaque, duplicate_field, bad_pointer) and `reinscription` (a second P2MR Inscription on a bit that already has one in the same transaction); an unbound reveal; a P2MR Inscription that lands in the coinbase; a lost one; a burn; a PayToAnchor output (any spender may move it) and a spend of it.", blocks, wants);
  return {
    description: "TV2-3: numbering, flags and placement over one synthetic chain on mainnet rules. Same layout as the TV3 files.",
    spec: "PINS-2 §4",
    cases: [result],
  };
}

// ---------------------------------------------------------------- TV2-2 and TV2-4: reorganisation, missing witness

function chainVectors(): Json {
  const common: Block = { height: 700, label: "tv2-2 common", coinbase: cbFor(0n, p2mr(0xc0)), txs: [reveal("tv2-2 p", 10_000n, [envelope("P")], [out(10_000n, p2mr(0xa1))])] };
  const a1: Block = { height: 701, label: "tv2-2 a701", coinbase: cbFor(0n, p2mr(0xc0)), txs: [
    { label: "tv2-2 a move", inputs: [spend("tv2-2 p", 0, 10_000n)], outputs: [out(10_000n, p2mr(0xa2))] },
    reveal("tv2-2 x", 10_000n, [envelope("X")], [out(10_000n, p2mr(0xa3))]),
  ] };
  const a2: Block = { height: 702, label: "tv2-2 a702", coinbase: cbFor(0n, p2mr(0xc0)), txs: [reveal("tv2-2 y", 10_000n, [envelope("Y")], [out(10_000n, p2mr(0xa4))])] };
  const b1: Block = { height: 701, label: "tv2-2 b701", coinbase: cbFor(0n, p2mr(0xc0)), txs: [reveal("tv2-2 w", 10_000n, [envelope("W")], [out(10_000n, p2mr(0xb3))])] };
  const b2: Block = { height: 702, label: "tv2-2 b702", coinbase: cbFor(0n, p2mr(0xc0)), txs: [reveal("tv2-2 v", 10_000n, [envelope("V")], [out(10_000n, p2mr(0xb4))])] };
  const b3: Block = { height: 703, label: "tv2-2 b703", coinbase: cbFor(0n, p2mr(0xc0)), txs: [] };

  const indexer = new Indexer("mainnet");
  const steps: Json[] = [];
  const step = (action: string, block: Block, apply: boolean): void => {
    if (apply) indexer.applyBlock(toChain(block));
    else indexer.disconnectTip(blockHash(block.label));
    const tip = apply ? block : undefined;
    steps.push({ action, block: block.label, table: table(indexer), ...(tip ? { state_hash: hashOf(indexer, tip) } : {}) });
  };
  step("connect", common, true);
  const afterCommon = hashOf(indexer, common);
  step("connect", a1, true);
  step("connect", a2, true);
  step("disconnect", a2, false);
  step("disconnect", a1, false);
  if (hashOf(indexer, common) !== afterCommon) throw new Error("TV2-2: disconnecting two blocks did not restore the state");
  step("connect", b1, true);
  step("connect", b2, true);
  step("connect", b3, true);
  expectTable("TV2-2 branch B", indexer, [
    { id: id("tv2-2 p", 0), location: at("tv2-2 p", 0, 0) },
    { id: id("tv2-2 w", 0), location: at("tv2-2 w", 0, 0) },
    { id: id("tv2-2 v", 0), location: at("tv2-2 v", 0, 0) },
  ]);
  const fresh = runBlocks([common, b1, b2, b3]);
  if (hashOf(fresh, b3) !== hashOf(indexer, b3)) throw new Error("TV2-2: the reorganised state differs from a fresh run of branch B");

  // TV2-4: a P2MR spend with no witness.
  const pruned: Block = { height: 800, label: "tv2-4 pruned", coinbase: cbFor(0n, p2mr(0xc0)), txs: [reveal("tv2-4 reveal", 10_000n, [envelope("pruned")], [out(10_000n, p2mr(0xa1))])] };
  const good = new Indexer("mainnet");
  good.applyBlock(toChain({ ...pruned, height: 799, label: "tv2-4 before", txs: [reveal("tv2-4 before reveal", 10_000n, [envelope("before")], [out(10_000n, p2mr(0xa2))])] }));
  const before = table(good);
  const stripped = toChain(pruned);
  stripped.txs[1].inputs.forEach((input) => { delete input.leafScript; input.witnessItems = 0; });
  let message = "";
  try {
    good.applyBlock(stripped);
  } catch (error) {
    message = (error as Error).message;
  }
  if (!message.startsWith("witness pruned")) throw new Error("TV2-4: a missing witness was not refused");
  if (JSON.stringify(table(good)) !== JSON.stringify(before)) throw new Error("TV2-4: a refused block changed the state");
  const strippedJson = blockJson(pruned) as { txs: { inputs: Json[] }[] };
  strippedJson.txs[1].inputs.forEach((input) => { delete input.leaf_script_hex; input.witness_items = 0; });

  return {
    description: "TV2-2 reorganisation and TV2-4 missing witness, PINS-2 §5 and §6. TV2-2 connects a common block and branch A (two blocks), disconnects branch A tip first, connects branch B (three blocks) and ends in the same state as a fresh run of the common block plus branch B: numbers are reused and the state hash matches. TV2-4 feeds a block whose P2MR spend carries no witness: the engine refuses it and its state does not change.",
    spec: "PINS-2 §5, §6",
    reorg: {
      name: "TV2-2 reorganisation of depth 2",
      blocks: Object.fromEntries([common, a1, a2, b1, b2, b3].map((block) => [block.label, blockJson(block)])),
      steps,
      fresh_state_hash_equals_final: true,
    },
    missing_witness: {
      name: "TV2-4 P2MR spend without a witness",
      applied_before: blockJson({ ...pruned, height: 799, label: "tv2-4 before", txs: [reveal("tv2-4 before reveal", 10_000n, [envelope("before")], [out(10_000n, p2mr(0xa2))])] }),
      refused_block: strippedJson,
      error: message,
      table_unchanged: before,
    },
  };
}

// ---------------------------------------------------------------- PINS-2 §4.4: the state hash

/** The hash written from the text of PINS-2 §4.4, with no code shared with `hash.ts`. */
export function specStateHash(height: number, hash: string, rows: { number: number; id: string; body_sha256: string; field1_hex: string; place: string; owner_address: string; location_height: number; flags: string[] }[]): { preimage: string; hash: string } {
  const lines: Buffer[] = [Buffer.from(`block ${height} ${hash}`, "utf8")];
  for (const row of [...rows].sort((a, b) => a.number - b.number)) {
    const escaped: number[] = [];
    for (const byte of Buffer.from(row.field1_hex, "hex")) {
      if (byte === 0x0a) escaped.push(0x25, 0x30, 0x61);
      else if (byte === 0x25) escaped.push(0x25, 0x32, 0x35);
      else escaped.push(byte);
    }
    lines.push(Buffer.concat([
      Buffer.from(`${row.number} ${row.id} ${row.body_sha256} `, "utf8"),
      Buffer.from(escaped),
      Buffer.from(` ${row.place} ${row.owner_address} ${row.location_height} ${[...row.flags].sort().join(",")}`, "utf8"),
    ]));
  }
  const joined = lines.flatMap((line, index) => (index === 0 ? [line] : [Buffer.from("\n"), line]));
  const preimage = Buffer.concat(joined);
  return { preimage: preimage.toString("hex"), hash: sha256(preimage).toString("hex") };
}

function rowOf(item: Inscription): Parameters<typeof specStateHash>[2][number] {
  const field = item.fields.find((entry) => entry.tag === 1);
  return {
    number: item.number,
    id: item.id,
    body_sha256: item.bodySha256,
    field1_hex: field ? field.value : hex(text(item.contentType)),
    place: item.location.state === "located" ? `${item.location.txid}:${item.location.vout}:${item.location.offset}` : item.location.state,
    owner_address: item.ownerAddress,
    location_height: item.locationHeight,
    flags: item.flags,
  };
}

function stateHashVectors(): Json {
  const cases: Json[] = [];
  const blockLabel = "tv2-1 block";
  const height = 900;
  const raw = (name: string, field1: Uint8Array | null): Json => {
    const label = `tv2-1 ${name}`;
    const withField = buildEnvelope(field1 === null ? [] : [field(1, field1)], text(label));
    const block: Block = { height, label: blockLabel, coinbase: cbFor(0n, p2mr(0xc0)), txs: [{ label, inputs: [spend(`commit of ${label}`, 0, 10_000n, leaf(withField))], outputs: [out(10_000n, p2mr(0xa1))] }] };
    const indexer = runBlocks([block]);
    const rows = [...indexer.inscriptions.values()].map(rowOf);
    const spec = specStateHash(height, blockHash(blockLabel), rows);
    const engine = hashOf(indexer, block);
    if (spec.hash !== engine) throw new Error(`state hash vector ${name}: the spec function and the engine disagree`);
    return {
      name,
      field1_hex: field1 === null ? null : hex(field1),
      block: blockJson(block),
      row: rows[0],
      preimage_hex: spec.preimage,
      state_hash: engine,
    };
  };
  cases.push(raw("no field 1", null));
  cases.push(raw("plain type", text("text/plain")));
  cases.push(raw("a space inside", text("text/plain; charset=utf-8")));
  cases.push(raw("a line feed inside", text("text/plain\nbogus")));
  cases.push(raw("a percent sign", text("text/100%")));
  cases.push(raw("a literal %0a", text("a%0ab")));
  cases.push(raw("bytes that are not UTF-8", Uint8Array.of(0xff, 0xfe, 0x20, 0x80)));
  cases.push(raw("empty field 1", new Uint8Array()));

  // The whole TV2-3 chain, hashed by the spec function row by row.
  const blocks = numberingChain();
  const indexer = runBlocks(blocks);
  const last = blocks[blocks.length - 1];
  const rows = [...indexer.inscriptions.values()].map(rowOf);
  const spec = specStateHash(last.height, blockHash(last.label), rows);
  if (spec.hash !== hashOf(indexer, last)) throw new Error("state hash of the TV2-3 chain: spec function and engine disagree");

  // The empty state is the first line alone.
  const empty = specStateHash(5, "00".repeat(32), []);
  if (empty.hash !== stateHash(new Indexer("mainnet"), { height: 5, hash: "00".repeat(32) })) throw new Error("empty state hash differs");

  return {
    description: "PINS-2 §4.4 state hash. `preimage_hex` is the exact byte string that is hashed with SHA-256. Field 1 is carried as raw bytes: line feed becomes `%0a`, `%` becomes `%25`, every other byte is copied, so a value with spaces, line breaks or bytes that are not UTF-8 cannot move a field or start a line. The tests recompute every hash with the engine and with a second function written from the text of §4.4.",
    spec: "PINS-2 §4.4",
    empty_state: { height: 5, block_hash: "00".repeat(32), preimage_hex: empty.preimage, state_hash: empty.hash },
    field1_cases: cases,
    chain_case: { source: "ownership of TV2-3 in numbering.json, after block 604", height: last.height, block_hash: blockHash(last.label), rows, preimage_hex: spec.preimage, state_hash: spec.hash },
    mainnet_checkpoint: {
      height: 171486,
      state_hash: "2d8255401cc9bace5eeba394b83eb38865ec6713b8d2a8578009b77b76424112",
      p2mr_inscriptions: 10002,
      authentic: 10000,
      note: "The reference indexer replayed from block 161948 to 171486 reports this hash. It is recorded here so that an independent indexer can compare against it; the 10002 rows are not part of this repository.",
    },
  };
}

// ---------------------------------------------------------------- TV6-2: the FIFO outcome of the trade templates

function tradeVectors(): Json {
  const price = 50_000n;
  const padding = 5_000n;
  const u = 10_000n;
  const build = (title: string, name: string, description: string, inputs: In[], outputs: Out[], wants: Want[]): Json => {
    const blocks: Block[] = [
      { height: 1000, label: `${name} listing block`, coinbase: cbFor(0n, p2mr(0xc0)), txs: [reveal(`${name} U`, 20_000n, [envelope("for sale")], [out(u, p2mr(0x51))])] },
      { height: 1001, label: `${name} trade block`, coinbase: cbFor(0n, p2mr(0xc0)), txs: [{ label: `${name} trade`, inputs, outputs }] },
    ];
    return chainCase(title, description, blocks, wants);
  };
  const compact = build("TV6-2 compact template", "compact",
    "Compact template: input 0 is the buyer's padding a, input 1 the seller's U (signed SINGLE|ANYONECANPAY), and the seller's payment is output 1. Output 0 collects the padding and U in one coin of a + v_U bits, so FIFO puts U at offset a of output 0. The buyer owns U and can only move it together with the padding.",
    [spend("funding of compact padding", 0, padding), spend("compact U", 0, u), spend("funding of compact price", 0, 100_000n)],
    [out(padding + u, p2mr(0xb1)), out(price + u, p2mr(0x52)), out(30_000n, p2mr(0xb2))],
    [{ id: id("compact U", 0), location: at("compact trade", 0, Number(padding)) }]);
  const clean = build("TV6-2 clean template", "clean",
    "Clean template of PINS-6 §4.1: inputs 0 and 1 are the buyer's paddings a and b, input 2 is the seller's U (signed SINGLE|ANYONECANPAY), and input 3 is the buyer's funding. Output 0 returns a + b, output 1 is the receive output of exactly v_U bits, and output 2 pays the seller. FIFO puts U at offset 0 of output 1, a coin with no padding, so the buyer owns U alone.",
    [spend("funding of clean padding a", 0, padding), spend("funding of clean padding b", 0, padding), spend("clean U", 0, u), spend("funding of clean price", 0, 100_000n)],
    [out(padding + padding, p2mr(0xb0)), out(u, p2mr(0xb1)), out(price + u, p2mr(0x52)), out(30_000n, p2mr(0xb2))],
    [{ id: id("clean U", 0), location: at("clean trade", 1, 0) }]);
  return {
    description: "TV6-2: what the rules engine does with the two trade templates of PINS-6 §4. The signatures and the PSBT checks are covered by the regtest runs in regtest/runs.json (TV6-1, TV6-3). These cases fix only where the P2MR Inscription lands.",
    spec: "PINS-6 §4",
    cases: [compact, clean],
  };
}

export function chainVectorFiles(): Record<string, Json> {
  return {
    "ownership.json": ownershipVectors(),
    "numbering.json": numberingVectors(),
    "chain.json": chainVectors(),
    "state-hash.json": stateHashVectors(),
    "trade.json": tradeVectors(),
  };
}
