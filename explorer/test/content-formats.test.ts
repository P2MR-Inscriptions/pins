// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { PREVIEW_BYTES } from "../public/content-view.js";

const hid = (byte: string) => `${byte.repeat(32)}i0`;
const textId = hid("11");
const htmlId = hid("22");
const svgId = hid("33");
const pdfId = hid("44");
const leafId = hid("55");
const binId = hid("66");
const audioId = hid("77");
const videoId = hid("88");
const jsId = hid("99");
const badId = hid("ab");
const zeroId = hid("cd");
const slowId = hid("ef");
const missingId = hid("10");
const bigId = hid("12");
const sameA = hid("13");
const sameB = hid("14");
const textBody = Buffer.from(`${"A".repeat(3000)}<b>not html</b>`);
const bodies = new Map<string, Buffer>([
  [textId, textBody],
  [htmlId, Buffer.from("<!doctype html><script>document.body.dataset.ran='1'</script><p>game</p>")],
  [svgId, Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' onload='window.top.location=\"http://127.0.0.1/\"'><rect width='10' height='10'/></svg>")],
  [pdfId, Buffer.from("%PDF-1.1\n")],
  [leafId, Buffer.alloc(64)],
  [binId, Buffer.from([0, 1, 2, 3, 4])],
  [audioId, Buffer.alloc(100, 7)],
  [videoId, Buffer.from("not-a-video")],
  [jsId, Buffer.from("alert(1)")],
  [badId, Buffer.from("zz")],
  [zeroId, Buffer.alloc(0)],
  [bigId, Buffer.alloc(20)],
  [sameA, Buffer.from("one")],
  [sameB, Buffer.from("two")],
]);

function row(id: string, number: number, contentType: unknown, extra: Record<string, unknown> = {}) {
  return {
    id, txid: id.slice(0, 64), n: 0, number, contentType,
    bodySha256: id === sameA || id === sameB ? "samehash" : id.slice(0, 8),
    bodyLength: bodies.get(id)?.length ?? 0,
    fields: id === badId ? "nope" : id === textId ? [{ tag: 5, value: "zz" }] : [],
    createdHeight: 2, createdIndex: 0, locationHeight: 2, location: null,
    ownerAddress: "", ownerScript: "", leafIssuer: "", flags: id === badId ? null : [],
    burned: false, reinscription: false, ...extra,
  };
}

let indexer: Server;
let explorer: Server;
let base = "";

