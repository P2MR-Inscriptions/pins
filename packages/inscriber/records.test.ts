// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { p2mrAddressFromPubkey } from "@qbit-oss/protocol";
import { encodeCbor } from "../collection/canonical.mjs";
import { collectionView } from "../indexer/collection.ts";
import { Indexer, bodyFacts, type Inscription } from "../indexer/pins.ts";
import { CLOSE_SCHEMA, SALE_REVEAL_SCHEMA, UNSOLD_ADDRESS_SCHEMA, parseRecord, recordBody, recordField, recordInscription, saleCommitmentOf, unsoldAddressScript } from "./records.ts";

const ROOT_HEX = "ab".repeat(32);
const SECRET = Buffer.alloc(32, 0x11);
const ADDRESS = p2mrAddressFromPubkey(Buffer.alloc(32, 7), "regtest");

test("the closing record is the CBOR map of the vectors, byte for byte", () => {
  const bytes = Buffer.from(recordField({ kind: "close", root: ROOT_HEX, count: 3 })).toString("hex");
  const expected = `a3${Buffer.from(encodeCbor("schema")).toString("hex")}${Buffer.from(encodeCbor(CLOSE_SCHEMA)).toString("hex")}`
    + `${Buffer.from(encodeCbor("root")).toString("hex")}5820${ROOT_HEX}${Buffer.from(encodeCbor("count")).toString("hex")}03`;
  assert.equal(bytes, expected);
  assert.equal(bytes, "a366736368656d616c70696e732d636c6f73652f31" + "64726f6f74" + `5820${ROOT_HEX}` + "65636f756e74" + "03");
});

test("the sale reveal and the unsold-address records have the keys of PINS-5 in order", () => {
  const reveal = Buffer.from(recordField({ kind: "sale-reveal", root: ROOT_HEX, saleSecret: SECRET })).toString("hex");
  assert.equal(reveal, `a3${Buffer.from(encodeCbor("schema")).toString("hex")}${Buffer.from(encodeCbor(SALE_REVEAL_SCHEMA)).toString("hex")}${Buffer.from(encodeCbor("root")).toString("hex")}5820${ROOT_HEX}${Buffer.from(encodeCbor("sale_secret")).toString("hex")}5820${SECRET.toString("hex")}`);
  const unsold = Buffer.from(recordField({ kind: "unsold-address", root: ROOT_HEX, address: ADDRESS, network: "regtest" })).toString("hex");
  assert.equal(unsold, `a3${Buffer.from(encodeCbor("schema")).toString("hex")}${Buffer.from(encodeCbor(UNSOLD_ADDRESS_SCHEMA)).toString("hex")}${Buffer.from(encodeCbor("root")).toString("hex")}5820${ROOT_HEX}${Buffer.from(encodeCbor("address")).toString("hex")}${Buffer.from(encodeCbor(ADDRESS)).toString("hex")}`);
});

test("a count above 23 is written in the shortest form, as the reader requires", () => {
  for (const count of [23, 24, 255, 256, 10_000, 65_535, 65_536, 4_294_967_296]) {
    const parsed = parseRecord(recordField({ kind: "close", root: ROOT_HEX, count }));
    assert.deepEqual(parsed, { kind: "close", root: ROOT_HEX, count });
  }
});

test("each record reads back and the body is its schema, never the secret", () => {
  const inputs = [
    { kind: "close", root: ROOT_HEX, count: 10_000 },
    { kind: "sale-reveal", root: ROOT_HEX, saleSecret: SECRET },
    { kind: "unsold-address", root: ROOT_HEX, address: ADDRESS, network: "regtest" },
  ] as const;
  for (const input of inputs) {
    const parsed = parseRecord(recordField(input));
    assert.equal(parsed?.kind, input.kind);
    const made = recordInscription(input);
    assert.equal(made.contentType, "text/plain");
    assert.notDeepEqual(Buffer.from(made.body), SECRET);
    assert.equal(Buffer.from(made.body).toString(), Buffer.from(recordBody(input.kind)).toString());
  }
  assert.equal(Buffer.from(recordBody("close")).toString(), CLOSE_SCHEMA);
});

test("the encoders refuse what the indexer would not read", () => {
  assert.throws(() => recordField({ kind: "close", root: ROOT_HEX.toUpperCase(), count: 3 }), /64 lowercase hex/);
  assert.throws(() => recordField({ kind: "close", root: "ab", count: 3 }), /64 lowercase hex/);
  assert.throws(() => recordField({ kind: "close", root: ROOT_HEX, count: 0 }), /positive whole number/);
  assert.throws(() => recordField({ kind: "close", root: ROOT_HEX, count: 1.5 }), /positive whole number/);
  assert.throws(() => recordField({ kind: "sale-reveal", root: ROOT_HEX, saleSecret: Buffer.alloc(31) }), /32 bytes/);
  assert.throws(() => recordField({ kind: "unsold-address", root: ROOT_HEX, address: ADDRESS.toUpperCase(), network: "regtest" }), /lowercase/);
  assert.throws(() => recordField({ kind: "unsold-address", root: ROOT_HEX, address: ADDRESS, network: "mainnet" }), /HRP/);
  assert.throws(() => recordField({ kind: "unsold-address", root: ROOT_HEX, address: "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080", network: "regtest" }), /bech32m/);
  assert.equal(Buffer.from(unsoldAddressScript(ADDRESS, "regtest")).toString("hex").slice(0, 4), "5220");
});

