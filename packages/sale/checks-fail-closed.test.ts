// SPDX-License-Identifier: Apache-2.0

/**
 * The buyer check fails closed (`complete`, `allowNotChecked`), compares the inputs with a node (`utxoAt`), reads the
 * sighash type from the signature (the real TV6-1 trade), and checks each script against the output it spends.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  P2MR_LEAF_VERSION_V1,
  PSBT_IN_FINAL_SCRIPTWITNESS,
  PSBT_IN_SIGHASH_TYPE,
  addressToScriptPubKey,
  buildControlBlock,
  createP2mrPsbt,
  decodePsbt,
  encodeP2mrPsbtScriptSigField,
  hexToBytes,
  p2mrAddressFromPubkey,
  p2mrBranchHash,
  p2mrLeafHash,
  p2mrScriptPubKey,
  singleKeyLeafScript,
  type Psbt,
} from "@qbit-oss/protocol";
import {
  PurchaseCheckError,
  SELLER_SIGHASH_TYPE,
  assertPurchasePsbt,
  bitsOf,
  checkPurchasePsbt,
  sighashTypeOfSignature,
  utxoFromGetTxOut,
  type PurchaseOptions,
} from "./checks.ts";
import { primarySalePsbt, type PrimarySale, type SaleCoin } from "./psbt.ts";

const script = (byte: number) => addressToScriptPubKey(p2mrAddressFromPubkey(new Uint8Array(32).fill(byte), "regtest"), "regtest");
const walletScript = script(4);
const sellerScript = script(5);

function coin(value: bigint, byte: number): SaleCoin {
  const leafScript = singleKeyLeafScript(new Uint8Array(32).fill(byte));
  return {
    txid: new Uint8Array(32).fill(byte),
    vout: 0,
    value,
    scriptPubKey: p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)),
    leafScript,
    controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
  };
}

function sale(change: Partial<PrimarySale> = {}): PrimarySale {
  return {
    paddingA: coin(20_000n, 1),
    paddingB: coin(20_000n, 2),
    inscribed: coin(10_000n, 3),
    funding: coin(200_000n, 4),
    receiveScript: walletScript,
    paddingReturnScript: walletScript,
    sellerScript,
    changeScript: walletScript,
    price: 50_000n,
    postage: 10_000n,
    changeValue: 150_000n,
    ...change,
  };
}

const display = (txid: Uint8Array) => Buffer.from(txid).reverse().toString("hex");

/** The answers of a node and an indexer for the clean template: U holds the bit at offset 0, the others hold none. */
function lookups(from: PrimarySale): Required<Pick<PurchaseOptions, "heldAt" | "utxoAt">> {
  const coins = [from.paddingA, from.paddingB, from.inscribed, from.funding];
  const find = (txid: string, vout: number) => coins.find((entry) => display(entry.txid) === txid && entry.vout === vout);
  return {
    heldAt: (txid, vout) => (find(txid, vout) ? (txid === display(from.inscribed.txid) ? [0n] : []) : undefined),
    utxoAt: (txid, vout) => {
      const entry = find(txid, vout);
      return entry ? { value: entry.value, scriptPubKey: entry.scriptPubKey } : undefined;
    },
  };
}

const codes = (psbt: Psbt | Uint8Array, options: PurchaseOptions = {}) => checkPurchasePsbt(psbt, options).problems.map((entry) => entry.code).sort();

// ---------------------------------------------------------------- H2: fail closed

test("by default a check that was skipped makes the trade not ok, and the report says complete is false", () => {
  const psbt = primarySalePsbt(sale());
  const bare = checkPurchasePsbt(psbt);
  assert.deepEqual([bare.ok, bare.complete], [false, false]);
  assert.deepEqual(bare.problems.map((entry) => entry.code), ["not-checked"]);
  assert.equal(bare.notChecked.length, 2);
  for (const line of bare.notChecked) assert.ok(bare.problems[0].message.includes(line));
  assert.throws(() => assertPurchasePsbt(psbt), (error: unknown) => error instanceof PurchaseCheckError && /checks were skipped/.test(error.message));

  const only = lookups(sale());
  for (const partial of [{ heldAt: only.heldAt }, { utxoAt: only.utxoAt }]) {
    const report = checkPurchasePsbt(psbt, partial);
    assert.deepEqual([report.ok, report.complete, report.notChecked.length], [false, false, 1]);
  }
  const full = checkPurchasePsbt(psbt, only);
  assert.deepEqual([full.ok, full.complete, full.problems, full.notChecked], [true, true, [], []]);
});

