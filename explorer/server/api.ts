// SPDX-License-Identifier: Apache-2.0
import type { IncomingMessage, ServerResponse } from "node:http";
import { mediaKind, normalizeType, PREVIEW_BYTES } from "../public/content-view.js";
import { config } from "./config.ts";
import { decodeCbor } from "./cbor.ts";
import { cache, type Inscription } from "./index-cache.ts";
import { profile } from "./profile.ts";
import { publicError } from "./redact.ts";
import { rpc, rpcEnabled, rpcProbe } from "./rpc.ts";

const ID = /^[0-9a-f]{64}i\d+$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ADDRESS = /^(qb|tq|qbrt)1[0-9a-z]{6,120}$/;
const INERT_CSP = "default-src 'none'; sandbox";
/** Unique origin, inline page only. No network, frames, forms, or parent origin. */
const HTML_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";
const FIELD_CAP = 32_000;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'",
    "cache-control": "no-store",
  });
  res.end(text);
}

export function paging(url: URL, max = 200, fallback = 50): { offset: number; limit: number } {
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const limit = Number(url.searchParams.get("limit") ?? String(fallback));
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new HttpError(400, `offset must be >= 0 and limit between 1 and ${max}`);
  }
  return { offset, limit };
}

/** Explorer page window. The indexer piece read stays at 100; this limit is separate. */
export function pageSlice<T>(items: readonly T[], offset: number, limit: number): { total: number; offset: number; limit: number; shown: T[] } {
  return { total: items.length, offset, limit, shown: items.slice(offset, offset + limit) };
}

function plain(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return { bytesHex: Buffer.from(value).toString("hex") };
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  return value;
}

function metadataOf(item: Inscription): { rawHex: string; decoded?: unknown; error?: string; truncated?: boolean } | null {
  const fields = Array.isArray(item?.fields) ? item.fields : [];
  const parts = fields.filter((f) => f && f.tag === 5 && typeof f.value === "string").map((f) => f.value);
  if (parts.length === 0) return null;
  const joined = parts.join("");
  const truncated = joined.length > FIELD_CAP;
  const rawHex = truncated ? joined.slice(0, FIELD_CAP) : joined;
  if (!/^[0-9a-fA-F]*$/.test(rawHex) || rawHex.length % 2 !== 0) return { rawHex: rawHex.slice(0, 200), error: "CBOR decode failed", truncated };
  try {
    return { rawHex, decoded: plain(decodeCbor(Buffer.from(rawHex, "hex"))), ...(truncated ? { truncated: true } : {}) };
  } catch {
    return { rawHex: rawHex.slice(0, 200), error: "CBOR decode failed", truncated };
  }
}

function summary(item: Inscription) {
  const id = typeof item?.id === "string" ? item.id : "";
  const piece = id ? cache.pieceByInscription.get(id) : undefined;
  const length = Number(item?.bodyLength);
  return {
    id, number: item?.number,
    contentType: typeof item?.contentType === "string" ? item.contentType : "",
    bodyLength: Number.isFinite(length) && length >= 0 ? length : 0,
    createdHeight: item?.createdHeight, createdIndex: item?.createdIndex, n: item?.n,
    ownerAddress: typeof item?.ownerAddress === "string" ? item.ownerAddress : "",
    location: item?.location ?? null,
    burned: item?.burned === true, collectionPiece: piece ? piece.number : null,
  };
}

/** Display hint only. It does not mark the inscription authentic or invalid. */
function contentRole(item: Inscription): "leaf-list" | null {
  const collection = cache.collection;
  if (!collection || collection.status !== "present") return null;
  const genesis = typeof collection.genesisId === "string" ? collection.genesisId : "";
  const txid = genesis.slice(0, 64);
  const supply = Number(collection.supply);
  if (!HEX64.test(txid) || !Number.isInteger(supply) || supply < 0) return null;
  if (item.txid !== txid) return null;
  if (normalizeType(item.contentType) !== "application/octet-stream") return null;
  if (Number(item.bodyLength) !== supply * 32) return null;
  return "leaf-list";
}

