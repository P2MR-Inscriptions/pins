// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal PINS indexer. It reads transactions the caller already fetched.
 * It does not connect to a node. Two instances of this class are the two
 * independent indexers used for Q11.
 */
import { createHash } from "node:crypto";
import { LAUNCH_COLLECTION_SCHEMA, LAUNCH_PRICE_SCHEMA, priceSchemaFor } from "../inscriber/price.ts";
import { MARKER, parseEnvelopes } from "../inscriber/script.ts";
import { addressOf } from "./address.ts";

export type Located = { state: "located"; txid: string; vout: number; offset: bigint; script: Uint8Array };
export type Location = Located | { state: "unbound" } | { state: "burned" } | { state: "lost" };

export type Inscription = {
  id: string;
  txid: string;
  n: number;
  number: number;
  location: Location;
  flags: string[];
  /** MIME type from field 1. Empty when the field is absent. */
  contentType: string;
  body: Uint8Array;
  bodySha256: string;
  /** Raw field 5, concatenated when the envelope repeats the tag. */
  metadata: Uint8Array | null;
  /** Tag/value pairs other than the body, values as hex. */
  fields: { tag: number; value: string }[];
  /** Block that created the inscription. Not the collection genesis. */
  createdHeight: number;
  /** Position of the creating transaction in that block. */
  createdIndex: number;
  /** Height of the block that last placed the inscription. */
  locationHeight: number;
  /** Public key that opened the reveal leaf, hex, when the leaf has that prefix. */
  leafIssuer: string;
  ownerScript: string;
  ownerAddress: string;
};

export type UndoEntry = {
  hash: string;
  created: string[];
  prior: { id: string; location: Location; locationHeight: number; ownerScript: string; ownerAddress: string; flags: string[] }[];
};

export type ChainInput = {
  coinbase?: boolean;
  prevTxid?: string;
  prevVout?: number;
  value: bigint;
  /** Leaf script from the witness, when this input spends P2MR through a leaf of version 0xc0. */
  leafScript?: Uint8Array;
  /** True when the spent output is P2MR, false when it is not. Absent when the source does not know. */
  p2mr?: boolean;
  /** Number of witness items of this input. Absent when the source does not report it. */
  witnessItems?: number;
};

export type ChainOutput = { value: bigint; script: Uint8Array };

export type ChainTx = { txid: string; inputs: ChainInput[]; outputs: ChainOutput[] };

export type ChainBlock = {
  hash: string;
  height: number;
  /** Block subsidy in bits, before fees. Coinbase placement uses it. */
  subsidy: bigint;
  txs: ChainTx[];
};

type Held = { id: string; offset: bigint };

const OP_RETURN = 0x6a;

function outpoint(txid: string, vout: number): string {
  return `${txid}:${vout}`;
}

function isBurn(script: Uint8Array): boolean {
  return script.length > 0 && script[0] === OP_RETURN;
}

function readPointer(value: Uint8Array): { ok: true; n: bigint } | { ok: false } {
  if (value.length > 8) return { ok: false };
  let n = 0n;
  for (let i = value.length - 1; i >= 0; i -= 1) n = (n << 8n) | BigInt(value[i]);
  return { ok: true, n };
}

export class Indexer {
  readonly network: "regtest" | "testnet4" | "mainnet";
  readonly marker: Uint8Array;
  /** Field-5 schema. The JSON body is not a genesis parameter. Launch value is `pins-collection/1`. */
  readonly collectionSchema: string;
  /**
   * Price schema derived from the collection schema. Launch is `pins-price/1`.
   * A rehearsal schema `c/1` derives `p/1`, the same stand-in `inscribe price --schema` writes.
   */
  readonly priceSchema: string;
  /** When set, the collection view only accepts the inscription with this id as its genesis. */
  readonly genesisId: string | null;
  readonly inscriptions = new Map<string, Inscription>();
  private readonly held = new Map<string, Held[]>();
  private nextNumber = 0;
  private height = 0;
  private readonly undo: UndoEntry[] = [];

