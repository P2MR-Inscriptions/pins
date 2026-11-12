// SPDX-License-Identifier: Apache-2.0
/**
 * DEVELOPMENT ONLY. A tiny stand-in for the PINS indexer API (docs/indexer/API.md) with synthetic data,
 * so the UI can be tried without a node. Its /status says `mock: true` and the UI shows a banner.
 * Nothing here is real chain data.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { mockBrand } from "./mock-brand.ts";

const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const CRC = Uint32Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(body));
  return Buffer.concat([head, body, tail]);
}
function sprite(n: number): Buffer {
  const seed = Buffer.from(sha(`sprite${n}`), "hex");
  const palette = [0, 1, 2].map((i) => [seed[i * 3] | 64, seed[i * 3 + 1] | 64, seed[i * 3 + 2] | 64]);
  const rows: Buffer[] = [];
  for (let y = 0; y < 24; y++) {
    const row = Buffer.alloc(1 + 24 * 4);
    for (let x = 0; x < 24; x++) {
      const mx = x < 12 ? x : 23 - x;
      const bit = seed[(y * 12 + mx) % 32] & 3;
      const on = bit > 0 && y > 2 && y < 22 && mx > 1;
      const [r, g, b] = on ? palette[bit - 1 < 0 ? 0 : bit - 1] : [20, 18, 28];
      row.set([r, g, b, on ? 255 : 0], 1 + x * 4);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(24, 0); ihdr.writeUInt32BE(24, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const owners = ["qb1mockowneraaaaaaaaaaaaaaaaaaaaaa", "qb1mockownerbbbbbbbbbbbbbbbbbbbbbb", "qb1mockownerccccccccccccccccccccc", "qb1mockownerdddddddddddddddddddd", "qb1mockownereeeeeeeeeeeeeeeeeeeee"];
const SUPPLY = 50, MINTED = 40, BASE = 161950;
type Item = Record<string, any> & { body: Buffer };
const items: Item[] = [];
function add(number: number, txseed: string, contentType: string, body: Buffer, metadata: Buffer | null, owner: string, height: number): Item {
  const txid = sha(txseed);
  const item: Item = {
    id: `${txid}i0`, txid, n: 0, number, contentType, bodySha256: sha(body), bodyLength: body.length,
    fields: [{ tag: 1, value: Buffer.from(contentType).toString("hex") }, ...(metadata ? [{ tag: 5, value: metadata.toString("hex") }] : [])],
    createdHeight: height, createdIndex: 1, locationHeight: height,
    location: { state: "located", txid: sha(`out${txseed}`), vout: 0, offset: "0", script: "5220" + "00".repeat(32) },
    ownerAddress: owner, ownerScript: "5220" + "00".repeat(32), leafIssuer: "ab".repeat(32), flags: [], burned: false, reinscription: false, body,
  };
  items.push(item);
  return item;
}
const text = (s: string) => Buffer.from(s);
function cborText(s: string): Buffer { const b = Buffer.from(s); return Buffer.concat([b.length < 24 ? Buffer.from([0x60 | b.length]) : Buffer.from([0x78, b.length]), b]); }
function metaCbor(name: string, trait: string, value: string): Buffer {
  const attr = Buffer.concat([Buffer.from([0xa2]), cborText("trait_type"), cborText(trait), cborText("value"), cborText(value)]);
  return Buffer.concat([Buffer.from([0xa1]), cborText("meta"), Buffer.from([0xa2]), cborText("name"), cborText(name), cborText("attributes"), Buffer.from([0x81]), attr]);
}
const genesis = add(0, "mock-genesis", "application/json", text(JSON.stringify({ name: mockBrand.name, supply: SUPPLY, root: "00".repeat(32), issuer: "ab".repeat(32) })), null, owners[0], BASE);
add(1, "mock-leaves", "application/octet-stream", Buffer.alloc(SUPPLY * 32), null, owners[0], BASE);
const traits = ["Sky", "Moss", "Ember", "Frost"];
const pieces = Array.from({ length: SUPPLY }, (_, i) => i + 1).map((n) => {
  if (n > MINTED) return { number: n, inscriptionId: null, authentic: false, reason: "no authentic P2MR Inscription", status: "unassigned", location: null, ownerAddress: "", ownerScript: "", confirmations: 0, final: false, attributes: [] };
  const it = add(n + 1, `mock-piece-${n}`, "image/png", sprite(n), metaCbor(mockBrand.pieceTitle(n), "Mood", traits[n % 4]), owners[n % owners.length], BASE + 1 + (n % 7));
  return { number: n, inscriptionId: it.id, authentic: true, reason: "ok", status: "sale", location: it.location, ownerAddress: it.ownerAddress, ownerScript: it.ownerScript, confirmations: 20, final: true, attributes: [{ trait_type: "Mood", value: traits[n % 4] }] };
});
add(items.length, "mock-note", "text/plain", text("hello from a mock text P2MR Inscription <b>not html</b>"), null, owners[2], BASE + 9);
const strip = ({ body: _b, ...rest }: Item) => rest;

export function startMock(port = 8787): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const p = url.pathname;
    if (p === "/status") return json(200, { network: "regtest", chain: "regtest", height: BASE + 12, hash: sha("tip"), stateHash: sha("state"), inscriptions: items.length, mock: true, standards: [1, 2, 3, 4, 5].map((n) => ({ id: `PINS-${n}`, status: "draft" })) });
    if (p === "/collection") return json(200, { status: "present", sale: "waiting_for_wallet", genesisId: genesis.id, name: mockBrand.name, supply: SUPPLY, first: 1, namePrefix: mockBrand.prefix, root: "00".repeat(32), issuer: "ab".repeat(32), itemType: "image/png", authentic: MINTED });
    if (p === "/inscriptions") {
      // Like the real indexer: every row unless a limit is given, and the total of the list.
      const o = url.searchParams.get("owner"), offset = Number(url.searchParams.get("offset") ?? 0), text = url.searchParams.get("limit");
      const limit = text === null ? null : Number(text);
      if (!Number.isInteger(offset) || offset < 0 || (limit !== null && !(Number.isInteger(limit) && limit >= 1 && limit <= 1000))) return json(400, { error: "offset and limit" });
      const rows = items.filter((i) => !o || i.ownerAddress === o);
      return json(200, { total: rows.length, offset, limit, inscriptions: rows.slice(offset, limit === null ? undefined : offset + limit).map(strip) });
    }
    if (p === "/pieces") {
      const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 100);
      if (!(limit >= 1 && limit <= 1000)) return json(400, { error: "offset and limit" });
      return json(200, { total: pieces.length, offset, limit, pieces: pieces.slice(offset, offset + limit) });
    }
    let m = /^\/inscription\/(.+)$/.exec(p);
    if (m) { const i = items.find((x) => x.id === m![1]); return i ? json(200, strip(i)) : json(404, { error: "not found" }); }
    m = /^\/content\/(.+)$/.exec(p);
    if (m) { const i = items.find((x) => x.id === m![1]); if (!i) return json(404, { error: "not found" }); res.writeHead(200, { "content-type": i.contentType }); return void res.end(i.body); }
    json(404, { error: "not found" });
  });
  return new Promise((ok) => server.listen(port, "127.0.0.1", () => {
    const a = server.address(); const chosen = a && typeof a === "object" ? a.port : port;
    ok({ url: `http://127.0.0.1:${chosen}`, close: () => new Promise((d) => server.close(() => d())) });
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startMock(Number(process.env.MOCK_PORT ?? 8787)).then((s) => process.stdout.write(`MOCK indexer (synthetic data) at ${s.url}\n`));
}
