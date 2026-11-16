// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { contentTypeBytes, Indexer, bodyFacts, type Inscription } from "./pins.ts";
import { escapedContentType, inscriptionLine, stateHash } from "./hash.ts";

/** The PINS-2 §4.4 preimage, encoded the way the previous implementation did, with no line cache. */
function escapedNaive(item: Inscription): Buffer {
  const out: number[] = [];
  for (const byte of contentTypeBytes(item)) {
    if (byte === 0x0a) out.push(0x25, 0x30, 0x61);
    else if (byte === 0x25) out.push(0x25, 0x32, 0x35);
    else out.push(byte);
  }
  return Buffer.from(out);
}

function stateHashNaive(indexer: Indexer, block: { height: number; hash: string }): string {
  const hash = createHash("sha256");
  const items = [...indexer.inscriptions.values()].sort((a, b) => a.number - b.number);
  hash.update(`block ${block.height} ${block.hash}`);
  for (const item of items) {
    const place = item.location.state === "located"
      ? `${item.location.txid}:${item.location.vout}:${item.location.offset}`
      : item.location.state;
    const flags = [...item.flags].sort().join(",");
    hash.update("\n");
    hash.update(Buffer.concat([
      Buffer.from(`${item.number} ${item.id} ${item.bodySha256} `),
      escapedNaive(item),
      Buffer.from(` ${place} ${item.ownerAddress} ${item.locationHeight} ${flags}`),
    ]));
  }
  return hash.digest("hex");
}

function item(partial: Partial<Inscription> & { id: string; number: number }): Inscription {
  return {
    txid: "11".repeat(32),
    n: 0,
    location: { state: "unbound" },
    flags: [],
    contentType: "text/plain",
    ...bodyFacts(partial.body ?? new Uint8Array([1])),
    metadata: null,
    fields: [],
    createdHeight: 10,
    createdIndex: 0,
    locationHeight: 10,
    leafIssuer: "",
    ownerScript: "",
    ownerAddress: "addr",
    ...partial,
  };
}

function same(indexer: Indexer, block: { height: number; hash: string }, label: string): string {
  const got = stateHash(indexer, block);
  assert.equal(got, stateHashNaive(indexer, block), label);
  return got;
}

const blockA = { height: 100, hash: "aa".repeat(32) };
const blockB = { height: 101, hash: "bb".repeat(32) };

test("state hash of an empty indexer is the hash of the block line alone", () => {
  const indexer = new Indexer("mainnet");
  const digest = same(indexer, blockA, "empty");
  assert.equal(digest, createHash("sha256").update(`block ${blockA.height} ${blockA.hash}`).digest("hex"));
  assert.equal(stateHash(indexer, blockA), digest);
});

test("escaped content type writes LF and percent the way PINS-2 requires", () => {
  const raw = item({ id: "x", number: 0, fields: [{ tag: 1, value: Buffer.from("a\nb%c").toString("hex") }], contentType: "a\nb%c" });
  assert.deepEqual(Buffer.from(escapedContentType(raw)), Buffer.from("a%0ab%25c"));
  assert.deepEqual(Buffer.from(escapedContentType(raw)), escapedNaive(raw));
});

test("cached state hash stays bit-identical to the PINS-2 preimage after creates, moves, flag changes, and removals", () => {
  const indexer = new Indexer("regtest");
  const first = item({
    id: "aa".repeat(32) + "i0",
    number: 0,
    bodySha256: "11".repeat(32),
    location: { state: "located", txid: "cc".repeat(32), vout: 1, offset: 0n, script: new Uint8Array() },
    ownerAddress: "owner-a",
    locationHeight: 100,
    flags: ["reinscription", "bad_pointer"],
    fields: [{ tag: 1, value: Buffer.from("text/plain").toString("hex") }],
    contentType: "text/plain",
  });
  const second = item({
    id: "dd".repeat(32) + "i0",
    number: 2,
    bodySha256: "22".repeat(32),
    location: { state: "unbound" },
    ownerAddress: "owner-b",
    locationHeight: 100,
    flags: [],
    fields: [{ tag: 1, value: Buffer.from("image/png\n%").toString("hex") }],
    contentType: "image/png\n%",
  });
  indexer.inscriptions.set(first.id, first);
  indexer.inscriptions.set(second.id, second);

  const before = same(indexer, blockA, "initial, with a hole at number 1");
  assert.equal(stateHash(indexer, blockA), before, "unchanged fields reuse the cached lines");

  const line = inscriptionLine(first).toString("utf8");
  assert.equal(line, `0 ${first.id} ${first.bodySha256} text/plain ${"cc".repeat(32)}:1:0 owner-a 100 bad_pointer,reinscription`);

  first.location = { state: "located", txid: "ee".repeat(32), vout: 0, offset: 40n, script: new Uint8Array() };
  first.ownerAddress = "owner-a2";
  first.locationHeight = 101;
  const moved = same(indexer, blockB, "after a transfer");
  assert.notEqual(moved, stateHashNaive(indexer, blockA));
  assert.notEqual(moved, before);

  first.flags.push("fee:10");
  same(indexer, blockB, "after an in-place flag push");

  const third = item({
    id: "ff".repeat(32) + "i0",
    number: 1,
    bodySha256: "33".repeat(32),
    location: { state: "burned" },
    ownerAddress: "",
    locationHeight: 101,
    flags: [],
    contentType: "",
    fields: [],
  });
  indexer.inscriptions.set(third.id, third);
  same(indexer, blockB, "after filling the hole at number 1");

  indexer.inscriptions.delete(second.id);
  same(indexer, blockB, "after removing an inscription");

  first.number = 7;
  same(indexer, blockB, "after a number change");
});
