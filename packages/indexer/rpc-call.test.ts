// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rpcCall, RpcError } from "./follow.ts";
import { cookieFileIn, httpRpc, readCookie, redactSecrets, rpcAuthFromFlags } from "./rpc.ts";

type Seen = { authorization: string | undefined; body: { method: string; params: unknown[] } };

/** A node on 127.0.0.1 that answers with `answer` and records what it was sent. */
async function withNode(answer: (request: Seen, response: ServerResponse) => void | Promise<void>, run: (url: string, seen: Seen[]) => Promise<void>): Promise<void> {
  const seen: Seen[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const entry: Seen = { authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
      seen.push(entry);
      void Promise.resolve(answer(entry, response));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, seen);
  } finally {
    await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  }
}

const ok = (result: unknown) => (_seen: Seen, response: ServerResponse) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ result, error: null })); };
const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
const scratch = () => mkdtempSync(join(tmpdir(), "pins-cookie-"));

test("a call with a user and password sends them as Basic authentication and returns the result", async () => {
  await withNode(ok(7), async (url, seen) => {
    assert.equal(await rpcCall(url, { user: "user", password: "secret" }, "getblockcount", [1]), 7);
    assert.equal(seen[0].authorization, basic("user", "secret"));
    assert.deepEqual(seen[0].body, { jsonrpc: "1.0", id: "indexer", method: "getblockcount", params: [1] });
  });
});

