// SPDX-License-Identifier: Apache-2.0

/**
 * The explorer reads CBOR with the indexer's reader and keeps no copy of it, takes its version from package.json,
 * reports a manifest that is not JSON instead of ignoring it, and rate-limits by the address its proxy appended.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decodeCbor as indexerDecode } from "../../packages/indexer/cbor.ts";
import { loadManifest, packageVersion } from "../server/config.ts";
import { forwardedClient } from "../server/net.ts";

test("the explorer has no copy of the CBOR reader, and keeps a __proto__ key and a leading byte order mark", async () => {
  assert.equal(existsSync(new URL("../server/cbor.ts", import.meta.url)), false);
  const api = readFileSync(new URL("../server/api.ts", import.meta.url), "utf8");
  assert.match(api, /from "\.\.\/\.\.\/packages\/indexer\/cbor\.ts"/);
  // { "__proto__": 1 } and the text "\uFEFFa": the readers the explorer used to copy lost both.
  const map = indexerDecode(Uint8Array.of(0xa1, 0x69, ...Buffer.from("__proto__"), 0x01)) as Record<string, number>;
  assert.deepEqual(Object.keys(map), ["__proto__"]);
  assert.equal(indexerDecode(Uint8Array.of(0x64, 0xef, 0xbb, 0xbf, 0x61)), "\uFEFFa");
});

test("the version comes from package.json", () => {
  const written = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  assert.equal(packageVersion(), written);
  assert.equal(readFileSync(new URL("../server/config.ts", import.meta.url), "utf8").includes(`version: "${written}"`), false);
});

test("a missing manifest is no collection, and one that is not JSON is an error", () => {
  const dir = mkdtempSync(join(tmpdir(), "pins-manifest-"));
  assert.equal(loadManifest(join(dir, "absent.json")), null);
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{ not json");
  assert.throws(() => loadManifest(bad), /is not valid JSON/);
  const list = join(dir, "list.json");
  writeFileSync(list, "[]");
  assert.throws(() => loadManifest(list), /must be a JSON object/);
  const good = join(dir, "good.json");
  writeFileSync(good, JSON.stringify({ name: "Set" }));
  assert.equal(loadManifest(good)?.name, "Set");
});

test("the client address is the one the proxy appended", () => {
  assert.equal(forwardedClient("203.0.113.9"), "203.0.113.9");
  assert.equal(forwardedClient("198.51.100.1, 203.0.113.9"), "203.0.113.9");
  assert.equal(forwardedClient("198.51.100.1,203.0.113.9 "), "203.0.113.9");
  assert.equal(forwardedClient(["198.51.100.1", "203.0.113.9"]), "203.0.113.9");
  assert.equal(forwardedClient(""), null);
  assert.equal(forwardedClient("   "), null);
  assert.equal(forwardedClient(undefined), null);
});