test("allowNotChecked accepts the skipped checks, keeps them listed, and never hides a real problem", () => {
  const psbt = primarySalePsbt(sale());
  const report = checkPurchasePsbt(psbt, { allowNotChecked: true });
  assert.deepEqual([report.ok, report.complete, report.problems], [true, false, []]);
  assert.equal(report.notChecked.length, 2);
  assert.equal(checkPurchasePsbt(psbt, { allowNotChecked: false }).ok, false);
  // A problem stays a problem with the opt-out.
  assert.equal(checkPurchasePsbt(psbt, { allowNotChecked: true, expectedSellerPayment: 1n }).ok, false);
});

test("a PSBT that could not be read is never complete, with or without the opt-out", () => {
  for (const options of [{}, { allowNotChecked: true }, lookups(sale())]) {
    const report = checkPurchasePsbt(new Uint8Array(0), options);
    assert.deepEqual([report.ok, report.complete], [false, false]);
  }
});

test("an output the indexer does not know is skipped, so the trade is not ok unless that is allowed", () => {
  const psbt = primarySalePsbt(sale());
  const known = lookups(sale());
  const holes = { ...known, heldAt: (txid: string, vout: number) => (txid === display(sale().paddingA.txid) ? undefined : known.heldAt(txid, vout)) };
  const report = checkPurchasePsbt(psbt, holes);
  assert.deepEqual([report.ok, report.complete, report.notChecked.length], [false, false, 1]);
  assert.match(report.notChecked[0], /input 0: the indexer does not know/);
  assert.equal(checkPurchasePsbt(psbt, { ...holes, allowNotChecked: true }).ok, true);
});

test("the builder returns a PSBT that the buyer still has to check in full", () => {
  const psbt = primarySalePsbt(sale());
  assert.equal(checkPurchasePsbt(psbt).complete, false);
  assert.equal(checkPurchasePsbt(psbt, lookups(sale())).complete, true);
});

// ---------------------------------------------------------------- M2: utxoAt

test("utxoAt: every input must be the unspent output the node holds, with the amount and the script the PSBT states", () => {
  const psbt = primarySalePsbt(sale());
  const good = lookups(sale());
  assert.deepEqual(codes(psbt, good), []);
  const changed = (edit: (txid: string, vout: number, base: ReturnType<typeof good.utxoAt>) => ReturnType<typeof good.utxoAt>) => ({
    ...good,
    utxoAt: (txid: string, vout: number) => edit(txid, vout, good.utxoAt(txid, vout)),
  });
  const first = display(sale().paddingA.txid);
  assert.deepEqual(codes(psbt, changed((txid, _vout, base) => (txid === first ? undefined : base))), ["utxo-missing"]);
  assert.deepEqual(codes(psbt, changed((txid, _vout, base) => (txid === first && base ? { ...base, value: base.value + 1n } : base))), ["utxo-amount"]);
  assert.deepEqual(codes(psbt, changed((txid, _vout, base) => (txid === first && base ? { ...base, scriptPubKey: walletScript } : base))), ["utxo-script"]);
  assert.deepEqual(codes(psbt, changed(() => undefined)), ["utxo-missing", "utxo-missing", "utxo-missing", "utxo-missing"]);
  const lie = checkPurchasePsbt(psbt, changed((txid, _vout, base) => (txid === display(sale().funding.txid) && base ? { ...base, value: 1_000n } : base)));
  assert.match(lie.problems[0].message, /input 3 states 200000 bits, the node holds 1000 bits/);
});