/** Indexer piece.authentic only. Missing or non-boolean is unknown, not confirmed. */
export function authenticityState(piece: { authentic?: unknown } | null | undefined): "confirmed" | "rejected" | "unknown" {
  if (!piece || typeof piece.authentic !== "boolean") return "unknown";
  return piece.authentic ? "confirmed" : "rejected";
}

const TIP_HASH = /^[0-9a-f]{64}$/;

/**
 * On-chain means this inscription's creating height is inside the indexed tip.
 * Mock data, a stale snapshot, a missing tip hash, or a height past the tip are not confirmed.
 * Collection authenticity and content bytes are not used.
 */
export function chainInclusion(input: {
  mock?: unknown;
  stale?: unknown;
  tipHeight?: unknown;
  tipHash?: unknown;
  createdHeight?: unknown;
}): "confirmed" | "stale" | "mock" | "unknown" {
  if (input.mock === true) return "mock";
  if (input.stale === true) return "stale";
  if (typeof input.tipHash !== "string" || !TIP_HASH.test(input.tipHash)) return "unknown";
  if (!Number.isInteger(input.createdHeight) || (input.createdHeight as number) < 0) return "unknown";
  if (!Number.isInteger(input.tipHeight) || (input.tipHeight as number) < 0) return "unknown";
  if ((input.createdHeight as number) > (input.tipHeight as number)) return "unknown";
  return "confirmed";
}

/** Previous and next existing inscription numbers. Gaps are skipped. The scan uses the snapshot's number list only. */
export function inscriptionNeighbors(order: readonly number[], byNumber: ReadonlyMap<number, { id: string }>, number: number): { prev: { number: number; id: string } | null; next: { number: number; id: string } | null } {
  let prevN: number | null = null;
  let nextN: number | null = null;
  for (const n of order) {
    if (n < number) prevN = n;
    else if (n > number) { nextN = n; break; }
  }
  const pack = (n: number | null) => {
    if (n == null) return null;
    const id = byNumber.get(n)?.id;
    return id ? { number: n, id } : null;
  };
  return { prev: pack(prevN), next: pack(nextN) };
}

function detail(item: Inscription) {
  const piece = cache.pieceByInscription.get(item.id) ?? null;
  const collection = cache.collection;
  const linked = piece && collection ? {
    number: piece.number, authentic: piece.authentic, reason: piece.reason,
    confirmations: piece.confirmations, final: piece.final, attributes: piece.attributes,
    collectionName: collection.name ?? null, namePrefix: collection.namePrefix ?? null, genesisId: collection.genesisId ?? null,
  } : null;
  return {
    ...item,
    metadata: metadataOf(item),
    piece: linked,
    authenticity: authenticityState(linked),
    contentRole: contentRole(item),
    snapshotStale: cache.stale,
    neighbors: inscriptionNeighbors(cache.numberOrder, cache.byNumber, item.number),
    chain: chainInclusion({
      mock: cache.status?.mock,
      stale: cache.stale,
      tipHeight: cache.status?.height,
      tipHash: cache.status?.hash,
      createdHeight: item.createdHeight,
    }),
  };
}

function need<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new HttpError(404, `${what} not found in the indexer snapshot`);
  return value;
}

/** The image size from the manifest, only when it is two whole numbers in a sane range. */
function artSize(): { width: number; height: number } | null {
  const image = config.manifest?.image;
  const ok = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 4096;
  return image && ok(image.width) && ok(image.height) ? { width: image.width, height: image.height } : null;
}

function manifestChecks() {
  const m = config.manifest;
  const c = cache.collection;
  if (!m) return { manifest: null, checks: [] };
  const onchain = c && c.status === "present" ? c : null;
  const row = (field: string, expected: unknown, actual: unknown) => ({
    field, manifest: expected, onchain: actual ?? null, match: actual === undefined || actual === null ? null : actual === expected,
  });
  return {
    manifest: m,
    checks: [
      row("Genesis P2MR Inscription", m.genesisId, onchain?.genesisId),
      row("Name", m.name, onchain?.name),
      row("Supply", m.supply, onchain?.supply),
      row("First number", m.first, onchain?.first),
      row("Merkle root", m.merkleRoot, onchain?.root),
      row("Item type", m.itemType, onchain?.itemType),
    ],
  };
}

