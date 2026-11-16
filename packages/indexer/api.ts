// SPDX-License-Identifier: Apache-2.0

/**
 * Read-only HTTP API. It binds to loopback. Content responses send the
 * P2MR Inscription bytes with the recorded content type and headers that stop a
 * browser from treating those bytes as a script. The list endpoints take optional
 * `offset` and `limit`. Results that depend only on the indexed state are kept until
 * the tip changes. docs/indexer/API.md describes both.
 */
import { createServer, type ServerResponse } from "node:http";
import type { FollowNetwork } from "./chains.ts";
import { CLOSE_SCHEMA, LEAFLIST_SCHEMA, SALE_REVEAL_SCHEMA, collectionView, piecePage, pieceByNumber, publicLocation, traitsFromMetadata } from "./collection.ts";
import { rpcChainName } from "./chains.ts";
import { contentTypeBytes } from "./pins.ts";
import { DEFAULT_PIECES_LIMIT, PAGE_ERROR, pageRequest, slicePage } from "./paging.ts";
import type { Store } from "./store.ts";
import { TipCache } from "./tip-cache.ts";
import { STANDARDS } from "../protocol/index.mjs";

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
  "cache-control": "no-store",
};

/**
 * The standards this indexer implements, by id. PINS-6 describes trades between wallets and marketplaces.
 * The indexer reads no PSBT, so it is not listed.
 */
export const INDEXER_STANDARD_IDS: readonly string[] = ["PINS-1", "PINS-2", "PINS-3", "PINS-4", "PINS-5"];

/** Host names a client of the loopback listener may use. `allowedHosts` adds names, for a reverse proxy. */
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

/**
 * A page on another site can make a browser send requests to 127.0.0.1 under that site's own name
 * (DNS rebinding). Its Host header then is not a loopback name, and the request is refused.
 * A request with no Host header is HTTP/1.0 and cannot come from such a page.
 */
export function hostAllowed(header: string | undefined, allowedHosts: readonly string[] = []): boolean {
  if (header === undefined) return true;
  const name = header.toLowerCase().replace(/:\d+$/, "");
  return LOOPBACK_HOSTS.includes(name) || allowedHosts.some((host) => host.toLowerCase() === name);
}

/**
 * A recorded content type is whatever the inscriber wrote. One that is not a plain header value would make
 * `writeHead` throw, so the item could not be read. Such a value is served as bytes. `/inscription/{id}` still shows it.
 */
export function servedContentType(value: string): string {
  return value.length > 0 && /^[\x20-\x7e]+$/.test(value) ? value : "application/octet-stream";
}

/** `decodeURIComponent` throws on a bad escape such as `%zz`. That is a bad request, not a server error. */
function decodePath(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = HEADERS): void {
  const text = JSON.stringify(body, (_key, value) => typeof value === "bigint" ? value.toString() : value);
  response.writeHead(status, headers);
  response.end(text);
}

/** What a malformed outpoint in `/output/{outpoint}` is refused with. */
const OUTPOINT_ERROR = "outpoint must be <txid>:<vout>, with the txid as 64 lowercase hex digits and the vout as a whole number in digits, without a leading zero, from 0 to 4294967294";

/**
 * `<txid>:<vout>` in its one canonical form: 64 lowercase hex digits, a colon, and a vout in plain decimal (`0`, or
 * digits with no leading zero) of at most 4294967294. Anything else is refused, so two spellings never name the same
 * output and a malformed one is never read as an output that holds nothing.
 */
function parseOutpoint(text: string): { txid: string; vout: number } | null {
  const match = /^([0-9a-f]{64}):(0|[1-9][0-9]{0,9})$/.exec(text);
  if (!match) return null;
  const vout = Number(match[2]);
  if (vout > 0xfffffffe) return null;
  return { txid: match[1], vout };
}

type Row = NonNullable<ReturnType<typeof inscriptionJson>>;

function jsonRows(items: Iterable<ReturnType<Store["indexer"]["get"]>>): Row[] {
  const rows: Row[] = [];
  for (const item of items) {
    const row = inscriptionJson(item);
    if (row) rows.push(row);
  }
  return rows;
}

/** What a list response says about the page it holds. `limit` is null when the request set none. */
function pageMeta(page: { total: number; offset: number; limit: number | null }): { total: number; offset: number; limit: number | null } {
  return { total: page.total, offset: page.offset, limit: page.limit };
}

