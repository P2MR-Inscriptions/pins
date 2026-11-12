// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  PSBT_IN_SIGHASH_TYPE,
  SIGHASH_ANYONECANPAY,
  SIGHASH_SINGLE,
  addressToScriptPubKey,
  buildControlBlock,
  createP2mrPsbt,
  p2mrAddressFromPubkey,
  p2mrLeafHash,
  p2mrScriptPubKey,
  serializePsbt,
  singleKeyLeafScript,
  P2MR_LEAF_VERSION_V1,
  type P2mrTransactionOutput,
  type Psbt,
} from "@qbit-oss/protocol";
import { itemsLeaf } from "../inscriber/reveal.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApi } from "../indexer/api.ts";
import { Indexer, type ChainBlock, type ChainTx } from "../indexer/pins.ts";
import { Store } from "../indexer/store.ts";
import {
  DUST_BITS,
  PurchaseCheckError,
  SELLER_SIGHASH_TYPE,
  assertPurchasePsbt,
  checkPurchasePsbt,
  fifoLanding,
  offsetsFromOutputAnswer,
  outpointsOf,
  type PurchaseOptions,
} from "./checks.ts";
import { checkPrimarySale, primarySalePsbt, type PrimarySale, type SaleCoin } from "./psbt.ts";

const script = (byte: number) => addressToScriptPubKey(p2mrAddressFromPubkey(new Uint8Array(32).fill(byte), "regtest"), "regtest");
const walletScript = script(4);
const otherScript = script(9);
const sellerScript = script(5);
const holdingScript = script(6);
const BURN = Uint8Array.of(0x6a, 0x01, 0x00);
const ANCHOR = Uint8Array.of(0x51, 0x02, 0x4e, 0x73);

function coin(value: bigint, byte: number, vout = 0): SaleCoin {
  const leafScript = singleKeyLeafScript(new Uint8Array(32).fill(byte));
  return {
    txid: new Uint8Array(32).fill(byte),
    vout,
    value,
    scriptPubKey: p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)),
    leafScript,
    controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
  };
}

