// SPDX-License-Identifier: Apache-2.0
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const id = `${"ab".repeat(32)}i0`;
const htmlId = `${"cd".repeat(32)}i0`;
const svgId = `${"ef".repeat(32)}i0`;
const chunkId = `${"12".repeat(32)}i0`;
const bigId = `${"34".repeat(32)}i0`;
let hits = 0;
let sink: Server;
let indexer: Server;
let explorer: Server;
let base = "";
const PASSWORD = "dummy-secret-not-real";

function inscription(itemId: string, contentType: string) {
  return {
    id: itemId, txid: itemId.slice(0, 64), n: 0, number: 1, contentType, bodySha256: "aa", bodyLength: 4,
    fields: [], createdHeight: 1, createdIndex: 0, locationHeight: 1, location: null,
    ownerAddress: "", ownerScript: "", leafIssuer: "", flags: [], burned: false, reinscription: false,
  };
}

before(async () => {
  sink = createServer((_req, res) => { hits += 1; res.end("secret-body"); });
  await new Promise<void>((ok) => sink.listen(0, "127.0.0.1", () => ok()));
  const sinkPort = (sink.address() as { port: number }).port;
  indexer = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/status") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ network: "regtest", chain: "regtest", height: 3, hash: "aa", stateHash: "bb", inscriptions: 3 }));
      return;
    }
    if (path.split("?")[0] === "/inscriptions") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ inscriptions: [inscription(id, "text/html"), inscription(htmlId, "text/html"), inscription(svgId, "image/svg+xml"), inscription(chunkId, "image/png"), inscription(bigId, "image/png")] }));
      return;
    }
    if (path === "/collection") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "absent" }));
      return;
    }
    if (path === `/content/${id}`) {
      res.writeHead(302, { location: `http://127.0.0.1:${sinkPort}/gone` });
      res.end();
      return;
    }
    if (path === `/content/${htmlId}`) {
      res.setHeader("content-type", "text/html");
      res.end("<script>alert(1)</script>");
      return;
    }
    if (path === `/content/${svgId}`) {
      res.writeHead(200, { "content-type": "image/svg+xml" });
      res.end("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
      return;
    }
    if (path === `/content/${chunkId}`) {
      res.writeHead(200, { "content-type": "image/png" });
      res.write(Buffer.alloc(600));
      res.write(Buffer.alloc(600));
      res.end();
      return;
    }
    if (path === `/content/${bigId}`) {
      res.writeHead(200, { "content-type": "image/png", "content-length": "5000" });
      res.end(Buffer.alloc(20));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((ok) => indexer.listen(0, "127.0.0.1", () => ok()));
  const dir = mkdtempSync(join(tmpdir(), "pins-manifest-"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    name: "Wrong name", supply: 1, first: 1, genesisId: `${"11".repeat(32)}i0`, merkleRoot: "22".repeat(32), itemType: "image/png",
  }));
  process.env.INDEXER_URL = `http://127.0.0.1:${(indexer.address() as { port: number }).port}`;
  process.env.MANIFEST = join(dir, "missing.json");
  process.env.HOST = "127.0.0.1";
  process.env.RATE_PER_MINUTE = "1000";
  process.env.CONTENT_MAX_BYTES = "1000";
  process.env.TRUSTED_HOSTS = "explorer.example";
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
  explorer.close();
  indexer.close();
  sink.close();
});

function statusFor(host: string, path = "/"): Promise<number> {
  const port = (explorer.address() as { port: number }).port;
  return new Promise((ok, fail) => {
    const req = httpRequest({ hostname: "127.0.0.1", port, path, headers: { host } }, (res) => {
      res.resume();
      res.on("end", () => ok(res.statusCode ?? 0));
    });
    req.on("error", fail);
    req.end();
  });
}

test("content redirects are not followed", async () => {
  const before = hits;
  const res = await fetch(`${base}/api/content/${id}`);
  assert.equal(res.status, 502);
  assert.equal(hits, before);
  const body = await res.json() as { error: string };
  assert.match(body.error, /redirect/);
});

test("html and svg content stay inert", async () => {
  const html = await fetch(`${base}/api/content/${htmlId}`);
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-type") ?? "", /text\/plain/);
  assert.match(html.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.equal(html.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await html.text(), "<script>alert(1)</script>");
  const svg = await fetch(`${base}/api/content/${svgId}`, { headers: { "sec-fetch-dest": "image" } });
  assert.equal(svg.status, 200);
  assert.equal(svg.headers.get("content-disposition"), null);
  assert.equal(svg.headers.get("content-type"), "image/svg+xml");
  assert.equal((svg.headers.get("content-security-policy") ?? "").includes("allow-scripts"), false);
  const svgNav = await fetch(`${base}/api/content/${svgId}`, { headers: { "sec-fetch-dest": "document" } });
  assert.match(svgNav.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.equal((svgNav.headers.get("content-security-policy") ?? "").includes("allow-scripts"), false);
  const saved = await fetch(`${base}/api/content/${svgId}?download=1`);
  assert.match(saved.headers.get("content-disposition") ?? "", /attachment/);
  assert.equal(saved.headers.get("content-type"), "application/octet-stream");
});

test("a public bind does not widen the Host check", async () => {
  assert.equal(await statusFor("evil.example"), 421);
  assert.equal(await statusFor("explorer.example"), 200);
  assert.equal(await statusFor(`127.0.0.1:${(explorer.address() as { port: number }).port}`), 200);
});

test("an absent manifest does not invent a collection", async () => {
  const body = await (await fetch(`${base}/api/collection`)).json() as { manifest: unknown; checks: unknown[]; onchain: { status: string } };
  assert.equal(body.manifest, null);
  assert.deepEqual(body.checks, []);
  assert.equal(body.onchain.status, "absent");
});

test("RPC methods outside the allow-list are refused", async () => {
  const { assertRpcMethod } = await import("../server/rpc.ts");
  assert.throws(() => assertRpcMethod("sendrawtransaction"), /not allowed/);
  assert.doesNotThrow(() => assertRpcMethod("getblockcount"));
});

test("oversized and chunked content stop at the byte cap", async () => {
  assert.equal((await fetch(`${base}/api/content/${bigId}`)).status, 413);
  assert.equal((await fetch(`${base}/api/content/${chunkId}`)).status, 413);
});

test("a credential in the RPC URL is rejected without echoing it", async () => {
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "-e", "await import('./server/config.ts')"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, QBIT_RPC_URL: `http://alice:${PASSWORD}@127.0.0.1:9/`, QBIT_RPC_USER: "alice", QBIT_RPC_PASSWORD: PASSWORD, HOST: "127.0.0.1" },
    encoding: "utf8",
  });
  assert.notEqual(run.status, 0);
  assert.equal(`${run.stdout}${run.stderr}`.includes(PASSWORD), false);
  assert.match(`${run.stderr}`, /must not contain credentials/);
});