test("utxoFromGetTxOut reads the answer of gettxout, null for a spent or unknown output, and refuses anything else", () => {
  const hex = `5220${"ab".repeat(32)}`;
  assert.deepEqual(utxoFromGetTxOut({ bestblock: "x", confirmations: 3, value: 0.0001, scriptPubKey: { hex, type: "witness_unknown" }, coinbase: false }), { value: 10_000n, scriptPubKey: hexToBytes(hex) });
  assert.deepEqual(utxoFromGetTxOut({ bestblock: "x", confirmations: 3, value: "0.00010000", scriptPubKey: { hex, type: "witness_unknown" }, coinbase: false }), { value: 10_000n, scriptPubKey: hexToBytes(hex) });
  assert.equal(utxoFromGetTxOut(null), undefined);
  for (const bad of [undefined, {}, { error: "bad gateway" }, { value: "1", scriptPubKey: { hex } }, { value: 1 }, { value: 1, scriptPubKey: { hex: "zz" } }, { value: 1, scriptPubKey: { hex: "ABCD" } }, { value: -1, scriptPubKey: { hex } }, { value: 1, scriptPubKey: { hex: "" } }, { value: Number.NaN, scriptPubKey: { hex } }, "text"]) {
    assert.throws(() => utxoFromGetTxOut(bad), TypeError, JSON.stringify(bad));
  }
  assert.equal(bitsOf(0), 0n);
  assert.equal(bitsOf(21_000_000), 2_100_000_000_000_000n);
  assert.equal(bitsOf("0.00010000"), 10_000n);
  assert.equal(bitsOf("1.23456789"), 123_456_789n);
  assert.throws(() => bitsOf(-0.1), RangeError);
  assert.throws(() => bitsOf("-0.10000000"), RangeError);
  assert.throws(() => bitsOf(Number.POSITIVE_INFINITY), RangeError);
});

// ---------------------------------------------------------------- M1: sighash from the signature

const SIGNATURE = 3680;
const signature = (extra?: number): Uint8Array => {
  const bytes = new Uint8Array(SIGNATURE + (extra === undefined ? 0 : 1)).fill(0x11);
  if (extra !== undefined) bytes[SIGNATURE] = extra;
  return bytes;
};

test("the sighash type of a signature: 3680 bytes is the default, 3681 bytes ends with the type, nothing else is valid", () => {
  assert.equal(sighashTypeOfSignature(signature()), 0);
  assert.equal(sighashTypeOfSignature(signature(0x83)), 0x83);
  assert.equal(sighashTypeOfSignature(signature(0x01)), 0x01);
  assert.equal(sighashTypeOfSignature(signature(0x81)), 0x81);
  assert.equal(sighashTypeOfSignature(signature(0x82)), 0x82);
  for (const bad of [signature(0x00), signature(0x04), signature(0x84), signature(0xff), new Uint8Array(0), new Uint8Array(SIGNATURE - 1), new Uint8Array(SIGNATURE + 2)]) {
    assert.throws(() => sighashTypeOfSignature(bad), /./, `length ${bad.length}`);
  }
});

type Tv61 = { trade_tx_hex: string; input_witness_item_lengths: number[][]; input_sighash_types: string[]; outputs: { value_bits: number; script: string }[] };
const tv61: Tv61 = JSON.parse(readFileSync(new URL("../../docs/specs/vectors/regtest/runs.json", import.meta.url), "utf8")).trade;

/** The inputs, outputs and witnesses of the real transaction of TV6-1 (a segwit-serialized transaction). */
function parseTransaction(hex: string) {
  const bytes = hexToBytes(hex);
  let at = 4;
  const compact = (): number => {
    const first = bytes[at++];
    if (first < 0xfd) return first;
    assert.equal(first, 0xfd, "this parser reads 2-byte lengths at most");
    const value = bytes[at] | (bytes[at + 1] << 8);
    at += 2;
    return value;
  };
  assert.deepEqual([bytes[at], bytes[at + 1]], [0, 1], "marker and flag");
  at += 2;
  const inputs = Array.from({ length: compact() }, () => {
    const txid = bytes.slice(at, at + 32);
    const vout = new DataView(bytes.buffer, bytes.byteOffset + at + 32, 4).getUint32(0, true);
    assert.equal(bytes[at + 36], 0, "empty scriptSig");
    const sequence = new DataView(bytes.buffer, bytes.byteOffset + at + 37, 4).getUint32(0, true);
    at += 41;
    return { txid, vout, sequence };
  });
  const outputs = Array.from({ length: compact() }, () => {
    const value = new DataView(bytes.buffer, bytes.byteOffset + at, 8).getBigUint64(0, true);
    at += 8;
    const length = compact();
    const scriptPubKey = bytes.slice(at, at + length);
    at += length;
    return { value, scriptPubKey };
  });
  const witnesses = inputs.map(() => {
    const start = at;
    const items = Array.from({ length: compact() }, () => {
      const length = compact();
      const item = bytes.slice(at, at + length);
      at += length;
      return item;
    });
    return { items, serialized: bytes.slice(start, at) };
  });
  assert.equal(at + 4, bytes.length, "only the locktime is left");
  return { inputs, outputs, witnesses };
}

