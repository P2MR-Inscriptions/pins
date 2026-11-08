// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPatchSeries, patchState } from "../scripts/setup-indexer.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const patches = ["patches/0001-indexer-genesis-flag.patch", "patches/0002-rpc-credentials-off-argv.patch", "patches/0005-output-identity.patch"].map((patch) => join(root, patch));

function freshTree(): string {
  const tmp = mkdtempSync(join(tmpdir(), "pins-patch-"));
  cpSync(join(root, "test/fixtures/pins-unpatched"), tmp, { recursive: true });
  return tmp;
}

test("the credential patch does not apply to the clean pin", () => {
  const tmp = freshTree();
  try {
    assert.equal(patchState(tmp, patches[1]), "conflict");
    const checked = spawnSync("git", ["apply", "--check", patches[1]], { cwd: tmp, encoding: "utf8" });
    assert.notEqual(checked.status, 0);
    assert.match(checked.stderr, /scripts\/indexer-run\.ts/);
    assert.equal(patchState(tmp, patches[0]), "needed");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("patches apply in order, resume after the first, and do not reset a local edit", () => {
  const tmp = freshTree();
  try {
    applyPatchSeries(tmp, patches);
    assert.equal(patchState(tmp, patches[0]), "applied");
    assert.equal(patchState(tmp, patches[1]), "applied");
    applyPatchSeries(tmp, patches);
    const follow = readFileSync(join(tmp, "packages/indexer/follow.ts"), "utf8");
    assert.equal(follow.includes('"-u"'), false);
    assert.match(follow, /createdHere/);
    const store = readFileSync(join(tmp, "packages/indexer/store.ts"), "utf8");
    assert.match(store, /created twice in block/);
    assert.equal(store.includes("INSERT OR IGNORE INTO outputs"), false);
    assert.match(readFileSync(join(tmp, "packages/indexer/collection.ts"), "utf8"), /indexer\.genesisId && item\.id !== indexer\.genesisId/);
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--test", "packages/indexer/rpc-auth.test.ts"], { cwd: tmp, encoding: "utf8" });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const partial = freshTree();
  try {
    applyPatchSeries(partial, [patches[0]]);
    assert.equal(patchState(partial, patches[0]), "applied");
    assert.equal(patchState(partial, patches[1]), "needed");
    applyPatchSeries(partial, patches);
    assert.match(readFileSync(join(partial, "packages/indexer/follow.ts"), "utf8"), /curlRpcInvocation/);
    assert.match(readFileSync(join(partial, "packages/indexer/follow.ts"), "utf8"), /createdHere/);
    const marker = "user-edit-must-remain";
    const target = join(partial, "packages/indexer/follow.ts");
    writeFileSync(target, readFileSync(target, "utf8").replace("curlRpcInvocation(url, user, password, file)", `curlRpcInvocation(url, user, password, file) /* ${marker} */`));
    assert.throws(() => applyPatchSeries(partial, patches), /Refusing to reset/);
    assert.match(readFileSync(target, "utf8"), new RegExp(marker));
  } finally {
    rmSync(partial, { recursive: true, force: true });
  }
});
