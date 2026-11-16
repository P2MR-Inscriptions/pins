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
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { isP2mr } from "./address.ts";
import type { CollectionProfile } from "./collection.ts";
import { forgetStateLine, inscriptionLine, primeStateLines, resetStateLines, stateHash } from "./hash.ts";
import { Indexer, contentTypeText, type ChainBlock, type Inscription, type InscriptionQuery, type Location, type UndoEntry } from "./pins.ts";

/** PINS-2 §4.3: an indexer SHOULD keep at least 1,000 blocks of undo data. */
export const DEFAULT_UNDO_DEPTH = 1_000;
/** Blocks written in one SQLite transaction during catch-up. */
export const DEFAULT_COMMIT_BATCH = 64;

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
  metadata BLOB,
  owner_address TEXT NOT NULL DEFAULT '',
  loc_state TEXT NOT NULL DEFAULT '',
  loc_txid TEXT,
  loc_vout INTEGER,
  loc_offset TEXT,
  leaf_issuer TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT '',
  created_height INTEGER NOT NULL DEFAULT 0,
  created_index INTEGER NOT NULL DEFAULT 0,
  n INTEGER NOT NULL DEFAULT 0,
  state_line BLOB
);
CREATE UNIQUE INDEX inscriptions_number ON inscriptions (number);
CREATE INDEX inscriptions_owner ON inscriptions (owner_address);
CREATE INDEX inscriptions_location ON inscriptions (loc_txid, loc_vout);
CREATE INDEX inscriptions_issuer ON inscriptions (leaf_issuer);
CREATE INDEX inscriptions_created ON inscriptions (created_height, created_index, n);
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