/** TV6-1 as a PSBT: its real inputs, outputs and final witnesses; no sighash field, as a wallet leaves it once it has finalized. */
function realTradePsbt(): { psbt: Psbt; witnesses: { items: Uint8Array[] }[] } {
  const tx = parseTransaction(tv61.trade_tx_hex);
  const sum = tx.outputs.reduce((total, output) => total + output.value, 0n);
  const psbt = createP2mrPsbt({
    version: 2,
    locktime: 0,
    restrictedOutputMode: false,
    inputs: tx.inputs.map((input, index) => {
      const [, leafScript, controlBlock] = tx.witnesses[index].items;
      return {
        prevout: { txid: input.txid, vout: input.vout },
        sequence: input.sequence,
        // The amounts of the spent outputs are not in the record; they add up to the outputs plus a fee of 1,000 bits.
        witnessUtxo: { value: index === 0 ? sum + 1_000n - 3n * 1_000n : 1_000n, scriptPubKey: p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)) },
        leafScript,
        controlBlock,
      };
    }),
    outputs: tx.outputs,
  });
  tx.witnesses.forEach((witness, index) => psbt.inputs[index].push({ key: Uint8Array.of(PSBT_IN_FINAL_SCRIPTWITNESS), value: witness.serialized }));
  return { psbt, witnesses: tx.witnesses };
}

const sighashCodes = (psbt: Psbt) => codes(psbt, { allowNotChecked: true, sellerInput: 2, receiveOutput: 1 }).filter((code) => /sighash|signature|witness/.test(code));

test("the real TV6-1 trade: the signature lengths are 3680 and one of 3681, and the sighash comes from them", () => {
  assert.deepEqual(tv61.input_witness_item_lengths, [[3680, 34, 1], [3680, 34, 1], [3681, 34, 1], [3680, 34, 1]]);
  assert.deepEqual(tv61.input_sighash_types, ["default", "default", "83", "default"]);
  const { psbt, witnesses } = realTradePsbt();
  assert.deepEqual(witnesses.map((entry) => entry.items.map((item) => item.length)), tv61.input_witness_item_lengths);
  assert.deepEqual(witnesses.map((entry) => sighashTypeOfSignature(entry.items[0])), [0, 0, 0x83, 0]);
  assert.equal(witnesses[2].items[0].at(-1), 0x83);
  // The finalized PSBT carries no sighash field, which is what Qbit Core leaves after it signs and finalizes.
  assert.deepEqual(decodePsbt(psbt).inputs.map((input) => input.sighashType), [undefined, undefined, undefined, undefined]);
  // Read from the PSBT field alone every input would be the default, and the seller input would be refused: not any more.
  assert.deepEqual(sighashCodes(psbt), []);
  const report = checkPurchasePsbt(psbt, { allowNotChecked: true });
  assert.ok(!report.problems.some((entry) => /sighash/.test(entry.code)), JSON.stringify(report.problems));
  // The real script of every input is in the tree of the output it spends.
  assert.ok(!report.problems.some((entry) => entry.code === "script-mismatch"));
});

test("a signature of the wrong kind on the real trade is a problem, wherever the type comes from", () => {
  const swap = (input: number, item: Uint8Array, field?: number): Psbt => {
    const { psbt } = realTradePsbt();
    const tx = parseTransaction(tv61.trade_tx_hex);
    const items = [...tx.witnesses[input].items];
    items[0] = new Uint8Array(item);
    const parts: Uint8Array[] = [Uint8Array.of(items.length)];
    for (const entry of items) parts.push(entry.length < 0xfd ? Uint8Array.of(entry.length) : Uint8Array.of(0xfd, entry.length & 0xff, entry.length >> 8), entry);
    const value = Buffer.concat(parts);
    const record = psbt.inputs[input].find((entry) => entry.key.length === 1 && entry.key[0] === PSBT_IN_FINAL_SCRIPTWITNESS)!;
    record.value = Uint8Array.from(value);
    if (field !== undefined) {
      const bytes = new Uint8Array(4);
      new DataView(bytes.buffer).setUint32(0, field, true);
      psbt.inputs[input].push({ key: Uint8Array.of(PSBT_IN_SIGHASH_TYPE), value: bytes });
    }
    return psbt;
  };
  // The seller input signed with the default, or with another type.
  assert.deepEqual(sighashCodes(swap(2, signature())), ["seller-sighash"]);
  assert.deepEqual(sighashCodes(swap(2, signature(0x01))), ["seller-sighash"]);
  // A buyer input signed 0x83 would not commit to every output.
  assert.deepEqual(sighashCodes(swap(0, signature(0x83))), ["buyer-sighash"]);
  assert.deepEqual(sighashCodes(swap(3, signature(0x81))), ["buyer-sighash"]);
  // A field that disagrees with the signature is named as such.
  assert.deepEqual(sighashCodes(swap(2, signature(0x83), 0)), ["sighash-conflict"]);
  assert.deepEqual(sighashCodes(swap(2, signature(), SELLER_SIGHASH_TYPE)), ["sighash-conflict", "seller-sighash"].sort());
  // A field that agrees with the signature changes nothing.
  assert.deepEqual(sighashCodes(swap(2, signature(0x83), SELLER_SIGHASH_TYPE)), []);
  assert.deepEqual(sighashCodes(swap(0, signature(), 0)), []);
  // A signature that is not valid is a problem, not an exception.
  assert.deepEqual(sighashCodes(swap(2, signature(0x00))), ["seller-sighash", "signature"].sort());
});