test("the cookie file is read again for every call, so a new cookie is used without a restart", async () => {
  const dir = scratch();
  const file = join(dir, ".cookie");
  try {
    await withNode(ok("fine"), async (url, seen) => {
      writeFileSync(file, `__cookie__:${"a".repeat(64)}\n`);
      const rpc = httpRpc(url, { cookieFile: file });
      assert.equal(await rpc.call("getblockcount"), "fine");
      writeFileSync(file, `__cookie__:${"b".repeat(64)}\r\n`);
      await rpc.call("getblockcount");
      assert.deepEqual(seen.map((entry) => entry.authorization), [basic("__cookie__", "a".repeat(64)), basic("__cookie__", "b".repeat(64))]);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cookie file that is missing, malformed or too large is an error that names the cause and not the content", async () => {
  const dir = scratch();
  try {
    await assert.rejects(() => readCookie(join(dir, ".cookie")), (error: unknown) => error instanceof RpcError && error.retry && /ENOENT/.test(error.message));
    for (const [content, code] of [["no-colon-here", "EMALFORMED"], [":nopassword-user-empty", "EMALFORMED"], ["user:", "EMALFORMED"], ["user:pa\u0007ss", "EMALFORMED"], [`user:${"x".repeat(2000)}`, "ETOOBIG"]] as const) {
      writeFileSync(join(dir, ".cookie"), content);
      await assert.rejects(() => readCookie(join(dir, ".cookie")), (error: unknown) => error instanceof RpcError && error.message.includes(code) && !error.message.includes("nopassword") && !error.message.includes("xxx"));
    }
    await assert.rejects(() => readCookie(dir), (error: unknown) => error instanceof RpcError && !error.retry);
    writeFileSync(join(dir, ".cookie"), "user:p:a:ss\n");
    assert.deepEqual(await readCookie(join(dir, ".cookie")), { user: "user", password: "p:a:ss" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cookie is accepted only for an RPC URL on this machine", () => {
  assert.throws(() => httpRpc("http://192.0.2.1:18452/", { cookieFile: "/nonexistent/.cookie" }), /only for an RPC URL on this machine/);
  assert.throws(() => httpRpc("https://node.example/", { cookieFile: "/nonexistent/.cookie" }), /only for an RPC URL on this machine/);
  for (const url of ["http://127.0.0.1:1/", "http://localhost:1/", "http://[::1]:1/"]) httpRpc(url, { cookieFile: "/nonexistent/.cookie" });
});

test("a URL with credentials, or that is not http, is refused", async () => {
  await assert.rejects(() => rpcCall("http://user:secret@127.0.0.1:9/", { user: "user", password: "secret" }, "getblockcount"), /credentials/);
  await assert.rejects(() => rpcCall("file:///etc/passwd", { user: "user", password: "secret" }, "getblockcount"), /http or https/);
  await assert.rejects(() => rpcCall("not a url", { user: "user", password: "secret" }, "getblockcount"), /not valid/);
});

test("a login with a colon in the user, a control character or an empty part is refused before any request", async () => {
  for (const [user, password] of [["a:b", "x"], ["", "x"], ["u", ""], ["u", "line\nbreak"]]) {
    await assert.rejects(() => rpcCall("http://127.0.0.1:9/", { user, password }, "getblockcount"), /RPC (user|password)/);
  }
});

test("401 is retried with a cookie, which the node changes at a restart, and not with a password", async () => {
  const dir = scratch();
  const file = join(dir, ".cookie");
  writeFileSync(file, `__cookie__:${"c".repeat(64)}`);
  try {
    await withNode((_seen, response) => { response.writeHead(401); response.end(); }, async (url) => {
      await assert.rejects(() => rpcCall(url, { cookieFile: file }, "getblockcount"), (error: unknown) => error instanceof RpcError && error.retry && /401 \(credentials rejected\)/.test(error.message));
      await assert.rejects(() => rpcCall(url, { user: "user", password: "wrong" }, "getblockcount"), (error: unknown) => error instanceof RpcError && !error.retry && /credentials rejected/.test(error.message));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the node's own error is an RpcError that can be repeated, and no secret is in it", async () => {
  await withNode((_seen, response) => { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ result: null, error: { code: -28, message: "Loading block index for user:secret-value" } })); }, async (url) => {
    await assert.rejects(() => rpcCall(url, { user: "user", password: "secret-value" }, "getblockcount"), (error: unknown) => error instanceof RpcError && error.retry && /Loading block index/.test(error.message) && !error.message.includes("secret-value"));
  });
  await withNode((_seen, response) => { response.writeHead(200); response.end("not-json"); }, async (url) => {
    await assert.rejects(() => rpcCall(url, { user: "user", password: "secret" }, "getblockcount"), /not JSON/);
  });
  await withNode((_seen, response) => { response.writeHead(503); response.end("busy"); }, async (url) => {
    await assert.rejects(() => rpcCall(url, { user: "user", password: "secret" }, "getblockcount"), /HTTP 503/);
  });
});

test("a refused connection is an RpcError that can be repeated, and the password is not in its text", async () => {
  await assert.rejects(() => rpcCall("http://127.0.0.1:9/", { user: "user", password: "secret-value" }, "getblockcount"), (error: unknown) => error instanceof RpcError && error.retry && /getblockcount failed/.test(error.message) && !error.message.includes("secret-value"));
});

test("a redirect is not followed, and the credentials are not sent to its target", async () => {
  let targetHits = 0;
  await withNode((_seen, response) => { targetHits += 1; response.writeHead(200); response.end("{}"); }, async (target) => {
    await withNode((_seen, response) => { response.writeHead(302, { location: target }); response.end(); }, async (url) => {
      await assert.rejects(() => rpcCall(url, { user: "user", password: "secret" }, "getblockcount"), RpcError);
    });
  });
  assert.equal(targetHits, 0);
});

test("rpcCall does not block the event loop while the node answers", async () => {
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 20);
  try {
    await withNode(async (_seen, response) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      ok(7)(_seen, response);
    }, async (url) => {
      assert.equal(await rpcCall(url, { user: "user", password: "secret" }, "getblockcount"), 7);
    });
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks >= 10, `the event loop ran ${ticks} times during a 0.6 s call`);
});

test("the cookie of a datadir is in its network's subdirectory, and in the datadir itself on mainnet", () => {
  assert.equal(cookieFileIn("/d", "mainnet"), "/d/.cookie");
  assert.equal(cookieFileIn("/d", "regtest"), "/d/regtest/.cookie");
  assert.equal(cookieFileIn("/d/", "testnet4"), "/d/testnet4/.cookie");
});

test("the RPC login of a command is one of three kinds, from a flag or from the environment", () => {
  assert.deepEqual(rpcAuthFromFlags({ "rpc-user": "u", "rpc-password": "p" }, "regtest", {}), { user: "u", password: "p" });
  assert.deepEqual(rpcAuthFromFlags({}, "regtest", { QBIT_RPC_USER: "eu", QBIT_RPC_PASSWORD: "ep" }), { user: "eu", password: "ep" });
  assert.deepEqual(rpcAuthFromFlags({ "rpc-user": "u" }, "regtest", { QBIT_RPC_PASSWORD: "ep" }), { user: "u", password: "ep" });
  assert.deepEqual(rpcAuthFromFlags({ "rpc-cookie-file": "/x/.cookie" }, "mainnet", {}), { cookieFile: "/x/.cookie" });
  assert.deepEqual(rpcAuthFromFlags({ "rpc-datadir": "/q" }, "testnet4", {}), { cookieFile: "/q/testnet4/.cookie" });
  assert.deepEqual(rpcAuthFromFlags({}, "regtest", { QBIT_RPC_COOKIE_FILE: "/e/.cookie" }), { cookieFile: "/e/.cookie" });
  assert.deepEqual(rpcAuthFromFlags({ "rpc-datadir": "/q" }, "mainnet", {}), { cookieFile: "/q/.cookie" });
  assert.throws(() => rpcAuthFromFlags({}, "regtest", {}), /missing the RPC login/);
  assert.throws(() => rpcAuthFromFlags({ "rpc-user": "u" }, "regtest", {}), /missing --rpc-password/);
  assert.throws(() => rpcAuthFromFlags({ "rpc-password": "p" }, "regtest", {}), /missing --rpc-user/);
  assert.throws(() => rpcAuthFromFlags({ "rpc-user": "u", "rpc-password": "p", "rpc-cookie-file": "/x" }, "regtest", {}), /not a mix/);
  assert.throws(() => rpcAuthFromFlags({ "rpc-cookie-file": "/x", "rpc-datadir": "/q" }, "regtest", {}), /not a mix/);
  assert.throws(() => rpcAuthFromFlags({ "rpc-cookie-file": true }, "regtest", {}), /needs a value/);
  assert.throws(() => rpcAuthFromFlags({ "rpc-user": "a:b", "rpc-password": "p" }, "regtest", {}), /RPC user/);
  // The message names the flags, never a value.
  assert.throws(() => rpcAuthFromFlags({ "rpc-user": "a:b", "rpc-password": "top-secret" }, "regtest", {}), (error: Error) => !error.message.includes("top-secret"));
});

test("redactSecrets hides each secret and the userinfo of a URL", () => {
  assert.equal(redactSecrets("bad user:secret-value at http://user:secret-value@host/", ["secret-value"]), "bad user:[redacted] at http://[redacted]@host/");
});
