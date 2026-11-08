// Development only. Starts the synthetic mock, then the explorer, on loopback.
import { type ChildProcess, spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseDevPorts(env: NodeJS.ProcessEnv): { mockPort: number; explorerPort: number } {
  const mockPort = readPort("MOCK_PORT", env.MOCK_PORT, 8787);
  const explorerPort = readPort("PORT", env.PORT, 8080);
  if (mockPort === explorerPort) {
    throw new Error("PORT and MOCK_PORT are the same. npm run dev needs one port for the mock and a different port for the explorer.");
  }
  return { mockPort, explorerPort };
}

export function devChildEnv(env: NodeJS.ProcessEnv, ports: { mockPort: number; explorerPort: number }): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  delete next.QBIT_RPC_URL;
  delete next.QBIT_RPC_USER;
  delete next.QBIT_RPC_PASSWORD;
  delete next.QBIT_CONF;
  next.HOST = "127.0.0.1";
  next.PORT = String(ports.explorerPort);
  next.MOCK_PORT = String(ports.mockPort);
  next.INDEXER_URL = `http://127.0.0.1:${ports.mockPort}`;
  next.MANIFEST = "config/manifest.mock.json";
  next.POLL_MS = "2000";
  return next;
}

function readPort(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be an integer from 1 to 65535.`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be an integer from 1 to 65535.`);
  }
  return value;
}

export function assertPortFree(port: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        reject(new Error(`127.0.0.1:${port} is already in use. npm run dev stopped before starting. It did not attach to the process already listening there. Choose a free MOCK_PORT or PORT.`));
        return;
      }
      reject(error);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close((closeError) => (closeError ? reject(closeError) : resolvePromise()));
    });
  });
}

function waitUntilListening(port: number, child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`127.0.0.1:${port} did not accept connections.`)), timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`The process exited before it listened on 127.0.0.1:${port} (${signal || code}).`));
    };
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolvePromise();
    }
    child.once("exit", onExit);
    const attempt = () => {
      if (settled) return;
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.end();
        finish();
      });
      socket.once("error", () => {
        socket.destroy();
        if (!settled) setTimeout(attempt, 40);
      });
    };
    attempt();
  });
}

function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
    child.kill("SIGTERM");
  });
}

export async function runDev(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const ports = parseDevPorts(env);
  await assertPortFree(ports.mockPort);
  await assertPortFree(ports.explorerPort);
  const childEnv = devChildEnv(env, ports);
  const flags = ["--experimental-strip-types"];
  const mock = spawn(process.execPath, [...flags, "dev/mock-indexer.ts"], { cwd: ROOT, env: childEnv, stdio: "inherit" });
  const children = [mock];
  let mode = "starting";
  const shutdown = async (exitCode: number) => {
    if (mode === "stopping") return;
    mode = "stopping";
    await Promise.all(children.map((child) => stopChild(child)));
    process.exit(exitCode);
  };
  process.once("SIGINT", () => { void shutdown(130); });
  process.once("SIGTERM", () => { void shutdown(143); });
  try {
    await waitUntilListening(ports.mockPort, mock, 8000);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "The mock did not start."}\n`);
    await stopChild(mock);
    process.exit(1);
  }
  const explorer = spawn(process.execPath, [...flags, "server/index.ts"], { cwd: ROOT, env: childEnv, stdio: "inherit" });
  children.push(explorer);
  try {
    await waitUntilListening(ports.explorerPort, explorer, 8000);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "The explorer did not start."}\n`);
    await Promise.all(children.map((child) => stopChild(child)));
    process.exit(1);
  }
  mode = "running";
  const onChildExit = (which: string) => (code: number | null, signal: NodeJS.Signals | null) => {
    if (mode !== "running") return;
    process.stderr.write(`${which} stopped (${signal || code}).\n`);
    void shutdown(typeof code === "number" && code > 0 ? code : 1);
  };
  mock.on("exit", onChildExit("mock"));
  explorer.on("exit", onChildExit("explorer"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDev().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "npm run dev failed."}\n`);
    process.exit(1);
  });
}
