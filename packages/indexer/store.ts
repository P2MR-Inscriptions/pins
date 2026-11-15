// SPDX-License-Identifier: Apache-2.0

/**
 * SQLite storage for the indexer. Undo is kept for the last `undoDepth` blocks
 * (default 1,000, the minimum PINS-2 §4.3 recommends). A deeper reorg throws
 * and the caller resyncs from the activation height.
 *
 * Outputs are kept while they are unspent, and for as long after they are spent as
 * the undo of the spending block is kept. After that the row is deleted: it can no
 * longer be needed, because only a reorg of the spending block would need it.
 *
 * The `meta` table also records what the chain data was built with: network,
 * envelope marker, collection schema, activation height and the pinned genesis.
 * A database that is opened with other values is refused, because its rows
 * would be read under rules they were not built under.
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { isP2mr } from "./address.ts";
import type { CollectionProfile } from "./collection.ts";
import { stateHash } from "./hash.ts";
import { Indexer, contentTypeText, type ChainBlock, type Inscription, type Location, type UndoEntry } from "./pins.ts";

/** PINS-2 §4.3: an indexer SHOULD keep at least 1,000 blocks of undo data. */
export const DEFAULT_UNDO_DEPTH = 1_000;

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
  p2mr INTEGER,
  spent_height INTEGER,
  PRIMARY KEY (txid, vout)
);
CREATE INDEX outputs_spent ON outputs (spent_height);
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

/**
 * What the `payload` column holds. The body and the field 5 bytes have their own columns. Field 1 is not stored as
 * text: its raw bytes are the first tag 1 value of `fields`, and `contentType` is derived from them when a row is read
 * (a row that has a `contentType` of its own is read the same way).
 */
type Payload = Omit<Inscription, "body" | "metadata" | "location" | "contentType"> & { location: StoredLocation };

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
  const { body, metadata, location, contentType, ...rest } = item;
  void body;
  void metadata;
  void contentType;
  return { ...rest, location: storedLocation(location) };
}

