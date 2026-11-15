// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { cookieFileFromEnv } from "../scripts/credentials.ts";
import { buildIndexerLaunch } from "../scripts/indexer-launch.ts";
import { loadConfig } from "../server/config.ts";

const SECRET = "cookie-secret-not-real";
const NO_MANIFEST = { MANIFEST: "" };

test("a cookie file is named directly or found in the data directory of the network", () => {
  assert.equal(cookieFileFromEnv({}), undefined);
  assert.equal(cookieFileFromEnv({ QBIT_RPC_COOKIE_FILE: "/tmp/x/.cookie" }), "/tmp/x/.cookie");
  assert.equal(cookieFileFromEnv({ QBIT_RPC_DATADIR: "/tmp/node", PINS_NETWORK: "mainnet" }), "/tmp/node/.cookie");
  assert.equal(cookieFileFromEnv({ QBIT_RPC_DATADIR: "/tmp/node" }), "/tmp/node/.cookie");
  assert.equal(cookieFileFromEnv({ QBIT_RPC_DATADIR: "/tmp/node", PINS_NETWORK: "regtest" }), "/tmp/node/regtest/.cookie");
  assert.throws(() => cookieFileFromEnv({ QBIT_RPC_COOKIE_FILE: "/a", QBIT_RPC_DATADIR: "/b" }), /not both/);
  assert.throws(() => cookieFileFromEnv({ QBIT_RPC_DATADIR: "/b", PINS_NETWORK: "signet" }), /PINS_NETWORK/);
});

test("the explorer takes a cookie login, and refuses a mix or a node that is not on this machine", () => {
  const config = loadConfig({ ...NO_MANIFEST, QBIT_RPC_URL: "http://127.0.0.1:18452/", QBIT_RPC_DATADIR: "/tmp/node", PINS_NETWORK: "regtest" });
  assert.equal(config.rpc?.cookieFile, "/tmp/node/regtest/.cookie");
  assert.equal(config.rpc?.user, "");
  assert.throws(() => loadConfig({ ...NO_MANIFEST, QBIT_RPC_URL: "http://127.0.0.1:18452/", QBIT_RPC_DATADIR: "/tmp/node", QBIT_RPC_USER: "a", QBIT_RPC_PASSWORD: SECRET }), /one RPC login/);
  assert.throws(() => loadConfig({ ...NO_MANIFEST, QBIT_RPC_DATADIR: "/tmp/node" }), /QBIT_RPC_URL/);
  assert.throws(() => loadConfig({ ...NO_MANIFEST, QBIT_RPC_URL: "http://192.0.2.1:8352/", QBIT_RPC_COOKIE_FILE: "/tmp/x/.cookie" }), /loopback|this machine/);
});

test("the indexer launch of a cookie login carries the path and no password", () => {
  const launch = buildIndexerLaunch({ rpcUrl: "http://127.0.0.1:18452/", cookieFile: "/tmp/node/regtest/.cookie", db: "data/index.sqlite", port: 8787, network: "regtest", env: { QBIT_RPC_USER: "old", QBIT_RPC_PASSWORD: SECRET, PATH: "/usr/bin" } });
  const at = launch.args.indexOf("--rpc-cookie-file");
  assert.equal(launch.args[at + 1], "/tmp/node/regtest/.cookie");
  assert.equal(launch.env.QBIT_RPC_USER, undefined);
  assert.equal(launch.env.QBIT_RPC_PASSWORD, undefined);
  assert.equal(launch.env.PATH, "/usr/bin");
  assert.throws(() => buildIndexerLaunch({ rpcUrl: "http://127.0.0.1:18452/", cookieFile: "/c", user: "a", password: SECRET, db: "d", port: 1, network: "regtest" }), /one RPC login/);
  assert.throws(() => buildIndexerLaunch({ rpcUrl: "http://127.0.0.1:18452/", db: "d", port: 1, network: "regtest" }), /login is required/);
});

test("the node call reads the cookie again each time, and an error never shows it", async () => {
  const seen: string[] = [];
  const node = createServer((request, response) => {
    seen.push(request.headers.authorization ?? "");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ result: 77, error: null, id: "x" }));
  });
  await new Promise<void>((done) => node.listen(0, "127.0.0.1", done));
  const port = (node.address() as { port: number }).port;
  const datadir = mkdtempSync(join(tmpdir(), "pins-cookie-"));
  mkdirSync(join(datadir, "regtest"));
  const cookie = join(datadir, "regtest", ".cookie");
  writeFileSync(cookie, "__cookie__:first\n");
  const script = `
    import { writeFileSync } from "node:fs";
    const { rpc, rpcSecrets } = await import(${JSON.stringify(resolve("server/rpc.ts"))});
    const a = await rpc("getblockcount");
    writeFileSync(${JSON.stringify(cookie)}, "__cookie__:${SECRET}\\n");
    const b = await rpc("getblockcount");
    writeFileSync(${JSON.stringify(cookie)}, "no colon here\\n");
    let message = "";
    try { await rpc("getblockcount"); } catch (error) { message = error.message; }
    console.log(JSON.stringify({ a, b, message, secrets: rpcSecrets() }));`;
  const out = await new Promise<string>((done, fail) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script], {
      env: { ...process.env, MANIFEST: "", QBIT_RPC_URL: `http://127.0.0.1:${port}/`, QBIT_RPC_DATADIR: datadir, PINS_NETWORK: "regtest" },
    });
    let text = "";
    let errors = "";
    child.stdout.on("data", (chunk) => { text += chunk; });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.on("close", (code) => (code === 0 ? done(text) : fail(new Error(errors))));
  });
  node.close();
  const result = JSON.parse(out) as { a: number; b: number; message: string; secrets: string[] };
  assert.equal(result.a, 77);
  assert.equal(result.b, 77);
  assert.equal(seen[0], `Basic ${Buffer.from("__cookie__:first").toString("base64")}`);
  assert.equal(seen[1], `Basic ${Buffer.from(`__cookie__:${SECRET}`).toString("base64")}`);
  assert.match(result.message, /EMALFORMED/);
  assert.equal(out.includes(SECRET), true, "the secrets list holds the last cookie, for redaction");
  assert.equal(result.message.includes(SECRET), false);
});
