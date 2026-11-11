// SPDX-License-Identifier: Apache-2.0
/**
 * Fetch the pinned public PINS commit and apply the local patches in order.
 * This does not push, open a pull request, or talk to a node.
 * It does not reset or clean vendor/pins, and it does not read .env or data/.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PIN = "3e014f4ff156a35eea4b8613e37116fd124aa719";
const REMOTE = "https://github.com/P2MR-Inscriptions/pins.git";
const PATCHES = ["patches/0001-indexer-genesis-flag.patch", "patches/0002-rpc-credentials-off-argv.patch", "patches/0005-output-identity.patch", "patches/0006-parser-bounds.patch", "patches/0007-genesis-auth.patch"];

export type PatchState = "needed" | "applied" | "conflict";

function git(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const child = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { status: child.status ?? 1, stdout: child.stdout ?? "", stderr: child.stderr ?? "" };
}

function gitMust(args: string[], cwd: string): string {
  const child = git(args, cwd);
  if (child.status !== 0) throw new Error((child.stderr || `git ${args[0]} failed`).trim());
  return child.stdout.trim();
}

/**
 * Lines a patch adds. A later patch can change the same file, so `git apply --reverse`
 * on the earlier patch then fails even though those added lines are still present.
 */
export function patchAddedLines(patchText: string): Map<string, string[]> {
  const added = new Map<string, string[]>();
  let file = "";
  for (const line of patchText.split("\n")) {
    if (line.startsWith("+++ ")) {
      const name = line.slice(4).split("\t")[0]?.trim() ?? "";
      file = name === "/dev/null" ? "" : name.replace(/^b\//, "");
      if (file && !added.has(file)) added.set(file, []);
      continue;
    }
    if (file && line.startsWith("+") && !line.startsWith("+++")) {
      const text = line.slice(1);
      if (text.trim()) added.get(file)?.push(text);
    }
  }
  return added;
}

function addedLinesPresent(cwd: string, patchPath: string): boolean {
  const added = patchAddedLines(readFileSync(patchPath, "utf8"));
  if (added.size === 0) return false;
  for (const [file, lines] of added) {
    const path = join(cwd, file);
    if (!existsSync(path)) return false;
    const body = readFileSync(path, "utf8");
    if (lines.some((line) => !body.includes(line))) return false;
  }
  return true;
}

/** The credential patch matches the tree only after the genesis patch. Check one patch at a time. */
export function patchState(cwd: string, patchPath: string): PatchState {
  if (git(["apply", "--check", patchPath], cwd).status === 0) return "needed";
  if (git(["apply", "--reverse", "--check", patchPath], cwd).status === 0) return "applied";
  if (addedLinesPresent(cwd, patchPath)) return "applied";
  return "conflict";
}

export function applyPatchSeries(cwd: string, patchPaths: readonly string[]): void {
  for (const patchPath of patchPaths) {
    const state = patchState(cwd, patchPath);
    if (state === "applied") continue;
    if (state === "conflict") {
      throw new Error(`Refusing to reset. ${patchPath} does not apply to vendor/pins and is not already present.`);
    }
    const applied = git(["apply", patchPath], cwd);
    if (applied.status !== 0) throw new Error((applied.stderr || `git apply failed for ${patchPath}`).trim());
  }
}

export function ensureVendor(remote: string, vendor: string, pin: string): void {
  if (!existsSync(join(vendor, ".git"))) {
    if (existsSync(vendor) && readdirSync(vendor).length > 0) {
      throw new Error("vendor/pins exists without a git checkout. Refusing to delete it.");
    }
    mkdirSync(vendor, { recursive: true });
    gitMust(["init", "-q"], vendor);
    gitMust(["remote", "add", "origin", remote], vendor);
    gitMust(["fetch", "--depth", "1", "origin", pin], vendor);
    gitMust(["checkout", "--quiet", "--detach", "FETCH_HEAD"], vendor);
  } else {
    gitMust(["fetch", "--depth", "1", "origin", pin], vendor);
  }
  const head = gitMust(["rev-parse", "HEAD"], vendor);
  if (head !== pin) {
    const dirty = gitMust(["status", "--porcelain"], vendor);
    if (dirty) throw new Error("vendor/pins is not the pinned commit and has local changes. Refusing to reset.");
    gitMust(["checkout", "--quiet", "--detach", pin], vendor);
  }
  if (gitMust(["rev-parse", "HEAD"], vendor) !== pin) throw new Error("vendor/pins is not the pinned PINS commit");
}

function main(): void {
  const vendor = resolve(ROOT, "vendor/pins");
  try {
    ensureVendor(REMOTE, vendor, PIN);
    applyPatchSeries(vendor, PATCHES.map((patch) => resolve(ROOT, patch)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "setup failed"}\n`);
    process.exit(1);
  }
  const installed = spawnSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: vendor, stdio: "inherit" });
  if (installed.status !== 0) process.exit(installed.status ?? 1);
  process.stdout.write(`PINS indexer ready in vendor/pins at ${PIN}, with the genesis, RPC, and output-identity patches applied.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