test("partial signatures count like final ones, and an unsigned input uses its field or the default", () => {
  const base = sale();
  const sellerLeaf = p2mrLeafHash(P2MR_LEAF_VERSION_V1, base.inscribed.leafScript!);
  const withPartial = (input: number, hashType: number, coinFor: SaleCoin): Psbt => {
    const psbt = primarySalePsbt(base);
    // The builder wrote the field for input 2; a wallet that has signed leaves a signature and no field.
    psbt.inputs[2] = psbt.inputs[2].filter((entry) => entry.key[0] !== PSBT_IN_SIGHASH_TYPE);
    const field = encodeP2mrPsbtScriptSigField(new Uint8Array(32).fill(input === 2 ? 3 : 1), p2mrLeafHash(P2MR_LEAF_VERSION_V1, coinFor.leafScript!), signature(), hashType);
    psbt.inputs[input].push(field);
    return psbt;
  };
  assert.ok(sellerLeaf.length === 32);
  assert.deepEqual(sighashCodes(withPartial(2, 0x83, base.inscribed)), []);
  assert.deepEqual(sighashCodes(withPartial(2, 0, base.inscribed)), ["seller-sighash"]);
  assert.deepEqual(sighashCodes(withPartial(0, 0x83, base.paddingA)), ["buyer-sighash", "seller-sighash"].sort());
  // Unsigned: the seller input with no field is the default and is refused, with the field it is accepted.
  const unsigned = primarySalePsbt(base);
  assert.deepEqual(sighashCodes(unsigned), []);
  unsigned.inputs[2] = unsigned.inputs[2].filter((entry) => entry.key[0] !== PSBT_IN_SIGHASH_TYPE);
  assert.deepEqual(sighashCodes(unsigned), ["seller-sighash"]);
});

test("a malformed final witness is a problem, not an exception", () => {
  const psbt = primarySalePsbt(sale());
  for (const value of [Uint8Array.of(), Uint8Array.of(0xff), Uint8Array.of(0x01), Uint8Array.of(0x01, 0x05, 0x00), Uint8Array.of(0x00, 0x00), Uint8Array.of(0xfd, 0x01)]) {
    const copy = primarySalePsbt(sale());
    copy.inputs[0].push({ key: Uint8Array.of(PSBT_IN_FINAL_SCRIPTWITNESS), value });
    const report = checkPurchasePsbt(copy, { allowNotChecked: true });
    assert.equal(report.ok, false, `witness ${Buffer.from(value).toString("hex")}`);
    assert.ok(report.problems.some((entry) => entry.code === "witness"), JSON.stringify(report.problems));
  }
  assert.equal(checkPurchasePsbt(psbt, { allowNotChecked: true }).ok, true);
});

// ---------------------------------------------------------------- L3: the script is in the output's tree