async function txView(txid: string) {
  const created = cache.byTxid.get(txid) ?? [];
  const holding = cache.byLocationTx.get(txid) ?? [];
  let node: unknown = null;
  let nodeError: string | null = null;
  if (rpcEnabled()) {
    try {
      const raw = await rpc<Record<string, unknown>>("getrawtransaction", [txid, true]);
      const pick: Record<string, unknown> = {};
      for (const k of ["txid", "blockhash", "confirmations", "blocktime", "time", "size", "vsize", "weight"]) if (raw[k] !== undefined) pick[k] = raw[k];
      if (Array.isArray(raw.vout)) {
        pick.vout = raw.vout.map((o: Record<string, any>) => ({ n: o.n, value: o.value, address: o.scriptPubKey?.address ?? null }));
      }
      node = pick;
    } catch {
      nodeError = "node details unavailable";
    }
  }
  return { txid, created: created.map(summary), holding: holding.map(summary), node, nodeError };
}

async function blockView(param: string) {
  let height: number;
  let hash: string | null = null;
  let header: Record<string, unknown> | null = null;
  let nodeError: string | null = null;
  if (/^\d+$/.test(param) && param.length < 16) {
    height = Number(param);
  } else if (HEX64.test(param) && rpcEnabled()) {
    const h = await rpc<Record<string, any>>("getblockheader", [param, true]);
    height = Number(h.height);
    hash = param;
  } else {
    throw new HttpError(400, "block must be a height, or a hash when node RPC is configured");
  }
  if (rpcEnabled()) {
    try {
      hash = hash ?? (await rpc<string>("getblockhash", [height]));
      const raw = await rpc<Record<string, unknown>>("getblockheader", [hash, true]);
      header = {};
      for (const k of ["hash", "height", "confirmations", "time", "nTx", "previousblockhash", "nextblockhash"]) if (raw[k] !== undefined) header[k] = raw[k];
    } catch {
      nodeError = "node details unavailable";
    }
  }
  const created = cache.byHeight.get(height) ?? [];
  return { height, hash, header, nodeError, created: created.map(summary) };
}

