// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { encodeCbor } from "../collection/canonical.mjs";
import { collectionView, type CollectionView } from "./collection.ts";
import { Indexer, type Inscription } from "./pins.ts";

const ISSUER = "ab".repeat(32);
const OTHER = "cd".repeat(32);
const cursor = { tipHeight: 20, blockHash: () => null };

function item(partial: Partial<Inscription> & { id: string }): Inscription {
  return {
    txid: "11".repeat(32),
    n: 0,
    number: 0,
    location: { state: "unbound" },
    flags: [],
    contentType: "image/png",
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

function sha256(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

function leafOf(number: number, body: Uint8Array, metadata: Uint8Array): Buffer {
  const preimage = Buffer.alloc(68);
  preimage.writeUInt32BE(number, 0);
  sha256(body).copy(preimage, 4);
  sha256(metadata).copy(preimage, 36);
  return sha256(preimage);
}

function map(...pairs: [string, Uint8Array][]): Buffer {
  return Buffer.concat([Buffer.from([0xa0 + pairs.length]), ...pairs.flatMap(([key, value]) => [encodeCbor(key), value])]);
}

const NULL = Buffer.from([0xf6]);
const TRUE = Buffer.from([0xf5]);
const NEGATIVE = Buffer.from([0x20]);

function itemField(name: Uint8Array): Buffer {
  return map(["meta", map(["name", name], ["attributes", encodeCbor([])])]);
}

/** Field 5 values a third party can inscribe that are not an item. */
const NOT_ITEMS: [string, Uint8Array][] = [
  ["a number name", itemField(encodeCbor(5))],
  ["a negative name", itemField(NEGATIVE)],
  ["a boolean name", itemField(TRUE)],
  ["a null name", itemField(NULL)],
  ["an array name", itemField(encodeCbor(["Item#1"]))],
  ["a map name", itemField(encodeCbor({ name: "Item#1" }))],
  ["a name with 100,000 digits", itemField(encodeCbor(`Item#${"9".repeat(100_000)}`))],
  ["no name", map(["meta", map(["attributes", encodeCbor([])])])],
  ["a number meta", map(["meta", encodeCbor(5)])],
  ["a text meta", map(["meta", encodeCbor("Item#1")])],
  ["a null meta", map(["meta", NULL])],
  ["an array meta", map(["meta", encodeCbor(["Item#1"])])],
  ["no meta", map(["name", encodeCbor("Item#1")])],
  ["a null map", NULL],
  ["a number", encodeCbor(5)],
  ["an array", encodeCbor([1, 2])],
  ["number attributes", map(["meta", map(["name", encodeCbor("Item#2")], ["attributes", encodeCbor(5)])])],
  ["attributes that are not pairs", map(["meta", map(["name", encodeCbor("Item#2")], ["attributes", encodeCbor([5, "x"])])])],
  ["attributes with a number value", map(["meta", map(["name", encodeCbor("Item#2")], ["attributes", encodeCbor([{ trait_type: "a", value: 1 }])])])],
];

function collection(): Indexer {
  const body = Uint8Array.of(9, 8, 7);
  const metadata = itemField(encodeCbor("Item#1"));
  const leaf = leafOf(1, body, metadata);
  const indexer = new Indexer();
  indexer.inscriptions.set("genesis", item({
    id: "genesis",
    n: 0,
    contentType: "application/json",
    metadata: encodeCbor({
      schema: "pins-collection/1",
      name: "Example",
      supply: 1,
      first: 1,
      name_prefix: "Item#",
      root: leaf.toString("hex"),
      issuer: ISSUER,
      item_type: "image/png",
      sale_commitment: "ee".repeat(32),
    }),
  }));
  indexer.inscriptions.set("list", item({
    id: "list",
    n: 1,
    contentType: "application/octet-stream",
    body: leaf,
  }));
  indexer.inscriptions.set("good", item({ id: "good", n: 2, createdHeight: 9, body, metadata }));
  return indexer;
}

function assertOnlyGoodPiece(view: CollectionView): void {
  assert.equal(view.status, "present");
  assert.equal(view.pieces?.length, 1);
  assert.equal(view.pieces?.[0]?.authentic, true);
  assert.equal(view.pieces?.[0]?.inscriptionId, "good");
}

test("a collection with one authentic item and no other inscriptions", async () => {
  assertOnlyGoodPiece(await collectionView(collection(), cursor));
});

for (const [label, metadata] of NOT_ITEMS) {
  test(`an inscription with ${label} does not stop the collection view`, async () => {
    for (const [leafIssuer, id] of [[ISSUER, "bad-issuer"], [OTHER, "bad-other"]] as const) {
      const indexer = collection();
      indexer.inscriptions.set(id, item({ id, n: 3, createdHeight: 5, leafIssuer, metadata }));
      assertOnlyGoodPiece(await collectionView(indexer, cursor));
    }
  });
}
