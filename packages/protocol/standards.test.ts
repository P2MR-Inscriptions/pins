// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { STANDARDS } from "./index.mjs";

const SPECS = join(dirname(fileURLToPath(import.meta.url)), "../../docs/specs");

test("STANDARDS lists the documents of the specification index, in order", () => {
  const index = readFileSync(join(SPECS, "README.md"), "utf8");
  const listed = [...index.matchAll(/^\| \[(PINS-\d+)\]\(\1\.md\) \|/gm)].map((match) => match[1]);
  assert.deepEqual(STANDARDS.map((standard) => standard.id), listed);
  assert.equal(new Set(listed).size, listed.length);
});

test("STANDARDS states the status that each document states", () => {
  for (const standard of STANDARDS) {
    const text = readFileSync(join(SPECS, `${standard.id}.md`), "utf8");
    assert.match(text, new RegExp(`^\\| Standard \\| ${standard.id} \\|$`, "m"), standard.id);
    const status = /^\| Status \| (\w+)/m.exec(text)?.[1];
    assert.equal(status?.toLowerCase(), standard.status, `${standard.id}: change STANDARDS in packages/protocol/index.mjs together with the status line`);
  }
});

test("STANDARDS cannot be changed by a caller", () => {
  assert.ok(Object.isFrozen(STANDARDS));
  for (const standard of STANDARDS) assert.ok(Object.isFrozen(standard));
});
