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
  /**
   * Field 1 as text, for display: the bytes of the first field 1 value decoded as UTF-8, with a
   * replacement character for a byte that does not decode and a leading U+FEFF kept. Empty when the
   * field is absent. It is derived from `fields` and is lossy by nature. The bytes are the value
   * (PINS-1 §5.1.1): use `contentTypeBytes` to compare or to hash, never this text.
   */
  contentType: string;
  /** Length of the body in bytes (all body pushes concatenated). */
  bodyLength: number;
  /**
   * The body, only while the indexer holds it in memory: a P2MR Inscription created in the block being
   * applied, or one that was never stored. A store drops it once the block is committed, and a reader
   * calls `Indexer.bodyOf(id)`, which returns it from memory or loads it on demand.
   */
  body?: Uint8Array;
  /** SHA-256 of the body, lowercase hex. It stands for the body wherever only equality or a digest is needed. */
  bodySha256: string;
  /** Raw field 5, concatenated when the envelope repeats the tag. */
  metadata: Uint8Array | null;
  /** Tag/value pairs other than the body, values as hex of the raw bytes, in envelope order. Field 1 is here, unaltered. */
  fields: { tag: number; value: string }[];
  /** Block that created the P2MR Inscription. Not the collection genesis. */
  createdHeight: number;
  /** Position of the creating transaction in that block. */
  createdIndex: number;
  /** Height of the block that last placed the P2MR Inscription. */
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

/**
 * `body`, `bodyLength` and `bodySha256` of a body, for code that builds an `Inscription` by hand (tests, vector
 * generators). The indexer fills the three from the envelope, and they always agree.
 */
export function bodyFacts(body: Uint8Array): { body: Uint8Array; bodyLength: number; bodySha256: string } {
  return { body, bodyLength: body.length, bodySha256: createHash("sha256").update(body).digest("hex") };
}

/** The bytes of the first field 1 value, or an empty array when the field is absent (PINS-1 §5.1.1, PINS-2 §4.4). */
function firstFieldOne(fields: readonly { tag: number; value: string }[]): Buffer {
  const field = fields.find((entry) => entry.tag === 1);
  return field ? Buffer.from(field.value, "hex") : Buffer.alloc(0);
}

/**
 * The content type of a P2MR Inscription as raw bytes: the first field 1 value, unaltered (PINS-1 §5.1.1).
 * This is what the state hash covers (PINS-2 §4.4) and what a comparison with a type must use. An item that has
 * no field 1 in `fields` gives the UTF-8 bytes of its `contentType`, which is empty for an item the indexer made.
 */
export function contentTypeBytes(item: Pick<Inscription, "fields" | "contentType">): Buffer {
  return item.fields.some((entry) => entry.tag === 1) ? firstFieldOne(item.fields) : Buffer.from(item.contentType, "utf8");
}

/** Whether the content type bytes of an item are exactly the UTF-8 bytes of `type`. */
export function hasContentType(item: Pick<Inscription, "fields" | "contentType">, type: string): boolean {
  return contentTypeBytes(item).equals(Buffer.from(type, "utf8"));
}

/** Field 1 as display text: UTF-8, a replacement character for bytes that do not decode, a leading U+FEFF kept. */
export function contentTypeText(fields: readonly { tag: number; value: string }[]): string {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(firstFieldOne(fields));
}

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


/**
 * A bounded read of P2MR Inscriptions. A store answers from SQLite; an indexer
 * with no store filters the in-memory map. `limit` null means every match.
 */
