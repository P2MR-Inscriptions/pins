// SPDX-License-Identifier: Apache-2.0

/**
 * The commands that the documents show are the commands the code has. Every fenced code block of every Markdown
 * file is read, and for each command of the reference tools the test checks that the command exists, that every
 * flag it passes is one the tool documents in its own `--help`, and that every script and file it names is there.
 * A rename in the code that leaves a document behind fails here.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "../inscriber/help.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SKIP = new Set(["node_modules", ".git"]);
const SHELL_BLOCKS = new Set(["", "text", "bash", "sh", "shell", "console"]);

function markdownFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...markdownFiles(path));
    else if (name.endsWith(".md")) found.push(path);
  }
  return found;
}

/** The text of every fenced block that is shell, with the line the block starts on. */
function shellBlocks(text: string): { line: number; code: string }[] {
  const blocks: { line: number; code: string }[] = [];
  const lines = text.split("\n");
  let open: { line: number; lang: string; rows: string[] } | null = null;
  lines.forEach((row, index) => {
    const fence = /^\s*```(\w*)/.exec(row);
    if (fence && open === null) open = { line: index + 2, lang: fence[1], rows: [] };
    else if (fence && open !== null) {
      if (SHELL_BLOCKS.has(open.lang)) blocks.push({ line: open.line, code: open.rows.join("\n") });
      open = null;
    } else if (open !== null) open.rows.push(row);
  });
  return blocks;
}

/** Simple commands of a shell block, as lists of words. Quotes group words, `\` joins lines, comments are dropped. */
function commands(code: string): string[][] {
  const joined = code.replace(/\\\n/g, " ");
  const out: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote = "";
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) out.push(words);
    words = [];
  };
  for (let i = 0; i < joined.length; i++) {
    const c = joined[i];
    if (quote) {
      if (c === quote) quote = "";
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (c === "#" && !inWord) {
      while (i < joined.length && joined[i] !== "\n") i++;
      endCommand();
    } else if (c === "$" && joined[i + 1] === "(") {
      endCommand();
      i++;
    } else if (c === " " || c === "\t") endWord();
    else if ("\n;|&()".includes(c)) endCommand();
    else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return out;
}

function flagsOfHelp(script: string): Set<string> {
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", script, "--help"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(run.status, 0, `${script} --help exits 0`);
  return new Set(run.stdout.match(/--[a-z][a-z-]*/g) ?? []);
}

const rootScripts = new Set(Object.keys(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts));
const explorerScripts = new Set(Object.keys(JSON.parse(readFileSync(join(ROOT, "explorer/package.json"), "utf8")).scripts));
const INDEXER_FLAGS = flagsOfHelp("scripts/indexer-run.ts");
const TRADE_FLAGS = flagsOfHelp("packages/sale/regtest-trade.ts");
const INSCRIBER = new Map(COMMANDS.map((command) => [command.name, new Set(command.options.map((option) => option.flag))]));

/** Flags after the word at `from`, up to the end of the command. */
function flagsAfter(words: string[], from: number): string[] {
  return words.slice(from).filter((word) => /^--[a-z][a-z-]*$/.test(word));
}

type Problem = string;
let inscriberCommands = 0;

function check(file: string, line: number, words: string[]): Problem[] {
  const where = `${relative(ROOT, file)}:${line}`;
  const problems: Problem[] = [];
  const text = words.join(" ");
  // A word that names a file of this repository. `$PINS/` is the checkout.
  for (const word of words) {
    const match = /^(?:\$PINS\/)?((?:scripts|packages|explorer|docs)\/[A-Za-z0-9_./-]+\.(?:ts|mjs))$/.exec(word);
    if (match && !existsSync(join(ROOT, match[1]))) problems.push(`${where}: ${match[1]} does not exist (${text})`);
  }
  const npm = words.indexOf("npm");
  const runAt = npm >= 0 && words[npm + 1] === "run" ? words.findIndex((word, at) => at > npm + 1 && !word.startsWith("-")) : -1;
  if (runAt >= 0) {
    const script = words[runAt];
    if (!rootScripts.has(script) && !explorerScripts.has(script)) problems.push(`${where}: no npm script "${script}" (${text})`);
    const dashes = words.indexOf("--", runAt);
    const rest = dashes >= 0 ? dashes + 1 : words.length;
    if (script === "inscribe" || script === "mainnet:preflight") problems.push(...inscriber(where, words, rest, text, script === "inscribe" ? undefined : "preflight"));
    if (script === "indexer:serve" || script === "indexer:run") problems.push(...flagCheck(where, flagsAfter(words, rest), INDEXER_FLAGS, "the indexer", text));
    return problems;
  }
  const cli = words.findIndex((word) => word === "inscribe" || /(^|\/)packages\/inscriber\/cli\.ts$/.test(word));
  if (cli === 0 || (cli > 0 && /cli\.ts$/.test(words[cli]))) problems.push(...inscriber(where, words, cli + 1, text));
  const indexer = words.findIndex((word) => /(^|\/)scripts\/indexer-run\.ts$/.test(word));
  if (indexer >= 0) problems.push(...flagCheck(where, flagsAfter(words, indexer + 1), INDEXER_FLAGS, "the indexer", text));
  const trade = words.findIndex((word) => /(^|\/)packages\/sale\/regtest-trade\.ts$/.test(word));
  if (trade >= 0) problems.push(...flagCheck(where, flagsAfter(words, trade + 1), TRADE_FLAGS, "regtest-trade.ts", text));
  for (const script of ["vectors", "vectors-collection", "canonical-batch", "example-collection"]) {
    const at = words.findIndex((word) => new RegExp(`(^|/)scripts/${script}\\.ts$`).test(word));
    if (at < 0) continue;
    const source = readFileSync(join(ROOT, "scripts", `${script}.ts`), "utf8");
    for (const flag of flagsAfter(words, at + 1)) if (!source.includes(`"${flag}"`)) problems.push(`${where}: scripts/${script}.ts does not read ${flag} (${text})`);
  }
  return problems;
}

function flagCheck(where: string, flags: string[], known: Set<string>, tool: string, text: string): Problem[] {
  return flags.filter((flag) => !known.has(flag)).map((flag) => `${where}: ${flag} is not an option of ${tool} (${text})`);
}

/** `fixed` is the command that an npm script runs (`mainnet:preflight` is `preflight`): then every word from `from` is a flag. */
function inscriber(where: string, words: string[], from: number, text: string, fixed?: string): Problem[] {
  const name = fixed ?? words[from];
  if (name === undefined || name.startsWith("--") || name.startsWith("$") || name === "help" || name === "-h") return [];
  inscriberCommands++;
  const options = INSCRIBER.get(name);
  if (!options) return [`${where}: "${name}" is not a command of the inscriber (${text})`];
  return flagCheck(where, flagsAfter(words, fixed ? from : from + 1).filter((flag) => flag !== "--help"), options, `the inscriber command ${name}`, text);
}

test("every command, flag and script that a document shows exists in the code", () => {
  const problems: Problem[] = [];
  let seen = 0;
  for (const file of markdownFiles(ROOT)) {
    for (const block of shellBlocks(readFileSync(file, "utf8"))) {
      const rows = commands(block.code);
      for (const words of rows) {
        seen++;
        problems.push(...check(file, block.line, words));
      }
    }
  }
  assert.ok(seen > 100, `read ${seen} commands`);
  assert.ok(inscriberCommands > 40, `checked ${inscriberCommands} inscriber commands`);
  assert.deepEqual(problems, []);
});

test("the parser reads quotes, continuation lines, comments and command substitution", () => {
  const rows = commands('A=$(inscribe address --pub "p q.json") # note\ninscribe plan \\\n  --single --out x | tee y\n# only a comment\n');
  assert.deepEqual(rows, [["A="], ["inscribe", "address", "--pub", "p q.json"], ["inscribe", "plan", "--single", "--out", "x"], ["tee", "y"]]);
});

test("a command that is not in the code is reported", () => {
  const bad = check(join(ROOT, "README.md"), 1, ["inscribe", "plan", "--no-such-flag"]);
  assert.equal(bad.length, 1);
  assert.match(bad[0], /--no-such-flag is not an option of the inscriber command plan/);
  assert.equal(check(join(ROOT, "README.md"), 1, ["inscribe", "nosuch"]).length, 1);
  assert.equal(check(join(ROOT, "README.md"), 1, ["npm", "run", "nosuch"]).length, 1);
  assert.equal(check(join(ROOT, "README.md"), 1, ["node", "scripts/missing.ts"]).length, 1);
});
