// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { buildVectors, VECTOR_DIR } from "../../scripts/vectors.ts";

const sha = (bytes: Buffer): Buffer => createHash("sha256").update(bytes).digest();
const read = (name: string) => JSON.parse(readFileSync(join(VECTOR_DIR, name), "utf8"));

// A second reading of PINS-5 §5.1, written for this test and sharing no code with the repository.
function referenceLeaf(number: number, body: Buffer, metadata: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(number);
  return sha(Buffer.concat([head, sha(body), sha(metadata)]));
}

function referenceRoot(leaves: Buffer[]): Buffer {
  let level = leaves;
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha(Buffer.concat([level[i], level[i + 1] ?? level[i]])));
    level = next;
  }
  return level[0];
}

function referenceProofHolds(leaf: Buffer, index: number, count: number, path: string[], root: string): boolean {
  if (count < 1 || index < 0 || index >= count) return false;
  let depth = 0;
  for (let width = count; width > 1; width = Math.ceil(width / 2)) depth += 1;
  if (path.length !== depth) return false;
  let node = leaf;
  let position = index;
  for (const sibling of path) {
    const other = Buffer.from(sibling, "hex");
    node = sha(position % 2 === 0 ? Buffer.concat([node, other]) : Buffer.concat([other, node]));
    position = Math.floor(position / 2);
  }
  return node.toString("hex") === root;
}

test("every vector file is what the code of this repository produces", async () => {
  const built = await buildVectors();
  const onDisk = readdirSync(VECTOR_DIR).filter((name) => name.endsWith(".json")).sort();
  assert.deepEqual(onDisk, Object.keys(built).sort());
  for (const [name, content] of Object.entries(built)) assert.equal(readFileSync(join(VECTOR_DIR, name), "utf8"), content, name);
});

test("the leaf vectors agree with a separate reading of PINS-5 §5.1", () => {
  const file = read("merkle-leaf.json");
  for (const item of file.cases) {
    if (item.error) continue;
    const body = Buffer.from(item.body_hex, "hex");
    const metadata = Buffer.from(item.metadata_hex, "hex");
    assert.equal(referenceLeaf(item.number, body, metadata).toString("hex"), item.leaf, item.name);
    assert.equal(sha(body).toString("hex"), item.body_sha256, item.name);
    assert.equal(sha(metadata).toString("hex"), item.metadata_sha256, item.name);
  }
  assert.equal(file.cases.filter((item: { error?: boolean }) => item.error).length, 2);
});

test("the root vectors agree with a separate reading, and their levels fold to the root", () => {
  const file = read("merkle-root.json");
  for (const item of file.cases) {
    const leaves = item.leaves.map((leaf: string) => Buffer.from(leaf, "hex"));
    assert.equal(referenceRoot(leaves).toString("hex"), item.root, item.name);
    assert.deepEqual(item.levels[0].slice(0, leaves.length), item.leaves);
    assert.equal(item.levels[item.levels.length - 1].length, 1);
    assert.equal(item.levels[item.levels.length - 1][0], item.root);
  }
  assert.deepEqual(file.cases.map((item: { leaves: string[] }) => item.leaves.length), [1, 2, 3, 4, 5, 6, 7, 8, 9, 16, 17]);
  assert.equal(file.cases[0].root, file.cases[0].leaves[0]);
  for (const pair of file.equal_roots) {
    assert.equal(referenceRoot(pair.left.map((leaf: string) => Buffer.from(leaf, "hex"))).toString("hex"), pair.root);
    assert.equal(referenceRoot(pair.right.map((leaf: string) => Buffer.from(leaf, "hex"))).toString("hex"), pair.root);
  }
});

test("the proof vectors agree with a separate reading, valid and invalid", () => {
  const file = read("merkle-proof.json");
  assert.ok(file.valid.length >= 30);
  assert.ok(file.invalid.length >= 10);
  for (const item of file.valid) assert.equal(referenceProofHolds(Buffer.from(item.leaf, "hex"), item.index, item.count, item.path, item.root), true, `${item.count}/${item.index}`);
  for (const item of file.invalid) assert.equal(referenceProofHolds(Buffer.from(item.leaf, "hex"), item.index, item.count, item.path, item.root), false, item.name);
});

test("the leaf list vectors fold the way the root vectors do", () => {
  const file = read("leaf-list.json");
  for (const item of file.cases) {
    const body = Buffer.from(item.body_hex, "hex");
    if (item.root === null) {
      assert.ok(body.length === 0 || body.length % 32 !== 0, item.name);
      continue;
    }
    const leaves = Array.from({ length: body.length / 32 }, (_, index) => body.subarray(index * 32, index * 32 + 32));
    assert.equal(referenceRoot(leaves).toString("hex"), item.root, item.name);
  }
});

test("the public example genesis is on chain at the height the page gives", () => {
  const file = read("genesis-example.json");
  assert.equal(file.values.supply, 10000);
  assert.equal(file.genesis_id, "15d6f9c48865b579f7d1144e4d2d71d905c6fe04458bebc814052a3e39a07784i0");
  assert.match(file.field5_hex, /^a9/);
});

test("the vector folder has a README that names every file", () => {
  const readme = readFileSync(join(VECTOR_DIR, "README.md"), "utf8");
  for (const name of readdirSync(VECTOR_DIR).filter((entry) => entry.endsWith(".json"))) assert.ok(readme.includes(`\`${name}\``), name);
});

test("only the shared module folds a Merkle tree", () => {
  const roots = ["packages", "scripts"];
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(path); continue; }
      if (!/\.(ts|mjs)$/.test(entry.name) || /\.test\./.test(entry.name)) continue;
      if (/length % 2 === 1\) \w+\.push\(/.test(readFileSync(path, "utf8"))) found.push(path);
    }
  };
  for (const root of roots) walk(join(VECTOR_DIR, "../../..", root));
  assert.deepEqual(found.map((path) => path.split("/").slice(-2).join("/")), ["protocol/merkle.mjs"]);
});

test("the type file of the shared module names every export", async () => {
  const module = await import("./merkle.mjs");
  const declared = [...readFileSync(join(VECTOR_DIR, "../../../packages/protocol/merkle.d.mts"), "utf8").matchAll(/^export function (\w+)/gm)].map((match) => match[1]);
  assert.deepEqual(declared.sort(), Object.keys(module).sort());
});
