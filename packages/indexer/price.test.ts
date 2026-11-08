// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encodeCbor } from "../collection/canonical.mjs";
import { encodePriceField, PRICE_BODY } from "../inscriber/preflight.ts";
import { priceBody, priceSchemaFor } from "../inscriber/price.ts";
import { startApi } from "./api.ts";
import { collectionView, firstValidPrice } from "./collection.ts";
import { Indexer, type Inscription } from "./pins.ts";
import { Store } from "./store.ts";

const ISSUER = "ab".repeat(32);
const GENESIS = `${"cd".repeat(32)}i0`;
const PRICE = { price_bits: 12_345_678, price_sources: ["Desk A 8.10 USD"], price_time: "2026-11-04T18:00:00Z" };

function item(partial: {
  id: string;
  metadata: Uint8Array | null;
  leafIssuer?: string;
  createdHeight?: number;
  createdIndex?: number;
  n?: number;
  flags?: string[];
  contentType?: string;
  body?: Uint8Array;
}): Inscription {
  return {
    id: partial.id,
    txid: "11".repeat(32),
    n: partial.n ?? 0,
    number: 0,
    location: { state: "unbound" },
    flags: partial.flags ?? [],
    contentType: partial.contentType ?? "text/plain",
    body: partial.body ?? PRICE_BODY,
    bodySha256: "",
    metadata: partial.metadata,
    fields: [],
    createdHeight: partial.createdHeight ?? 10,
    createdIndex: partial.createdIndex ?? 0,
    locationHeight: 10,
    leafIssuer: partial.leafIssuer ?? ISSUER,
    ownerScript: "",
    ownerAddress: "",
  };
}

function genesisField(extra: Record<string, unknown> = {}): Uint8Array {
  return encodeCbor({
    schema: "pins-collection/1",
    name: "Example",
    supply: 1,
    first: 1,
    name_prefix: "Item#",
    root: "ab".repeat(32),
    issuer: ISSUER,
    item_type: "image/png",
    sale_commitment: "cd".repeat(32),
    ...extra,
  });
}

test("the first valid price inscription wins and a genesis needs no price", async () => {
  const first = await encodePriceField({ genesis: GENESIS, price: PRICE });
  const later = await encodePriceField({
    genesis: GENESIS,
    price: { price_bits: 99, price_sources: ["Other 1.00 USD"], price_time: "2026-11-05T00:00:00Z" },
  });
  const otherGenesis = await encodePriceField({ genesis: `${"ee".repeat(32)}i0`, price: PRICE });
  const winner = firstValidPrice([
    item({ id: "late", metadata: later, createdHeight: 12 }),
    item({ id: "stranger", metadata: first, leafIssuer: "ff".repeat(32), createdHeight: 9 }),
    item({ id: "wrong-genesis", metadata: otherGenesis, createdHeight: 8 }),
    item({ id: "first", metadata: first, createdHeight: 11 }),
    item({ id: "bad-body", metadata: first, createdHeight: 7, body: new TextEncoder().encode("nope\n") }),
    item({ id: "empty", metadata: null, createdHeight: 1 }),
  ], GENESIS, ISSUER);
  assert.equal(winner?.id, "first");
  assert.equal(winner?.price.price_bits, PRICE.price_bits);
  assert.equal(firstValidPrice([item({ id: "none", metadata: null })], GENESIS, ISSUER), null);
});

test("a genesis without a price is valid and one that carries a price is not", async () => {
  const cursor = { tipHeight: 20, blockHash: () => null };
  const clean = new Indexer();
  clean.inscriptions.set("g", item({
    id: "g",
    metadata: genesisField(),
    contentType: "application/json",
    body: new TextEncoder().encode(JSON.stringify({ name: "Shadow", supply: 9, issuer: "ff".repeat(32), root: "00".repeat(32) })),
    createdHeight: 4,
    leafIssuer: ISSUER,
  }));
  const pending = await collectionView(clean, cursor);
  assert.equal(pending.status, "present");
  assert.equal(pending.name, "Example");
  assert.equal(pending.priceStatus, "pending");
  assert.equal(pending.priceBits, undefined);

  const priced = new Indexer();
  priced.inscriptions.set("g", item({
    id: "g",
    metadata: genesisField({ price_bits: 1 }),
    contentType: "application/json",
    body: new TextEncoder().encode("{}"),
    createdHeight: 4,
  }));
  assert.equal((await collectionView(priced, cursor)).status, "absent");

  const early = await encodePriceField({ genesis: "g", price: PRICE });
  clean.inscriptions.set("early", item({ id: "early", metadata: early, createdHeight: 3 }));
  clean.inscriptions.set("kept", item({ id: "kept", metadata: await encodePriceField({ genesis: "g", price: PRICE }), createdHeight: 9 }));
  const ready = await collectionView(clean, cursor);
  assert.equal(ready.priceStatus, "ready");
  assert.equal(ready.priceId, "kept");
  assert.equal(ready.priceBits, PRICE.price_bits);
});

