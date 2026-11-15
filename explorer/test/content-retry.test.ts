// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { attachImageRetry, CONTENT_RETRIES, fetchWithRetry, retryDelayMs } from "../public/content-retry.js";

test("retryDelayMs honours Retry-After in seconds and caps the wait", () => {
  assert.equal(retryDelayMs("1", 0), 1000);
  assert.equal(retryDelayMs("60", 0), 30000);
  assert.equal(retryDelayMs(" 2 ", 9), 2000);
  const inFive = new Date(Date.now() + 5000).toUTCString();
  const httpDate = retryDelayMs(inFive, 0);
  assert.ok(httpDate >= 4000 && httpDate <= 5000, String(httpDate));
  const past = new Date(Date.now() - 5000).toUTCString();
  assert.equal(retryDelayMs(past, 0), 0);
});

test("retryDelayMs falls back to exponential backoff", () => {
  assert.equal(retryDelayMs(null, 0), 400);
  assert.equal(retryDelayMs("", 1), 800);
  assert.equal(retryDelayMs("nope", 2), 1600);
  assert.equal(retryDelayMs(undefined, 10), 8000);
});

async function withServer(handler: (hits: number, res: import("node:http").ServerResponse) => void) {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    handler(hits, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/body`,
    hits: () => hits,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

test("fetchWithRetry waits for Retry-After and then returns a 200", async () => {
  const server = await withServer((hits, res) => {
    if (hits === 1) {
      res.writeHead(429, { "Retry-After": "0", "Content-Type": "text/plain" });
      res.end("slow");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });
  try {
    const res = await fetchWithRetry(server.url);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
    assert.equal(server.hits(), 2);
  } finally {
    await server.close();
  }
});

test("fetchWithRetry returns a 404 without retrying", async () => {
  const server = await withServer((_hits, res) => {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("missing");
  });
  try {
    const res = await fetchWithRetry(server.url);
    assert.equal(res.status, 404);
    assert.equal(server.hits(), 1);
  } finally {
    await server.close();
  }
});

test("fetchWithRetry retries a 503 and then gives up", async () => {
  const server = await withServer((_hits, res) => {
    res.writeHead(503, { "Retry-After": "0", "Content-Type": "text/plain" });
    res.end("busy");
  });
  try {
    const res = await fetchWithRetry(server.url, undefined, { attempts: 2 });
    assert.equal(res.status, 503);
    assert.equal(server.hits(), 3);
  } finally {
    await server.close();
  }
});

function fakeImg(url: string) {
  const sources: string[] = [];
  const img = {
    isConnected: true,
    listeners: [] as Array<() => void>,
    addEventListener(_type: string, fn: () => void) {
      this.listeners.push(fn);
    },
    fire() {
      for (const fn of this.listeners) fn();
    },
  };
  Object.defineProperty(img, "src", {
    get() {
      return sources.at(-1) ?? url;
    },
    set(value: string) {
      sources.push(value);
    },
  });
  return { img, sources };
}

test("attachImageRetry points the image at the URL again after a 429", async () => {
  const server = await withServer((hits, res) => {
    if (hits === 1) {
      res.writeHead(429, { "Retry-After": "0", "Content-Type": "text/plain" });
      res.end("slow");
      return;
    }
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end("ok");
  });
  const { img, sources } = fakeImg(server.url);
  let gaveUp = 0;
  attachImageRetry(img as unknown as HTMLImageElement, server.url, () => {
    gaveUp += 1;
  });
  img.fire();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(gaveUp, 0);
  assert.equal(server.hits(), 1);
  assert.equal(sources.length, 1);
  assert.match(sources[0]!, /\?retry=1$/);
  await server.close();
});

test("attachImageRetry gives up when the probe is not 429 or 503", async () => {
  const server = await withServer((_hits, res) => {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("missing");
  });
  const { img, sources } = fakeImg(server.url);
  let gaveUp = 0;
  attachImageRetry(img as unknown as HTMLImageElement, server.url, () => {
    gaveUp += 1;
  });
  img.fire();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(gaveUp, 1);
  assert.equal(sources.length, 0);
  await server.close();
});

test("attachImageRetry gives up after the retry cap", async () => {
  const server = await withServer((_hits, res) => {
    res.writeHead(429, { "Retry-After": "0", "Content-Type": "text/plain" });
    res.end("slow");
  });
  const { img, sources } = fakeImg(server.url);
  let gaveUp = 0;
  attachImageRetry(img as unknown as HTMLImageElement, server.url, () => {
    gaveUp += 1;
  });
  for (let i = 0; i < CONTENT_RETRIES; i++) {
    img.fire();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(gaveUp, 0, `gave up early on try ${i}`);
    assert.equal(sources.length, i + 1);
  }
  img.fire();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(gaveUp, 1);
  assert.equal(sources.length, CONTENT_RETRIES);
  await server.close();
});
