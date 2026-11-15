// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { createP2mrPsbt, p2mrAddressFromPubkey, parsePsbt, psbtUnsignedTransaction, serializePsbt } from "@qbit-oss/protocol";
import { encodeCbor } from "../collection/canonical.mjs";
import { recordField, unsoldAddressScript } from "../inscriber/records.ts";
import { DUST_BITS, fifoLanding } from "./checks.ts";
import { coin } from "./psbt.ts";
import {
  UNSOLD_MAX_ITEMS,
  checkUnsoldTransfer,
  keyCoin,
  unsoldChunks,
  unsoldCommitmentOf,
  unsoldTransferFee,
  unsoldTransferPsbt,
  unsoldTransferWeight,
  verifyUnsoldTransferPsbt,
  type IndexerRow,
  type UnsoldCollection,
} from "./unsold.ts";

const SALE_KEY = Buffer.alloc(32, 5);
const FEE_KEY = Buffer.alloc(32, 6);
const unsoldScript = unsoldAddressScript(p2mrAddressFromPubkey(Buffer.alloc(32, 7), "regtest"), "regtest");
const changeScript = unsoldAddressScript(p2mrAddressFromPubkey(Buffer.alloc(32, 8), "regtest"), "regtest");
const txid = (n: number): string => n.toString(16).padStart(2, "0").repeat(32);
const items = (count: number, value = 10_000n) => Array.from({ length: count }, (_, index) => keyCoin(txid(index + 1), index % 3, value, SALE_KEY));
const funding = (value = 1_000_000n) => keyCoin(txid(200), 1, value, FEE_KEY);

test("a transfer pays the unsold address the value of each item and the change last", () => {
  const sale = items(5);
  const fee = unsoldTransferFee(5, 1);
  const psbt = unsoldTransferPsbt({ items: sale, funding: funding(), unsoldScript, changeScript, fee });
  const tx = psbtUnsignedTransaction(psbt);
  assert.equal(tx.inputs.length, 6);
  assert.equal(tx.outputs.length, 6);
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(tx.outputs[i].scriptPubKey, unsoldScript);
    assert.equal(tx.outputs[i].value, 10_000n);
  }
  assert.deepEqual(tx.outputs[5].scriptPubKey, changeScript);
  assert.equal(tx.outputs[5].value, 1_000_000n - fee);
  assert.deepEqual(verifyUnsoldTransferPsbt(serializePsbt(psbt), { unsoldScript, items: 5 }), []);
});

test("by first in, first out, bit 0 and every offset of each item lands in its own unsold output", () => {
  const sale = [...items(4), keyCoin(txid(77), 0, 25_000n, SALE_KEY)];
  const psbt = unsoldTransferPsbt({ items: sale, funding: funding(), unsoldScript, changeScript, fee: unsoldTransferFee(5, 1) });
  const tx = psbtUnsignedTransaction(psbt);
  const values = [...sale.map((entry) => entry.value), funding().value];
  let start = 0n;
  sale.forEach((entry, index) => {
    for (const offset of [0n, 1n, entry.value / 2n, entry.value - 1n]) {
      assert.deepEqual(fifoLanding(values, tx.outputs, start + offset), { kind: "output", output: index, offset });
    }
    start += entry.value;
  });
  // The first bit of the fee coin is not in an item output.
  const landing = fifoLanding(values, tx.outputs, start);
  assert.equal(landing.kind === "output" && landing.output, tx.outputs.length - 1);
});

test("a transfer is refused when it breaks a number or a shape", () => {
  const base = { items: items(3), funding: funding(), unsoldScript, changeScript, fee: 1_000n };
  const codes = (over: Partial<typeof base>): string[] => checkUnsoldTransfer({ ...base, ...over }).map((entry) => entry.code);
  assert.deepEqual(codes({}), []);
  assert.ok(codes({ items: [] }).includes("no-items"));
  assert.ok(codes({ items: items(UNSOLD_MAX_ITEMS + 1) }).includes("too-many-items"));
  assert.ok(codes({ changeScript: unsoldScript }).includes("change-is-unsold"));
  assert.ok(codes({ funding: keyCoin(txid(9), 0, 50_000n, SALE_KEY), unsoldScript: keyCoin(txid(9), 0, 1n, SALE_KEY).scriptPubKey }).includes("funding-is-unsold"));
  assert.ok(codes({ items: [...items(2), items(1)[0]] }).includes("duplicate-input"));
  assert.ok(codes({ items: [keyCoin(txid(1), 0, DUST_BITS - 1n, SALE_KEY)] }).includes("dust"));
  assert.ok(codes({ funding: funding(2_000n) }).includes("dust"), "a change below dust");
  assert.ok(codes({ fee: -1n }).includes("fee"));
  assert.ok(codes({ unsoldScript: new Uint8Array(34) }).includes("unsold-script"));
  assert.ok(codes({ items: [keyCoin(txid(1), 0, 10_000n, SALE_KEY)], unsoldScript: keyCoin(txid(1), 0, 10_000n, SALE_KEY).scriptPubKey }).includes("already-unsold"));
  assert.throws(() => unsoldTransferPsbt({ ...base, items: [] }), /at least one sale item/);
});