function primary(change: Partial<PrimarySale> = {}): PrimarySale {
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

/** Any trade: inputs with an optional sighash type each, any outputs. */
function trade(inputs: { coin: SaleCoin; sighash?: number }[], outputs: P2mrTransactionOutput[]): Psbt {
  const psbt = createP2mrPsbt({
    version: 2,
    locktime: 0,
    restrictedOutputMode: false,
    inputs: inputs.map(({ coin: c }) => ({
      prevout: { txid: c.txid, vout: c.vout },
      sequence: 0xfffffffe,
      witnessUtxo: { value: c.value, scriptPubKey: c.scriptPubKey },
      leafScript: c.leafScript,
      controlBlock: c.controlBlock!,
    })),
    outputs,
  });
  inputs.forEach(({ sighash }, index) => {
    if (sighash === undefined) return;
    const value = new Uint8Array(4);
    new DataView(value.buffer).setUint32(0, sighash, true);
    psbt.inputs[index].push({ key: Uint8Array.of(PSBT_IN_SIGHASH_TYPE), value });
  });
  return psbt;
}

/** The clean template with every part replaceable. */
function clean(
  parts: {
    outputs?: P2mrTransactionOutput[];
    sighash?: (number | undefined)[];
    coins?: SaleCoin[];
  } = {},
): Psbt {
  const coins = parts.coins ?? [coin(20_000n, 1), coin(20_000n, 2), coin(10_000n, 3), coin(200_000n, 4)];
  const sighash = parts.sighash ?? [undefined, undefined, SELLER_SIGHASH_TYPE, undefined];
  return trade(
    coins.map((c, index) => ({ coin: c, sighash: sighash[index] })),
    parts.outputs ?? [
      { value: 40_000n, scriptPubKey: walletScript },
      { value: 10_000n, scriptPubKey: walletScript },
      { value: 50_000n, scriptPubKey: sellerScript },
      { value: 150_000n, scriptPubKey: walletScript },
    ],
  );
}

function codes(psbt: Psbt | Uint8Array, options?: PurchaseOptions): string[] {
  return checkPurchasePsbt(psbt, options).problems.map((entry) => entry.code).sort();
}

test("the seller sighash is SIGHASH_SINGLE | SIGHASH_ANYONECANPAY, defined once", () => {
  assert.equal(SELLER_SIGHASH_TYPE, SIGHASH_SINGLE | SIGHASH_ANYONECANPAY);
  assert.equal(SELLER_SIGHASH_TYPE, 0x83);
  assert.equal(DUST_BITS, 2_855n);
});

test("outpointsOf lists the spent outputs with the txid in display order", () => {
  const psbt = primarySalePsbt(primary());
  const first = outpointsOf(psbt)[0];
  assert.deepEqual(outpointsOf(psbt).map((entry) => entry.vout), [0, 0, 0, 0]);
  assert.equal(first.txid, "01".repeat(32));
  const reversed = clean({ coins: [{ ...coin(20_000n, 1), txid: Uint8Array.from({ length: 32 }, (_, index) => index) }, coin(20_000n, 2), coin(10_000n, 3), coin(200_000n, 4)] });
  assert.equal(outpointsOf(reversed)[0].txid, Array.from({ length: 32 }, (_, index) => (31 - index).toString(16).padStart(2, "0")).join(""));
});

test("a clean sale passes every check, as a PSBT and as bytes", () => {
  const psbt = primarySalePsbt(primary());
  for (const input of [psbt, serializePsbt(psbt)]) {
    const report = checkPurchasePsbt(input, { expectedReceiveScript: walletScript, expectedSellerPayment: 50_000n, strict: true });
    assert.deepEqual(report.problems, []);
    assert.deepEqual(report.warnings, []);
    assert.equal(report.ok, true);
    assert.equal(report.fee, 0n);
    assert.deepEqual(report.landing, { kind: "output", output: 1, offset: 0n });
    assert.equal(report.notChecked.length, 1, "without an indexer lookup, items 1 and 3 are reported as not checked");
  }
  assertPurchasePsbt(psbt);
});

test("the builder refuses each broken number of PINS-6 section 4.1 and names it", () => {
  const refused = (change: Partial<PrimarySale>, code: string) => {
    assert.ok(checkPrimarySale(primary(change)).some((entry) => entry.code === code), code);
    assert.throws(() => primarySalePsbt(primary(change)), /the sale is not valid/);
  };
  assert.deepEqual(checkPrimarySale(primary()), []);
  refused({ paddingA: coin(1_000n, 1), paddingB: coin(1_800n, 2) }, "dust"); // a + b = 2,800 < 2,855
  refused({ postage: 12_000n, changeValue: 148_000n }, "postage"); // output 1 is not v_U
  refused({ postage: 2_000n, inscribed: coin(2_000n, 3) }, "dust");
  refused({ price: 2_854n, changeValue: 150_000n }, "dust");
  refused({ changeValue: 0n }, "dust");
  refused({ changeValue: 160_000n }, "fee"); // outputs exceed inputs
  refused({ price: -1n }, "amount");
  refused({ paddingB: coin(20_000n, 1) }, "duplicate-input");
  // Exactly the dust threshold is fine, one bit less is not.
  assert.deepEqual(checkPrimarySale(primary({ paddingA: coin(1_000n, 1), paddingB: coin(1_855n, 2) })), []);
});

test("a fee of exactly 0 and a large fee are both allowed, a negative fee is not", () => {
  assert.deepEqual(checkPrimarySale(primary({ changeValue: 150_000n })), []);
  assert.deepEqual(checkPrimarySale(primary({ changeValue: 100_000n })), []);
  assert.equal(checkPurchasePsbt(primarySalePsbt(primary({ changeValue: 100_000n }))).fee, 50_000n);
  assert.deepEqual(codes(clean({ outputs: [
    { value: 40_000n, scriptPubKey: walletScript },
    { value: 10_000n, scriptPubKey: walletScript },
    { value: 50_000n, scriptPubKey: sellerScript },
    { value: 150_001n, scriptPubKey: walletScript },
  ] })), ["amounts"]);
});

test("the receive output must be where the bit lands, not the fee, a burn or another output", () => {
  const out = (value: bigint, scriptPubKey: Uint8Array) => ({ value, scriptPubKey });
  // Output 0 is larger than a + b: the bit (position 40,000) lands in output 0, not 1.
  assert.deepEqual(
    codes(clean({ outputs: [out(41_000n, walletScript), out(9_000n, walletScript), out(50_000n, sellerScript), out(150_000n, walletScript)] }), { strict: true }),
    ["landing", "receive-value"],
  );
  // The receive output is an OP_RETURN: the P2MR Inscription would be burned.
  const burned = checkPurchasePsbt(clean({ outputs: [out(40_000n, walletScript), out(10_000n, BURN), out(50_000n, sellerScript), out(150_000n, walletScript)] }));
  assert.ok(burned.problems.some((entry) => entry.code === "landing" && /burned/.test(entry.message)));
  assert.ok(burned.problems.some((entry) => entry.code === "receive-script"));
  // Less is paid out than comes in at the front, so the bit becomes fee.
  const fee = checkPurchasePsbt(clean({ outputs: [out(30_000n, walletScript), out(5_000n, walletScript)] }));
  assert.deepEqual(fee.landing, { kind: "fee", offset: 5_000n });
  assert.ok(fee.problems.some((entry) => entry.code === "landing" && /fee/.test(entry.message)));
  const toFee = checkPurchasePsbt(clean({ outputs: [out(40_000n, walletScript), out(0n, walletScript), out(50_000n, sellerScript), out(150_000n, walletScript)] }));
  assert.deepEqual(toFee.landing, { kind: "output", output: 2, offset: 0n });
  assert.ok(toFee.problems.some((entry) => entry.code === "landing"));
});

test("outputs must be P2MR, OP_RETURN or PayToAnchor, and a P2MR output must not be dust", () => {
  const out = (value: bigint, scriptPubKey: Uint8Array) => ({ value, scriptPubKey });
  const base = [out(40_000n, walletScript), out(10_000n, walletScript), out(50_000n, sellerScript)];
  assert.deepEqual(codes(clean({ outputs: [...base, out(2_855n, walletScript)] })), []);
  assert.deepEqual(codes(clean({ outputs: [...base, out(2_854n, walletScript)] })), ["dust"]);
  assert.deepEqual(codes(clean({ outputs: [...base, out(0n, BURN), out(100_000n, walletScript)] })), []);
  assert.deepEqual(codes(clean({ outputs: [...base, out(100_000n, ANCHOR), out(1n, walletScript)] })), ["dust"]);
  assert.deepEqual(codes(clean({ outputs: [...base, out(150_000n, ANCHOR)] })), []);
  assert.deepEqual(codes(clean({ outputs: [...base, out(150_000n, Uint8Array.of(0x00, 0x14, ...new Uint8Array(20)))] })), ["output-script"]);
  // A P2MR-looking output of a wrong program length is not P2MR.
  assert.deepEqual(codes(clean({ outputs: [...base, out(150_000n, Uint8Array.of(0x52, 0x1f, ...new Uint8Array(31)))] })), ["output-script"]);
  // The padding return at output 0 below dust (a + b < 2,855): the builder rule seen from the buyer side.
  const padding = checkPurchasePsbt(clean({
    coins: [coin(1_000n, 1), coin(1_800n, 2), coin(10_000n, 3), coin(200_000n, 4)],
    outputs: [out(2_800n, walletScript), out(10_000n, walletScript), out(50_000n, sellerScript), out(147_200n, walletScript)],
  }), { outputNames: ["the padding return (a + b)"] });
  assert.ok(padding.problems.some((entry) => entry.code === "dust" && /padding return/.test(entry.message)));
});

test("the receive script must be P2MR, the buyer's, and not a holding address", () => {
  const out = (value: bigint, scriptPubKey: Uint8Array) => ({ value, scriptPubKey });
  const to = (receive: Uint8Array) => clean({ outputs: [out(40_000n, walletScript), out(10_000n, receive), out(50_000n, sellerScript), out(150_000n, walletScript)] });
  assert.deepEqual(codes(to(otherScript), { expectedReceiveScript: otherScript }), []);
  assert.deepEqual(codes(to(otherScript), { expectedReceiveScript: walletScript }), ["receive-script"]);
  assert.deepEqual(codes(to(holdingScript), { holdingScripts: [holdingScript] }), ["receive-holding"]);
  assert.deepEqual(codes(to(ANCHOR)), ["landing", "receive-script"].filter((code) => code !== "landing"));
  assert.deepEqual(codes(to(otherScript), { holdingScripts: [holdingScript] }), []);
});

test("sighash types: the seller is 0x83, every other input is the default", () => {
  assert.deepEqual(codes(clean({ sighash: [undefined, undefined, undefined, undefined] })), ["seller-sighash"]);
  assert.deepEqual(codes(clean({ sighash: [undefined, undefined, 0x01, undefined] })), ["seller-sighash"]);
  assert.deepEqual(codes(clean({ sighash: [undefined, 0x01, SELLER_SIGHASH_TYPE, undefined] })), ["buyer-sighash"]);
  assert.deepEqual(codes(clean({ sighash: [0x81, undefined, SELLER_SIGHASH_TYPE, 0x83] })), ["buyer-sighash", "buyer-sighash"]);
  assert.deepEqual(codes(clean({ sighash: [0, 0, SELLER_SIGHASH_TYPE, 0] })), []);
});

test("the seller signs 0x83 for the output at its own index, so that output must exist", () => {
  const out = (value: bigint, scriptPubKey: Uint8Array) => ({ value, scriptPubKey });
  const report = checkPurchasePsbt(clean({ outputs: [out(40_000n, walletScript), out(10_000n, walletScript)] }));
  assert.ok(report.problems.some((entry) => entry.code === "seller-output"));
});

test("the seller payment value is checked when the listing fixes it", () => {
  assert.deepEqual(codes(clean(), { expectedSellerPayment: 50_000n }), []);
  assert.deepEqual(codes(clean(), { expectedSellerPayment: 60_000n }), ["seller-payment"]);
});

test("a receive value different from the value of the inscribed output is a warning, or a problem in strict mode", () => {
  const out = (value: bigint, scriptPubKey: Uint8Array) => ({ value, scriptPubKey });
  const psbt = clean({ outputs: [out(40_000n, walletScript), out(12_000n, walletScript), out(48_000n, sellerScript), out(150_000n, walletScript)] });
  const relaxed = checkPurchasePsbt(psbt);
  assert.equal(relaxed.ok, true);
  assert.deepEqual(relaxed.warnings.map((entry) => entry.code), ["receive-value"]);
  assert.deepEqual(codes(psbt, { strict: true }), ["receive-value"]);
});

test("a repeated input is refused, and an unusable index is a problem", () => {
  // A repeated input cannot even be written as a PSBT by the protocol library.
  assert.throws(() => clean({ coins: [coin(20_000n, 1), coin(20_000n, 1), coin(10_000n, 3), coin(200_000n, 4)] }), /same output/);
  // A hostile PSBT can still carry one: input 1 made to spend the output of input 0, in the bytes.
  const bytes = Buffer.from(serializePsbt(clean()));
  const from = Buffer.alloc(32, 2);
  const at = bytes.indexOf(from);
  assert.ok(at > 0);
  Buffer.alloc(32, 1).copy(bytes, at);
  assert.deepEqual(codes(new Uint8Array(bytes)), ["duplicate-input"]);
  assert.deepEqual(codes(clean(), { sellerInput: 9 }), ["seller-input"]);
  assert.deepEqual(codes(clean(), { receiveOutput: 9 }), ["receive-output"]);
  assert.throws(() => checkPurchasePsbt(clean(), { sellerInput: -1 }), RangeError);
  assert.throws(() => checkPurchasePsbt(clean(), { bitOffset: -1n }), RangeError);
  assert.deepEqual(codes(clean(), { bitOffset: 10_000n }), ["seller-input"]);
});

test("garbage and hostile bytes give a problem, never an exception", () => {
  assert.deepEqual(codes(new Uint8Array(0)), ["unreadable"]);
  assert.deepEqual(codes(Uint8Array.of(1, 2, 3, 4, 5)), ["unreadable"]);
  assert.deepEqual(codes(new Uint8Array(2_000_000).fill(0x70)), ["unreadable"]);
  const bytes = serializePsbt(clean());
  for (let cut = 1; cut < bytes.length; cut += 97) {
    const report = checkPurchasePsbt(bytes.subarray(0, cut));
    assert.equal(report.ok, false);
  }
  assert.throws(() => assertPurchasePsbt(new Uint8Array(0)), PurchaseCheckError);
});

test("with an indexer lookup, U must hold the P2MR Inscription at the offset and the buyer inputs none", () => {
  const psbt = primarySalePsbt(primary());
  const id = (byte: number) => Buffer.from(new Uint8Array(32).fill(byte)).toString("hex");
  const held = (table: Record<string, bigint[] | undefined>) => (txid: string, vout: number) => table[`${txid}:${vout}`];
  const good = held({ [`${id(1)}:0`]: [], [`${id(2)}:0`]: [], [`${id(3)}:0`]: [0n], [`${id(4)}:0`]: [] });
  const ok = checkPurchasePsbt(psbt, { heldAt: good });
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.notChecked, []);
  // U holds nothing at offset 0.
  assert.deepEqual(codes(psbt, { heldAt: held({ [`${id(1)}:0`]: [], [`${id(2)}:0`]: [], [`${id(3)}:0`]: [5n], [`${id(4)}:0`]: [] }) }), ["seller-input-empty"]);
  // A padding input holds a P2MR Inscription.
  assert.deepEqual(codes(psbt, { heldAt: held({ [`${id(1)}:0`]: [3n], [`${id(2)}:0`]: [], [`${id(3)}:0`]: [0n], [`${id(4)}:0`]: [] }) }), ["buyer-input-inscribed"]);
  assert.deepEqual(codes(psbt, { heldAt: held({ [`${id(1)}:0`]: [], [`${id(2)}:0`]: [], [`${id(3)}:0`]: [0n], [`${id(4)}:0`]: [0n] }) }), ["buyer-input-inscribed"]);
  // Another bit in U is a warning, with where it lands.
  const extra = checkPurchasePsbt(psbt, { heldAt: held({ [`${id(1)}:0`]: [], [`${id(2)}:0`]: [], [`${id(3)}:0`]: [0n, 4_000n], [`${id(4)}:0`]: [] }) });
  assert.equal(extra.ok, true);
  assert.deepEqual(extra.warnings.map((entry) => entry.code), ["seller-input-extra"]);
  assert.match(extra.warnings[0].message, /output 1 at offset 4000/);
  // An output the indexer does not know is reported, not guessed.
  const unknown = checkPurchasePsbt(psbt, { heldAt: held({ [`${id(3)}:0`]: [0n] }) });
  assert.equal(unknown.ok, true);
  assert.equal(unknown.notChecked.length, 3);
});