function search(q: string): { type: string; path: string } | null {
  const s = q.trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (ID.test(lower)) return { type: "inscription", path: `/inscription/${lower}` };
  if (HEX64.test(lower)) return { type: "transaction", path: `/tx/${lower}` };
  if (ADDRESS.test(lower)) return { type: "address", path: `/address/${lower}` };
  const words = profile.pieceWords.join("|");
  const piece = new RegExp(`^(?:${words})?\\s*#\\s*(\\d+)$`, "i").exec(s) ?? new RegExp(`^(?:${words})\\s+(\\d+)$`, "i").exec(s);
  if (piece) return { type: "collection piece", path: `/${profile.piecePath}/${Number(piece[1])}` };
  const block = /^block\s*#?\s*(\d+)$/i.exec(s);
  if (block) return { type: "block", path: `/block/${Number(block[1])}` };
  const numbered = /^(?:no\.?|n°|inscription)\s*#?\s*(\d+)$/i.exec(s);
  if (numbered) return { type: "inscription number", path: `/number/${Number(numbered[1])}` };
  if (/^\d+$/.test(s)) return { type: "inscription number", path: `/number/${Number(s)}` };
  return null;
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    const path = url.pathname.replace(/^\/api/, "") || "/";
    if (path === "/status") {
      send(res, 200, {
        explorer: { version: config.version },
        indexer: { reachable: cache.error === null && cache.status !== null, error: cache.error, ...(cache.status ?? {}) },
        snapshot: {
          ready: cache.ready, preview: cache.previewReady, piecesComplete: cache.piecesComplete,
          stale: cache.stale, height: cache.snapshotHeight, updatedAt: cache.updatedAt,
          loading: cache.loading, inscriptions: cache.list.length, owners: cache.byOwner.size,
        },
        rpc: await rpcProbe(),
        externalExplorer: config.externalExplorer,
        manifestLoaded: config.manifest !== null,
        // The source image size the manifest declares, or null. The page uses it for the width and height hints of an image.
        artSize: artSize(),
      });
      return;
    }
    if (!cache.previewReady && !cache.ready) {
      throw new HttpError(503, cache.error ? "Indexer unavailable" : "The first indexer snapshot is still loading");
    }
    if (!cache.piecesComplete && (path === "/collection/pieces" || path.startsWith("/collection/pieces/") || path === "/collection/sample")) {
      throw new HttpError(503, "The collection piece check is still loading");
    }
    if (path === "/search") {
      const found = search(url.searchParams.get("q") ?? "");
      send(res, found ? 200 : 404, found ?? { error: "Not a recognized P2MR Inscription id or number, txid, address, or piece." });
      return;
    }
    if (path === "/inscriptions") {
      const { offset, limit } = paging(url);
      const asc = url.searchParams.get("order") === "asc";
      const rows = pageSlice(asc ? cache.list : cache.newest, offset, limit);
      send(res, 200, { total: rows.total, offset: rows.offset, limit: rows.limit, inscriptions: rows.shown.map(summary) });
      return;
    }
    let m = /^\/inscription\/([0-9a-f]{64}i\d+)$/.exec(path);
    if (m) { send(res, 200, detail(need(cache.byId.get(m[1]), "P2MR Inscription"))); return; }
    m = /^\/number\/(\d+)$/.exec(path);
    if (m) { send(res, 200, detail(need(cache.byNumber.get(Number(m[1])), "P2MR Inscription number"))); return; }
    m = /^\/content\/([0-9a-f]{64}i\d+)$/.exec(path);
    if (m) { await content(req, res, need(cache.byId.get(m[1]), "P2MR Inscription"), url); return; }
    if (path === "/collection") {
      const c = cache.collection ?? { status: cache.previewReady ? "pending" : "absent" };
      const authentic = cache.piecesComplete ? cache.pieces.filter((p) => p.authentic).length : null;
      send(res, 200, { onchain: c, authenticPieces: authentic, piecesComplete: cache.piecesComplete, ...manifestChecks() });
      return;
    }
    if (path === "/collection/sample") {
      const count = Math.min(60, Math.max(1, Number(url.searchParams.get("count") ?? "12") || 12));
      const pool = cache.pieces.filter((p) => p.authentic && p.inscriptionId);
      const take = Math.min(count, pool.length);
      const pieces = Array.from({ length: take }, (_, k) => pool[Math.floor((k * pool.length) / take)]);
      send(res, 200, { pieces });
      return;
    }
    if (path === "/collection/pieces") {
      const { offset, limit } = paging(url, 200, 100);
      const only = url.searchParams.get("authentic") === "1";
      const source = only ? cache.pieces.filter((p) => p.authentic) : cache.pieces;
      const rows = pageSlice(source, offset, limit);
      send(res, 200, { total: rows.total, offset: rows.offset, limit: rows.limit, pieces: rows.shown });
      return;
    }
    m = /^\/collection\/pieces\/(\d+)$/.exec(path);
    if (m) {
      send(res, 200, need(cache.pieceByNumber.get(Number(m[1])), "collection piece"));
      return;
    }
    m = /^\/address\/([0-9a-z]+)$/.exec(path);
    if (m && ADDRESS.test(m[1])) {
      const { offset, limit } = paging(url, 200, 100);
      const all = cache.byOwner.get(m[1]) ?? [];
      const rows = pageSlice(all, offset, limit);
      const outputs = new Map<string, number>();
      for (const item of all) if (item.location?.state === "located") {
        const key = `${item.location.txid}:${item.location.vout}`;
        outputs.set(key, (outputs.get(key) ?? 0) + 1);
      }
      send(res, 200, {
        address: m[1], total: rows.total, offset: rows.offset, limit: rows.limit,
        collectionPieces: all.filter((i) => cache.pieceByInscription.has(i.id)).length,
        outputs: [...outputs].map(([outpoint, count]) => ({ outpoint, count })),
        inscriptions: rows.shown.map(summary),
      });
      return;
    }
    m = /^\/tx\/([0-9a-f]{64})$/.exec(path);
    if (m) { send(res, 200, await txView(m[1])); return; }
    m = /^\/block\/(\w+)$/.exec(path);
    if (m) { send(res, 200, await blockView(m[1])); return; }
    throw new HttpError(404, "unknown API route");
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const secrets = config.rpc ? [config.rpc.user, config.rpc.password] : [];
    send(res, status, { error: error instanceof HttpError ? error.message : publicError(error, secrets) });
  }
}