test("the verifier names a PSBT that would not move every item to the unsold address", () => {
  const sale = items(2);
  const good = unsoldTransferPsbt({ items: sale, funding: funding(), unsoldScript, changeScript, fee: 1_000n });
  const inputs = [...sale, funding()].map(coin);
  const rebuilt = (outputs: { value: bigint; scriptPubKey: Uint8Array }[], list = inputs) => serializePsbt(createP2mrPsbt({ version: 2, locktime: 0, inputs: list, outputs }));
  const check = (bytes: Uint8Array, count = 2) => verifyUnsoldTransferPsbt(bytes, { unsoldScript, items: count }).map((entry) => entry.code);
  assert.deepEqual(check(serializePsbt(good)), []);
  assert.deepEqual(check(rebuilt([{ value: 10_000n, scriptPubKey: unsoldScript }, { value: 10_000n, scriptPubKey: unsoldScript }, { value: 900_000n, scriptPubKey: changeScript }])), []);
  assert.ok(check(rebuilt([{ value: 10_000n, scriptPubKey: unsoldScript }, { value: 10_000n, scriptPubKey: changeScript }, { value: 900_000n, scriptPubKey: changeScript }])).includes("item-output"));
  assert.ok(check(rebuilt([{ value: 9_000n, scriptPubKey: unsoldScript }, { value: 11_000n, scriptPubKey: unsoldScript }, { value: 900_000n, scriptPubKey: changeScript }])).includes("item-value"));
  assert.ok(check(rebuilt([{ value: 10_000n, scriptPubKey: unsoldScript }, { value: 10_000n, scriptPubKey: unsoldScript }, { value: 900_000n, scriptPubKey: unsoldScript }])).includes("change-is-unsold"));
  assert.ok(check(rebuilt([{ value: 10_000n, scriptPubKey: unsoldScript }, { value: 10_000n, scriptPubKey: unsoldScript }, { value: 9_000_000n, scriptPubKey: changeScript }])).includes("fee"));
  assert.ok(check(rebuilt([{ value: 10_000n, scriptPubKey: unsoldScript }, { value: 10_000n, scriptPubKey: unsoldScript }]), 2).includes("outputs"));
  assert.ok(check(serializePsbt(good), 3).includes("inputs"));
  assert.ok(check(Uint8Array.of(1, 2, 3)).includes("unreadable"));
  assert.equal(parsePsbt(serializePsbt(good)).inputs.length, 3);
});

test("a transfer fits one standard transaction and larger sets are split in order", () => {
  assert.ok(unsoldTransferWeight(UNSOLD_MAX_ITEMS) <= 400_000);
  assert.ok(unsoldTransferWeight(UNSOLD_MAX_ITEMS + 1) > 400_000);
  assert.equal(UNSOLD_MAX_ITEMS, 104);
  // The size of a transfer of 4 items, signed and serialized by Qbit Core v1.0.1 on regtest (the live proof of the close-sale tools).
  assert.equal(unsoldTransferWeight(4), 19_037);
  assert.equal(unsoldTransferWeight(3), 15_232);
  const rows = Array.from({ length: 250 }, (_, index) => index);
  const chunks = unsoldChunks(rows, 100 > UNSOLD_MAX_ITEMS ? UNSOLD_MAX_ITEMS : 100);
  assert.equal(chunks.flat().length, 250);
  assert.deepEqual(chunks.flat(), rows);
  assert.ok(chunks.every((chunk) => chunk.length <= UNSOLD_MAX_ITEMS));
  assert.throws(() => unsoldChunks(rows, 0), /per transaction/);
  assert.throws(() => unsoldChunks(rows, UNSOLD_MAX_ITEMS + 1), /per transaction/);
  assert.equal(unsoldTransferFee(10, 2), BigInt(unsoldTransferWeight(10) * 2));
  assert.equal(unsoldTransferFee(4, 1), 19_037n);
  assert.throws(() => unsoldTransferFee(10, 0), /positive/);
});

test("keyCoin takes its script from the key and refuses malformed input", () => {
  const entry = keyCoin(txid(3), 2, 10_000n, SALE_KEY);
  assert.equal(entry.scriptPubKey.length, 34);
  assert.equal(Buffer.from(entry.txid).reverse().toString("hex"), txid(3));
  assert.throws(() => keyCoin("zz", 0, 1n, SALE_KEY), /64 lowercase hex/);
  assert.throws(() => keyCoin(txid(3), -1, 1n, SALE_KEY), /whole number/);
  assert.throws(() => keyCoin(txid(3), 0, 1n, Buffer.alloc(31)), /32 bytes/);
});