test("the compact template: seller input 1, receive output 0, the bit lands at offset a", () => {
  const a = coin(20_000n, 1);
  const u = coin(10_000n, 3);
  const funding = coin(100_000n, 4);
  const out = (value: bigint, scriptPubKey: Uint8Array) => ({ value, scriptPubKey });
  const psbt = trade(
    [{ coin: a }, { coin: u, sighash: SELLER_SIGHASH_TYPE }, { coin: funding }],
    [out(30_000n, otherScript), out(50_000n, sellerScript), out(50_000n, walletScript)],
  );
  const options: PurchaseOptions = { sellerInput: 1, receiveOutput: 0, landingOffset: 20_000n };
  assert.deepEqual(codes(psbt, options), []);
  assert.deepEqual(codes(psbt, { ...options, landingOffset: 0n }), ["landing"]);
  assert.deepEqual(codes(psbt, { sellerInput: 1, receiveOutput: 0 }), ["landing"]);
});

/** The same placement as the indexer, on random transactions. */
test("fifoLanding gives the answer of the indexer for the bit of a P2MR Inscription", () => {
  const SCRIPT = new Uint8Array([0x52, 0x20, ...new Uint8Array(32).fill(1)]);
  let state = 12345;
  const next = (n: number) => {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    return state % n;
  };
  const coinbase = (txid: string, extra = 0n): ChainTx => ({ txid, inputs: [{ coinbase: true, value: 50n }], outputs: [{ value: 50n + extra, script: SCRIPT }] });
  const tally = { output: 0, burned: 0, fee: 0, unbound: 0 };
  for (let round = 0; round < 300; round += 1) {
    const before = BigInt(1 + next(30));
    const bit = BigInt(1 + next(30));
    const total = before + bit;
    const reveal: ChainTx = {
      txid: "a".repeat(63) + "1",
      inputs: [
        { prevTxid: "0".repeat(64), prevVout: 0, value: before },
        { prevTxid: "0".repeat(64), prevVout: 1, value: bit, leafScript: itemsLeaf(new Uint8Array(32).fill(7), [{ body: Uint8Array.of(1), contentType: "text/plain" }]) },
      ],
      outputs: [{ value: total, script: SCRIPT }],
    };
    const spendIndex = next(4);
    const values: bigint[] = [BigInt(1 + next(40)), BigInt(1 + next(40)), BigInt(1 + next(40)), BigInt(1 + next(40))];
    values[spendIndex] = total;
    const inputs = values.map((value, index) =>
      index === spendIndex ? { prevTxid: reveal.txid, prevVout: 0, value } : { prevTxid: "0".repeat(63) + String(index + 2), prevVout: 0, value },
    );
    const inputTotal = values.reduce((sum, value) => sum + value, 0n);
    const outputs: P2mrTransactionOutput[] = [];
    let budget = inputTotal - BigInt(next(Number(inputTotal) / 2 | 0));
    for (let i = 0, count = 1 + next(4); i < count && budget > 0n; i += 1) {
      const value = i === count - 1 ? budget : BigInt(1 + next(Number(budget)));
      outputs.push({ value, scriptPubKey: next(5) === 0 ? BURN : SCRIPT });
      budget -= value;
    }
    const spend: ChainTx = {
      txid: "b".repeat(63) + "2",
      inputs,
      outputs: outputs.map((output) => ({ value: output.value, script: output.scriptPubKey })),
    };
    const indexer = new Indexer();
    const blocks: ChainBlock[] = [
      { hash: "h1", height: 1, subsidy: 50n, txs: [coinbase("c1"), reveal] },
      { hash: "h2", height: 2, subsidy: 50n, txs: [coinbase("c2", inputTotal), spend] },
    ];
    for (const entry of blocks) indexer.applyBlock(entry);
    const item = indexer.get(`${reveal.txid}i0`)!;
    const start = values.slice(0, spendIndex).reduce((sum, value) => sum + value, 0n);
    const landing = fifoLanding(values, outputs, start + before);
    tally[landing.kind] += 1;
    if (landing.kind === "output") {
      assert.deepEqual(item.location.state === "located" ? [item.location.vout, item.location.offset] : null, [landing.output, landing.offset], `round ${round}`);
    } else if (landing.kind === "burned") {
      assert.equal(item.location.state, "burned", `round ${round}`);
    } else if (landing.kind === "fee") {
      // A fee bit goes to the coinbase: after the subsidy (50 bits), at its offset in the fee.
      assert.deepEqual(item.location.state === "located" ? [item.location.txid, item.location.offset] : null, ["c2", 50n + landing.offset], `round ${round}`);
    } else {
      assert.equal(item.location.state, "unbound", `round ${round}`);
    }
  }
  // The random cases reach the placements that matter, so the comparison means something.
  assert.ok(tally.output > 20 && tally.burned > 5 && tally.fee > 5, JSON.stringify(tally));
});

