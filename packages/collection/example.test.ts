// SPDX-License-Identifier: Apache-2.0

/**
 * The made-up example collection: the zip it writes is read by the real tools, and the root it states is the
 * root the inscriber computes. `root` and the example profiles are the first steps of a newcomer's mint.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseCollectionProfile } from "../protocol/profile.mjs";
import { loadCanonical } from "../../scripts/canonical-batch.ts";
import { parsePrice } from "../inscriber/preflight.ts";
import { exampleCollection, zipOf } from "./example.mjs";

const cli = fileURLToPath(new URL("../inscriber/cli.ts", import.meta.url));
const script = fileURLToPath(new URL("../../scripts/example-collection.ts", import.meta.url));

function node(args: string[]) {
  return spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", ...args], { encoding: "utf8" });
}

test("the example is deterministic and its profiles are accepted", () => {
  const first = exampleCollection();
  const second = exampleCollection();
  assert.equal(first.root, second.root);
  assert.match(first.root, /^[0-9a-f]{64}$/);
  assert.equal(first.files.size, 12 * 2 + 1);
  const sale = parseCollectionProfile(first.profileSale);
  assert.equal(sale.reserveCount, 2);
  assert.equal(sale.saleCount, 10);
  const none = parseCollectionProfile(first.profileNoSale);
  assert.equal(none.sale, false);
  assert.equal(parsePrice(first.price).price_bits, 50_000);
  assert.deepEqual(Buffer.from(zipOf(first.files)), Buffer.from(zipOf(second.files)));
  assert.notEqual(exampleCollection({ supply: 9 }).root, first.root);
  assert.throws(() => exampleCollection({ supply: 7 }), /8 or more/);
});

test("the zip is read by the inscriber's loader and `root` prints the root the profile states", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pins-example-"));
  try {
    const example = exampleCollection();
    const zip = join(dir, "collection.zip");
    writeFileSync(zip, zipOf(example.files));
    const canonical = await loadCanonical(zip, { supply: 12 });
    assert.equal(canonical.items.length, 12);
    const profile = join(dir, "profile.json");
    writeFileSync(profile, JSON.stringify(example.profileSale));
    const byProfile = node([cli, "root", "--zip", zip, "--collection", profile]);
    assert.equal(byProfile.status, 0, byProfile.stderr);
    assert.match(byProfile.stdout, new RegExp(`merkle root ${example.root}\\n`));
    assert.match(byProfile.stdout, /The collection profile has this root/);
    const bySupply = node([cli, "root", "--zip", zip, "--supply", "12"]);
    assert.equal(bySupply.status, 0, bySupply.stderr);
    assert.match(bySupply.stdout, new RegExp(`merkle root ${example.root}\\n`));
    assert.match(bySupply.stdout, /Put this value in the profile's root/);
    // A profile with another root is refused, and the message names the real root.
    writeFileSync(profile, JSON.stringify({ ...example.profileSale, root: "00".repeat(32) }));
    const wrong = node([cli, "root", "--zip", zip, "--collection", profile]);
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.stderr, new RegExp(`merkle root ${example.root} is not the collection root`));
    // A supply that does not match the zip is refused.
    assert.notEqual(node([cli, "root", "--zip", zip, "--supply", "13"]).status, 0);
    assert.notEqual(node([cli, "root", "--zip", zip]).status, 0);
    // `root` is offline.
    assert.notEqual(node([cli, "root", "--zip", zip, "--supply", "12", "--rpc", "http://127.0.0.1:1/"]).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("npm run example:collection writes the folder and refuses a folder that is not empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "pins-example-out-"));
  try {
    const out = join(dir, "sample");
    const made = node([script, "--out", out]);
    assert.equal(made.status, 0, made.stderr);
    const example = exampleCollection();
    assert.match(made.stdout, new RegExp(`merkle root ${example.root}`));
    assert.equal(JSON.parse(readFileSync(join(out, "profile.sale.json"), "utf8")).root, example.root);
    assert.equal(JSON.parse(readFileSync(join(out, "profile.nosale.json"), "utf8")).sale, false);
    assert.equal(readFileSync(join(out, "collection", "images", "1.png")).subarray(1, 4).toString(), "PNG");
    assert.deepEqual(readFileSync(join(out, "collection.zip")), zipOf(example.files));
    const again = node([script, "--out", out]);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /is not empty/);
    // The system unzip, the reader of the inscriber, lists exactly the entries.
    const listing = execFileSync("unzip", ["-Z1", join(out, "collection.zip")], { encoding: "utf8" }).trim().split("\n");
    assert.equal(listing.length, example.files.size);
    assert.ok(listing.includes("collection.json"));
    assert.ok(listing.includes("images/12.png"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