before(async () => {
  indexer = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/status") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ network: "regtest", chain: "regtest", height: 3, hash: "aa".repeat(32), stateHash: "bb".repeat(32), inscriptions: 14 }));
      return;
    }
    if (path.split("?")[0] === "/inscriptions") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ inscriptions: [
        row(textId, 1, "text/plain"),
        row(htmlId, 2, "text/html"),
        row(svgId, 4, "image/svg+xml"),
        row(pdfId, 5, "application/pdf"),
        row(leafId, 6, "application/octet-stream"),
        row(binId, 7, "application/octet-stream"),
        row(audioId, 8, "audio/mpeg"),
        row(videoId, 9, "video/mp4"),
        row(jsId, 10, "text/javascript"),
        row(badId, 11, "image/png\r\nX"),
        row(zeroId, 12, "image/png"),
        row(slowId, 13, "text/plain", { bodyLength: 4, bodySha256: "slow" }),
        row(missingId, 14, "image/png", { bodyLength: 4, bodySha256: "gone" }),
        row(bigId, 15, "image/png", { bodyLength: 9000, bodySha256: "big" }),
        row(sameA, 16, "text/plain"),
        row(sameB, 17, "text/plain"),
      ] }));
      return;
    }
    if (path === "/collection") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "present", name: "Example", supply: 2, first: 1, genesisId: leafId, root: "00", issuer: "ab", itemType: "image/png", authentic: 0 }));
      return;
    }
    if (path === "/pieces?offset=0&limit=100") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ total: 0, offset: 0, limit: 100, pieces: [] }));
      return;
    }
    const content = /^\/content\/(.+)$/.exec(path);
    if (content) {
      if (content[1] === slowId) return;
      if (content[1] === bigId) {
        res.writeHead(200, { "content-type": "image/png", "content-length": "9000" });
        res.end(Buffer.alloc(20));
        return;
      }
      const body = bodies.get(content[1]);
      if (!body) { res.statusCode = 404; res.end(); return; }
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(body);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((ok) => indexer.listen(0, "127.0.0.1", () => ok()));
  const dir = mkdtempSync(join(tmpdir(), "pins-formats-"));
  writeFileSync(join(dir, "missing.json"), "{}");
  process.env.INDEXER_URL = `http://127.0.0.1:${(indexer.address() as { port: number }).port}`;
  process.env.MANIFEST = join(dir, "missing.json");
  process.env.HOST = "127.0.0.1";
  process.env.RATE_PER_MINUTE = "2000";
  process.env.CONTENT_MAX_BYTES = "4000";
  process.env.CONTENT_TIMEOUT_MS = "1000";
  delete process.env.QBIT_RPC_URL;
  delete process.env.QBIT_RPC_USER;
  delete process.env.QBIT_RPC_PASSWORD;
  delete process.env.QBIT_CONF;
  const { cache } = await import("../server/index-cache.ts");
  const { createExplorer } = await import("../server/index.ts");
  await cache.tick();
  explorer = createExplorer();
  await new Promise<void>((ok) => explorer.listen(0, "127.0.0.1", () => ok()));
  base = `http://127.0.0.1:${(explorer.address() as { port: number }).port}`;
});

after(async () => {
  explorer?.close();
  indexer?.close();
});

test("a bad record stays in the list and does not remove its neighbors", async () => {
  const list = await (await fetch(`${base}/api/inscriptions?limit=200`)).json() as { inscriptions: { id: string; number: number }[] };
  assert.equal(list.inscriptions.some((item) => item.id === badId), true);
  assert.equal(list.inscriptions.some((item) => item.id === svgId), true);
  const detail = await (await fetch(`${base}/api/inscription/${badId}`)).json() as { contentRole: string | null; neighbors: { prev: { number: number }; next: { number: number } }; metadata: { error?: string } | null };
  assert.equal(detail.contentRole, null);
  assert.equal((await fetch(`${base}/api/inscription/${textId}`)).status, 200);
  const text = await (await fetch(`${base}/api/inscription/${textId}`)).json() as { metadata: { error?: string }; neighbors: { next: { number: number } | null } };
  assert.equal(text.metadata.error, "CBOR decode failed");
  assert.equal(text.neighbors.next?.number, 2);
  const svg = await (await fetch(`${base}/api/inscription/${svgId}`)).json() as { neighbors: { prev: { number: number } }; authenticity: string };
  assert.equal(svg.neighbors.prev?.number, 2);
  assert.equal(svg.authenticity, "unknown");
  const leaf = await (await fetch(`${base}/api/inscription/${leafId}`)).json() as { contentRole: string; authenticity: string };
  const bin = await (await fetch(`${base}/api/inscription/${binId}`)).json() as { contentRole: string | null; authenticity: string };
  assert.equal(leaf.contentRole, "leaf-list");
  assert.equal(leaf.authenticity, "unknown");
  assert.equal(bin.contentRole, null);
  assert.equal(bin.authenticity, "unknown");
});