test("a sale that passes the checks gives the buyer the P2MR Inscription, by the indexer's own FIFO", () => {
  const SCRIPT = new Uint8Array([0x52, 0x20, ...new Uint8Array(32).fill(1)]);
  const sale = primary();
  const inscribed = sale.inscribed;
  const display = (txid: Uint8Array) => Buffer.from(txid).reverse().toString("hex");
  const reveal: ChainTx = {
    txid: display(inscribed.txid),
    inputs: [{ prevTxid: "0".repeat(64), prevVout: 0, value: inscribed.value, leafScript: itemsLeaf(new Uint8Array(32).fill(7), [{ body: Uint8Array.of(1), contentType: "text/plain" }]) }],
    outputs: [{ value: inscribed.value, script: inscribed.scriptPubKey }],
  };
  const psbt = primarySalePsbt(sale);
  assert.equal(checkPurchasePsbt(psbt, {
    heldAt: (txid, vout) => (txid === reveal.txid && vout === 0 ? [0n] : []),
  }).ok, true);
  const coins = [sale.paddingA, sale.paddingB, sale.inscribed, sale.funding];
  const outputs = [
    { value: 40_000n, script: walletScript },
    { value: 10_000n, script: sale.receiveScript },
    { value: 50_000n, script: sellerScript },
    { value: 150_000n, script: walletScript },
  ];
  const spend: ChainTx = {
    txid: "d".repeat(64),
    inputs: coins.map((entry) => ({ prevTxid: display(entry.txid), prevVout: entry.vout, value: entry.value })),
    outputs,
  };
  const indexer = new Indexer();
  indexer.applyBlock({ hash: "h1", height: 1, subsidy: 50n, txs: [{ txid: "c1".padEnd(64, "0"), inputs: [{ coinbase: true, value: 50n }], outputs: [{ value: 50n, script: SCRIPT }] }, reveal] });
  indexer.applyBlock({ hash: "h2", height: 2, subsidy: 50n, txs: [{ txid: "c2".padEnd(64, "0"), inputs: [{ coinbase: true, value: 50n }], outputs: [{ value: 50n, script: SCRIPT }] }, spend] });
  const item = indexer.get(`${reveal.txid}i0`)!;
  assert.equal(item.location.state, "located");
  if (item.location.state === "located") {
    assert.equal(item.location.vout, 1);
    assert.equal(item.location.offset, 0n);
    assert.equal(item.ownerScript, Buffer.from(sale.receiveScript).toString("hex"));
  }
});