  constructor(network: "regtest" | "testnet4" | "mainnet" = "regtest", options: { marker?: Uint8Array; schema?: string; genesisId?: string | null } = {}) {
    this.network = network;
    this.genesisId = options.genesisId ?? null;
    this.marker = options.marker ?? MARKER;
    this.collectionSchema = options.schema ?? LAUNCH_COLLECTION_SCHEMA;
    this.priceSchema = priceSchemaFor(this.collectionSchema);
    if (network === "mainnet" && (Buffer.from(this.marker).toString() !== "pins" || this.collectionSchema !== LAUNCH_COLLECTION_SCHEMA || this.priceSchema !== LAUNCH_PRICE_SCHEMA)) {
      throw new Error("mainnet refuses a rehearsal marker or schema");
    }
  }

  get(id: string): Inscription | undefined {
    return this.inscriptions.get(id);
  }

  /**
   * PINS-2 §2.2: a block whose witnesses are missing is not a block without inscriptions.
   * A P2MR spend always carries a script and a control block, so an empty witness on one
   * means the source dropped it.
   */
  static requireWitness(tx: ChainTx): void {
    if (tx.inputs.some((input) => !input.coinbase && input.p2mr === true && input.witnessItems === 0)) {
      throw new Error(`witness pruned: transaction ${tx.txid} spends P2MR without a witness`);
    }
  }

  applyBlock(block: ChainBlock): void {
    for (const tx of block.txs.slice(1)) Indexer.requireWitness(tx);
    const created: string[] = [];
    this.height = block.height;
    const prior: UndoEntry["prior"] = [];
    const remember = (id: string) => {
      if (prior.some((row) => row.id === id)) return;
      const item = this.inscriptions.get(id);
      if (!item) return;
      prior.push({
        id,
        location: item.location,
        locationHeight: item.locationHeight,
        ownerScript: item.ownerScript,
        ownerAddress: item.ownerAddress,
        flags: [...item.flags],
      });
    };
    const fees: { ids: string[]; fee: bigint }[] = [];
    block.txs.slice(1).forEach((tx, index) => {
      const before = created.length;
      fees.push(this.applyTx(tx, created, remember));
      for (const id of created.slice(before)) {
        const item = this.inscriptions.get(id);
        if (item) item.createdIndex = index + 1;
      }
    });
    this.applyCoinbase(block, fees, remember);
    this.undo.push({ hash: block.hash, created, prior });
  }

  disconnectTip(hash: string): void {
    const last = this.undo.at(-1);
    if (!last || last.hash !== hash) throw new Error(`refusing to disconnect ${hash}; it is not the tip`);
    this.undo.pop();
    for (const id of last.created) {
      const item = this.inscriptions.get(id);
      if (item && item.location.state === "located") this.removeHeld(item.location, id);
      this.inscriptions.delete(id);
      this.nextNumber -= 1;
    }
    for (const row of last.prior) {
      const item = this.inscriptions.get(row.id);
      if (!item) continue;
      if (item.location.state === "located") this.removeHeld(item.location, row.id);
      item.location = row.location;
      item.locationHeight = row.locationHeight;
      item.ownerScript = row.ownerScript;
      item.ownerAddress = row.ownerAddress;
      item.flags = [...row.flags];
      if (row.location.state === "located") this.addHeld(row.location, row.id);
    }
  }

  /** Replace the in-memory undo log. Used when a store reloads the last 100 blocks. */
  installUndo(entries: UndoEntry[]): void {
    this.undo.length = 0;
    this.undo.push(...entries);
  }

  lastUndo(): UndoEntry | undefined {
    return this.undo.at(-1);
  }

  /** Drop the oldest undo entries until only `depth` remain. The tip stays. */
  trimUndo(depth: number): void {
    if (!Number.isInteger(depth) || depth < 1) throw new Error("undo depth must be a positive integer");
    while (this.undo.length > depth) this.undo.shift();
  }

  /** Load a previously stored set. The rows must already be the tip state. */
  adopt(rows: Inscription[]): void {
    this.inscriptions.clear();
    this.held.clear();
    let max = -1;
    for (const row of rows) {
      this.inscriptions.set(row.id, row);
      if (row.number > max) max = row.number;
      if (row.location.state === "located") this.addHeld(row.location, row.id);
    }
    this.nextNumber = max + 1;
  }