test("html is inert unless framed, and the frame cannot use the parent origin", async () => {
  const plain = await fetch(`${base}/api/content/${htmlId}`);
  assert.match(plain.headers.get("content-type") ?? "", /text\/plain/);
  assert.match(plain.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.equal((plain.headers.get("content-security-policy") ?? "").includes("allow-scripts"), false);
  assert.equal(plain.headers.get("access-control-allow-origin"), null);
  const framed = await fetch(`${base}/api/content/${htmlId}?frame=1`);
  assert.equal(framed.headers.get("content-type"), "text/html; charset=utf-8");
  const csp = framed.headers.get("content-security-policy") ?? "";
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /script-src 'unsafe-inline'/);
  assert.equal(csp.split(";").map((part) => part.trim()).find((part) => part.startsWith("sandbox")), "sandbox allow-scripts");
  for (const token of ["allow-same-origin", "allow-fullscreen", "allow-popups", "allow-forms", "allow-top-navigation", "allow-downloads"]) {
    assert.equal(csp.includes(token), false, token);
  }
  assert.equal(framed.headers.get("access-control-allow-origin"), null);
  assert.equal((await fetch(`${base}/api/content/${jsId}?frame=1`)).status, 415);
  assert.match((await fetch(`${base}/api/content/${jsId}`)).headers.get("content-type") ?? "", /text\/plain/);
  const saved = await fetch(`${base}/api/content/${htmlId}?download=1`);
  assert.match(saved.headers.get("content-disposition") ?? "", new RegExp(`filename="${htmlId}.bin"`));
  assert.equal(saved.headers.get("content-type"), "application/octet-stream");
});

test("svg is an image and a direct navigation cannot run its script", async () => {
  const image = await fetch(`${base}/api/content/${svgId}`, { headers: { "sec-fetch-dest": "image" } });
  assert.equal(image.headers.get("content-type"), "image/svg+xml");
  assert.equal((image.headers.get("content-security-policy") ?? "").includes("allow-scripts"), false);
  const opened = await fetch(`${base}/api/content/${svgId}`, { headers: { "sec-fetch-dest": "document" } });
  assert.match(opened.headers.get("content-security-policy") ?? "", /script-src 'none'/);
  assert.match(opened.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.equal((opened.headers.get("content-security-policy") ?? "").includes("allow-scripts"), false);
});

test("text preview is bounded and does not replace the full body", async () => {
  const preview = await fetch(`${base}/api/content/${textId}?preview=1`);
  const shown = await preview.text();
  assert.equal(shown.length, PREVIEW_BYTES);
  assert.equal(shown.includes("<b>"), false);
  assert.match(preview.headers.get("content-type") ?? "", /text\/plain/);
  const full = await (await fetch(`${base}/api/content/${textId}`)).text();
  assert.equal(full.length, textBody.length);
  assert.equal(full.endsWith("<b>not html</b>"), true);
  assert.equal((await fetch(`${base}/api/content/${pdfId}?preview=1`)).status, 415);
});

test("media ranges stay on this body and other types do not share a cache entry", async () => {
  const part = await fetch(`${base}/api/content/${audioId}`, { headers: { range: "bytes=0-9" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-type"), "audio/mpeg");
  assert.equal(part.headers.get("content-range"), "bytes 0-9/100");
  assert.equal((await part.arrayBuffer()).byteLength, 10);
  assert.equal((await fetch(`${base}/api/content/${audioId}`, { headers: { range: "bytes=0-1,2-3" } })).status, 416);
  const pdf = await fetch(`${base}/api/content/${pdfId}`);
  assert.equal(pdf.headers.get("content-type"), "application/octet-stream");
  assert.match(pdf.headers.get("content-disposition") ?? "", /attachment/);
  const first = await (await fetch(`${base}/api/content/${sameA}`)).text();
  const second = await (await fetch(`${base}/api/content/${sameB}`)).text();
  assert.equal(first, "one");
  assert.equal(second, "two");
});

test("oversized, missing, and stalled content fail without a partial body", async () => {
  assert.equal((await fetch(`${base}/api/content/${bigId}`)).status, 413);
  assert.equal((await fetch(`${base}/api/content/${missingId}`)).status, 502);
  const started = Date.now();
  assert.equal((await fetch(`${base}/api/content/${slowId}`)).status, 502);
  assert.ok(Date.now() - started >= 900);
});