test("a rehearsal schema recognizes the derived price text and ignores the launch text", async () => {
  assert.equal(priceSchemaFor("c/1"), "p/1");
  assert.equal(priceSchemaFor("pins-collection/1"), "pins-price/1");
  const masked = await encodePriceField({ genesis: "g", price: PRICE, schema: "p/1" });
  const launch = await encodePriceField({ genesis: "g", price: PRICE });
  const indexer = new Indexer("regtest", { schema: "c/1" });
  const winner = firstValidPrice([
    item({ id: "launch", metadata: launch, createdHeight: 2, body: PRICE_BODY }),
    item({ id: "masked", metadata: masked, createdHeight: 4, body: priceBody("p/1") }),
    item({ id: "later", metadata: await encodePriceField({
      genesis: "g",
      price: { price_bits: 1, price_sources: ["Later 1.00 USD"], price_time: "2026-11-05T00:00:00Z" },
      schema: "p/1",
    }), createdHeight: 6, body: priceBody("p/1") }),
    item({ id: "stranger", metadata: masked, createdHeight: 3, body: priceBody("p/1"), leafIssuer: "ff".repeat(32) }),
  ], "g", ISSUER, indexer.priceSchema);
  assert.equal(winner?.id, "masked");
  assert.equal(winner?.price.price_bits, PRICE.price_bits);
});

test("a quota shortfall stays on the collection view instead of failing the request", async () => {
  const seed = Buffer.alloc(32, 3);
  const indexer = new Indexer();
  indexer.inscriptions.set("g", item({
    id: "g",
    metadata: encodeCbor({
      schema: "pins-collection/1",
      name: "Set",
      supply: 4,
      first: 1,
      name_prefix: "#",
      root: "ab".repeat(32),
      issuer: ISSUER,
      item_type: "image/png",
      sale_commitment: createHash("sha256").update(seed).digest("hex"),
      reserve: { groups: [{ trait_type: "a", value: "0", count: 4 }], extra: 4 },
    }),
    contentType: "application/json",
    body: new TextEncoder().encode("{\"name\":\"Shadow\"}"),
    createdHeight: 4,
  }));
  indexer.inscriptions.set("seed", item({
    id: "seed",
    metadata: null,
    contentType: "application/octet-stream",
    body: new Uint8Array(seed),
    createdHeight: 5,
  }));
  const view = await collectionView(indexer, { tipHeight: 20, blockHash: () => null });
  assert.equal(view.status, "present");
  assert.equal(view.reserveVerified, false);
  assert.match(view.reserveReason ?? "", /Quota a=0 needs 4, found 0/);
  assert.equal(view.orderStatus, "failed");
  assert.equal(view.orderPendingReason, view.reserveReason);
  assert.equal(view.name, "Set");
  const dir = mkdtempSync(join(tmpdir(), "price-quota-"));
  const store = new Store(join(dir, "a.sqlite"));
  store.indexer.inscriptions.set("g", indexer.inscriptions.get("g")!);
  store.indexer.inscriptions.set("seed", indexer.inscriptions.get("seed")!);
  const api = await startApi(store, 0);
  try {
    const response = await fetch(`${api.url}/collection`);
    assert.equal(response.status, 200);
    const body = await response.json() as { error?: string; reserveVerified: boolean; reserveReason: string; orderStatus: string; name: string };
    assert.equal(body.error, undefined);
    assert.equal(body.reserveVerified, false);
    assert.match(body.reserveReason, /Quota a=0 needs 4, found 0/);
    assert.equal(body.orderStatus, "failed");
    assert.equal(body.name, "Set");
  } finally {
    await api.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