  /** Highest inscription number already assigned, or -1. */
  get tipNumber(): number {
    return this.nextNumber - 1;
  }

  private applyTx(tx: ChainTx, created: string[], remember: (id: string) => void): { ids: string[]; fee: bigint } {
    const inputRanges: { start: bigint; value: bigint }[] = [];
    let cursor = 0n;
    for (const input of tx.inputs) {
      inputRanges.push({ start: cursor, value: input.value });
      cursor += input.value;
    }
    const inputTotal = cursor;
    const outputTotal = tx.outputs.reduce((sum, output) => sum + output.value, 0n);
    const moving: { id: string; x: bigint }[] = [];
    tx.inputs.forEach((input, index) => {
      if (input.coinbase || !input.prevTxid || input.prevVout === undefined) return;
      const slot = this.held.get(outpoint(input.prevTxid, input.prevVout)) ?? [];
      for (const held of slot) moving.push({ id: held.id, x: inputRanges[index].start + held.offset });
    });
    const feeIds: string[] = [];
    const fresh = this.freshInscriptions(tx, created);
    for (const move of moving) {
      remember(move.id);
      if (this.place(this.inscriptions.get(move.id)!, move.x, tx, inputTotal, outputTotal, false) === "fee") feeIds.push(move.id);
    }
    for (const item of fresh) {
      const x = this.initialOffset(item, tx, inputRanges, outputTotal);
      if (this.place(item, x, tx, inputTotal, outputTotal, true) === "fee") feeIds.push(item.id);
    }
    return { ids: feeIds, fee: inputTotal > outputTotal ? inputTotal - outputTotal : 0n };
  }

  private freshInscriptions(tx: ChainTx, created: string[]): (Inscription & { inputIndex: number; envelope: ReturnType<typeof parseEnvelopes>[number] })[] {
    const found: (Inscription & { inputIndex: number; envelope: ReturnType<typeof parseEnvelopes>[number] })[] = [];
    let n = 0;
    tx.inputs.forEach((input, inputIndex) => {
      if (!input.leafScript) return;
      for (const envelope of parseEnvelopes(input.leafScript, this.marker)) {
        const id = `${tx.txid}i${n}`;
        const content = envelope.fields.find((field) => field.tag === 1);
        const metadata = envelope.fields.find((field) => field.tag === 5)?.value ?? null;
        const item: Inscription & { inputIndex: number; envelope: ReturnType<typeof parseEnvelopes>[number] } = {
          id,
          txid: tx.txid,
          n,
          number: this.nextNumber,
          location: { state: "unbound" },
          flags: [...envelope.flags],
          contentType: content ? new TextDecoder("utf-8", { ignoreBOM: true }).decode(content.value) : "",
          body: envelope.body,
          bodySha256: createHash("sha256").update(envelope.body).digest("hex"),
          metadata,
          fields: envelope.fields.map((field) => ({ tag: field.tag, value: Buffer.from(field.value).toString("hex") })),
          createdHeight: this.height,
          createdIndex: -1,
          locationHeight: this.height,
          leafIssuer: leafIssuer(input.leafScript),
          ownerScript: "",
          ownerAddress: "",
          inputIndex,
          envelope,
        };
        this.nextNumber += 1;
        this.inscriptions.set(id, item);
        created.push(id);
        found.push(item);
        n += 1;
      }
    });
    return found;
  }

  private initialOffset(
    item: Inscription & { inputIndex: number; envelope?: ReturnType<typeof parseEnvelopes>[number] },
    tx: ChainTx,
    inputRanges: { start: bigint }[],
    outputTotal: bigint,
  ): bigint {
    const pointer = item.envelope?.fields.find((field) => field.tag === 2);
    const fallback = inputRanges[item.inputIndex]?.start ?? 0n;
    if (!pointer) return fallback;
    const parsed = readPointer(pointer.value);
    if (!parsed.ok || parsed.n >= outputTotal) {
      item.flags.push("bad_pointer");
      return fallback;
    }
    return parsed.n;
  }