// The commitment reader, on the rows of an indexer.
const ROOT = "ab".repeat(32);
const ISSUER = "cd".repeat(32);
const SECRET = Buffer.alloc(32, 0x11);
const collection: UnsoldCollection = { genesis: "g", root: ROOT, issuer: ISSUER, saleCommitment: "", network: "regtest" };
const ADDRESS_A = p2mrAddressFromPubkey(Buffer.alloc(32, 1), "regtest");
const ADDRESS_B = p2mrAddressFromPubkey(Buffer.alloc(32, 2), "regtest");

function row(id: string, height: number, field: Uint8Array | null, over: Partial<IndexerRow> = {}): IndexerRow {
  return {
    id, txid: id, n: 0, createdHeight: height, createdIndex: 0, leafIssuer: ISSUER, flags: [],
    fields: field ? [{ tag: 5, value: Buffer.from(field).toString("hex") }] : [], ...over,
  };
}
const commit = (address: string, root = ROOT) => recordField({ kind: "unsold-address", root, address, network: "regtest" });
const reveal = recordField({ kind: "sale-reveal", root: ROOT, saleSecret: SECRET });

test("the commitment reader takes the first valid commitment after the genesis and before the sale reveal", async () => {
  const { createHash } = await import("node:crypto");
  const target: UnsoldCollection = { ...collection, saleCommitment: createHash("sha256").update(SECRET).digest("hex") };
  const genesis = row("g", 10, null);
  const read = (rows: IndexerRow[]) => unsoldCommitmentOf([genesis, ...rows], target)?.id ?? null;
  assert.equal(read([]), null);
  assert.equal(read([row("a", 11, commit(ADDRESS_A))]), "a");
  // The first counts; a later one is ignored, whatever its address.
  assert.equal(read([row("b", 12, commit(ADDRESS_B)), row("a", 11, commit(ADDRESS_A))]), "a");
  assert.equal(unsoldCommitmentOf([genesis, row("a", 11, commit(ADDRESS_A)), row("b", 12, commit(ADDRESS_B))], target)?.address, ADDRESS_A);
  // Chain order is height, then index in the block, then position in the transaction.
  assert.equal(read([row("late", 11, commit(ADDRESS_B), { createdIndex: 2 }), row("early", 11, commit(ADDRESS_A), { createdIndex: 1 })]), "early");
  assert.equal(read([row("two", 11, commit(ADDRESS_B), { n: 1 }), row("one", 11, commit(ADDRESS_A), { n: 0 })]), "one");
  // Invalid ones are skipped: another root, another key, a flag, a wrong network, the wrong schema map, before the genesis.
  assert.equal(read([row("x", 11, commit(ADDRESS_A, "ee".repeat(32))), row("a", 12, commit(ADDRESS_B))]), "a");
  assert.equal(read([row("x", 11, commit(ADDRESS_A), { leafIssuer: "00".repeat(32) }), row("a", 12, commit(ADDRESS_B))]), "a");
  assert.equal(read([row("x", 11, commit(ADDRESS_A), { flags: ["reinscription"] }), row("a", 12, commit(ADDRESS_B))]), "a");
  assert.equal(read([row("x", 11, commit(ADDRESS_A), { flags: ["opaque"] }), row("a", 12, commit(ADDRESS_B))]), "a");
  assert.equal(read([row("x", 9, commit(ADDRESS_A)), row("a", 12, commit(ADDRESS_B))]), "a");
  assert.equal(read([row("x", 11, Buffer.from(encodeCbor({ schema: "pins-unsold-address/1", root: ROOT, address: ADDRESS_A }))), row("a", 12, commit(ADDRESS_B))]), "a", "a root that is text is not a commitment");
  const mainnet = recordField({ kind: "unsold-address", root: ROOT, address: p2mrAddressFromPubkey(Buffer.alloc(32, 1), "mainnet"), network: "mainnet" });
  assert.equal(read([row("x", 11, mainnet), row("a", 12, commit(ADDRESS_B))]), "a");
  // A commitment confirmed after the sale reveal, in chain order, is not before the close.
  assert.equal(read([row("r", 12, reveal), row("late", 13, commit(ADDRESS_A))]), null);
  assert.equal(read([row("a", 11, commit(ADDRESS_A)), row("r", 12, reveal), row("late", 13, commit(ADDRESS_B))]), "a");
  assert.equal(read([row("r", 12, reveal, { createdIndex: 3 }), row("same", 12, commit(ADDRESS_A), { createdIndex: 4 })]), null);
  assert.equal(read([row("same", 12, commit(ADDRESS_A), { createdIndex: 2 }), row("r", 12, reveal, { createdIndex: 3 })]), "same");
  // A reveal of another secret is not the close, so a commitment after it still counts.
  const other = recordField({ kind: "sale-reveal", root: ROOT, saleSecret: Buffer.alloc(32, 0x22) });
  assert.equal(read([row("r", 12, other), row("a", 13, commit(ADDRESS_A))]), "a");
  assert.throws(() => unsoldCommitmentOf([], target), /genesis g is not among the rows/);
});
