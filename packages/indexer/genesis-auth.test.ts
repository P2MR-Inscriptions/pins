// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { encodeCbor } from "../collection/canonical.mjs";
import { encodeGenesisField } from "../inscriber/preflight.ts";
import { collectionView } from "./collection.ts";
import { Indexer, type Inscription } from "./pins.ts";

const ISSUER = "ab".repeat(32);
const ROOT = "cd".repeat(32);
const cursor = { tipHeight: 20, blockHash: () => null };

function item(partial: Partial<Inscription> & { id: string }): Inscription {
  return {
    txid: "11".repeat(32),
    n: 0,
    number: 0,
    location: { state: "unbound" },
    flags: [],
    contentType: "application/json",
    body: new Uint8Array(),
    bodySha256: "",
    metadata: null,
    fields: [],
    createdHeight: 1,
    createdIndex: 0,
    locationHeight: 1,
    leafIssuer: ISSUER,
    ownerScript: "",
    ownerAddress: "",
    ...partial,
  };
}

function launchField(over: Record<string, unknown> = {}): Uint8Array {
  return encodeCbor({
    schema: "pins-collection/1",
    name: "Example",
    supply: 1,
    first: 1,
    name_prefix: "Item#",
    root: ROOT,
    issuer: ISSUER,
    item_type: "image/png",
    sale_commitment: "ee".repeat(32),
    ...over,
  });
}

test("an earlier JSON body cannot shadow a later field-5 genesis", async () => {
  const indexer = new Indexer();
  indexer.inscriptions.set("shadow", item({
    id: "shadow",
    createdHeight: 1,
    body: new TextEncoder().encode(JSON.stringify({ name: "Shadow", supply: 2, issuer: ISSUER, root: ROOT })),
    metadata: null,
  }));
  indexer.inscriptions.set("real", item({
    id: "real",
    createdHeight: 2,
    metadata: launchField(),
    leafIssuer: ISSUER,
  }));
  const view = await collectionView(indexer, cursor);
  assert.equal(view.status, "present");
  assert.equal(view.genesisId, "real");
  assert.equal(view.name, "Example");
});

test("a field 5 whose issuer is not the reveal key is skipped", async () => {
  const indexer = new Indexer();
  indexer.inscriptions.set("forged", item({
    id: "forged",
    metadata: launchField({ issuer: "ff".repeat(32) }),
    leafIssuer: ISSUER,
  }));
  assert.equal((await collectionView(indexer, cursor)).status, "absent");
});

test("the launch schema rejects a missing sale commitment and a rehearsal schema does not", async () => {
  const indexer = new Indexer();
  const rest = {
    schema: "pins-collection/1",
    name: "Example",
    supply: 1,
    first: 1,
    name_prefix: "Item#",
    root: ROOT,
    issuer: ISSUER,
    item_type: "image/png",
  };
  indexer.inscriptions.set("short", item({ id: "short", metadata: encodeCbor(rest) }));
  assert.equal((await collectionView(indexer, cursor)).status, "absent");
  const rehearsal = new Indexer("regtest", { schema: "c/1" });
  rehearsal.inscriptions.set("ok", item({
    id: "ok",
    metadata: encodeCbor({ ...rest, schema: "c/1" }),
  }));
  const view = await collectionView(rehearsal, cursor);
  assert.equal(view.status, "present");
  assert.equal(view.name, "Example");
});

test("a leaf list is authentic only when its leaves fold to the genesis root", async () => {
  const leaf = createHash("sha256").update("one").digest();
  const other = createHash("sha256").update("two").digest();
  const indexer = new Indexer();
  indexer.inscriptions.set("g", item({
    id: "g",
    n: 0,
    metadata: launchField({ root: leaf.toString("hex"), supply: 1 }),
  }));
  indexer.inscriptions.set("bad", item({
    id: "bad",
    n: 1,
    contentType: "application/octet-stream",
    body: other,
    metadata: null,
  }));
  const hidden = await collectionView(indexer, cursor);
  assert.equal(hidden.leafListId, undefined);
  indexer.inscriptions.set("good", item({
    id: "good",
    n: 2,
    contentType: "application/octet-stream",
    body: leaf,
    metadata: null,
  }));
  const shown = await collectionView(indexer, cursor);
  assert.equal(shown.leafListId, "good");
});

test("a leaf list field 5 that is not pins-leaflist/1 is ignored", async () => {
  const leaf = createHash("sha256").update("one").digest();
  const indexer = new Indexer();
  indexer.inscriptions.set("g", item({
    id: "g",
    metadata: launchField({ root: leaf.toString("hex") }),
  }));
  indexer.inscriptions.set("tagged", item({
    id: "tagged",
    n: 1,
    contentType: "application/octet-stream",
    body: leaf,
    metadata: encodeCbor({ schema: "pins-other/1", root: leaf }),
  }));
  assert.equal((await collectionView(indexer, cursor)).leafListId, undefined);
  indexer.inscriptions.set("plain", item({
    id: "plain",
    n: 2,
    contentType: "application/octet-stream",
    body: leaf,
    metadata: null,
  }));
  assert.equal((await collectionView(indexer, cursor)).leafListId, "plain");
});

test("encodeGenesisField output is recognized for the public FlatBits shape", async () => {
  const issuer = "12".repeat(32);
  const field = await encodeGenesisField({
    schema: "pins-collection/1",
    name: "Flatbits",
    supply: 10000,
    first: 1,
    namePrefix: "Flatbit#",
    itemType: "image/png",
    root: "70768608a21dec18f611a643ed1f519a19df4a0eca35c65a62588d383dcaf7b2",
    issuer,
    saleCommitment: "34".repeat(32),
  });
  const indexer = new Indexer("mainnet");
  indexer.inscriptions.set("g", item({ id: "g", metadata: field, leafIssuer: issuer }));
  const view = await collectionView(indexer, cursor);
  assert.equal(view.status, "present");
  assert.equal(view.supply, 10000);
  assert.equal(view.namePrefix, "Flatbit#");
  assert.equal(view.root, "70768608a21dec18f611a643ed1f519a19df4a0eca35c65a62588d383dcaf7b2");
});
