// SPDX-License-Identifier: Apache-2.0
/**
 * Snapshot of the PINS indexer, replaced only when a full read matches one tip.
 * A tip that moves during the read is discarded, so a reorg cannot publish a mix
 * of two chains. Authenticity flags come from the indexer and are not recomputed here.
 */
import { config } from "./config.ts";
import { redactSecrets } from "./redact.ts";

export type Location =
  | { state: "located"; txid: string; vout: number; offset: string; script: string }
  | { state: "unbound" | "burned" | "lost" };

export type Inscription = {
  id: string; txid: string; n: number; number: number;
  contentType: string; bodySha256: string; bodyLength: number;
  fields: { tag: number; value: string }[];
  createdHeight: number; createdIndex: number; locationHeight: number;
  location: Location | null; ownerAddress: string; ownerScript: string;
  leafIssuer: string; flags: string[]; burned: boolean; reinscription: boolean;
};

export type Piece = {
  number: number; inscriptionId: string | null; authentic: boolean; reason: string; status: string;
  location: Location | null; ownerAddress: string; ownerScript: string;
  confirmations: number; final: boolean;
  attributes: { trait_type: string; value: string }[];
};

type IndexerStatus = {
  network: string; chain: string; height: number; hash: string | null; stateHash: string | null; inscriptions: number; mock?: boolean;
  /** The standards and record schemas the indexer reports. Absent from an indexer that predates them. */
  standards?: { id: string; status: string }[]; schemas?: Record<string, string>;
};

/** Rows per request when the P2MR Inscription list is read. The indexer accepts up to 1000. */
const INSCRIPTION_PAGE = 1000;

async function get<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(`${config.indexerUrl}${path}`, { signal, redirect: "error" });
  if (!response.ok) throw new Error(`indexer answered HTTP ${response.status}`);
  return (await response.json()) as T;
}