function indexFields(item: Inscription): {
  owner_address: string;
  loc_state: string;
  loc_txid: string | null;
  loc_vout: number | null;
  loc_offset: string | null;
  leaf_issuer: string;
  content_type: string;
  created_height: number;
  created_index: number;
  n: number;
  state_line: Buffer;
} {
  const location = item.location;
  return {
    owner_address: item.ownerAddress,
    loc_state: location.state,
    loc_txid: location.state === "located" ? location.txid : null,
    loc_vout: location.state === "located" ? location.vout : null,
    loc_offset: location.state === "located" ? location.offset.toString() : null,
    leaf_issuer: item.leafIssuer,
    content_type: item.contentType,
    created_height: item.createdHeight,
    created_index: item.createdIndex,
    n: item.n,
    state_line: inscriptionLine(item),
  };
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
  /** How many blocks to put in one SQLite transaction. 1 is one transaction per block. */
  private batchLimit = 1;
  private batchOpen = false;
  private closed = false;
  private staged: { height: number; hash: string; stateHash: string; created: readonly string[] }[] = [];
  private readonly primeHashLines: boolean;
  private hashLinesReady = false;

  constructor(path: string, options: { undoDepth?: number; network?: "regtest" | "testnet4" | "mainnet"; marker?: Uint8Array; schema?: string; profile?: CollectionProfile | null; genesisId?: string | null; primeHashLines?: boolean } = {}) {
    this.indexer = new Indexer(options.network ?? "regtest", { marker: options.marker, schema: options.schema, genesisId: options.genesisId });
    this.profile = options.profile ?? null;
    this.primeHashLines = options.primeHashLines !== false;
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
      this.migrateInscriptionIndex();
      this.bindConfig(options.genesisId ?? null);
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      this.indexer.setItemSource(
        (id) => this.readInscription(id),
        (query) => this.selectInscriptions(query),
        () => this.inscriptionCount(),
        (txid, vout) => this.heldAt(txid, vout),
      );
      this.indexer.setBodyLoader((id) => this.readBody(id));
      this.loadIndex();
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
    if (this.closed) return;
    this.endCommitBatch();
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.statements.clear();
    this.db.close();
    this.closed = true;
  }

  /**
   * Close the database handle without writing an open batch, as a process kill would.
   * An uncommitted batch is dropped. Tests use this to check that follow resumes.
   */
  abandon(): void {
    if (this.closed) return;
    if (this.batchOpen) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The handle is being dropped the way a killed process would drop it.
      }
    }
    this.batchOpen = false;
    this.staged = [];
    this.statements.clear();
    this.db.close();
    this.closed = true;
  }

  tip(): { height: number; hash: string; stateHash: string } | null {
    const last = this.staged.at(-1);
    if (last) return { height: last.height, hash: last.hash, stateHash: last.stateHash };
    const row = this.sql("SELECT height, hash, state_hash FROM blocks ORDER BY height DESC LIMIT 1").get() as
      | { height: number; hash: string; state_hash: string }
      | undefined;
    return row ? { height: row.height, hash: row.hash, stateHash: row.state_hash } : null;
  }

  hashAt(height: number): string | null {
    const hit = this.staged.find((item) => item.height === height);
    if (hit) return hit.hash;
    const row = this.sql("SELECT hash FROM blocks WHERE height = ?").get(height) as { hash: string } | undefined;
    return row?.hash ?? null;
  }

  /** Start grouping commits into one SQLite transaction of up to `limit` blocks. */
  startCommitBatch(limit: number = DEFAULT_COMMIT_BATCH): void {
    this.flushCommitBatch();
    if (!Number.isInteger(limit) || limit < 1) throw new Error("commit batch must be a positive integer");
    this.batchLimit = limit;
  }

  /** Write any open batch and go back to one transaction per block. */
  endCommitBatch(): void {
    this.flushCommitBatch();
    this.batchLimit = 1;
  }

  /** Commit the open batch, keep the same batch size for the next blocks. */
  flushCommitBatch(): void {
    if (this.closed || !this.batchOpen) return;
    this.db.exec("COMMIT");
    for (const item of this.staged) {
      for (const id of item.created) this.indexer.releaseBody(id);
    }
    this.indexer.trimUndo(this.undoDepth);
    this.evictWorkingSet();
    this.batchOpen = false;
    this.staged = [];
  }

  /** Drop an open batch from memory and from the uncommitted transaction. */
  abortCommitBatch(): void {
    if (this.closed || !this.batchOpen) return;
    this.db.exec("ROLLBACK");
    for (const item of [...this.staged].reverse()) {
      if (this.indexer.lastUndo()?.hash === item.hash) this.indexer.disconnectTip(item.hash);
    }
    this.batchOpen = false;
    this.staged = [];
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
    this.ensureHashLines();
    const digest = stateHash(this.indexer, block);
    try {
      if (!this.batchOpen) {
        this.db.exec("BEGIN");
        this.batchOpen = true;
      }
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
      this.staged.push({ height: block.height, hash: block.hash, stateHash: digest, created: undo.created });
      if (this.staged.length >= this.batchLimit) this.flushCommitBatch();
    } catch (error) {
      this.abortCommitBatch();
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
    // An uncommitted batch is one atomic unit. A reorg drops the whole batch and starts again from the last written tip.
    if (this.staged.length > 0) {
      this.abortCommitBatch();
      return;
    }
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
      for (const id of undo.created) {
        remove.run(id);
        forgetStateLine(this.indexer, id);
      }
      this.writeInscriptions([], undo.prior.map((row) => row.id));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  stateHashAt(height: number): string | null {
    const hit = this.staged.find((item) => item.height === height);
    if (hit) return hit.stateHash;
    const row = this.sql("SELECT state_hash FROM blocks WHERE height = ?").get(height) as { state_hash: string } | undefined;
    return row?.state_hash ?? null;
  }

  /** Forget chain data so follow() can rebuild from the activation height. */
  resync(): void {
    this.abortCommitBatch();
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
    this.indexer.clearHeldCache();
    resetStateLines(this.indexer);
    this.hashLinesReady = true;
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
      INSERT INTO inscriptions (
        id, number, payload, body, metadata,
        owner_address, loc_state, loc_txid, loc_vout, loc_offset,
        leaf_issuer, content_type, created_height, created_index, n, state_line
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        number = excluded.number, payload = excluded.payload, body = excluded.body, metadata = excluded.metadata,
        owner_address = excluded.owner_address, loc_state = excluded.loc_state, loc_txid = excluded.loc_txid,
        loc_vout = excluded.loc_vout, loc_offset = excluded.loc_offset, leaf_issuer = excluded.leaf_issuer,
        content_type = excluded.content_type, created_height = excluded.created_height,
        created_index = excluded.created_index, n = excluded.n, state_line = excluded.state_line
    `);
    const fresh = new Set(created);
    for (const id of fresh) {
      const item = this.indexer.get(id);
      if (!item) continue;
      const body = item.body ?? this.indexer.bodyOf(id);
      if (!body) throw new Error(`the body of ${id} is neither in memory nor stored`);
      const idx = indexFields(item);
      insert.run(
        item.id, item.number, JSON.stringify(freeze(item)), Buffer.from(body), item.metadata ? Buffer.from(item.metadata) : null,
        idx.owner_address, idx.loc_state, idx.loc_txid, idx.loc_vout, idx.loc_offset,
        idx.leaf_issuer, idx.content_type, idx.created_height, idx.created_index, idx.n, idx.state_line,
      );
    }
    const update = this.sql(`
      UPDATE inscriptions SET
        number = ?, payload = ?, metadata = ?,
        owner_address = ?, loc_state = ?, loc_txid = ?, loc_vout = ?, loc_offset = ?,
        leaf_issuer = ?, content_type = ?, created_height = ?, created_index = ?, n = ?, state_line = ?
      WHERE id = ?
    `);
    for (const id of new Set(moved)) {
      if (fresh.has(id)) continue;
      const item = this.indexer.get(id);
      if (!item) continue;
      const idx = indexFields(item);
      update.run(
        item.number, JSON.stringify(freeze(item)), item.metadata ? Buffer.from(item.metadata) : null,
        idx.owner_address, idx.loc_state, idx.loc_txid, idx.loc_vout, idx.loc_offset,
        idx.leaf_issuer, idx.content_type, idx.created_height, idx.created_index, idx.n, idx.state_line,
        item.id,
      );
    }
  }

  private inscriptionColumns(): { name: string }[] {
    return this.db.prepare("PRAGMA table_info(" + "inscriptions" + ")").all() as { name: string }[];
  }

  /** Add indexed columns to a database that predates them, and fill them from the stored payload. */
  private migrateInscriptionIndex(): void {
    const have = new Set(this.inscriptionColumns().map((column) => column.name));
    const add: [string, string][] = [
      ["owner_address", "TEXT NOT NULL DEFAULT ''"],
      ["loc_state", "TEXT NOT NULL DEFAULT ''"],
      ["loc_txid", "TEXT"],
      ["loc_vout", "INTEGER"],
      ["loc_offset", "TEXT"],
      ["leaf_issuer", "TEXT NOT NULL DEFAULT ''"],
      ["content_type", "TEXT NOT NULL DEFAULT ''"],
      ["created_height", "INTEGER NOT NULL DEFAULT 0"],
      ["created_index", "INTEGER NOT NULL DEFAULT 0"],
      ["n", "INTEGER NOT NULL DEFAULT 0"],
      ["state_line", "BLOB"],
    ];
    for (const [name, typ] of add) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE inscriptions ADD COLUMN ${name} ${typ}`);
    }
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS inscriptions_number ON " + "inscriptions" + " (number)");
    this.db.exec("CREATE INDEX IF NOT EXISTS inscriptions_owner ON " + "inscriptions" + " (owner_address)");
    this.db.exec("CREATE INDEX IF NOT EXISTS inscriptions_location ON " + "inscriptions" + " (loc_txid, loc_vout)");
    this.db.exec("CREATE INDEX IF NOT EXISTS inscriptions_issuer ON " + "inscriptions" + " (leaf_issuer)");
    this.db.exec("CREATE INDEX IF NOT EXISTS inscriptions_created ON " + "inscriptions" + " (created_height, created_index, n)");
    const missing = this.sql("SELECT 1 AS x FROM inscriptions WHERE state_line IS NULL LIMIT 1").get() as { x: number } | undefined;
    if (!missing) return;
    const update = this.sql(`
      UPDATE inscriptions SET
        owner_address = ?, loc_state = ?, loc_txid = ?, loc_vout = ?, loc_offset = ?,
        leaf_issuer = ?, content_type = ?, created_height = ?, created_index = ?, n = ?, state_line = ?
      WHERE id = ?
    `);
    const batch = this.sql("SELECT id, payload, metadata FROM inscriptions WHERE state_line IS NULL LIMIT 1000");
    this.db.exec("BEGIN");
    try {
      for (;;) {
        const rows = batch.all() as { id: string; payload: string; metadata: Uint8Array | null }[];
        if (rows.length === 0) break;
        for (const row of rows) {
          const item = thaw(JSON.parse(row.payload) as Payload, row.metadata ? new Uint8Array(row.metadata) : null);
          const idx = indexFields(item);
          update.run(
            idx.owner_address, idx.loc_state, idx.loc_txid, idx.loc_vout, idx.loc_offset,
            idx.leaf_issuer, idx.content_type, idx.created_height, idx.created_index, idx.n, idx.state_line,
            item.id,
          );
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private loadIndex(): void {
    const max = this.sql("SELECT MAX(number) AS n FROM inscriptions").get() as { n: number | null };
    this.indexer.adoptIndex((max.n ?? -1) + 1, []);
    if (this.primeHashLines) this.ensureHashLines();
  }

  /** Load cached §4.4 line bytes from SQLite, once, before the first state hash. */
  private ensureHashLines(): void {
    if (this.hashLinesReady) return;
    const rows = this.sql("SELECT id, number, state_line FROM inscriptions WHERE state_line IS NOT NULL").all() as { id: string; number: number; state_line: Uint8Array }[];
    if (rows.length > 0) {
      primeStateLines(this.indexer, rows.map((row) => ({ id: row.id, number: row.number, line: Buffer.from(row.state_line) })));
    } else {
      resetStateLines(this.indexer);
    }
    this.hashLinesReady = true;
  }

  private evictWorkingSet(): void {
    const keep = new Set<string>();
    for (const entry of this.readUndo()) {
      for (const id of entry.created) keep.add(id);
      for (const row of entry.prior) keep.add(row.id);
    }
    for (const id of [...this.indexer.inscriptions.keys()]) {
      if (!keep.has(id)) this.indexer.unload(id);
    }
    this.indexer.clearHeldCache();
  }

  inscriptionCount(): number {
    const row = this.sql("SELECT COUNT(*) AS n FROM inscriptions").get() as { n: number };
    return row.n;
  }

  private readInscription(id: string): Inscription | undefined {
    const row = this.sql("SELECT payload, metadata FROM inscriptions WHERE id = ?").get(id) as { payload: string; metadata: Uint8Array | null } | undefined;
    return row ? thaw(JSON.parse(row.payload) as Payload, row.metadata ? new Uint8Array(row.metadata) : null) : undefined;
  }

  private heldAt(txid: string, vout: number): { id: string; offset: bigint }[] {
    const rows = this.sql("SELECT id, loc_offset FROM inscriptions WHERE loc_txid = ? AND loc_vout = ?").all(txid, vout) as { id: string; loc_offset: string }[];
    return rows.map((row) => ({ id: row.id, offset: BigInt(row.loc_offset) }));
  }

  private inscriptionWhere(query: InscriptionQuery): { sql: string; params: SQLInputValue[] } {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (query.owner !== undefined) { where.push("owner_address = ?"); params.push(query.owner); }
    if (query.leafIssuer !== undefined) { where.push("leaf_issuer = ?"); params.push(query.leafIssuer); }
    if (query.txid !== undefined) { where.push("id LIKE ?"); params.push(`${query.txid}i%`); }
    if (query.createdHeight !== undefined) { where.push("created_height = ?"); params.push(query.createdHeight); }
    if (query.number !== undefined) { where.push("number = ?"); params.push(query.number); }
    if (query.locTxid !== undefined) {
      where.push("loc_txid = ?");
      params.push(query.locTxid);
      if (query.locVout !== undefined) { where.push("loc_vout = ?"); params.push(query.locVout); }
    }
    if (query.hasMetadata) where.push("metadata IS NOT NULL");
    if (query.contentType !== undefined) { where.push("content_type = ?"); params.push(query.contentType); }
    if (query.after) {
      where.push("(created_height > ? OR (created_height = ? AND created_index > ?) OR (created_height = ? AND created_index = ? AND n > ?))");
      const a = query.after;
      params.push(a.createdHeight, a.createdHeight, a.createdIndex, a.createdHeight, a.createdIndex, a.n);
    }
    if (query.before) {
      where.push("(created_height < ? OR (created_height = ? AND created_index < ?) OR (created_height = ? AND created_index = ? AND n < ?))");
      const b = query.before;
      params.push(b.createdHeight, b.createdHeight, b.createdIndex, b.createdHeight, b.createdIndex, b.n);
    }
    return { sql: where.length ? ` WHERE ${where.join(" AND ")}` : "", params };
  }

  selectInscriptions(query: InscriptionQuery): Inscription[] {
    const { sql, params } = this.inscriptionWhere(query);
    let order = "number ASC";
    if (query.order === "created") order = "created_height ASC, created_index ASC, n ASC";
    else if (query.order === "latest") order = "created_height DESC, created_index DESC, n DESC, number DESC";
    const offset = query.offset ?? 0;
    const extra: SQLInputValue[] = [];
    let page = "";
    if (query.limit !== null && query.limit !== undefined) {
      page = " LIMIT ? OFFSET ?";
      extra.push(query.limit, offset);
    } else if (offset > 0) {
      page = " LIMIT ? OFFSET ?";
      extra.push(-1, offset);
    }
    const rows = this.sql(`SELECT payload, metadata FROM inscriptions${sql} ORDER BY ${order}${page}`).all(...params, ...extra) as { payload: string; metadata: Uint8Array | null }[];
    return rows.map((row) => thaw(JSON.parse(row.payload) as Payload, row.metadata ? new Uint8Array(row.metadata) : null));
  }

  countInscriptions(query: InscriptionQuery = {}): number {
    const { sql, params } = this.inscriptionWhere(query);
    const row = this.sql(`SELECT COUNT(*) AS n FROM inscriptions${sql}`).get(...params) as { n: number };
    return row.n;
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