const contentCache = new Map<string, Buffer>();
const CONTENT_CACHE_MAX = 48;

function contentKey(item: Inscription): string {
  const id = typeof item.id === "string" ? item.id : "";
  const sha = typeof item.bodySha256 === "string" ? item.bodySha256 : "";
  return `${id}:${sha}`;
}

function rememberContent(key: string, body: Buffer): void {
  if (contentCache.has(key)) contentCache.delete(key);
  contentCache.set(key, body);
  while (contentCache.size > CONTENT_CACHE_MAX) {
    const oldest = contentCache.keys().next().value;
    if (oldest === undefined) break;
    contentCache.delete(oldest);
  }
}

function attachmentName(id: string): string {
  return ID.test(id) ? `${id}.bin` : "content.bin";
}

/** One byte range. Multiple ranges are refused. The body is already buffered; nothing is forwarded. */
function singleRange(header: string, size: number): { start: number; end: number } | "bad" {
  if (!header.startsWith("bytes=") || header.includes(",")) return "bad";
  const spec = header.slice("bytes=".length).trim();
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match || (match[1] === "" && match[2] === "") || size <= 0) return "bad";
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) return "bad";
    const count = Math.min(suffix, size);
    return { start: size - count, end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) return "bad";
  return { start, end: Math.min(end, size - 1) };
}

function finish(req: IncomingMessage, res: ServerResponse, status: number, headers: Record<string, string>, body?: Buffer): void {
  res.writeHead(status, headers);
  res.end(req.method === "HEAD" || body === undefined ? undefined : body);
}

async function readUpstream(req: IncomingMessage, item: Inscription, limit: number, truncate: boolean): Promise<Buffer> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.contentTimeoutMs);
  const onClose = () => ac.abort();
  req.on("close", onClose);
  const chunks: Buffer[] = [];
  try {
    let upstream: Response;
    try {
      upstream = await fetch(`${config.indexerUrl}/content/${item.id}`, { redirect: "error", signal: ac.signal });
    } catch (error) {
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
      const message = `${error instanceof Error ? error.message : ""} ${cause}`;
      if (/redirect/i.test(message)) throw new HttpError(502, "indexer content redirect was refused");
      throw new HttpError(502, "indexer content was not available");
    }
    if (!upstream.ok || !upstream.body) throw new HttpError(502, `indexer content answered HTTP ${upstream.status}`);
    const declared = Number(upstream.headers.get("content-length") ?? "");
    if (!truncate && Number.isFinite(declared) && declared > limit) throw new HttpError(413, "P2MR Inscription content is larger than the limit");
    const reader = upstream.body.getReader();
    let total = 0;
    while (true) {
      const step = await reader.read();
      if (step.done) break;
      const value = Buffer.from(step.value);
      if (total + value.length > limit) {
        if (truncate) {
          chunks.push(value.subarray(0, Math.max(0, limit - total)));
          await reader.cancel();
          break;
        }
        await reader.cancel();
        throw new HttpError(413, "P2MR Inscription content is larger than the limit");
      }
      total += value.length;
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "indexer content was not available");
  } finally {
    clearTimeout(timer);
    req.off("close", onClose);
  }
  return Buffer.concat(chunks);
}

