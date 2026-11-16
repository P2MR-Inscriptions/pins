// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical state hash, PINS-2 §4.4. Two indexers that saw the same blocks produce the
 * same hex digest. The preimage is one line for the tip block, then one line per P2MR Inscription,
 * sorted by number, joined by LF with no trailing LF. The content type is the raw bytes of the
 * first field 1 value, with LF written as `%0a` and `%` as `%25`, so a value that holds a space or
 * a line break cannot move a field or start a line.
 *
 * The digest is the SHA-256 of that exact preimage. It is not chained: the first line is the tip
 * block, so every tip is hashed from scratch. Unchanged P2MR Inscription lines are kept as the same
 * bytes and fed to SHA-256 again; only P2MR Inscriptions whose hashed fields changed are re-encoded.
 */
import { createHash } from "node:crypto";
import { contentTypeBytes, type Indexer, type Inscription } from "./pins.ts";

/** The content type bytes of `contentTypeBytes` (the first field 1 value, unaltered), with LF and `%` escaped (PINS-2 §4.4). Empty when the field is absent. */
export function escapedContentType(item: Inscription): Buffer {
  const raw = contentTypeBytes(item);
  let extra = 0;
  for (const byte of raw) {
    if (byte === 0x0a || byte === 0x25) extra += 2;
  }
  if (extra === 0) return raw.length === 0 ? Buffer.alloc(0) : Buffer.from(raw);
  const out = Buffer.allocUnsafe(raw.length + extra);
  let offset = 0;
  for (const byte of raw) {
    if (byte === 0x0a) {
      out[offset++] = 0x25;
      out[offset++] = 0x30;
      out[offset++] = 0x61;
    } else if (byte === 0x25) {
      out[offset++] = 0x25;
      out[offset++] = 0x32;
      out[offset++] = 0x35;
    } else {
      out[offset++] = byte;
    }
  }
  return out;
}

function placeOf(item: Inscription): string {
  return item.location.state === "located"
    ? `${item.location.txid}:${item.location.vout}:${item.location.offset}`
    : item.location.state;
}

function flagsOf(item: Inscription): string {
  return [...item.flags].sort().join(",");
}

function flagsUnchanged(current: readonly string[], snapshot: readonly string[]): boolean {
  if (current.length !== snapshot.length) return false;
  for (let i = 0; i < current.length; i++) {
    if (current[i] !== snapshot[i]) return false;
  }
  return true;
}

function lineUnchanged(item: Inscription, prev: CachedLine): boolean {
  if (prev.number !== item.number || prev.owner !== item.ownerAddress || prev.locationHeight !== item.locationHeight) {
    return false;
  }
  if (!flagsUnchanged(item.flags, prev.flags)) return false;
  if (item.location.state !== prev.state) return false;
  if (item.location.state === "located") {
    return item.location.txid === prev.txid && item.location.vout === prev.vout && item.location.offset === prev.offset;
  }
  return true;
}

/** One P2MR Inscription line of PINS-2 §4.4, without a trailing LF. */
export function inscriptionLine(item: Inscription): Buffer {
  return Buffer.concat([
    Buffer.from(`${item.number} ${item.id} ${item.bodySha256} `, "utf8"),
    escapedContentType(item),
    Buffer.from(` ${placeOf(item)} ${item.ownerAddress} ${item.locationHeight} ${flagsOf(item)}`, "utf8"),
  ]);
}

type CachedLine = {
  number: number;
  state: Inscription["location"]["state"];
  txid?: string;
  vout?: number;
  offset?: bigint;
  owner: string;
  locationHeight: number;
  flags: string[];
  line: Buffer;
};

type LineCache = {
  /** Line bytes by P2MR Inscription number. A hole is `undefined`. */
  lines: (Buffer | undefined)[];
  byId: Map<string, CachedLine>;
  /**
   * When true, the line array is the complete tip set (a store primed it, or it
   * grew from an empty store). Ids missing from the in-memory map were evicted,
   * not deleted, and their lines stay.
   */
  complete: boolean;
};

