// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rpcCall, RpcError } from "./follow.ts";
import { curlRpcInvocation } from "./rpc-curl.ts";

function pinsRpcDirs(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith("pins-rpc-"));
}

function withCurl(script: string, body: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "pins-fake-curl-"));
  const bin = join(dir, "curl");
  writeFileSync(bin, `#!/bin/sh\ncat >/dev/null\n${script.replace(/^#!\/bin\/sh\n/, "")}`);
  chmodSync(bin, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${dir}:${previous ?? ""}`;
  return body().finally(() => {
    process.env.PATH = previous;
  });
}

test("curl arguments do not contain the RPC password", () => {
  const call = curlRpcInvocation("http://127.0.0.1:9/", "user", "secret-value", "/tmp/body.json");
  assert.equal(call.args.join(" ").includes("secret-value"), false);
  assert.equal(call.args.includes("-u"), false);
  assert.match(call.input, /user = "user:secret-value"/);
  assert.throws(() => curlRpcInvocation("http://user:secret-value@127.0.0.1/", "user", "secret-value", "body.json"), /credentials/);
});

test("rpcCall removes its own temporary directory on success, failure, and bad JSON", async () => {
  const before = new Set(pinsRpcDirs());
  await withCurl("#!/bin/sh\nprintf '%s\\n' '{\"result\":7,\"error\":null}'\n", async () => {
    assert.equal(await rpcCall("http://127.0.0.1:9/", "user", "secret", "getblockcount"), 7);
  });
  await withCurl("#!/bin/sh\necho 'curl failed' >&2\nexit 7\n", async () => {
    await assert.rejects(() => rpcCall("http://127.0.0.1:9/", "user", "secret", "getblockcount"), /getblockcount failed/);
  });
  await withCurl("#!/bin/sh\nprintf '%s\\n' 'not-json'\n", async () => {
    await assert.rejects(() => rpcCall("http://127.0.0.1:9/", "user", "secret", "getblockcount"), /not JSON/);
  });
  const empty = mkdtempSync(join(tmpdir(), "pins-no-curl-"));
  const previous = process.env.PATH;
  process.env.PATH = empty;
  try {
    await assert.rejects(() => rpcCall("http://127.0.0.1:9/", "user", "secret", "getblockcount"), /getblockcount failed/);
  } finally {
    process.env.PATH = previous;
  }
  const leaked = pinsRpcDirs().filter((name) => !before.has(name));
  assert.deepEqual(leaked, []);
});

test("rpcCall does not block the event loop while the node answers", async () => {
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 20);
  try {
    await withCurl("#!/bin/sh\nsleep 1\nprintf '%s\\n' '{\"result\":7,\"error\":null}'\n", async () => {
      assert.equal(await rpcCall("http://127.0.0.1:9/", "user", "secret", "getblockcount"), 7);
    });
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks >= 10, `the event loop ran ${ticks} times during a 1 s call`);
});

test("a failed call is an RpcError that can be repeated, unless curl cannot work at all", async () => {
  await withCurl("#!/bin/sh\necho 'connection refused' >&2\nexit 7\n", async () => {
    await assert.rejects(() => rpcCall("http://127.0.0.1:9/", "user", "secret", "getblockcount"), (error: unknown) => error instanceof RpcError && error.retry);
  });
  await withCurl("#!/bin/sh\nprintf '%s\\n' '{\"result\":null,\"error\":{\"message\":\"Loading block index\"}}'\n", async () => {
    await assert.rejects(() => rpcCall("http://127.0.0.1:9/", "user", "secret", "getblockcount"), (error: unknown) => error instanceof RpcError && error.retry && /Loading block index/.test(error.message));
  });
  await withCurl("#!/bin/sh\nexit 3\n", async () => {
    await assert.rejects(() => rpcCall("http://127.0.0.1:9/", "user", "secret", "getblockcount"), (error: unknown) => error instanceof RpcError && !error.retry);
  });
  const empty = mkdtempSync(join(tmpdir(), "pins-no-curl-"));
  const previous = process.env.PATH;
  process.env.PATH = empty;
  try {
    await assert.rejects(() => rpcCall("http://127.0.0.1:9/", "user", "secret", "getblockcount"), (error: unknown) => error instanceof RpcError && !error.retry);
  } finally {
    process.env.PATH = previous;
  }
});

test("rpcCall does not put the password in an error", async () => {
  await withCurl("#!/bin/sh\necho 'failed for user:secret-value' >&2\nexit 7\n", async () => {
    await assert.rejects(() => rpcCall("http://127.0.0.1:9/", "user", "secret-value", "getblockcount"), (error: Error) => !error.message.includes("secret-value"));
  });
});