export type InscriptionQuery = {
  owner?: string;
  leafIssuer?: string;
  txid?: string;
  createdHeight?: number;
  number?: number;
  locTxid?: string;
  locVout?: number;
  hasMetadata?: boolean;
  contentType?: string;
  after?: { createdHeight: number; createdIndex: number; n: number };
  before?: { createdHeight: number; createdIndex: number; n: number };
  order?: "number" | "created" | "latest";
  offset?: number;
  limit?: number | null;
};

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
  /** When set, the collection view only accepts the P2MR Inscription with this id as its genesis. */
  readonly genesisId: string | null;
  readonly inscriptions = new Map<string, Inscription>();
  private readonly held = new Map<string, Held[]>();
  private nextNumber = 0;
  private height = 0;
  private readonly undo: UndoEntry[] = [];
  private bodyLoader: ((id: string) => Uint8Array | undefined) | null = null;
  private itemLoader: ((id: string) => Inscription | undefined) | null = null;
  private itemSelect: ((query: InscriptionQuery) => Inscription[]) | null = null;
  private itemCount: (() => number) | null = null;
  private heldLookup: ((txid: string, vout: number) => Held[]) | null = null;

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
    const hit = this.inscriptions.get(id);
    if (hit) return hit;
    const row = this.itemLoader?.(id);
    if (row) this.inscriptions.set(row.id, row);
    return row;
  }

  /**
   * How many P2MR Inscriptions exist at the tip. A store counts rows, so this
   * stays correct when the in-memory map holds only the undo working set.
   */
  get size(): number {
    return this.itemCount ? this.itemCount() : this.inscriptions.size;
  }

  /**
   * A bounded subset, in the requested order. A store answers from indexed
   * SQLite rows. An indexer with no store filters the in-memory map.
   */
  select(query: InscriptionQuery = {}): Inscription[] {
    if (!this.itemSelect) return selectFrom(this.inscriptions.values(), query);
    const byId = new Map<string, Inscription>();
    for (const item of this.itemSelect({ ...query, offset: 0, limit: null })) byId.set(item.id, item);
    for (const item of this.inscriptions.values()) byId.set(item.id, item);
    return selectFrom(byId.values(), query);
  }

  /** Where `get` loads a P2MR Inscription that is not in the in-memory map. */
  setItemSource(
    loader: ((id: string) => Inscription | undefined) | null,
    select: ((query: InscriptionQuery) => Inscription[]) | null = null,
    count: (() => number) | null = null,
    heldLookup: ((txid: string, vout: number) => Held[]) | null = null,
  ): void {
    this.itemLoader = loader;
    this.itemSelect = select;
    this.itemCount = count;
    this.heldLookup = heldLookup;
  }

  /** Drop an in-memory object without changing `held`. The store still has the row. */
  unload(id: string): void {
    this.inscriptions.delete(id);
  }

  /** Drop cached location slots. A store calls this after a flush; the next spend reads the index. */
  clearHeldCache(): void {
    this.held.clear();
  }

  /**
   * The body of a P2MR Inscription, or undefined when there is none with that id. It comes from memory when the
   * indexer holds it (see `Inscription.body`) and from the loader otherwise, so a reader never needs to know
   * which. A store sets the loader and drops the bodies it has written, so an indexer on a store holds no body
   * after a block is committed. An indexer without a store keeps every body in memory.
   */
  bodyOf(id: string): Uint8Array | undefined {
    const item = this.get(id);
    if (!item) return undefined;
    return item.body ?? this.bodyLoader?.(id);
  }

  /** Where `bodyOf` loads a body that is not in memory. `null` when bodies are only ever in memory. */
  setBodyLoader(loader: ((id: string) => Uint8Array | undefined) | null): void {
    this.bodyLoader = loader;
  }

  /** Drop the in-memory body of one P2MR Inscription. Call it only when the body can be loaded again. */
  releaseBody(id: string): void {
    const item = this.get(id);
    if (item) delete item.body;
  }

  /**
   * PINS-2 §2, item 2: a block whose witnesses are missing is not a block without P2MR Inscriptions.
   * A P2MR spend always carries a script and a control block, so an empty witness on one
   * means the source dropped it.
   */
  static requireWitness(tx: ChainTx): void {
    if (tx.inputs.some((input) => !input.coinbase && input.p2mr === true && input.witnessItems === 0)) {
      throw new Error(`witness pruned: transaction ${tx.txid} spends P2MR without a witness`);
    }
  }

  /**
   * Apply one block: the transactions in block order, then the coinbase.
   *
   * Order. Within a transaction the P2MR Inscriptions that its inputs already hold move first, in input order
   * and then in the order they were held; the ones its inputs reveal are numbered and placed after them, in input
   * order and envelope order (PINS-2 §4.1, PINS-3 §3). A bit that lands past the outputs is paid as fee: the
   * coinbase places it, after every other transaction, in the order of the transactions that paid the fee
   * (PINS-3 §6). Numbers are given in creation order, so an item created later never gets a lower number.
   *
   * Atomicity. The block is applied entirely or not at all. A block whose witnesses are missing is refused before
   * anything changes (PINS-2 §2, item 2). If anything else throws while the block is applied, every change made so
   * far is undone from the same record that a reorg uses, the numbers and the height are restored, and the error
   * is thrown again: the indexer is as it was before the call. On return the undo entry for this block is the
   * last one, which is what `Store.commit` writes in one SQLite transaction with the block.
   *
   * Reorg. The undo entry holds the ids created by the block and, for every P2MR Inscription it moved, its place,
   * owner and flags before. `disconnectTip` replays it backwards. Only the tip can be disconnected, and only while
   * its entry is retained (`trimUndo`).
   */
  applyBlock(block: ChainBlock): void {
    for (const tx of block.txs.slice(1)) Indexer.requireWitness(tx);
    const created: string[] = [];
    const before = { height: this.height, nextNumber: this.nextNumber };
    this.height = block.height;
    const prior: UndoEntry["prior"] = [];
    const remember = (id: string) => {
      if (prior.some((row) => row.id === id)) return;
      const item = this.get(id);
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
    try {
      const fees: { ids: string[]; fee: bigint }[] = [];
      block.txs.slice(1).forEach((tx, index) => {
        const first = created.length;
        fees.push(this.applyTx(tx, created, remember));
        for (const id of created.slice(first)) {
          const item = this.inscriptions.get(id);
          if (item) item.createdIndex = index + 1;
        }
      });
      this.applyCoinbase(block, fees, remember);
    } catch (error) {
      this.restore({ created, prior });
      this.height = before.height;
      this.nextNumber = before.nextNumber;
      throw error;
    }
    this.undo.push({ hash: block.hash, created, prior });
  }

  /** Undo the tip block. Throws unless `hash` is the block of the last undo entry. */
  disconnectTip(hash: string): void {
    const last = this.undo.at(-1);
    if (!last || last.hash !== hash) throw new Error(`refusing to disconnect ${hash}; it is not the tip`);
    this.undo.pop();
    this.restore(last);
  }

  /** Put back what an undo record says a block changed: remove what it created, restore what it moved. */
  private restore(entry: { created: string[]; prior: UndoEntry["prior"] }): void {
    for (const id of entry.created) {
      const item = this.get(id);
      if (item && item.location.state === "located") this.removeHeld(item.location, id);
      this.inscriptions.delete(id);
      this.nextNumber -= 1;
    }
    for (const row of entry.prior) {
      const item = this.get(row.id);
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

  /** Replace the in-memory undo log. Used when a store reloads its retained undo blocks. */
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

  /**
   * Rebuild `held` and the next number without loading every payload. A store
   * uses this on open so RAM stays the undo working set plus this compact index.
   */
  adoptIndex(nextNumber: number, held: { txid: string; vout: number; offset: bigint; id: string }[]): void {
    this.inscriptions.clear();
    this.held.clear();
    this.nextNumber = nextNumber;
    for (const row of held) this.addHeld({ state: "located", txid: row.txid, vout: row.vout, offset: row.offset, script: new Uint8Array() }, row.id);
  }

  /** Highest P2MR Inscription number already assigned, or -1. */
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
      const slot = this.heldSlot(input.prevTxid, input.prevVout);
      for (const held of slot) moving.push({ id: held.id, x: inputRanges[index].start + held.offset });
    });
    const feeIds: string[] = [];
    const fresh = this.freshInscriptions(tx, created);
    for (const move of moving) {
      remember(move.id);
      if (this.place(this.get(move.id)!, move.x, tx, inputTotal, outputTotal, false) === "fee") feeIds.push(move.id);
    }
    for (const { item, inputIndex, pointer } of fresh) {
      const x = this.initialOffset(item, inputIndex, pointer, inputRanges, outputTotal);
      if (this.place(item, x, tx, inputTotal, outputTotal, true) === "fee") feeIds.push(item.id);
    }
    return { ids: feeIds, fee: inputTotal > outputTotal ? inputTotal - outputTotal : 0n };
  }

  /**
   * The P2MR Inscriptions the transaction reveals, numbered and registered. What placement needs and the record does
   * not keep (the input the envelope came from, the pointer field) is returned beside the item and not stored on it,
   * so an item holds nothing of its envelope but the fields.
   */
  private freshInscriptions(tx: ChainTx, created: string[]): { item: Inscription; inputIndex: number; pointer: Uint8Array | undefined }[] {
    const found: { item: Inscription; inputIndex: number; pointer: Uint8Array | undefined }[] = [];
    let n = 0;
    tx.inputs.forEach((input, inputIndex) => {
      if (!input.leafScript) return;
      for (const envelope of parseEnvelopes(input.leafScript, this.marker)) {
        const id = `${tx.txid}i${n}`;
        const content = envelope.fields.find((field) => field.tag === 1);
        const metadata = envelope.fields.find((field) => field.tag === 5)?.value ?? null;
        const item: Inscription = {
          id,
          txid: tx.txid,
          n,
          number: this.nextNumber,
          location: { state: "unbound" },
          flags: [...envelope.flags],
          contentType: content ? new TextDecoder("utf-8", { ignoreBOM: true }).decode(content.value) : "",
          bodyLength: envelope.body.length,
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
        };
        this.nextNumber += 1;
        this.inscriptions.set(id, item);
        created.push(id);
        found.push({ item, inputIndex, pointer: envelope.fields.find((field) => field.tag === 2)?.value });
        n += 1;
      }
    });
    return found;
  }

  private initialOffset(
    item: Inscription,
    inputIndex: number,
    pointerField: Uint8Array | undefined,
    inputRanges: { start: bigint }[],
    outputTotal: bigint,
  ): bigint {
    const fallback = inputRanges[inputIndex]?.start ?? 0n;
    if (!pointerField) return fallback;
    const parsed = readPointer(pointerField);
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
        const item = this.get(id);
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
    return this.heldSlot(txid, vout).some((held) => held.offset === offset);
  }

  /**
   * Who is at this output. A store looks up the location index when this
   * process has not already established the slot (SQL would still have the
   * previous tip during apply).
   */
  private heldSlot(txid: string, vout: number): Held[] {
    const key = outpoint(txid, vout);
    const hit = this.held.get(key);
    if (hit) return hit;
    const rows = this.heldLookup?.(txid, vout) ?? [];
    this.held.set(key, rows);
    return rows;
  }

  private addHeld(location: Located, id: string): void {
    const list = this.heldSlot(location.txid, location.vout);
    list.push({ id, offset: location.offset });
  }

  private removeHeld(location: Located, id: string): void {
    const key = outpoint(location.txid, location.vout);
    const list = this.heldSlot(location.txid, location.vout).filter((held) => held.id !== id);
    // Keep an empty array so a later lookup does not re-read a stale stored tip.
    this.held.set(key, list);
  }
}

