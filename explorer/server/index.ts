// SPDX-License-Identifier: Apache-2.0
import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { handleApi } from "./api.ts";
import { config } from "./config.ts";
import { cache } from "./index-cache.ts";
import { hostAllowed, hostnameOf, isLoopbackHost } from "./net.ts";

const PUBLIC = resolve(fileURLToPath(new URL("../public", import.meta.url)));
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const PAGE_HEADERS = {
  "content-security-policy": "default-src 'self'; img-src 'self'; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const buckets = new Map<string, { tokens: number; at: number }>();
let inflight = 0;

function clientAddress(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? "";
  if (config.trustProxy && isLoopbackHost(hostnameOf(remote)) ) {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0]!.trim();
  }
  return remote || "unknown";
}

export function allowRequest(ip: string, now = Date.now()): boolean {
  if (buckets.size > 10_000) buckets.clear();
  const row = buckets.get(ip) ?? { tokens: config.ratePerMinute, at: now };
  const elapsed = (now - row.at) / 60_000;
  row.tokens = Math.min(config.ratePerMinute, row.tokens + elapsed * config.ratePerMinute);
  row.at = now;
  if (row.tokens < 1) {
    buckets.set(ip, row);
    return false;
  }
  row.tokens -= 1;
  buckets.set(ip, row);
  return true;
}

function requestHost(req: IncomingMessage): string {
  const remote = hostnameOf(req.socket.remoteAddress ?? "");
  if (config.trustProxy && isLoopbackHost(remote)) {
    const forwarded = req.headers["x-forwarded-host"];
    if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0]!.trim();
  }
  return req.headers.host ?? "";
}

export function createExplorer() {
  return createServer(async (req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" }).end("read only");
        return;
      }
      if (!hostAllowed(requestHost(req), config.trustedHosts)) {
        res.writeHead(421, { "content-type": "text/plain; charset=utf-8" }).end("unexpected Host header");
        return;
      }
      if (!allowRequest(clientAddress(req))) {
        res.writeHead(429, { "content-type": "text/plain; charset=utf-8", "retry-after": "60" }).end("too many requests");
        return;
      }
      if (inflight >= config.maxConcurrency) {
        res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "retry-after": "1" }).end("busy");
        return;
      }
      inflight += 1;
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname.startsWith("/api/")) { await handleApi(req, res, url); return; }
        const rel = url.pathname === "/" ? "index.html" : normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "");
        const file = join(PUBLIC, rel);
        if (rel.includes("\0") || !file.startsWith(PUBLIC + sep) || !TYPES[extname(file)]) {
          res.writeHead(404).end("not found");
          return;
        }
        const body = await readFile(file);
        res.writeHead(200, { ...PAGE_HEADERS, "content-type": TYPES[extname(file)], "cache-control": "no-cache" });
        res.end(req.method === "HEAD" ? undefined : body);
      } finally {
        inflight -= 1;
      }
    } catch {
      if (!res.headersSent) res.writeHead(404);
      res.end("not found");
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cache.start();
  createExplorer().listen(config.port, config.host, () => {
    process.stdout.write(`PINS Explorer on http://${config.host}:${config.port}\nIndexer: ${config.indexerUrl}\nNode RPC: ${config.rpc ? "configured (read-only allow-list)" : "not configured"}\nManifest: ${config.manifest ? "loaded" : "not loaded"}\n`);
  });
}
