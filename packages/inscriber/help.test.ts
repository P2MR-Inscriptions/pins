// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { COMMANDS, commandText, overviewText } from "./help.ts";

const NAMES = ["keygen", "address", "utxo", "root", "assign", "plan", "sign", "broadcast", "preflight", "price", "unsold-address", "sale-reveal", "unsold-transfer", "close"];

function run(...args: string[]) {
  return spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "packages/inscriber/cli.ts", ...args], { encoding: "utf8" });
}

/** Every flag name that the command line reads. */
function flagsInCode(): Set<string> {
  const found = new Set<string>();
  for (const file of ["cli.ts", "single.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const match of source.matchAll(/\bflag\.([a-z]+)\b|\bflag\["([a-z-]+)"\]|\btext\(flag, "([a-z-]+)"\)/g)) found.add(match[1] ?? match[2] ?? match[3]);
  }
  for (const match of readFileSync(new URL("single.ts", import.meta.url), "utf8").matchAll(/"([a-z-]+)"/g)) {
    if (/^(collection|zip|assignment|sale|holder|root|body|content-type|metadata)$/.test(match[1])) found.add(match[1]);
  }
  return found;
}

test("the help table has the fourteen commands, in the order of the overview", () => {
  assert.deepEqual(COMMANDS.map((command) => command.name), NAMES);
  const overview = overviewText();
  for (const name of NAMES) assert.match(overview, new RegExp(`^  ${name} `, "m"));
});

test("every flag the command line reads is in the help of a command, and every flag in the help is read", () => {
  const code = flagsInCode();
  const documented = new Set(COMMANDS.flatMap((command) => command.options.map((option) => option.flag.slice(2))));
  for (const name of code) assert.ok(documented.has(name), `--${name} is read by the command line and not documented in --help`);
  for (const name of documented) assert.ok(code.has(name), `--${name} is in --help and not read by the command line`);
});

test("the node commands list the login flags and the offline commands do not", () => {
  for (const command of COMMANDS) {
    const flags = command.options.map((option) => option.flag);
    for (const login of ["--rpc", "--rpc-user", "--rpc-password", "--rpc-cookie-file", "--rpc-datadir"]) {
      assert.equal(flags.includes(login), command.network === "node", `${command.name} ${login}`);
    }
  }
});

test("--help, help, and <command> --help print and exit 0", () => {
  for (const args of [["--help"], ["-h"], ["help"]]) {
    const result = run(...args);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, overviewText());
  }
  for (const name of NAMES) {
    for (const args of [[name, "--help"], [name, "-h"], ["help", name]]) {
      const result = run(...args);
      assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
      assert.equal(result.stdout, commandText(name));
      assert.match(result.stdout, new RegExp(`inscribe -- ${name} `));
    }
  }
});

test("no command and an unknown command fail and print the overview", () => {
  const none = run();
  assert.equal(none.status, 1);
  assert.match(none.stderr, /Commands:/);
  const unknown = run("frobnicate");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /^unknown command frobnicate\n/);
});

test("the inscriber guide shows every command", () => {
  const guide = readFileSync(new URL("../../docs/inscriber/README.md", import.meta.url), "utf8");
  const block = guide.slice(guide.indexOf("## Commands"), guide.indexOf("`npm run mainnet:preflight`"));
  for (const name of NAMES) assert.match(block, new RegExp(`packages/inscriber/cli\\.ts ${name} `), `${name} is missing from the Commands block`);
});