const caches = new WeakMap<Indexer, LineCache>();

function cacheOf(indexer: Indexer): LineCache {
  const hit = caches.get(indexer);
  if (hit) return hit;
  const created: LineCache = { lines: [], byId: new Map(), complete: false };
  caches.set(indexer, created);
  return created;
}

function remember(item: Inscription, line: Buffer): CachedLine {
  const flags = [...item.flags];
  if (item.location.state === "located") {
    return {
      number: item.number,
      state: "located",
      txid: item.location.txid,
      vout: item.location.vout,
      offset: item.location.offset,
      owner: item.ownerAddress,
      locationHeight: item.locationHeight,
      flags,
      line,
    };
  }
  return {
    number: item.number,
    state: item.location.state,
    owner: item.ownerAddress,
    locationHeight: item.locationHeight,
    flags,
    line,
  };
}

/**
 * Refresh cached line bytes for P2MR Inscriptions whose hashed fields changed, and drop
 * lines for ids the indexer no longer holds. The preimage bytes stay those of §4.4.
 */
function syncLines(indexer: Indexer): (Buffer | undefined)[] {
  const cache = cacheOf(indexer);
  const seen = new Set<string>();
  for (const item of indexer.inscriptions.values()) {
    seen.add(item.id);
    const prev = cache.byId.get(item.id);
    if (prev && lineUnchanged(item, prev)) continue;
    const line = inscriptionLine(item);
    if (prev && prev.number !== item.number && cache.lines[prev.number] === prev.line) {
      cache.lines[prev.number] = undefined;
    }
    const next = remember(item, line);
    cache.byId.set(item.id, next);
    cache.lines[item.number] = line;
  }
  if (!cache.complete && cache.byId.size !== seen.size) {
    for (const [id, prev] of cache.byId) {
      if (seen.has(id)) continue;
      if (cache.lines[prev.number] === prev.line) cache.lines[prev.number] = undefined;
      cache.byId.delete(id);
    }
  }
  while (cache.lines.length > 0 && cache.lines[cache.lines.length - 1] === undefined) cache.lines.pop();
  return cache.lines;
}


/**
 * Install already-encoded §4.4 line bytes, in number order, so `stateHash` does
 * not walk every payload. Further creates and moves still update the cache from
 * the in-memory working set. The digest is unchanged.
 */
export function primeStateLines(indexer: Indexer, rows: { id: string; number: number; line: Buffer }[]): void {
  const cache = cacheOf(indexer);
  cache.lines = [];
  cache.byId.clear();
  cache.complete = true;
  for (const row of rows) {
    cache.lines[row.number] = row.line;
    cache.byId.set(row.id, {
      number: row.number,
      state: "unbound",
      owner: "",
      locationHeight: -1,
      flags: [],
      line: row.line,
    });
  }
}

/** Clear the line cache, as after `resync`. */
export function resetStateLines(indexer: Indexer): void {
  const cache = cacheOf(indexer);
  cache.lines = [];
  cache.byId.clear();
  cache.complete = true;
}

/** Drop one cached line, as when a reorg removes a P2MR Inscription the block created. */
export function forgetStateLine(indexer: Indexer, id: string): void {
  const cache = cacheOf(indexer);
  const prev = cache.byId.get(id);
  if (!prev) return;
  if (cache.lines[prev.number] === prev.line) cache.lines[prev.number] = undefined;
  cache.byId.delete(id);
  while (cache.lines.length > 0 && cache.lines[cache.lines.length - 1] === undefined) cache.lines.pop();
}

export function stateHash(indexer: Indexer, block: { height: number; hash: string }): string {
  const lines = syncLines(indexer);
  const hash = createHash("sha256");
  hash.update(`block ${block.height} ${block.hash}`, "utf8");
  for (const line of lines) {
    if (!line) continue;
    hash.update("\n");
    hash.update(line);
  }
  return hash.digest("hex");
}