/** A row as the indexer holds it: no body in memory (it is loaded on demand), field 5 as bytes. */
function thaw(payload: Payload, metadata: Uint8Array | null): Inscription {
  // A row can carry a `contentType` (derived from `fields`) and the transient `inputIndex` and `envelope` of the
  // reveal; none of them is part of the record.
  const { contentType: older, inputIndex, envelope, ...rest } = payload as Payload & { contentType?: string; inputIndex?: number; envelope?: unknown };
  void older;
  void inputIndex;
  void envelope;
  return { ...rest, contentType: contentTypeText(payload.fields), metadata, location: liveLocation(payload.location) };
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
  /** Prepared statements by SQL text. A statement is prepared once per store and reused (see `sql`). */
  private readonly statements = new Map<string, StatementSync>();

  constructor(path: string, options: { undoDepth?: number; network?: "regtest" | "testnet4" | "mainnet"; marker?: Uint8Array; schema?: string; profile?: CollectionProfile | null; genesisId?: string | null } = {}) {
    this.indexer = new Indexer(options.network ?? "regtest", { marker: options.marker, schema: options.schema, genesisId: options.genesisId });
    this.profile = options.profile ?? null;
    this.undoDepth = options.undoDepth ?? DEFAULT_UNDO_DEPTH;
    if (!Number.isInteger(this.undoDepth) || this.undoDepth < 1) throw new Error("undo depth must be a positive integer");
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA journal_mode = WAL");
      const ready = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get() as { name: string } | undefined;
      if (!ready) {
        this.db.exec(SCHEMA);
        this.setMeta("schema", "1");
      } else if (this.meta("schema") !== "1") {
        throw new Error(`unknown indexer schema ${this.meta("schema")}`);
      }
      // A database without the output-type column gets it. Those rows stay NULL: unknown.
      const columns = this.db.prepare("PRAGMA table_info(outputs)").all() as { name: string }[];
      if (!columns.some((column) => column.name === "p2mr")) this.db.exec("ALTER TABLE outputs ADD COLUMN p2mr INTEGER");
      // A database without the spend column gets it. Its existing outputs stay NULL: unspent, as far as is known, and never pruned.
      if (!columns.some((column) => column.name === "spent_height")) this.db.exec("ALTER TABLE outputs ADD COLUMN spent_height INTEGER");
      this.db.exec("CREATE INDEX IF NOT EXISTS outputs_spent ON outputs (spent_height)");
      this.bindConfig(options.genesisId ?? null);
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      this.indexer.adopt(this.readInscriptions());
      this.indexer.setBodyLoader((id) => this.readBody(id));
      this.indexer.installUndo(this.readUndo());
    } catch (error) {
      this.statements.clear();
      this.db.close();
      throw error;
    }
  }

  /** The prepared statement for `text`, prepared on first use. Every query of the store goes through here. */
  private sql(text: string): StatementSync {
    let statement = this.statements.get(text);
    if (!statement) {
      statement = this.db.prepare(text);
      this.statements.set(text, statement);
    }
    return statement;
  }

  /**
   * Record what this database is built with, or check it against what it was
   * built with. A database with none of these rows is
   * adopted, and the values of this run are written. Nothing is written when
   * any value differs.
   */
  private bindConfig(genesisId: string | null): void {
    const wanted: { key: string; value: string; label: string; show: boolean }[] = [
      { key: "network", value: this.indexer.network, label: "network", show: true },
      // The marker of a rehearsal is not printed. It is public once it is on the chain, not before.
      { key: "marker", value: Buffer.from(this.indexer.marker).toString("hex"), label: "marker", show: false },
      { key: "collection_schema", value: this.indexer.collectionSchema, label: "collection schema", show: true },
    ];
    const writes: [string, string][] = [];
    for (const { key, value, label, show } of wanted) {
      const stored = this.meta(key);
      if (stored === null) writes.push([key, value]);
      else if (stored !== value) {
        throw new Error(show
          ? `this database was built for ${label} ${stored}, not ${value}. Start with the original option, or use a new database file.`
          : `this database was built with another ${label} than this run uses. Start with the original option, or use a new database file.`);
      }
    }
    // The pinned genesis only changes what the collection view accepts. A database that had none may gain one.
    // Another genesis, or none after one was pinned, is refused.
    const genesis = genesisId ?? "";
    const storedGenesis = this.meta("genesis_id");
    if (storedGenesis === null || (storedGenesis === "" && genesis !== "")) writes.push(["genesis_id", genesis]);
    else if (storedGenesis !== genesis) {
      throw new Error(storedGenesis === ""
        ? "this database was built without --genesis. Start without it, or use a new database file."
        : `this database was built with --genesis ${storedGenesis}${genesis ? `, not ${genesis}` : ""}. Start with the original option, or use a new database file.`);
    }
    if (writes.length === 0) return;
    this.db.exec("BEGIN");
    try {
      for (const [key, value] of writes) this.setMeta(key, value);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * `follow` calls this with the height it starts from. The first call records
   * it; a database that already holds blocks refuses another height, because
   * its first block is the one it started from. A database with no such row
   * is adopted. An empty database takes the new height.
   */
  bindActivation(height: number): void {
    const stored = this.meta("activation_height");
    if (stored === String(height)) return;
    if (stored !== null && this.tip() !== null) {
      throw new Error(`this database started at activation height ${stored}, not ${height}. Start with the original option, or call store.resync() first.`);
    }
    this.setMeta("activation_height", String(height));
  }

  /** The height this database started from, or null before `follow` has recorded it. */
  activationHeight(): number | null {
    const stored = this.meta("activation_height");
    return stored === null ? null : Number(stored);
  }

  close(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.statements.clear();
    this.db.close();
  }

  tip(): { height: number; hash: string; stateHash: string } | null {
    const row = this.sql("SELECT height, hash, state_hash FROM blocks ORDER BY height DESC LIMIT 1").get() as
      | { height: number; hash: string; state_hash: string }
      | undefined;
    return row ? { height: row.height, hash: row.hash, stateHash: row.state_hash } : null;
  }

  hashAt(height: number): string | null {
    const row = this.sql("SELECT hash FROM blocks WHERE height = ?").get(height) as { hash: string } | undefined;
    return row?.hash ?? null;
  }

  /** Remember an output that was created before the activation height. Its spend is recorded when the block that spends it is committed. */
  saveOutput(txid: string, vout: number, value: bigint, p2mr?: boolean): void {
    this.sql("INSERT OR IGNORE INTO outputs (txid, vout, value, height, p2mr) VALUES (?, ?, ?, -1, ?)").run(txid, vout, value.toString(), p2mr === undefined ? null : Number(p2mr));
  }

  /** Whether a stored output is P2MR. Undefined when it is not stored or was stored without its type. */
  outputIsP2mr(txid: string, vout: number): boolean | undefined {
    const row = this.sql("SELECT p2mr FROM outputs WHERE txid = ? AND vout = ?").get(txid, vout) as { p2mr: number | null } | undefined;
    if (!row || row.p2mr === null) return undefined;
    return row.p2mr === 1;
  }

  /**
   * What the store knows about an output: `undefined` when it has no row (never seen, created before the
   * activation height and not saved, or spent long enough ago that its undo data was dropped), otherwise whether
   * it is spent. A spent row stays only while the undo of its spending block is kept.
   */
  outputState(txid: string, vout: number): { spent: boolean } | undefined {
    const row = this.sql("SELECT spent_height FROM outputs WHERE txid = ? AND vout = ?").get(txid, vout) as { spent_height: number | null } | undefined;
    return row ? { spent: row.spent_height !== null } : undefined;
  }

  outputValue(txid: string, vout: number): bigint | undefined {
    const row = this.sql("SELECT value FROM outputs WHERE txid = ? AND vout = ?").get(txid, vout) as { value: string } | undefined;
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
      this.sql("INSERT INTO blocks (height, hash, prev_hash, state_hash) VALUES (?, ?, ?, ?)").run(
        block.height,
        block.hash,
        tip?.hash ?? null,
        digest,
      );
      this.sql("INSERT INTO undo (height, payload) VALUES (?, ?)").run(block.height, JSON.stringify(freezeUndo(undo)));
      const output = this.sql("INSERT INTO outputs (txid, vout, value, height, p2mr) VALUES (?, ?, ?, ?, ?)");
      for (const tx of block.txs) {
        tx.outputs.forEach((entry, vout) => output.run(tx.txid, vout, entry.value.toString(), block.height, Number(isP2mr(entry.script))));
      }
      // A spent output is needed again only if this block is disconnected. It is kept as long as the undo of this block is.
      const spend = this.sql("UPDATE outputs SET spent_height = ? WHERE txid = ? AND vout = ?");
      for (const tx of block.txs) {
        for (const input of tx.inputs) {
          if (!input.coinbase && input.prevTxid !== undefined && input.prevVout !== undefined) spend.run(block.height, input.prevTxid, input.prevVout);
        }
      }
      this.writeInscriptions(undo.created, undo.prior.map((row) => row.id));
      const oldest = block.height - this.undoDepth;
      if (oldest >= 0) {
        this.sql("DELETE FROM undo WHERE height <= ?").run(oldest);
        this.sql("DELETE FROM outputs WHERE spent_height IS NOT NULL AND spent_height <= ?").run(oldest);
      }
      this.db.exec("COMMIT");
      this.indexer.trimUndo(this.undoDepth);
      // The bodies are on disk now. The indexer keeps no body of a stored P2MR Inscription; `bodyOf` loads it.
      for (const id of undo.created) this.indexer.releaseBody(id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (this.indexer.lastUndo()?.hash === block.hash) this.indexer.disconnectTip(block.hash);
      throw error;
    }
    return digest;
  }

  /**
   * Drop the tip block and restore the P2MR Inscriptions it changed.
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
      this.sql("DELETE FROM blocks WHERE height = ?").run(tip.height);
      this.sql("DELETE FROM undo WHERE height = ?").run(tip.height);
      this.sql("DELETE FROM outputs WHERE height = ?").run(tip.height);
      this.sql("UPDATE outputs SET spent_height = NULL WHERE spent_height = ?").run(tip.height);
      const remove = this.sql("DELETE FROM inscriptions WHERE id = ?");
      for (const id of undo.created) remove.run(id);
      this.writeInscriptions([], undo.prior.map((row) => row.id));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  stateHashAt(height: number): string | null {
    const row = this.sql("SELECT state_hash FROM blocks WHERE height = ?").get(height) as { state_hash: string } | undefined;
    return row?.state_hash ?? null;
  }

  /** Forget chain data so follow() can rebuild from the activation height. */
  resync(): void {
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM inscriptions; DELETE FROM outputs; DELETE FROM undo; DELETE FROM blocks; DELETE FROM meta WHERE key = 'activation_height';");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.indexer.adopt([]);
    this.indexer.installUndo([]);
  }

  undoCount(): number {
    const row = this.sql("SELECT COUNT(*) AS n FROM undo").get() as { n: number };
    return row.n;
  }

  /**
   * Write what a block changed. A P2MR Inscription the block created is inserted with its body, which the indexer
   * still holds. One that only moved is updated without its body (the row has it already, and the indexer no
   * longer holds it), so a transfer never rewrites a body. An id in both lists is created.
   */
  private writeInscriptions(created: readonly string[], moved: readonly string[]): void {
    const insert = this.sql(`
      INSERT INTO inscriptions (id, number, payload, body, metadata)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET number = excluded.number, payload = excluded.payload, body = excluded.body, metadata = excluded.metadata
    `);
    const fresh = new Set(created);
    for (const id of fresh) {
      const item = this.indexer.get(id);
      if (!item) continue;
      const body = item.body ?? this.indexer.bodyOf(id);
      if (!body) throw new Error(`the body of ${id} is neither in memory nor stored`);
      insert.run(item.id, item.number, JSON.stringify(freeze(item)), Buffer.from(body), item.metadata ? Buffer.from(item.metadata) : null);
    }
    const update = this.sql("UPDATE inscriptions SET number = ?, payload = ?, metadata = ? WHERE id = ?");
    for (const id of new Set(moved)) {
      if (fresh.has(id)) continue;
      const item = this.indexer.get(id);
      if (!item) continue;
      update.run(item.number, JSON.stringify(freeze(item)), item.metadata ? Buffer.from(item.metadata) : null, item.id);
    }
  }

  /** Every stored P2MR Inscription without its body: the bodies stay on disk until `bodyOf` asks for one. */
  private readInscriptions(): Inscription[] {
    const rows = this.sql("SELECT payload, metadata FROM inscriptions").all() as { payload: string; metadata: Uint8Array | null }[];
    return rows.map((row) => thaw(JSON.parse(row.payload) as Payload, row.metadata ? new Uint8Array(row.metadata) : null));
  }

  /** The stored body of one P2MR Inscription, or undefined. */
  private readBody(id: string): Uint8Array | undefined {
    const row = this.sql("SELECT body FROM inscriptions WHERE id = ?").get(id) as { body: Uint8Array } | undefined;
    return row ? new Uint8Array(row.body) : undefined;
  }

  private readUndo(): UndoEntry[] {
    const rows = this.sql("SELECT payload FROM undo ORDER BY height").all() as { payload: string }[];
    return rows.map((row) => thawUndo(JSON.parse(row.payload) as StoredUndo));
  }

  private meta(key: string): string | null {
    const row = this.sql("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.sql("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}
