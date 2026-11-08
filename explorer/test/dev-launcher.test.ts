import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer, type AddressInfo, type Server } from "node:net";
import { test } from "node:test";
import { devChildEnv, parseDevPorts } from "../scripts/dev.ts";

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

function launch(env: NodeJS.ProcessEnv): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string; pid: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "scripts/dev.ts"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!child.pid) {
      reject(new Error("launcher did not start"));
      return;
    }
    let output = "";
    child.stdout?.on("data", (chunk) => { output += chunk; });
    child.stderr?.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`launcher timed out\n${output}`));
    }, 15000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output, pid: child.pid as number });
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

test("an occupied mock port exits 1 and does not start the explorer", async () => {
  const mockHolder = await hold();
  const explorerHolder = await hold();
  const mockPort = portOf(mockHolder);
  const explorerPort = portOf(explorerHolder);
  await close(explorerHolder);
  const result = await launch({ MOCK_PORT: String(mockPort), PORT: String(explorerPort) });
  assert.equal(result.code, 1);
  assert.match(result.output, new RegExp(`127\\.0\\.0\\.1:${mockPort} is already in use`));
  assert.equal(await canBind(explorerPort), true);
  await close(mockHolder);
});

test("an occupied explorer port exits 1 and does not leave a mock behind", async () => {
  const explorerHolder = await hold();
  const mockHolder = await hold();
  const explorerPort = portOf(explorerHolder);
  const mockPort = portOf(mockHolder);
  await close(mockHolder);
  const result = await launch({ MOCK_PORT: String(mockPort), PORT: String(explorerPort) });
  assert.equal(result.code, 1);
  assert.match(result.output, new RegExp(`127\\.0\\.0\\.1:${explorerPort} is already in use`));
  assert.equal(await canBind(mockPort), true);
  await close(explorerHolder);
});

test("nondefault ports serve the mock, and SIGINT stops only those processes", async () => {
  const mockHolder = await hold();
  const explorerHolder = await hold();
  const mockPort = portOf(mockHolder);
  const explorerPort = portOf(explorerHolder);
  await close(mockHolder);
  await close(explorerHolder);
  const child = spawn(process.execPath, ["--experimental-strip-types", "scripts/dev.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, MOCK_PORT: String(mockPort), PORT: String(explorerPort), INDEXER_URL: "http://127.0.0.1:9" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += chunk; });
  child.stderr?.on("data", (chunk) => { output += chunk; });
  const ready = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 8000);
    const probe = () => {
      fetch(`http://127.0.0.1:${explorerPort}/api/status`).then(async (response) => {
        const body = await response.json() as { explorer?: { version?: string }; indexer?: { mock?: boolean } };
        if (body.indexer?.mock === true && body.explorer?.version === "1.0.1") {
          clearTimeout(timer);
          resolve(true);
          return;
        }
        setTimeout(probe, 80);
      }).catch(() => setTimeout(probe, 80));
    };
    probe();
  });
  assert.equal(ready, true, output);
  child.kill("SIGINT");
  const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(ended.code, 130);
  assert.equal(await canBind(mockPort), true);
  assert.equal(await canBind(explorerPort), true);
});
