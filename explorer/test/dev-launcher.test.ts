// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo, type Server } from "node:net";
import { test } from "node:test";
import { devChildEnv, parseDevPorts } from "../scripts/dev.ts";

const packageVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

function hold(port = 0): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function portOf(server: Server): number {
  const address = server.address() as AddressInfo;
  return address.port;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Where the launcher tests start the launcher. It is its own process group, so the whole tree can be stopped. */
const LAUNCHER = ["--experimental-strip-types", "scripts/dev.ts"];
const LAUNCHER_CWD = fileURLToPath(new URL("..", import.meta.url));

function startLauncher(env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, LAUNCHER, { cwd: LAUNCHER_CWD, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Stop the launcher and everything it started, and wait until it is gone. SIGINT first, as a user would, then SIGKILL
 * to the whole group. Safe to call on a launcher that has already exited, and to call twice. A test calls it in
 * `finally`, so a failed start can never leave a mock or an explorer running (which would hold the job open).
 */
async function stopLauncher(child: ChildProcess): Promise<void> {
  const group = (signal: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, signal);
    } catch {
      /* the group is already gone */
    }
  };
  if (!hasExited(child)) {
    const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGINT");
    const timer = setTimeout(() => group("SIGKILL"), 3000);
    await gone;
    clearTimeout(timer);
  }
  group("SIGKILL");
}

function launch(env: NodeJS.ProcessEnv): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = startLauncher(env);
    if (!child.pid) {
      reject(new Error("launcher did not start"));
      return;
    }
    let output = "";
    child.stdout?.on("data", (chunk) => { output += chunk; });
    child.stderr?.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => {
      void stopLauncher(child).then(() => reject(new Error(`launcher timed out\n${output}`)));
    }, 15000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      void stopLauncher(child).then(() => resolve({ code, signal, output }));
    });
  });
}

function canBind(port: number): Promise<boolean> {
  return hold(port).then((server) => close(server).then(() => true)).catch(() => false);
}

test("dev ports reject a bad value and a shared port", () => {
  assert.deepEqual(parseDevPorts({}), { mockPort: 8787, explorerPort: 8080 });
  assert.throws(() => parseDevPorts({ MOCK_PORT: "8788", PORT: "8788" }), /are the same/);
  for (const value of ["0", "65536", "8787x", "1.5", "-1"]) {
    assert.throws(() => parseDevPorts({ MOCK_PORT: value }), /MOCK_PORT/, value);
  }
});

test("the child environment follows MOCK_PORT and drops RPC secrets", () => {
  const env = devChildEnv({
    INDEXER_URL: "http://127.0.0.1:8787",
    QBIT_RPC_PASSWORD: "secret",
    QBIT_RPC_USER: "rpc",
    QBIT_RPC_URL: "http://127.0.0.1:8332",
    QBIT_CONF: "/tmp/qbit.conf",
  }, { mockPort: 8799, explorerPort: 8099 });
  assert.equal(env.INDEXER_URL, "http://127.0.0.1:8799");
  assert.equal(env.MOCK_PORT, "8799");
  assert.equal(env.PORT, "8099");
  assert.equal(env.HOST, "127.0.0.1");
  assert.equal(env.MANIFEST, "config/manifest.mock.json");
  assert.equal(env.QBIT_RPC_PASSWORD, undefined);
  assert.equal(env.QBIT_RPC_USER, undefined);
  assert.equal(env.QBIT_RPC_URL, undefined);
  assert.equal(env.QBIT_CONF, undefined);
});

/**
 * Two distinct ports that could be bound a moment ago. They are drawn from 20000-29999, below the range the system
 * hands out to ephemeral connections (32768 and up on Linux, 49152 and up elsewhere), so another test, or the
 * launcher's own children, is unlikely to take one between this check and the launch. A test that starts the launcher
 * on them still retries with new ports when the launcher reports one in use.
 */
async function freePorts(): Promise<[number, number]> {
  const picked: number[] = [];
  while (picked.length < 2) {
    const port = 20000 + Math.floor(Math.random() * 10000);
    if (!picked.includes(port) && await canBind(port)) picked.push(port);
  }
  return [picked[0], picked[1]];
}

test("an occupied mock port exits 1 and does not start the explorer", async () => {
  const mockHolder = await hold();
  try {
    const [explorerPort] = await freePorts();
    const mockPort = portOf(mockHolder);
    const result = await launch({ MOCK_PORT: String(mockPort), PORT: String(explorerPort) });
    assert.equal(result.code, 1);
    assert.match(result.output, new RegExp(`127\\.0\\.0\\.1:${mockPort} is already in use`));
    assert.equal(await canBind(explorerPort), true);
  } finally {
    await close(mockHolder);
  }
});

test("an occupied explorer port exits 1 and does not leave a mock behind", async () => {
  const explorerHolder = await hold();
  try {
    const [mockPort] = await freePorts();
    const explorerPort = portOf(explorerHolder);
    const result = await launch({ MOCK_PORT: String(mockPort), PORT: String(explorerPort) });
    assert.equal(result.code, 1);
    assert.match(result.output, new RegExp(`127\\.0\\.0\\.1:${explorerPort} is already in use`));
    assert.equal(await canBind(mockPort), true);
  } finally {
    await close(explorerHolder);
  }
});

type Attempt = { ready: boolean; output: string; ended: { code: number | null; signal: NodeJS.Signals | null } | null; mockPort: number; explorerPort: number };

/** Start the launcher on two free ports, wait for the explorer to serve the mock, then stop it with SIGINT. */
async function serveAndInterrupt(): Promise<Attempt> {
  const [mockPort, explorerPort] = await freePorts();
  const child = startLauncher({ MOCK_PORT: String(mockPort), PORT: String(explorerPort), INDEXER_URL: "http://127.0.0.1:9" });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += chunk; });
  child.stderr?.on("data", (chunk) => { output += chunk; });
  try {
    const exited = new Promise<false>((resolve) => child.once("exit", () => resolve(false)));
    const served = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 8000);
      const probe = () => {
        if (hasExited(child)) return;
        fetch(`http://127.0.0.1:${explorerPort}/api/status`).then(async (response) => {
          const body = await response.json() as { explorer?: { version?: string }; indexer?: { mock?: boolean } };
          if (body.indexer?.mock === true && body.explorer?.version === packageVersion) {
            clearTimeout(timer);
            resolve(true);
            return;
          }
          setTimeout(probe, 80);
        }).catch(() => setTimeout(probe, 80));
      };
      probe();
    });
    const ready = await Promise.race([served, exited]);
    if (!ready) return { ready, output, ended: null, mockPort, explorerPort };
    const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    child.kill("SIGINT");
    return { ready, output, ended: await ended, mockPort, explorerPort };
  } finally {
    await stopLauncher(child);
  }
}

test("nondefault ports serve the mock, and SIGINT stops only those processes", async () => {
  // A port can still be taken by another process between the check and the start. That is the one failure that is
  // tried again, with new ports; any other failure is the test's result.
  let attempt = await serveAndInterrupt();
  for (let again = 0; again < 2 && !attempt.ready && /already in use/.test(attempt.output); again += 1) attempt = await serveAndInterrupt();
  assert.equal(attempt.ready, true, attempt.output);
  assert.equal(attempt.ended?.code, 130);
  assert.equal(await canBind(attempt.mockPort), true);
  assert.equal(await canBind(attempt.explorerPort), true);
});