  private place(item: Inscription, x: bigint, tx: ChainTx, inputTotal: bigint, outputTotal: bigint, isNew: boolean): "fee" | "ok" {
    if (item.location.state === "located") this.removeHeld(item.location, item.id);
    item.locationHeight = this.height;
    if (x >= inputTotal) {
      item.location = { state: "unbound" };
      item.ownerScript = "";
      item.ownerAddress = "";
      return "ok";
    }
    if (x >= outputTotal) {
      item.location = { state: "lost" };
      item.ownerScript = "";
      item.ownerAddress = "";
      item.flags.push(`fee:${x - outputTotal}`);
      return "fee";
    }
    let covered = 0n;
    for (let vout = 0; vout < tx.outputs.length; vout += 1) {
      const output = tx.outputs[vout];
      if (x < covered + output.value) {
        const offset = x - covered;
        if (isNew && this.bitTaken(tx.txid, vout, offset)) item.flags.push("reinscription");
        if (isBurn(output.script)) {
          item.location = { state: "burned" };
          item.ownerScript = Buffer.from(output.script).toString("hex");
          item.ownerAddress = "";
          return "ok";
        }
        const located: Located = { state: "located", txid: tx.txid, vout, offset, script: output.script };
        item.location = located;
        item.ownerScript = Buffer.from(output.script).toString("hex");
        item.ownerAddress = addressOf(output.script, this.network);
        this.addHeld(located, item.id);
        return "ok";
      }
      covered += output.value;
    }
    item.location = { state: "lost" };
    return "ok";
  }

  private applyCoinbase(block: ChainBlock, fees: { ids: string[]; fee: bigint }[], remember: (id: string) => void): void {
    const coinbase = block.txs[0];
    if (!coinbase) return;
    let claimed = 0n;
    for (const output of coinbase.outputs) claimed += output.value;
    const available = fees.reduce((sum, group) => sum + group.fee, block.subsidy);
    let feeStart = block.subsidy;
    for (const group of fees) {
      for (const id of group.ids) {
        const item = this.inscriptions.get(id);
        if (!item) continue;
        const feeFlag = item.flags.find((flag) => flag.startsWith("fee:"));
        const feeOffset = feeFlag ? BigInt(feeFlag.slice(4)) : 0n;
        const x = feeStart + feeOffset;
        remember(id);
        item.flags = item.flags.filter((flag) => !flag.startsWith("fee:"));
        if (x >= claimed || x >= available) item.location = { state: "lost" };
        else this.place(item, x, coinbase, available, claimed, false);
      }
      feeStart += group.fee;
    }
  }

  private bitTaken(txid: string, vout: number, offset: bigint): boolean {
    return (this.held.get(outpoint(txid, vout)) ?? []).some((held) => held.offset === offset);
  }

  private addHeld(location: Located, id: string): void {
    const key = outpoint(location.txid, location.vout);
    const list = this.held.get(key) ?? [];
    list.push({ id, offset: location.offset });
    this.held.set(key, list);
  }

  private removeHeld(location: Located, id: string): void {
    const key = outpoint(location.txid, location.vout);
    const list = (this.held.get(key) ?? []).filter((held) => held.id !== id);
    if (list.length) this.held.set(key, list);
    else this.held.delete(key);
  }
}

function leafIssuer(script: Uint8Array | undefined): string {
  if (!script || script.length < 34 || script[0] !== 32 || script[33] !== 0xb3) return "";
  return Buffer.from(script.subarray(1, 33)).toString("hex");
}

export function cloneIndexer(source: Indexer): Indexer {
  const copy = new Indexer(source.network, { marker: source.marker, schema: source.collectionSchema, genesisId: source.genesisId });
  for (const item of source.inscriptions.values()) {
    copy.inscriptions.set(item.id, {
      ...item,
      flags: [...item.flags],
      location: { ...item.location },
      body: item.body,
      metadata: item.metadata,
      fields: item.fields.map((field) => ({ ...field })),
    });
  }
  return copy;
}
