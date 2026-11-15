// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hostAllowed } from "../server/net.ts";
import { profile } from "../server/profile.ts";

test("a non-loopback Host is refused unless it is explicitly trusted", () => {
  assert.equal(hostAllowed("evil.example", []), false);
  assert.equal(hostAllowed("127.0.0.1:8080", []), true);
  assert.equal(hostAllowed("explorer.example:443", ["explorer.example"]), true);
});

test("the local build refuses a public bind before it listens", () => {
  if (!profile.forceLoopbackBind) return;
  const env: NodeJS.ProcessEnv = { ...process.env, HOST: "0.0.0.0", INDEXER_URL: "http://127.0.0.1:9" };
  delete env.QBIT_RPC_URL;
  delete env.QBIT_RPC_PASSWORD;
  delete env.QBIT_RPC_USER;
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "server/index.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env,
    encoding: "utf8",
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /loopback/);
});