function inscriptionJson(item: ReturnType<Store["indexer"]["get"]>) {
  if (!item) return null;
  // Same hex script as `/pieces/{n}`. Do not pass `item.location` through JSON.stringify.
  const location = publicLocation(item.location);
  return {
    id: item.id,
    txid: item.txid,
    n: item.n,
    number: item.number,
    contentType: item.contentType,
    contentTypeHex: contentTypeBytes(item).toString("hex"),
    bodySha256: item.bodySha256,
    bodyLength: item.bodyLength,
    fields: item.fields,
    createdHeight: item.createdHeight,
    createdIndex: item.createdIndex,
    locationHeight: item.locationHeight,
    location,
    ownerAddress: item.ownerAddress,
    ownerScript: item.ownerScript,
    leafIssuer: item.leafIssuer,
    flags: item.flags,
    burned: item.location.state === "burned",
    reinscription: item.flags.includes("reinscription"),
  };
}

export function startApi(store: Store, port = 0, network: FollowNetwork = "regtest", options: { allowedHosts?: readonly string[] } = {}): Promise<{ url: string; close: () => Promise<void>; cacheStats: () => { hits: number; misses: number } }> {
  const allowedHosts = options.allowedHosts ?? [];
  const cache = new TipCache();
  const server = createServer((request, response) => {
    if (!hostAllowed(request.headers.host, allowedHosts)) {
      send(response, 403, { error: "host not allowed" });
      return;
    }
    void handle(store, cache, request, response, network);
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const chosen = address && typeof address === "object" ? address.port : port;
      resolve({
        url: `http://127.0.0.1:${chosen}`,
        close: () => new Promise((done, reject) => server.close((error) => error ? reject(error) : done())),
        cacheStats: () => ({ hits: cache.hits, misses: cache.misses }),
      });
    });
  });
}

