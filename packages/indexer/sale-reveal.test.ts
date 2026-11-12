// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { encodeCbor } from "../collection/canonical.mjs";
import { collectionView } from "./collection.ts";
import { Indexer, type Inscription } from "./pins.ts";

const ISSUER = "ab".repeat(32);
const OTHER = "ff".repeat(32);
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
const uint = (value: number) => head(0, value);

/** A map whose values are already encoded, in the order given. */
function map(...entries: [string, Buffer][]): Buffer {
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([key, value]) => [text(key), value])]);
}

const reveal = (over: { secret?: Buffer; root?: Buffer } = {}) =>
  map(["schema", text("pins-sale-reveal/1")], ["root", bytes(over.root ?? ROOT)], ["sale_secret", bytes(over.secret ?? SECRET)]);
const closing = (over: { root?: Buffer; count?: number } = {}) =>
  map(["schema", text("pins-close/1")], ["root", bytes(over.root ?? ROOT)], ["count", uint(over.count ?? 3)]);

/** A collection of three items whose genesis commits to SECRET. The genesis is at height 10, the items at 11. */
function collection(): Indexer {
  const indexer = new Indexer();
  indexer.inscriptions.set("g", item({
    id: "g",
    contentType: "application/json",
    metadata: encodeCbor({
      schema: "pins-collection/1",
      name: "Example",
      supply: 3,
      first: 1,
      name_prefix: "Item#",
      root: ROOT.toString("hex"),
      issuer: ISSUER,
      item_type: "image/png",
      sale_commitment: sha(SECRET).toString("hex"),
    }),
  }));
  indexer.inscriptions.set("list", item({ id: "list", n: 1, contentType: "application/octet-stream", body: Buffer.concat(LEAVES) }));
  addItems(indexer, [1, 2, 3], 11);
  return indexer;
}

function addItems(indexer: Indexer, numbers: number[], createdHeight: number, createdIndex = 0): void {
  for (const n of numbers) {
    indexer.inscriptions.set(`item${n}`, item({ id: `item${n}`, n, body: BODIES[n - 1], metadata: METAS[n - 1], createdHeight, createdIndex }));
  }
}

const add = (indexer: Indexer, id: string, metadata: Buffer, over: Partial<Inscription> = {}) =>
  indexer.inscriptions.set(id, item({ id, contentType: "text/plain", metadata, createdHeight: 12, ...over }));

const authentic = async (indexer: Indexer) => (await collectionView(indexer, cursor)).pieces?.filter((piece) => piece.authentic).map((piece) => piece.number);

test("without a closing inscription every item of the leaf list is authentic", async () => {
  const view = await collectionView(collection(), cursor);
  assert.equal(view.closingId, undefined);
  assert.deepEqual(view.pieces?.map((piece) => piece.authentic), [true, true, true]);
});

test("an item inscribed after the closing inscription is not authentic", async () => {
  const indexer = collection();
  addItems(indexer, [2, 3], 13);
  add(indexer, "close", closing());
  const view = await collectionView(indexer, cursor);
  assert.equal(view.closingId, "close");
  assert.deepEqual(view.pieces?.map((piece) => piece.authentic), [true, false, false]);
});

test("the closing inscription orders by block, transaction position, and envelope index", async () => {
  const indexer = collection();
  for (const n of [1, 2, 3]) indexer.inscriptions.delete(`item${n}`);
  addItems(indexer, [1], 12, 1);
  add(indexer, "close", closing(), { createdHeight: 12, createdIndex: 2 });
  addItems(indexer, [2], 12, 3);
  add(indexer, "later", closing(), { createdHeight: 12, createdIndex: 4 });
  assert.deepEqual(await authentic(indexer), [1]);
  assert.equal((await collectionView(indexer, cursor)).closingId, "close");
});