/** Newest P2MR Inscription first: block height, then transaction index, then input index. */
export function latestFirst(a: { createdHeight: number; createdIndex: number; n: number; number: number }, b: { createdHeight: number; createdIndex: number; n: number; number: number }): number {
  return b.createdHeight - a.createdHeight || b.createdIndex - a.createdIndex || b.n - a.n || b.number - a.number;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function secrets(): string[] {
  return config.rpc ? [config.rpc.user, config.rpc.password] : [];
}

export class IndexCache {
  status: IndexerStatus | null = null;
  error: string | null = null;
  stale = false;
  snapshotHeight = -1;
  updatedAt = 0;
  loading = false;
  list: Inscription[] = [];
  newest: Inscription[] = [];
  byId = new Map<string, Inscription>();
  byNumber = new Map<number, Inscription>();
  /** P2MR Inscription numbers that exist, ascending. Rebuilt with each snapshot. */
  numberOrder: number[] = [];
  byTxid = new Map<string, Inscription[]>();
  byLocationTx = new Map<string, Inscription[]>();
  byOwner = new Map<string, Inscription[]>();
  byHeight = new Map<number, Inscription[]>();
  collection: Record<string, unknown> | null = null;
  pieces: Piece[] = [];
  pieceByInscription = new Map<string, Piece>();
  pieceByNumber = new Map<number, Piece>();
  previewReady = false;
  piecesComplete = false;
  private tipKey = "";
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), config.pollMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(): Promise<void> {
    if (!this.running) this.running = this.refresh().finally(() => { this.running = null; });
    return this.running;
  }

  get ready(): boolean {
    return this.updatedAt > 0;
  }

  private async loadPieces(signal: AbortSignal): Promise<Piece[]> {
    const first = await get<{ total: number; pieces: Piece[] }>("/pieces?offset=0&limit=100", signal);
    const total = first.total;
    if (!Number.isInteger(total) || total < 0) throw new Error("indexer pieces total is invalid");
    const pageSize = 100;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const chunks: Piece[][] = new Array(pages);
    chunks[0] = first.pieces;
    let cursor = 1;
    const worker = async () => {
      while (cursor < pages) {
        const index = cursor;
        cursor += 1;
        const page = await get<{ pieces: Piece[] }>(`/pieces?offset=${index * pageSize}&limit=${pageSize}`, signal);
        chunks[index] = page.pieces;
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, pages - 1) }, () => worker()));
    const pieces = chunks.flat();
    if (pieces.length > config.maxInscriptions) throw new Error("indexer snapshot exceeds the P2MR Inscription limit");
    return pieces;
  }

  /**
   * Read the whole P2MR Inscription list in pages. An indexer from before paging ignores `offset` and `limit`
   * and sends every row without a `total`: that answer is taken as the whole list. `total` is null then.
   */
  private async loadInscriptions(signal: AbortSignal): Promise<{ inscriptions: Inscription[]; total: number | null }> {
    const first = await get<{ total?: unknown; inscriptions: Inscription[] }>(`/inscriptions?offset=0&limit=${INSCRIPTION_PAGE}`, signal);
    const total = first.total;
    if (total === undefined) return { inscriptions: first.inscriptions, total: null };
    if (typeof total !== "number" || !Number.isInteger(total) || total < 0) throw new Error("indexer P2MR Inscriptions total is invalid");
    if (total > config.maxInscriptions) throw new Error("indexer snapshot exceeds the P2MR Inscription limit");
    const pages = Math.max(1, Math.ceil(total / INSCRIPTION_PAGE));
    const chunks: Inscription[][] = new Array(pages);
    chunks[0] = first.inscriptions;
    let cursor = 1;
    const worker = async () => {
      while (cursor < pages) {
        const index = cursor;
        cursor += 1;
        const page = await get<{ inscriptions: Inscription[] }>(`/inscriptions?offset=${index * INSCRIPTION_PAGE}&limit=${INSCRIPTION_PAGE}`, signal);
        chunks[index] = page.inscriptions;
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, pages - 1) }, () => worker()));
    return { inscriptions: chunks.flat(), total };
  }

  private async refresh(): Promise<void> {
    const signal = AbortSignal.timeout(config.snapshotTimeoutMs);
    try {
      const status = await get<IndexerStatus>("/status", signal);
      this.status = status;
      const key = `${status.hash}:${status.stateHash}`;
      if (key === this.tipKey && this.ready) {
        this.error = null;
        this.stale = false;
        return;
      }
      this.loading = true;
      const { inscriptions, total } = await this.loadInscriptions(signal);
      if (inscriptions.length > config.maxInscriptions) throw new Error("indexer snapshot exceeds the P2MR Inscription limit");
      // The latest P2MR Inscriptions can be shown before every collection piece page returns.
      if (!this.ready) this.publishPreview(inscriptions, status.height);
      const collection = await get<Record<string, unknown>>("/collection", signal);
      if (!this.ready) this.collection = collection;
      const pieces = collection.status === "present" ? await this.loadPieces(signal) : [];
      const after = await get<IndexerStatus>("/status", signal);
      if (after.hash !== status.hash || after.stateHash !== status.stateHash) {
        this.stale = this.ready || this.previewReady;
        this.tipKey = "";
        this.status = after;
        this.error = null;
        return;
      }
      // The tip did not move, so the pages are one list. A count that differs from the total is an indexer fault.
      if (total !== null && inscriptions.length !== total) throw new Error("indexer P2MR Inscription pages do not add up to the total");
      this.apply(inscriptions, collection, pieces, status.height);
      this.piecesComplete = true;
      this.previewReady = true;
      this.tipKey = key;
      this.status = after;
      this.updatedAt = Date.now();
      this.error = null;
      this.stale = false;
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : "indexer unreachable", secrets()) || "indexer unreachable";
      if (this.previewReady && !this.ready) this.error = null;
      else this.error = message;
      if (this.ready) this.stale = true;
    } finally {
      this.loading = false;
    }
  }

  /** P2MR Inscription list only. Does not claim collection piece totals. */
  private publishPreview(inscriptions: Inscription[], height: number): void {
    this.fillInscriptions(inscriptions, height);
    this.pieces = [];
    this.pieceByInscription = new Map();
    this.pieceByNumber = new Map();
    this.piecesComplete = false;
    this.previewReady = true;
  }

  private fillInscriptions(inscriptions: Inscription[], height: number): void {
    const list = [...inscriptions].sort((a, b) => a.number - b.number);
    const byId = new Map<string, Inscription>();
    const byNumber = new Map<number, Inscription>();
    const byTxid = new Map<string, Inscription[]>();
    const byLocationTx = new Map<string, Inscription[]>();
    const byOwner = new Map<string, Inscription[]>();
    const byHeight = new Map<number, Inscription[]>();
    for (const item of list) {
      byId.set(item.id, item);
      if (!byNumber.has(item.number)) byNumber.set(item.number, item);
      push(byTxid, item.txid, item);
      push(byHeight, item.createdHeight, item);
      if (item.location?.state === "located") push(byLocationTx, item.location.txid, item);
      if (item.ownerAddress) push(byOwner, item.ownerAddress, item);
    }
    this.list = list;
    this.newest = [...list].sort(latestFirst);
    this.byId = byId;
    this.byNumber = byNumber;
    this.numberOrder = [...byNumber.keys()].sort((a, b) => a - b);
    this.byTxid = byTxid;
    this.byLocationTx = byLocationTx;
    this.byOwner = byOwner;
    this.byHeight = byHeight;
    this.snapshotHeight = height;
  }

  private apply(inscriptions: Inscription[], collection: Record<string, unknown>, pieces: Piece[], height: number): void {
    this.fillInscriptions(inscriptions, height);
    const pieceByInscription = new Map<string, Piece>();
    const pieceByNumber = new Map<number, Piece>();
    for (const piece of pieces) {
      pieceByNumber.set(piece.number, piece);
      if (piece.inscriptionId) pieceByInscription.set(piece.inscriptionId, piece);
    }
    this.collection = collection;
    this.pieces = pieces;
    this.pieceByInscription = pieceByInscription;
    this.pieceByNumber = pieceByNumber;
  }
}

export const cache = new IndexCache();