async function handle(store: Store, cache: TipCache, request: { method?: string; url?: string }, response: ServerResponse, network: FollowNetwork): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const tip = store.tip();
    const tipHeight = tip?.height ?? -1;
    // The tip these results are for. A client that reads a list in several pages compares it between pages.
    const headers: Record<string, string> = tip ? { ...HEADERS, "x-indexed-tip": `${tip.height}:${tip.hash}` } : HEADERS;
    const reply = (status: number, body: unknown) => send(response, status, body, headers);
    const key = tip ? `${tip.height}:${tip.hash}:${tip.stateHash}` : "none";
    const view = () => cache.get(key, "view", () => collectionView(store.indexer, { tipHeight, blockHash: (height) => store.hashAt(height) }, store.profile));
    if (request.method !== "GET") {
      reply(405, { error: "read only" });
      return;
    }
    if (url.pathname === "/status") {
      reply(200, {
        network,
        chain: rpcChainName(network),
        height: tipHeight,
        hash: tip?.hash ?? null,
        stateHash: tip?.stateHash ?? null,
        inscriptions: store.indexer.size,
        undoBlocks: store.undoCount(),
        activationHeight: store.activationHeight(),
        standards: STANDARDS.filter((standard) => INDEXER_STANDARD_IDS.includes(standard.id)).map((standard) => ({ id: standard.id, version: standard.version })),
        schemas: {
          collection: store.indexer.collectionSchema,
          price: store.indexer.priceSchema,
          leafList: LEAFLIST_SCHEMA,
          saleReveal: SALE_REVEAL_SCHEMA,
          close: CLOSE_SCHEMA,
        },
      });
      return;
    }
    if (url.pathname === "/collection") {
      const { pieces, ...rest } = await view();
      reply(200, { ...rest, authentic: pieces?.filter((piece) => piece.authentic).length ?? 0, supply: rest.supply ?? 0 });
      return;
    }
    if (url.pathname === "/inscriptions") {
      const page = pageRequest(url.searchParams, null);
      if (!page) {
        reply(400, { error: PAGE_ERROR });
        return;
      }
      const owner = url.searchParams.get("owner") ?? undefined;
      const txid = url.searchParams.get("txid") ?? undefined;
      const locTxid = url.searchParams.get("locTxid") ?? undefined;
      const createdText = url.searchParams.get("createdHeight");
      const numberText = url.searchParams.get("number");
      const createdHeight = createdText === null ? undefined : (/^\d{1,15}$/.test(createdText) ? Number(createdText) : null);
      const number = numberText === null ? undefined : (/^\d{1,15}$/.test(numberText) ? Number(numberText) : null);
      if (createdHeight === null || number === null) {
        reply(400, { error: PAGE_ERROR });
        return;
      }
      const order = url.searchParams.get("sort") === "latest" ? "latest" as const : "number" as const;
      const filter = { owner, txid, locTxid, createdHeight, number };
      const cacheKey = `inscriptions:${owner ?? ""}:${txid ?? ""}:${locTxid ?? ""}:${createdHeight ?? ""}:${number ?? ""}:${order}:${page.offset}:${page.limit}`;
      const listed = await cache.get(key, cacheKey, () => {
        const total = store.countInscriptions(filter);
        const shown = jsonRows(store.selectInscriptions({ ...filter, order, offset: page.offset, limit: page.limit }));
        return { total, shown };
      });
      reply(200, { ...pageMeta({ total: listed.total, offset: page.offset, limit: page.limit }), inscriptions: listed.shown });
      return;
    }
    if (url.pathname.startsWith("/inscription/")) {
      const id = decodePath(url.pathname.slice("/inscription/".length));
      if (id === null) {
        reply(400, { error: "bad escape in the path" });
        return;
      }
      const item = store.indexer.get(id);
      if (!item) reply(404, { error: "not found" });
      else reply(200, inscriptionJson(item));
      return;
    }
    if (url.pathname.startsWith("/content/")) {
      const id = decodePath(url.pathname.slice("/content/".length));
      if (id === null) {
        reply(400, { error: "bad escape in the path" });
        return;
      }
      const item = store.indexer.get(id);
      if (!item) {
        reply(404, { error: "not found" });
        return;
      }
      // Load the body first: a failure here is a 500 with a JSON error, not a half-written 200.
      const body = store.indexer.bodyOf(item.id);
      if (!body) throw new Error(`the body of ${item.id} is not stored`);
      response.writeHead(200, {
        ...headers,
        "content-type": servedContentType(item.contentType),
      });
      response.end(Buffer.from(body));
      return;
    }
    if (url.pathname.startsWith("/output/")) {
      const outpoint = decodePath(url.pathname.slice("/output/".length));
      if (outpoint === null) {
        reply(400, { error: "bad escape in the path" });
        return;
      }
      const page = pageRequest(url.searchParams, null);
      if (!page) {
        reply(400, { error: PAGE_ERROR });
        return;
      }
      const parsed = parseOutpoint(outpoint);
      if (!parsed) {
        reply(400, { error: OUTPOINT_ERROR });
        return;
      }
      const key = `${parsed.txid}:${parsed.vout}`;
      const state = store.outputState(parsed.txid, parsed.vout);
      const held = await cache.get(key, `output:${parsed.txid}:${parsed.vout}`, () => jsonRows(store.selectInscriptions({ locTxid: parsed.txid, locVout: parsed.vout, order: "number" })));
      const shown = slicePage(held, page);
      // An output that holds a P2MR Inscription is known whatever the table says (it was created in an indexed block).
      const known = state !== undefined || held.length > 0;
      const spent = state ? state.spent : held.length > 0 ? false : null;
      reply(200, { outpoint: key, known, spent, ...pageMeta(shown), inscriptions: shown.shown });
      return;
    }
    if (url.pathname === "/pieces" || url.pathname.startsWith("/pieces/")) {
      const collection = await view();
      const withTraits = (piece: NonNullable<ReturnType<typeof pieceByNumber>>) => {
        const item = piece.inscriptionId ? store.indexer.get(piece.inscriptionId) : undefined;
        return { ...piece, attributes: traitsFromMetadata(item?.metadata ?? undefined) };
      };
      if (url.pathname === "/pieces") {
        const request = pageRequest(url.searchParams, DEFAULT_PIECES_LIMIT);
        const authenticOnly = url.searchParams.get("authentic") === "1";
        const page = request && request.limit !== null ? piecePage(collection.pieces ?? [], request.offset, request.limit, authenticOnly) : null;
        if (!page) {
          reply(400, { error: PAGE_ERROR });
          return;
        }
        reply(200, { ...page, pieces: page.pieces.map((piece) => withTraits(piece)) });
        return;
      }
      const number = Number(url.pathname.slice("/pieces/".length));
      const piece = pieceByNumber(collection, number);
      if (!piece) reply(404, { error: "not found" });
      else reply(200, withTraits(piece));
      return;
    }
    reply(404, { error: "not found" });
  } catch (error) {
    if (!response.headersSent) send(response, 500, { error: error instanceof Error ? error.message : "request failed" });
  }
}
