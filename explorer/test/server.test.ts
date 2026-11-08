// SPDX-License-Identifier: Apache-2.0
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { mockBrand } from "../dev/mock-brand.ts";
import { profile } from "../server/profile.ts";

let mock: { url: string; close: () => Promise<void> };
let server: Server;
let base = "";

before(async () => {
  const { startMock } = await import("../dev/mock-indexer.ts");
  mock = await startMock(0);
  process.env.INDEXER_URL = mock.url;
  process.env.MANIFEST = "config/manifest.mock.json";
  process.env.RATE_PER_MINUTE = "1000";
  process.env.HOST = "127.0.0.1";
  delete process.env.QBIT_RPC_URL;
  delete process.env.QBIT_RPC_USER;
  delete process.env.QBIT_RPC_PASSWORD;
  delete process.env.QBIT_CONF;
  const { cache } = await import("../server/index-cache.ts");
  const { createExplorer } = await import("../server/index.ts");
  await cache.tick();
  server = createExplorer();
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => { server.close(); await mock.close(); });

const api = async (path: string) => {
  const r = await fetch(base + path);
  return { status: r.status, body: await r.json() as any, headers: r.headers };
};

test("status reports the indexer snapshot", async () => {
  const { body } = await api("/api/status");
  assert.equal(body.indexer.reachable, true);
  assert.equal(body.snapshot.ready, true);
  assert.equal(body.snapshot.stale, false);
  assert.equal(body.indexer.mock, true);
  assert.equal(body.rpc.enabled, false);
});

test("collection matches the manifest and lists pieces", async () => {
  const { body } = await api("/api/collection");
  assert.equal(body.authenticPieces, 40);
  assert.equal(body.onchain.name, mockBrand.name);
  assert.ok(body.checks.every((c: { match: boolean | null }) => c.match === true));
  const page = await api("/api/collection/pieces?offset=0&limit=10");
  assert.equal(page.body.pieces.length, 10);
  assert.equal(page.body.total, 50);
});

test("inscription detail decodes field 5", async () => {
  const piece = (await api("/api/collection/pieces/3")).body;
  const { body } = await api(`/api/inscription/${piece.inscriptionId}`);
  assert.equal(body.metadata.decoded.meta.name, mockBrand.pieceTitle(3));
  assert.equal(body.piece.number, 3);
  assert.equal(body.piece.authentic, true);
  assert.equal(body.piece.final, true);
  assert.equal(body.authenticity, "confirmed");
  assert.equal(body.snapshotStale, false);
  assert.equal(body.chain, "mock");
});

test("latest inscriptions follow block height then transaction index", async () => {
  const newest = (await api("/api/inscriptions?limit=1")).body.inscriptions[0];
  const asc = (await api("/api/inscriptions?limit=200&order=asc")).body.inscriptions;
  const top = [...asc].sort((a, b) => b.createdHeight - a.createdHeight || b.createdIndex - a.createdIndex || b.n - a.n || b.number - a.number)[0];
  assert.equal(newest.id, top.id);
  const plain = asc.find((item: { contentType: string }) => item.contentType === "text/plain");
  const detail = (await api(`/api/inscription/${plain.id}`)).body;
  assert.equal(detail.authenticity, "unknown");
  assert.equal(detail.piece, null);
  assert.equal(detail.chain, "mock");
});

test("address holdings come from the snapshot owner", async () => {
  const { body } = await api("/api/address/qb1mockowneraaaaaaaaaaaaaaaaaaaaaa");
  assert.ok(body.total > 0);
  assert.equal(body.inscriptions.length, Math.min(body.total, 100));
});

test("search classifies queries", async () => {
  assert.equal((await api("/api/search?q=%23123")).body.path, `/${profile.piecePath}/123`);
  assert.equal((await api("/api/search?q=42")).body.path, "/number/42");
  assert.equal((await api("/api/search?q=" + "ab".repeat(32))).body.type, "transaction");
  assert.equal((await api("/api/search?q=hello")).status, 404);
});

test("content is served safely", async () => {
  const list = (await api("/api/inscriptions?limit=1")).body.inscriptions[0];
  const r = await fetch(`${base}/api/content/${list.id}`);
  assert.match(r.headers.get("content-type") ?? "", /text\/plain/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match(r.headers.get("content-security-policy") ?? "", /sandbox/);
  const png = (await api("/api/collection/pieces/1")).body;
  const img = await fetch(`${base}/api/content/${png.inscriptionId}`);
  assert.equal(img.headers.get("content-type"), "image/png");
});

test("non-GET and path escape are refused", async () => {
  assert.equal((await fetch(base + "/api/status", { method: "POST" })).status, 405);
  assert.equal((await fetch(base + "/../server/config.ts")).status, 404);
  assert.equal((await fetch(base + "/%2e%2e/server/config.ts")).status, 404);
});

test("the page sets a content security policy", async () => {
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-security-policy"), "default-src 'self'; img-src 'self'; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  assert.equal((page.headers.get("content-security-policy") ?? "").includes("qbit.org"), false);
  assert.equal((page.headers.get("content-security-policy") ?? "").includes("unsafe-inline"), false);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  const font = await fetch(base + "/fonts/chakra-petch-latin-400-normal.woff2");
  assert.equal(font.status, 200);
  assert.equal(font.headers.get("content-type"), "font/woff2");
  assert.equal(font.headers.get("content-security-policy"), page.headers.get("content-security-policy"));
  const mark = await fetch(base + "/pins-avatar.svg");
  const qbit = await fetch(base + "/qbit-logo-full.svg");
  assert.equal(mark.status, 200);
  assert.equal(qbit.status, 200);
  assert.equal(mark.headers.get("content-type"), "image/svg+xml");
  assert.equal(qbit.headers.get("content-type"), "image/svg+xml");
});