test("a closing inscription must match the genesis and be signed by the issuer", async () => {
  const bad: [string, Buffer, Partial<Inscription>][] = [
    ["other key", closing(), { leafIssuer: OTHER }],
    ["wrong root", closing({ root: Buffer.alloc(32, 1) }), {}],
    ["wrong count", closing({ count: 2 }), {}],
    ["another schema", map(["schema", text("pins-close/2")], ["root", bytes(ROOT)], ["count", uint(3)]), {}],
    ["root as text", map(["schema", text("pins-close/1")], ["root", text(ROOT.toString("hex"))], ["count", uint(3)]), {}],
    ["count as text", map(["schema", text("pins-close/1")], ["root", bytes(ROOT)], ["count", text("3")]), {}],
    ["extra key", map(["schema", text("pins-close/1")], ["root", bytes(ROOT)], ["count", uint(3)], ["sale_secret", bytes(SECRET)]), {}],
    ["keys out of order", map(["root", bytes(ROOT)], ["schema", text("pins-close/1")], ["count", uint(3)]), {}],
    ["short root", closing({ root: Buffer.alloc(31, 1) }), {}],
    ["reinscription", closing(), { flags: ["reinscription"] }],
    ["opaque", closing(), { flags: ["opaque"] }],
    ["before the genesis", closing(), { createdHeight: 9 }],
    ["not field 5 data", Buffer.from([0xf6]), {}],
  ];
  for (const [label, metadata, over] of bad) {
    const indexer = collection();
    add(indexer, "close", metadata, over);
    const view = await collectionView(indexer, cursor);
    assert.equal(view.closingId, undefined, label);
    assert.deepEqual(view.pieces?.map((piece) => piece.authentic), [true, true, true], label);
  }
});

test("a closing inscription in the transaction of the genesis closes the collection before any item", async () => {
  const indexer = collection();
  add(indexer, "close", closing(), { createdHeight: 10, n: 2 });
  assert.equal((await collectionView(indexer, cursor)).closingId, "close");
  assert.deepEqual(await authentic(indexer), []);
});

test("only a sale reveal signed by the issuer with the committed secret opens the sale order", async () => {
  const bad: [string, Buffer, Partial<Inscription>][] = [
    ["other key", reveal(), { leafIssuer: OTHER }],
    ["wrong secret", reveal({ secret: Buffer.alloc(32, 0x12) }), {}],
    ["wrong root", reveal({ root: Buffer.alloc(32, 1) }), {}],
    ["another schema", map(["schema", text("pins-sale-reveal/2")], ["root", bytes(ROOT)], ["sale_secret", bytes(SECRET)]), {}],
    ["secret as text", map(["schema", text("pins-sale-reveal/1")], ["root", bytes(ROOT)], ["sale_secret", text(SECRET.toString("hex"))]), {}],
    ["extra key", map(["schema", text("pins-sale-reveal/1")], ["root", bytes(ROOT)], ["sale_secret", bytes(SECRET)], ["note", text("x")]), {}],
    ["keys out of order", map(["schema", text("pins-sale-reveal/1")], ["sale_secret", bytes(SECRET)], ["root", bytes(ROOT)]), {}],
    ["reinscription", reveal(), { flags: ["reinscription"] }],
    ["opaque", reveal(), { flags: ["opaque"] }],
    ["before the genesis", reveal(), { createdHeight: 9 }],
  ];
  for (const [label, metadata, over] of bad) {
    const indexer = collection();
    add(indexer, "reveal", metadata, over);
    const view = await collectionView(indexer, cursor);
    assert.equal(view.seedRevealed, false, label);
    assert.equal(view.orderStatus, "pending", label);
  }
  const indexer = collection();
  add(indexer, "reveal", reveal());
  const view = await collectionView(indexer, cursor);
  assert.equal(view.seedRevealed, true);
  assert.equal(view.orderStatus, "ready");
  assert.deepEqual([...(view.order ?? [])].sort(), [1, 2, 3]);
});

test("the bare secret as an inscription body no longer reveals the sale order", async () => {
  const indexer = collection();
  indexer.inscriptions.set("raw", item({ id: "raw", contentType: "application/octet-stream", body: SECRET, createdHeight: 12 }));
  add(indexer, "early", reveal(), { createdHeight: 9 });
  const view = await collectionView(indexer, cursor);
  assert.equal(view.seedRevealed, false);
  assert.equal(view.orderStatus, "pending");
  assert.equal(view.orderPendingReason, "sale secret is not revealed");
});

test("the first valid sale reveal in chain order is the one used", async () => {
  const indexer = collection();
  add(indexer, "late", reveal(), { createdHeight: 14 });
  add(indexer, "bad", reveal({ secret: Buffer.alloc(32, 0x12) }), { createdHeight: 12 });
  add(indexer, "first", reveal(), { createdHeight: 13 });
  const view = await collectionView(indexer, cursor);
  assert.equal(view.seedRevealed, true);
  assert.equal(view.orderStatus, "ready");
});
