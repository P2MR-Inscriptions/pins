// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rpcCall } from "./follow.ts";
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
