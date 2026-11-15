// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnvFile, parseQbitConf } from "../scripts/credentials.ts";
import { buildIndexerLaunch } from "../scripts/indexer-launch.ts";

const PASSWORD = "dummy-secret-not-real";

test("env and qbit.conf are read literally", () => {
  const parsed = parseEnvFile(`# comment\nQBIT_RPC_PASSWORD=$(echo hi)\nQBIT_RPC_USER=alice\n`);
  assert.equal(parsed.QBIT_RPC_PASSWORD, "$(echo hi)");
  assert.equal(parsed.QBIT_RPC_USER, "alice");
  const conf = parseQbitConf("rpcuser=alice\nrpcpassword=s3cret\nrpcport=8352\nrpcbind=127.0.0.1\n");
  assert.equal(conf.rpcuser, "alice");
  assert.equal(conf.rpcpassword, "s3cret");
  assert.equal(conf.rpcport, "8352");
});

test("the indexer command never carries the password", () => {
  const launch = buildIndexerLaunch({
    rpcUrl: "http://127.0.0.1:8352/",
    user: "alice",
    password: PASSWORD,
    genesisId: `${"ab".repeat(32)}i0`,
    db: "data/index.sqlite",
    port: 8787,
    network: "mainnet",
    env: {},
  });
  const visible = [launch.command, ...launch.args].join(" ");
  assert.equal(visible.includes(PASSWORD), false);
  assert.equal(launch.args.includes("--silent"), true);
  assert.equal(launch.args.includes("--rpc-password"), false);
  assert.equal(launch.args.includes("-u"), false);
  assert.equal(launch.env.QBIT_RPC_PASSWORD, PASSWORD);
  assert.throws(() => buildIndexerLaunch({
    rpcUrl: `http://alice:${PASSWORD}@127.0.0.1:8352/`,
    user: "alice",
    password: PASSWORD,
    db: "data/index.sqlite",
    port: 8787,
    network: "mainnet",
  }), /must not contain credentials/);
});

test("a temp env file is not required to contain a real secret", () => {
  const dir = mkdtempSync(join(tmpdir(), "pins-env-"));
  writeFileSync(join(dir, ".env"), "QBIT_RPC_PASSWORD=\nQBIT_RPC_USER=\n");
  const parsed = parseEnvFile(readFileSync(join(dir, ".env"), "utf8"));
  assert.equal(parsed.QBIT_RPC_PASSWORD, "");
});