async function fullBody(req: IncomingMessage, item: Inscription): Promise<Buffer> {
  const key = contentKey(item);
  const cached = contentCache.get(key);
  if (cached) return cached;
  const body = await readUpstream(req, item, config.contentMaxBytes, false);
  if (body.length <= 1_500_000) rememberContent(key, body);
  return body;
}

/**
 * Inscription bytes are untrusted.
 * Raster images and SVG paint as images. Text preview is plain and short.
 * Audio and video keep their media type so the browser can play them.
 * HTML runs only for ?frame=1, and only under HTML_CSP.
 * The cache key is the inscription id plus its body hash, never the type alone.
 */
async function content(req: IncomingMessage, res: ServerResponse, item: Inscription, url: URL): Promise<void> {
  const type = normalizeType(item.contentType);
  const kind = mediaKind(item.contentType);
  const download = url.searchParams.get("download") === "1";
  const preview = url.searchParams.get("preview") === "1";
  const frame = url.searchParams.get("frame") === "1";
  const sha = typeof item.bodySha256 === "string" ? item.bodySha256 : "";
  const etag = `"${sha}"`;
  const dest = typeof req.headers["sec-fetch-dest"] === "string" ? req.headers["sec-fetch-dest"] : "";
  const common = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "private, no-cache", etag };
  if (!preview && req.headers["if-none-match"] === etag) {
    finish(req, res, 304, { ...common, "content-security-policy": INERT_CSP });
    return;
  }
  if (preview) {
    if (kind !== "text") throw new HttpError(415, "This content has no text preview");
    const cached = contentCache.get(contentKey(item));
    const body = cached ? cached.subarray(0, PREVIEW_BYTES) : await readUpstream(req, item, PREVIEW_BYTES, true);
    finish(req, res, 200, { ...common, "content-security-policy": INERT_CSP, "content-type": "text/plain; charset=utf-8" }, body);
    return;
  }
  const body = await fullBody(req, item);
  if (download) {
    finish(req, res, 200, {
      ...common,
      "content-security-policy": INERT_CSP,
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${attachmentName(item.id)}"`,
    }, body);
    return;
  }
  if (frame) {
    if (kind !== "html") throw new HttpError(415, "This content is not a page");
    finish(req, res, 200, { ...common, "content-security-policy": HTML_CSP, "content-type": "text/html; charset=utf-8" }, body);
    return;
  }
  const headers: Record<string, string> = { ...common, "content-security-policy": INERT_CSP };
  let contentType = "application/octet-stream";
  let payload = body;
  let status = 200;
  if (kind === "image") {
    contentType = type;
    headers["content-security-policy"] = "default-src 'none'";
  } else if (kind === "svg") {
    contentType = "image/svg+xml";
    headers["content-security-policy"] = dest === "image"
      ? "default-src 'none'; script-src 'none'"
      : "default-src 'none'; script-src 'none'; sandbox";
  } else if (kind === "audio" || kind === "video") {
    contentType = type;
    headers["content-security-policy"] = "default-src 'none'";
    headers["accept-ranges"] = "bytes";
    const range = req.headers.range;
    if (typeof range === "string" && range.trim()) {
      const parsed = singleRange(range.trim(), body.length);
      if (parsed === "bad") {
        finish(req, res, 416, { ...headers, "content-range": `bytes */${body.length}`, "content-type": contentType });
        return;
      }
      status = 206;
      payload = body.subarray(parsed.start, parsed.end + 1);
      headers["content-range"] = `bytes ${parsed.start}-${parsed.end}/${body.length}`;
    }
  } else if (type.startsWith("text/") || type === "application/json") {
    contentType = "text/plain; charset=utf-8";
  } else {
    headers["content-disposition"] = `attachment; filename="${attachmentName(item.id)}"`;
  }
  finish(req, res, status, { ...headers, "content-type": contentType }, payload);
}
