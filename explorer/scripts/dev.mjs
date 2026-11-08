// Starts the synthetic mock indexer and the explorer together. Development only.
import { spawn } from "node:child_process";

const flags = ["--experimental-strip-types"];
const env = { ...process.env, INDEXER_URL: "http://127.0.0.1:8787", MANIFEST: "config/manifest.mock.json", POLL_MS: "2000", HOST: "127.0.0.1" };
delete env.QBIT_RPC_URL;
delete env.QBIT_RPC_USER;
delete env.QBIT_RPC_PASSWORD;
delete env.QBIT_CONF;
const children = [
  spawn(process.execPath, [...flags, "dev/mock-indexer.ts"], { stdio: "inherit", env }),
  spawn(process.execPath, [...flags, "server/index.ts"], { stdio: "inherit", env }),
];
for (const child of children) child.on("exit", () => { for (const other of children) other.kill(); process.exit(0); });