test("parseRecord refuses a map that is not exactly one record", () => {
  const text = (value: string) => Buffer.from(encodeCbor(value));
  const bytes = (value: Buffer) => Buffer.concat([Buffer.from([0x58, value.length]), value]);
  const root = Buffer.from(ROOT_HEX, "hex");
  const close = (parts: Buffer[]) => Buffer.concat([Buffer.from([0xa0 + parts.length / 2]), ...parts]);
  const good = [text("schema"), text(CLOSE_SCHEMA), text("root"), bytes(root), text("count"), Buffer.from([3])];
  assert.deepEqual(parseRecord(close(good)), { kind: "close", root: ROOT_HEX, count: 3 });
  // Keys in another order.
  assert.equal(parseRecord(close([good[2], good[3], good[0], good[1], good[4], good[5]])), null);
  // The root as text, a short root, a wrong schema, a fourth key, a count of 0.
  assert.equal(parseRecord(close([good[0], good[1], good[2], text(ROOT_HEX), good[4], good[5]])), null);
  assert.equal(parseRecord(close([good[0], good[1], good[2], bytes(root.subarray(0, 31)), good[4], good[5]])), null);
  assert.equal(parseRecord(close([good[0], text("pins-close/2"), ...good.slice(2)])), null);
  assert.equal(parseRecord(close([...good, text("extra"), Buffer.from([1])])), null);
  assert.equal(parseRecord(close([...good.slice(0, 5), Buffer.from([0])])), null);
  assert.equal(parseRecord(Buffer.from([0xff])), null);
  assert.equal(saleCommitmentOf(SECRET), createHash("sha256").update(SECRET).digest("hex"));
});

// What the reference indexer reads. Three items, a genesis that commits to SECRET, and records made by the writers above.
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest();
const BODIES = [1, 2, 3].map((n) => Buffer.from([n]));
const METAS = [1, 2, 3].map((n) => Buffer.from(encodeCbor({ meta: { name: `Item#${n}`, attributes: [] } })));
const LEAVES = [1, 2, 3].map((n) => {
  const number = Buffer.alloc(4);
  number.writeUInt32BE(n);
  return sha(Buffer.concat([number, sha(BODIES[n - 1]), sha(METAS[n - 1])]));
});
const ROOT = sha(Buffer.concat([sha(Buffer.concat([LEAVES[0], LEAVES[1]])), sha(Buffer.concat([LEAVES[2], LEAVES[2]]))])).toString("hex");
const ISSUER = "ab".repeat(32);

function row(partial: Partial<Inscription> & { id: string }): Inscription {
  return {
    txid: "11".repeat(32), n: 0, number: 0, location: { state: "unbound" }, flags: [], contentType: "image/png",
    ...bodyFacts(partial.body ?? new Uint8Array()), metadata: null, fields: [], createdHeight: 10, createdIndex: 0, locationHeight: 10,
    leafIssuer: ISSUER, ownerScript: "", ownerAddress: "", ...partial,
  };
}

function launched(): Indexer {
  const indexer = new Indexer();
  indexer.inscriptions.set("g", row({
    id: "g", contentType: "application/json",
    metadata: encodeCbor({ schema: "pins-collection/1", name: "Example", supply: 3, first: 1, name_prefix: "Item#", root: ROOT, issuer: ISSUER, item_type: "image/png", sale_commitment: sha(SECRET).toString("hex") }),
  }));
  indexer.inscriptions.set("list", row({ id: "list", n: 1, contentType: "application/octet-stream", body: Buffer.concat(LEAVES) }));
  for (const n of [1, 2, 3]) indexer.inscriptions.set(`item${n}`, row({ id: `item${n}`, n, body: BODIES[n - 1], metadata: METAS[n - 1], createdHeight: 11 }));
  return indexer;
}

const cursor = { tipHeight: 100, blockHash: () => "22".repeat(32) };

test("the reference indexer reads the sale reveal and the closing the writers make", async () => {
  const indexer = launched();
  const reveal = recordInscription({ kind: "sale-reveal", root: ROOT, saleSecret: SECRET });
  const closing = recordInscription({ kind: "close", root: ROOT, count: 3 });
  indexer.inscriptions.set("reveal", row({ id: "reveal", contentType: reveal.contentType, ...bodyFacts(reveal.body), metadata: reveal.metadata ?? null, createdHeight: 12 }));
  indexer.inscriptions.set("close", row({ id: "close", contentType: closing.contentType, ...bodyFacts(closing.body), metadata: closing.metadata ?? null, createdHeight: 13 }));
  const view = await collectionView(indexer, cursor);
  assert.equal(view.closingId, "close");
  assert.notEqual(view.orderStatus, "pending", "the sale reveal was not recognised");
  assert.equal(view.pieces?.filter((piece) => piece.authentic).length, 3);
});

test("the indexer does not read a closing with a count other than the supply, or a reveal of another secret", async () => {
  const indexer = launched();
  const wrongCount = recordInscription({ kind: "close", root: ROOT, count: 4 });
  const wrongSecret = recordInscription({ kind: "sale-reveal", root: ROOT, saleSecret: Buffer.alloc(32, 0x22) });
  indexer.inscriptions.set("close", row({ id: "close", contentType: "text/plain", ...bodyFacts(wrongCount.body), metadata: wrongCount.metadata ?? null, createdHeight: 12 }));
  indexer.inscriptions.set("reveal", row({ id: "reveal", contentType: "text/plain", ...bodyFacts(wrongSecret.body), metadata: wrongSecret.metadata ?? null, createdHeight: 12 }));
  const view = await collectionView(indexer, cursor);
  assert.equal(view.closingId, undefined);
  assert.equal(view.orderStatus, "pending");
});
