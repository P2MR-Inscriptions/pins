// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { profile } from "../server/profile.ts";

function sources(dir: string, exts: string[]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path, exts);
    return exts.some((ext) => entry.name.endsWith(ext)) ? [path] : [];
  });
}

test("the page and the server code name no collection", () => {
  const files = [...sources("public", [".html", ".js", ".css"]), ...sources("server", [".ts"]), ...sources("scripts", [".ts"]), ...sources("dev", [".ts"])];
  assert.ok(files.length > 10);
  for (const file of files) {
    assert.equal(/flat\s?bits?/i.test(readFileSync(file, "utf8")), false, file);
  }
});

test("no manifest of a real collection is the default", () => {
  assert.equal(profile.defaultManifest, "config/manifest.json");
  assert.equal(existsSync(profile.defaultManifest), false);
  assert.equal(profile.piecePath, "item");
});

test("a real public collection is shipped only as an example manifest", () => {
  const manifest = JSON.parse(readFileSync("config/examples/flatbits.json", "utf8"));
  assert.equal(manifest.supply, 10000);
  assert.match(manifest.genesisId, /^[0-9a-f]{64}i0$/);
  assert.match(manifest.merkleRoot, /^[0-9a-f]{64}$/);
  const env = readFileSync(".env.example", "utf8");
  assert.match(env, /^MANIFEST=config\/examples\/flatbits\.json$/m);
  assert.match(env, /example/i);
  assert.equal(existsSync("config/manifest.flatbits.json"), false);
});