test("offsetsFromOutputAnswer reads the answer of the real /output endpoint, and refuses anything else", async () => {
  const SCRIPT = new Uint8Array([0x52, 0x20, ...new Uint8Array(32).fill(1)]);
  const dir = mkdtempSync(join(tmpdir(), "sale-api-"));
  const store = new Store(join(dir, "a.sqlite"), { network: "regtest" });
  store.bindActivation(1);
  // Input 0 is plain (7 bits), input 1 carries the P2MR Inscription: its bit sits at offset 7 of the one output.
  const reveal: ChainTx = {
    txid: "e".repeat(64),
    inputs: [
      { prevTxid: "0".repeat(64), prevVout: 0, value: 7n },
      { prevTxid: "0".repeat(64), prevVout: 1, value: 10_000n, leafScript: itemsLeaf(new Uint8Array(32).fill(7), [{ body: Uint8Array.of(1), contentType: "text/plain" }]) },
    ],
    outputs: [{ value: 10_007n, script: SCRIPT }],
  };
  store.commit({ hash: "a", height: 1, subsidy: 50n, txs: [{ txid: "c1", inputs: [{ coinbase: true, value: 50n }], outputs: [{ value: 50n, script: SCRIPT }] }, reveal] });
  const api = await startApi(store, 0, "regtest");
  try {
    const held = async (outpoint: string) => offsetsFromOutputAnswer(await (await fetch(`${api.url}/output/${outpoint}?limit=1000`)).json());
    assert.deepEqual(await held(`${reveal.txid}:0`), [7n]);
    assert.deepEqual(await held(`${reveal.txid}:1`), []);
    assert.deepEqual(await held(`${"f".repeat(64)}:0`), []);
  } finally {
    await api.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => offsetsFromOutputAnswer({ error: "bad gateway" }), TypeError);
  assert.throws(() => offsetsFromOutputAnswer(null), TypeError);
  assert.throws(() => offsetsFromOutputAnswer({ inscriptions: [{}] }), TypeError);
  assert.throws(() => offsetsFromOutputAnswer({ inscriptions: [{ location: { state: "located", offset: 7 } }] }), TypeError);
  assert.deepEqual(offsetsFromOutputAnswer({ inscriptions: [{ location: { state: "burned" } }, { location: { state: "located", offset: "12" } }] }), [12n]);
});
