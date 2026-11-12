// SPDX-License-Identifier: Apache-2.0

/**
 * Read-only HTTP API. It binds to loopback. Content responses send the
 * inscription bytes with the recorded content type and headers that stop a
 * browser from treating those bytes as a script.
 */
import { createServer, type ServerResponse } from "node:http";
import type { FollowNetwork } from "./chains.ts";
import { collectionView, piecePage, pieceByNumber, publicLocation, traitsFromMetadata } from "./collection.ts";
import { rpcChainName } from "./chains.ts";
import type { Store } from "./store.ts";

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
  "cache-control": "no-store",
};

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

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, (_key, value) => typeof value === "bigint" ? value.toString() : value);
  response.writeHead(status, HEADERS);
  response.end(text);
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
    bodySha256: item.bodySha256,
    bodyLength: item.body.length,
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

export function startApi(store: Store, port = 0, network: FollowNetwork = "regtest", options: { allowedHosts?: readonly string[] } = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const allowedHosts = options.allowedHosts ?? [];
  const server = createServer((request, response) => {
    if (!hostAllowed(request.headers.host, allowedHosts)) {
      send(response, 403, { error: "host not allowed" });
      return;
    }
    void handle(store, request, response, network);
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const chosen = address && typeof address === "object" ? address.port : port;
      resolve({
        url: `http://127.0.0.1:${chosen}`,
        close: () => new Promise((done, reject) => server.close((error) => error ? reject(error) : done())),
      });
    });
  });
}

async function handle(store: Store, request: { method?: string; url?: string }, response: ServerResponse, network: FollowNetwork): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const tip = store.tip();
    const tipHeight = tip?.height ?? -1;
    if (request.method !== "GET") {
      send(response, 405, { error: "read only" });
      return;
    }
    if (url.pathname === "/status") {
      send(response, 200, {
        network,
        chain: rpcChainName(network),
        height: tipHeight,
        hash: tip?.hash ?? null,
        stateHash: tip?.stateHash ?? null,
        inscriptions: store.indexer.inscriptions.size,
        undoBlocks: store.undoCount(),
        activationHeight: store.activationHeight(),
      });
      return;
    }
    if (url.pathname === "/collection") {
      const view = await collectionView(store.indexer, { tipHeight, blockHash: (height) => store.hashAt(height) }, store.profile);
      const { pieces, ...rest } = view;
      send(response, 200, { ...rest, authentic: pieces?.filter((piece) => piece.authentic).length ?? 0, supply: rest.supply ?? 0 });
      return;
    }
    if (url.pathname === "/inscriptions") {
      const owner = url.searchParams.get("owner");
      const rows = [...store.indexer.inscriptions.values()]
        .filter((item) => !owner || item.ownerAddress === owner)
        .sort((left, right) => left.number - right.number)
        .map((item) => inscriptionJson(item));
      send(response, 200, { inscriptions: rows });
      return;
    }
    if (url.pathname.startsWith("/inscription/")) {
      const id = decodePath(url.pathname.slice("/inscription/".length));
      if (id === null) {
        send(response, 400, { error: "bad escape in the path" });
        return;
      }
      const item = store.indexer.get(id);
      if (!item) send(response, 404, { error: "not found" });
      else send(response, 200, inscriptionJson(item));
      return;
    }
    if (url.pathname.startsWith("/content/")) {
      const id = decodePath(url.pathname.slice("/content/".length));
      if (id === null) {
        send(response, 400, { error: "bad escape in the path" });
        return;
      }
      const item = store.indexer.get(id);
      if (!item) {
        send(response, 404, { error: "not found" });
        return;
      }
      response.writeHead(200, {
        "content-type": servedContentType(item.contentType),
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "no-store",
      });
      response.end(Buffer.from(item.body));
      return;
    }
    if (url.pathname.startsWith("/output/")) {
      const outpoint = decodePath(url.pathname.slice("/output/".length));
      if (outpoint === null) {
        send(response, 400, { error: "bad escape in the path" });
        return;
      }
      const [txid, voutText] = outpoint.split(":");
      const vout = Number(voutText);
      const rows = [...store.indexer.inscriptions.values()].filter((item) => item.location.state === "located" && item.location.txid === txid && item.location.vout === vout);
      send(response, 200, { outpoint, inscriptions: rows.map((item) => inscriptionJson(item)) });
      return;
    }
    if (url.pathname === "/pieces" || url.pathname.startsWith("/pieces/")) {
      const view = await collectionView(store.indexer, { tipHeight, blockHash: (height) => store.hashAt(height) }, store.profile);
      const withTraits = (piece: NonNullable<ReturnType<typeof pieceByNumber>>) => {
        const item = piece.inscriptionId ? store.indexer.get(piece.inscriptionId) : undefined;
        return { ...piece, attributes: traitsFromMetadata(item?.metadata ?? undefined) };
      };
      if (url.pathname === "/pieces") {
        const offset = Number(url.searchParams.get("offset") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "100");
        const authenticOnly = url.searchParams.get("authentic") === "1";
        const page = piecePage(view.pieces ?? [], offset, limit, authenticOnly);
        if (!page) {
          send(response, 400, { error: "offset and limit" });
          return;
        }
        send(response, 200, { ...page, pieces: page.pieces.map((piece) => withTraits(piece)) });
        return;
      }
      const number = Number(url.pathname.slice("/pieces/".length));
      const piece = pieceByNumber(view, number);
      if (!piece) send(response, 404, { error: "not found" });
      else send(response, 200, withTraits(piece));
      return;
    }
    send(response, 404, { error: "not found" });
  } catch (error) {
    if (!response.headersSent) send(response, 500, { error: error instanceof Error ? error.message : "request failed" });
  }
}
