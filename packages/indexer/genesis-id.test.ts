// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { encodeCbor } from "../collection/canonical.mjs";
import { collectionView } from "./collection.ts";
import { cloneIndexer, Indexer, type Inscription } from "./pins.ts";

const ISSUER = "ab".repeat(32);
const cursor = { tipHeight: 20, blockHash: () => null };

function genesis(id: string, name: string, createdHeight: number): Inscription {
  return {
    id,
    txid: id.slice(0, 64),
    n: 0,
    number: 0,
    location: { state: "unbound" },
    flags: [],
    contentType: "application/json",
    body: new Uint8Array(),
    bodySha256: "",
    metadata: encodeCbor({
      schema: "pins-collection/1",
      name,
      supply: 1,
      first: 1,
      name_prefix: "Item#",
      root: "cd".repeat(32),
      issuer: ISSUER,
      item_type: "image/png",
      sale_commitment: "ee".repeat(32),
    }),
    fields: [],
    createdHeight,
    createdIndex: 0,
    locationHeight: createdHeight,
    leafIssuer: ISSUER,
    ownerScript: "",
    ownerAddress: "",
  };
}

const FIRST = `${"11".repeat(32)}i0`;
const SECOND = `${"22".repeat(32)}i0`;

function indexerWith(genesisId?: string): Indexer {
  const indexer = new Indexer("regtest", { genesisId });
  indexer.inscriptions.set(FIRST, genesis(FIRST, "First", 1));
  indexer.inscriptions.set(SECOND, genesis(SECOND, "Second", 2));
  return indexer;
}

test("without a genesis id the first valid genesis in chain order is used", async () => {
  const view = await collectionView(indexerWith(), cursor);
  assert.equal(view.genesisId, FIRST);
  assert.equal(view.name, "First");
});

test("a genesis id selects that inscription, even when an earlier genesis is valid", async () => {
  const view = await collectionView(indexerWith(SECOND), cursor);
  assert.equal(view.status, "present");
  assert.equal(view.genesisId, SECOND);
  assert.equal(view.name, "Second");
});

test("a genesis id that names no valid genesis gives an absent collection", async () => {
  assert.equal((await collectionView(indexerWith(`${"33".repeat(32)}i0`), cursor)).status, "absent");
});

test("a copy of an indexer keeps the genesis id", async () => {
  const copy = cloneIndexer(indexerWith(SECOND));
  assert.equal(copy.genesisId, SECOND);
  assert.equal((await collectionView(copy, cursor)).genesisId, SECOND);
});

test("the indexer command refuses a genesis id that is not an inscription id", () => {
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/indexer-run.ts", "--db", "unused.sqlite", "--genesis", "not-an-id"], { encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /--genesis must be a P2MR Inscription id/);
});