function leafIssuer(script: Uint8Array | undefined): string {
  if (!script || script.length < 34 || script[0] !== 32 || script[33] !== 0xb3) return "";
  return Buffer.from(script.subarray(1, 33)).toString("hex");
}


function queryAfter(item: Inscription, after: { createdHeight: number; createdIndex: number; n: number }): boolean {
  if (item.createdHeight !== after.createdHeight) return item.createdHeight > after.createdHeight;
  if (item.createdIndex !== after.createdIndex) return item.createdIndex > after.createdIndex;
  return item.n > after.n;
}

function queryBefore(item: Inscription, before: { createdHeight: number; createdIndex: number; n: number }): boolean {
  if (item.createdHeight !== before.createdHeight) return item.createdHeight < before.createdHeight;
  if (item.createdIndex !== before.createdIndex) return item.createdIndex < before.createdIndex;
  return item.n < before.n;
}

function compareCreated(left: Inscription, right: Inscription): number {
  return left.createdHeight - right.createdHeight || left.createdIndex - right.createdIndex || left.n - right.n;
}

function compareLatest(left: Inscription, right: Inscription): number {
  return right.createdHeight - left.createdHeight || right.createdIndex - left.createdIndex || right.n - left.n || right.number - left.number;
}

function selectFrom(items: Iterable<Inscription>, query: InscriptionQuery): Inscription[] {
  const rows: Inscription[] = [];
  for (const item of items) {
    if (query.owner !== undefined && item.ownerAddress !== query.owner) continue;
    if (query.leafIssuer !== undefined && item.leafIssuer !== query.leafIssuer) continue;
    if (query.txid !== undefined && item.txid !== query.txid) continue;
    if (query.createdHeight !== undefined && item.createdHeight !== query.createdHeight) continue;
    if (query.number !== undefined && item.number !== query.number) continue;
    if (query.locTxid !== undefined) {
      if (item.location.state !== "located" || item.location.txid !== query.locTxid) continue;
      if (query.locVout !== undefined && item.location.vout !== query.locVout) continue;
    } else if (query.locVout !== undefined) continue;
    if (query.hasMetadata && !item.metadata) continue;
    if (query.contentType !== undefined && item.contentType !== query.contentType) continue;
    if (query.after && !queryAfter(item, query.after)) continue;
    if (query.before && !queryBefore(item, query.before)) continue;
    rows.push(item);
  }
  if (query.order === "created") rows.sort(compareCreated);
  else if (query.order === "latest") rows.sort(compareLatest);
  else rows.sort((left, right) => left.number - right.number);
  const offset = query.offset ?? 0;
  if (query.limit === null || query.limit === undefined) return rows.slice(offset);
  return rows.slice(offset, offset + query.limit);
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