test("a leaf script that its output does not commit to is refused, by the checker and by the builder", () => {
  const stranger = coin(10_000n, 3);
  const wrong: SaleCoin = { ...stranger, leafScript: singleKeyLeafScript(new Uint8Array(32).fill(99)) };
  assert.throws(() => primarySalePsbt(sale({ inscribed: wrong })), (error: unknown) => error instanceof PurchaseCheckError && /no leaf script of input 2 hashes/.test(error.message));
  // The checker, on a PSBT someone else built.
  const psbt = primarySalePsbt(sale());
  const decoded = decodePsbt(psbt);
  assert.equal(decoded.inputs.length, 4);
  const forged = createP2mrPsbt({
    version: 2,
    locktime: 0,
    inputs: [sale().paddingA, sale().paddingB, wrong, sale().funding].map((entry) => ({
      prevout: { txid: entry.txid, vout: entry.vout },
      witnessUtxo: { value: entry.value, scriptPubKey: stranger.scriptPubKey === entry.scriptPubKey || entry === wrong ? stranger.scriptPubKey : entry.scriptPubKey },
      leafScript: entry.leafScript!,
      controlBlock: entry.controlBlock!,
    })),
    outputs: [
      { value: 40_000n, scriptPubKey: walletScript },
      { value: 10_000n, scriptPubKey: walletScript },
      { value: 50_000n, scriptPubKey: sellerScript },
      { value: 150_000n, scriptPubKey: walletScript },
    ],
  });
  assert.deepEqual(codes(forged, { allowNotChecked: true, sellerInput: 2 }).filter((code) => code === "script-mismatch"), ["script-mismatch"]);
});

test("the leaf is checked along its control block: a two-leaf tree matches only with the true sibling", () => {
  const leafA = singleKeyLeafScript(new Uint8Array(32).fill(21));
  const leafB = singleKeyLeafScript(new Uint8Array(32).fill(22));
  const hashA = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafA);
  const hashB = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafB);
  const spk = p2mrScriptPubKey(p2mrBranchHash(hashA, hashB));
  const build = (controlBlock: Uint8Array, leafScript: Uint8Array = leafA, scriptPubKey: Uint8Array = spk, merkleRoot?: Uint8Array): Psbt =>
    createP2mrPsbt({
      version: 2,
      locktime: 0,
      inputs: [{ prevout: { txid: new Uint8Array(32).fill(7), vout: 0 }, witnessUtxo: { value: 20_000n, scriptPubKey }, leafScript, controlBlock, merkleRoot }],
      outputs: [{ value: 19_000n, scriptPubKey: walletScript }],
    });
  const scriptCodes = (psbt: Psbt) => codes(psbt, { allowNotChecked: true, sellerInput: 0, receiveOutput: 0 }).filter((code) => /script/.test(code));
  assert.deepEqual(scriptCodes(build(buildControlBlock(P2MR_LEAF_VERSION_V1, [hashB]))), []);
  assert.deepEqual(scriptCodes(build(buildControlBlock(P2MR_LEAF_VERSION_V1, [hashA]))), ["script-mismatch"]);
  assert.deepEqual(scriptCodes(build(buildControlBlock(P2MR_LEAF_VERSION_V1, []))), ["script-mismatch"]);
  assert.deepEqual(scriptCodes(build(buildControlBlock(P2MR_LEAF_VERSION_V1, [hashB]), leafB)), ["script-mismatch"]);
  // The Merkle root the PSBT names must be the program of the output.
  assert.deepEqual(scriptCodes(build(buildControlBlock(P2MR_LEAF_VERSION_V1, [hashB]), leafA, spk, p2mrBranchHash(hashA, hashB))), []);
  assert.deepEqual(scriptCodes(build(buildControlBlock(P2MR_LEAF_VERSION_V1, [hashB]), leafA, spk, hashA)), ["script-mismatch"]);
  // An output that is not P2MR cannot hold a P2MR script.
  assert.deepEqual(scriptCodes(build(buildControlBlock(P2MR_LEAF_VERSION_V1, [hashB]), leafA, Uint8Array.of(0x6a, 0x01, 0x00))), ["input-script"]);
});

test("an input with neither a leaf script nor a final witness cannot be checked, so the trade is not complete", () => {
  const psbt = primarySalePsbt(sale());
  psbt.inputs[0] = psbt.inputs[0].filter((entry) => entry.key[0] !== 0x1d);
  const report = checkPurchasePsbt(psbt, { ...lookups(sale()) });
  assert.deepEqual([report.ok, report.complete], [false, false]);
  assert.match(report.notChecked.join("\n"), /input 0: the PSBT has no leaf script for it/);
  assert.equal(checkPurchasePsbt(psbt, { ...lookups(sale()), allowNotChecked: true }).ok, true);
});
