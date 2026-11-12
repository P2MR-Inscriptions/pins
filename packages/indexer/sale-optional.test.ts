// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { encodeCbor } from "../collection/canonical.mjs";
import { encodePriceField, PRICE_BODY } from "../inscriber/preflight.ts";
import { collectionView } from "./collection.ts";
import { Indexer, type Inscription } from "./pins.ts";

const ISSUER = "ab".repeat(32);
const SECRET = Buffer.alloc(32, 0x11);
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest();
const BODIES = [1, 2, 3].map((n) => Buffer.from([n]));
const METAS = [1, 2, 3].map((n) => Buffer.from(encodeCbor({ meta: { name: `Item#${n}`, attributes: [] } })));
const LEAVES = [1, 2, 3].map((n) => {
  const number = Buffer.alloc(4);
  number.writeUInt32BE(n);
  return sha(Buffer.concat([number, sha(BODIES[n - 1]), sha(METAS[n - 1])]));
});
const ROOT = sha(Buffer.concat([sha(Buffer.concat([LEAVES[0], LEAVES[1]])), sha(Buffer.concat([LEAVES[2], LEAVES[2]]))]));
const cursor = { tipHeight: 100, blockHash: () => "22".repeat(32) };
const PRICE = { price_bits: 12_345_678, price_sources: ["Desk A 8.10 USD"], price_time: "2026-11-04T18:00:00Z" };

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
    createdHeight: 10,
    createdIndex: 0,
    locationHeight: 10,
    leafIssuer: ISSUER,
    ownerScript: "",
    ownerAddress: "",
    ...partial,
  };
}

const head = (major: number, length: number) => Buffer.from(length < 24 ? [(major << 5) | length] : [(major << 5) | 24, length]);
const text = (value: string) => Buffer.concat([head(3, value.length), Buffer.from(value)]);
const bytes = (value: Uint8Array) => Buffer.concat([head(2, value.length), value]);
const map = (...entries: [string, Buffer][]) => Buffer.concat([head(5, entries.length), ...entries.flatMap(([key, value]) => [text(key), value])]);
const reveal = () => map(["schema", text("pins-sale-reveal/1")], ["root", bytes(ROOT)], ["sale_secret", bytes(SECRET)]);

const BASE = {
  schema: "pins-collection/1",
  name: "Example",
  supply: 3,
  first: 1,
  name_prefix: "Item#",
  root: ROOT.toString("hex"),
  issuer: ISSUER,
  item_type: "image/png",
};
const RESERVE = { groups: [{ trait_type: "a", value: "b", count: 1 }], extra: 0 };

/** Three items. The genesis is at height 10 and the items at 11. `genesis` is the whole field 5 map. */
function collection(genesis: Record<string, unknown>): Indexer {
  const indexer = new Indexer();
  indexer.inscriptions.set("g", item({ id: "g", contentType: "application/json", metadata: encodeCbor(genesis) }));
  indexer.inscriptions.set("list", item({ id: "list", n: 1, contentType: "application/octet-stream", body: Buffer.concat(LEAVES) }));
  for (const n of [1, 2, 3]) {
    indexer.inscriptions.set(`item${n}`, item({ id: `item${n}`, n, body: BODIES[n - 1], metadata: METAS[n - 1], createdHeight: 11 }));
  }
  return indexer;
}

async function addPriceAndReveal(indexer: Indexer): Promise<void> {
  indexer.inscriptions.set("reveal", item({ id: "reveal", contentType: "text/plain", metadata: reveal(), createdHeight: 12 }));
  indexer.inscriptions.set("price", item({
    id: "price",
    contentType: "text/plain",
    body: PRICE_BODY,
    metadata: await encodePriceField({ genesis: "g", price: PRICE }),
    createdHeight: 12,
    createdIndex: 1,
  }));
}

test("a genesis without a sale commitment is authentic and declares no sale", async () => {
  const view = await collectionView(collection(BASE), cursor);
  assert.equal(view.status, "present");
  assert.equal(view.genesisId, "g");
  assert.equal(view.leafListId, "list");
  assert.deepEqual(view.pieces?.map((piece) => piece.authentic), [true, true, true]);
  assert.equal(view.seedRevealed, false);
  assert.equal(view.reserveMode, "none");
  assert.equal(view.orderStatus, "none");
  assert.equal(view.orderPendingReason, "genesis declares no sale");
  assert.equal(view.order, null);
  assert.equal(view.orderVerified, null);
  assert.equal(view.priceStatus, "none");
  assert.deepEqual(view.pieces?.map((piece) => piece.status), ["unassigned", "unassigned", "unassigned"]);
});

