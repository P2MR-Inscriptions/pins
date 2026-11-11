// SPDX-License-Identifier: Apache-2.0

/**
 * SQLite storage for the indexer. Undo is kept for the last `undoDepth` blocks
 * (default 100). A deeper reorg throws and the caller resyncs from the
 * activation height.
 */
import { DatabaseSync } from "node:sqlite";
import type { CollectionProfile } from "./collection.ts";
import { stateHash } from "./hash.ts";
import { Indexer, type ChainBlock, type Inscription, type Location, type UndoEntry } from "./pins.ts";

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE blocks (
  height INTEGER PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  prev_hash TEXT,
  state_hash TEXT NOT NULL
);
CREATE TABLE undo (
  height INTEGER PRIMARY KEY,
  payload TEXT NOT NULL
);
CREATE TABLE outputs (
  txid TEXT NOT NULL,
  vout INTEGER NOT NULL,
  value TEXT NOT NULL,
  height INTEGER NOT NULL,
  PRIMARY KEY (txid, vout)
);
CREATE TABLE inscriptions (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL,
  payload TEXT NOT NULL,
  body BLOB NOT NULL,
  metadata BLOB
);
`;

type StoredLocation =
  | { state: "unbound" }
  | { state: "burned" }
  | { state: "lost" }
  | { state: "located"; txid: string; vout: number; offset: string; script: string };

type Payload = Omit<Inscription, "body" | "metadata" | "location"> & { location: StoredLocation };

function storedLocation(location: Location): StoredLocation {
  if (location.state !== "located") return { state: location.state };
  return {
    state: "located",
    txid: location.txid,
    vout: location.vout,
    offset: location.offset.toString(),
    script: Buffer.from(location.script).toString("hex"),
  };
}

function liveLocation(location: StoredLocation): Location {
  if (location.state !== "located") return { state: location.state };
  return {
    state: "located",
    txid: location.txid,
    vout: location.vout,
    offset: BigInt(location.offset),
    script: Buffer.from(location.script, "hex"),
  };
}

function freeze(item: Inscription): Payload {
  const { body, metadata, location, ...rest } = item;
  void body;
  void metadata;
  return { ...rest, location: storedLocation(location) };
}

function thaw(payload: Payload, body: Uint8Array, metadata: Uint8Array | null): Inscription {
  return { ...payload, body, metadata, location: liveLocation(payload.location) };
}

type StoredUndo = {
  hash: string;
  created: string[];
  prior: { id: string; location: StoredLocation; locationHeight: number; ownerScript: string; ownerAddress: string; flags: string[] }[];
};

function freezeUndo(entry: UndoEntry): StoredUndo {
  return {
    hash: entry.hash,
    created: entry.created,
    prior: entry.prior.map((row) => ({ ...row, location: storedLocation(row.location) })),
  };
}

function thawUndo(value: StoredUndo): UndoEntry {
  return {
    hash: value.hash,
    created: value.created,
    prior: value.prior.map((row) => ({ ...row, location: liveLocation(row.location) })),
  };
}

export class Store {
  readonly indexer: Indexer;
  readonly undoDepth: number;
  readonly profile: CollectionProfile | null;
  private readonly db: DatabaseSync;

  constructor(path: string, options: { undoDepth?: number; network?: "regtest" | "testnet4" | "mainnet"; marker?: Uint8Array; schema?: string; profile?: CollectionProfile | null; genesisId?: string | null } = {}) {
    this.indexer = new Indexer(options.network ?? "regtest", { marker: options.marker, schema: options.schema, genesisId: options.genesisId });
    this.profile = options.profile ?? null;
    this.undoDepth = options.undoDepth ?? 100;
    if (!Number.isInteger(this.undoDepth) || this.undoDepth < 1) throw new Error("undo depth must be a positive integer");
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    const ready = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get() as { name: string } | undefined;
    if (!ready) {
      this.db.exec(SCHEMA);
      this.setMeta("schema", "1");
    } else if (this.meta("schema") !== "1") {
      throw new Error(`unknown indexer schema ${this.meta("schema")}`);
    }
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.indexer.adopt(this.readInscriptions());
    this.indexer.installUndo(this.readUndo());
  }

  close(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.close();
  }

  tip(): { height: number; hash: string; stateHash: string } | null {
    const row = this.db.prepare("SELECT height, hash, state_hash FROM blocks ORDER BY height DESC LIMIT 1").get() as
      | { height: number; hash: string; state_hash: string }
      | undefined;
    return row ? { height: row.height, hash: row.hash, stateHash: row.state_hash } : null;
  }

  hashAt(height: number): string | null {
    const row = this.db.prepare("SELECT hash FROM blocks WHERE height = ?").get(height) as { hash: string } | undefined;
    return row?.hash ?? null;
  }

  /** Remember an output that was created before the activation height. */
  saveOutput(txid: string, vout: number, value: bigint): void {
    this.db.prepare("INSERT OR IGNORE INTO outputs (txid, vout, value, height) VALUES (?, ?, ?, -1)").run(txid, vout, value.toString());
  }

  outputValue(txid: string, vout: number): bigint | undefined {
    const row = this.db.prepare("SELECT value FROM outputs WHERE txid = ? AND vout = ?").get(txid, vout) as { value: string } | undefined;
    return row ? BigInt(row.value) : undefined;
  }

  /** Apply one block that the caller already checked is the next height. */
  commit(block: ChainBlock): string {
    const tip = this.tip();
    if (tip && block.height !== tip.height + 1) throw new Error(`refusing block ${block.height}; tip is ${tip.height}`);
    this.indexer.applyBlock(block);
    const undo = this.indexer.lastUndo();
    if (!undo) throw new Error("applyBlock did not record undo");
    const digest = stateHash(this.indexer, block);
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO blocks (height, hash, prev_hash, state_hash) VALUES (?, ?, ?, ?)").run(
        block.height,
        block.hash,
        tip?.hash ?? null,
        digest,
      );
      this.db.prepare("INSERT INTO undo (height, payload) VALUES (?, ?)").run(block.height, JSON.stringify(freezeUndo(undo)));
      const output = this.db.prepare("INSERT INTO outputs (txid, vout, value, height) VALUES (?, ?, ?, ?)");
      for (const tx of block.txs) {
        tx.outputs.forEach((entry, vout) => output.run(tx.txid, vout, entry.value.toString(), block.height));
      }
      const changed = new Set([...undo.created, ...undo.prior.map((row) => row.id)]);
      this.writeInscriptions(changed);
      const oldest = block.height - this.undoDepth;
      if (oldest >= 0) this.db.prepare("DELETE FROM undo WHERE height <= ?").run(oldest);
      this.db.exec("COMMIT");
      this.indexer.trimUndo(this.undoDepth);
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (this.indexer.lastUndo()?.hash === block.hash) this.indexer.disconnectTip(block.hash);
      throw error;
    }
    return digest;
  }

  /**
   * Drop the tip block and restore the inscriptions it changed.
   * Throws when the tip is older than the retained undo. Call `resync()` and
   * follow again from the activation height.
   */
  disconnect(): void {
    const tip = this.tip();
    if (!tip) throw new Error("no tip to disconnect");
    const undo = this.indexer.lastUndo();
    if (!undo || undo.hash !== tip.hash) {
      throw new Error(
        `reorg at height ${tip.height} (${tip.hash}) exceeds the undo depth of ${this.undoDepth} blocks. ` +
        `Resync with store.resync(), then follow() from the activation height.`,
      );
    }
    this.indexer.disconnectTip(tip.hash);
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM blocks WHERE height = ?").run(tip.height);
      this.db.prepare("DELETE FROM undo WHERE height = ?").run(tip.height);
      this.db.prepare("DELETE FROM outputs WHERE height = ?").run(tip.height);
      const remove = this.db.prepare("DELETE FROM inscriptions WHERE id = ?");
      for (const id of undo.created) remove.run(id);
      this.writeInscriptions(new Set(undo.prior.map((row) => row.id)));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  stateHashAt(height: number): string | null {
    const row = this.db.prepare("SELECT state_hash FROM blocks WHERE height = ?").get(height) as { state_hash: string } | undefined;
    return row?.state_hash ?? null;
  }

  /** Forget chain data so follow() can rebuild from the activation height. */
  resync(): void {
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM inscriptions; DELETE FROM outputs; DELETE FROM undo; DELETE FROM blocks;");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.indexer.adopt([]);
    this.indexer.installUndo([]);
  }

  undoCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM undo").get() as { n: number };
    return row.n;
  }

  private writeInscriptions(ids: Set<string>): void {
    const upsert = this.db.prepare(`
      INSERT INTO inscriptions (id, number, payload, body, metadata)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET number = excluded.number, payload = excluded.payload, body = excluded.body, metadata = excluded.metadata
    `);
    for (const id of ids) {
      const item = this.indexer.get(id);
      if (!item) continue;
      upsert.run(item.id, item.number, JSON.stringify(freeze(item)), Buffer.from(item.body), item.metadata ? Buffer.from(item.metadata) : null);
    }
  }

  private readInscriptions(): Inscription[] {
    const rows = this.db.prepare("SELECT payload, body, metadata FROM inscriptions").all() as { payload: string; body: Uint8Array; metadata: Uint8Array | null }[];
    return rows.map((row) => thaw(JSON.parse(row.payload) as Payload, new Uint8Array(row.body), row.metadata ? new Uint8Array(row.metadata) : null));
  }

  private readUndo(): UndoEntry[] {
    const rows = this.db.prepare("SELECT payload FROM undo ORDER BY height").all() as { payload: string }[];
    return rows.map((row) => thawUndo(JSON.parse(row.payload) as StoredUndo));
  }

  private meta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}