test("a price inscription and a sale reveal are ignored when the genesis declares no sale", async () => {
  const plain = await collectionView(collection(BASE), cursor);
  const indexer = collection(BASE);
  await addPriceAndReveal(indexer);
  const view = await collectionView(indexer, cursor);
  assert.equal(view.seedRevealed, false);
  assert.equal(view.orderStatus, "none");
  assert.equal(view.order, null);
  assert.equal(view.priceStatus, "none");
  assert.equal(view.priceId, undefined);
  assert.equal(view.priceBits, undefined);
  assert.deepEqual(view.pieces, plain.pieces);
});

test("a genesis with a sale commitment reads the reveal and the price as before", async () => {
  const declared = { ...BASE, sale_commitment: sha(SECRET).toString("hex") };
  const before = await collectionView(collection(declared), cursor);
  assert.equal(before.orderStatus, "pending");
  assert.equal(before.orderPendingReason, "sale secret is not revealed");
  assert.equal(before.priceStatus, "pending");
  const indexer = collection(declared);
  await addPriceAndReveal(indexer);
  const view = await collectionView(indexer, cursor);
  assert.equal(view.seedRevealed, true);
  assert.equal(view.orderStatus, "ready");
  assert.deepEqual([...(view.order ?? [])].sort(), [1, 2, 3]);
  assert.equal(view.orderVerified, true);
  assert.equal(view.priceStatus, "ready");
  assert.equal(view.priceId, "price");
  assert.equal(view.priceBits, PRICE.price_bits);
  assert.deepEqual(view.pieces?.map((piece) => piece.status), ["sale", "sale", "sale"]);
});

test("the optional keys are `sale_commitment` after `item_type`, then `reserve` last", async () => {
  const sale = sha(SECRET).toString("hex");
  const accepted: [string, Record<string, unknown>][] = [
    ["neither", BASE],
    ["sale commitment", { ...BASE, sale_commitment: sale }],
    ["reserve only", { ...BASE, reserve: RESERVE }],
    ["sale commitment and reserve", { ...BASE, sale_commitment: sale, reserve: RESERVE }],
  ];
  for (const [label, field] of accepted) {
    assert.equal((await collectionView(collection(field), cursor)).status, "present", label);
  }
  const { item_type: itemType, ...withoutType } = BASE;
  const rejected: [string, Record<string, unknown>][] = [
    ["sale commitment before item_type", { ...withoutType, sale_commitment: sale, item_type: itemType }],
    ["reserve before sale commitment", { ...BASE, reserve: RESERVE, sale_commitment: sale }],
    ["reserve before item_type", { ...withoutType, reserve: RESERVE, item_type: itemType }],
    ["sale commitment too short", { ...BASE, sale_commitment: "ab".repeat(31) }],
    ["sale commitment in capitals", { ...BASE, sale_commitment: "AB".repeat(32) }],
    ["sale commitment as bytes", { ...BASE, sale_commitment: new Uint8Array(32) }],
    ["sale commitment as a number", { ...BASE, sale_commitment: 1 }],
    ["an unknown key", { ...BASE, sale_commitment: sale, note: "x" }],
    ["an unknown key without a sale commitment", { ...BASE, note: "x" }],
    ["a price key without a sale commitment", { ...BASE, price_bits: 1 }],
    ["a malformed reserve", { ...BASE, sale_commitment: sale, reserve: { groups: 1, extra: 0 } }],
    ["a missing base key", withoutType],
  ];
  for (const [label, field] of rejected) {
    assert.equal((await collectionView(collection(field), cursor)).status, "absent", label);
  }
});

test("a rehearsal schema accepts the same optional keys", async () => {
  const sale = sha(SECRET).toString("hex");
  for (const field of [{ ...BASE, schema: "c/1" }, { ...BASE, schema: "c/1", sale_commitment: sale }]) {
    const rehearsal = new Indexer("regtest", { schema: "c/1" });
    rehearsal.inscriptions.set("g", item({ id: "g", contentType: "application/json", metadata: encodeCbor(field) }));
    assert.equal((await collectionView(rehearsal, cursor)).status, "present");
  }
});

test("a profile with no reserve groups configures no reserve", async () => {
  const profile = { name: "Example", namePrefix: "Item#", supply: 3, first: 1, itemType: "image/png", root: ROOT.toString("hex"), reserveGroups: [], reserveExtra: 0, reserveCount: 0 };
  assert.equal((await collectionView(collection(BASE), cursor, profile)).reserveMode, "none");
  const withGroups = { ...profile, reserveGroups: [{ trait_type: "a", value: "b", count: 1 }], reserveCount: 1 };
  const declared = { ...BASE, sale_commitment: sha(SECRET).toString("hex") };
  assert.equal((await collectionView(collection(declared), cursor, withGroups)).reserveMode, "configured");
  assert.equal((await collectionView(collection(declared), cursor)).reserveMode, "none");
});
