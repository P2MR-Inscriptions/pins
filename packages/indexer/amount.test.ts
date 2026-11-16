// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { bitsFromRpcAmount, quoteRpcAmounts, rpcAmountFromBits } from "./amount.ts";
import { formatEta, formatSyncLine } from "./progress.ts";
import { DEFAULT_PREFETCH, parsePrefetch } from "./prefetch.ts";

test("bitsFromRpcAmount reads exact 8-decimal text", () => {
  assert.equal(bitsFromRpcAmount("0.00000001"), 1n);
  assert.equal(bitsFromRpcAmount("0.00010000"), 10_000n);
  assert.equal(bitsFromRpcAmount("0.10000000"), 10_000_000n);
  assert.equal(bitsFromRpcAmount("21.00000000"), 2_100_000_000n);
  assert.equal(bitsFromRpcAmount("-1.50000000"), -150_000_000n);
  assert.equal(rpcAmountFromBits(10_000n), "0.00010000");
  assert.equal(rpcAmountFromBits(0n), "0.00000000");
  assert.equal(bitsFromRpcAmount(rpcAmountFromBits(123_456_789n)), 123_456_789n);
  assert.throws(() => bitsFromRpcAmount("0.1"), /8-decimal/);
  assert.throws(() => bitsFromRpcAmount("1.2345678"), /8-decimal/);
  assert.throws(() => bitsFromRpcAmount("1e-8"), /8-decimal/);
  assert.throws(() => bitsFromRpcAmount("1.234567890"), /8-decimal/);
});

test("bitsFromRpcAmount accepts a JSON number only as the unique 8-decimal amount it already is", () => {
  assert.equal(bitsFromRpcAmount(0.00000001), 1n);
  assert.equal(bitsFromRpcAmount(0.00010000), 10_000n);
  assert.equal(bitsFromRpcAmount(0.1), 10_000_000n);
  assert.equal(bitsFromRpcAmount(1.23456789), 123_456_789n);
  assert.equal(bitsFromRpcAmount(21_000_000), 2_100_000_000_000_000n);
  assert.equal(bitsFromRpcAmount(-1.5), -150_000_000n);
  assert.throws(() => bitsFromRpcAmount(Number.POSITIVE_INFINITY), /decimal text, not a JSON number/);
  assert.throws(() => bitsFromRpcAmount(Number.NaN), /decimal text, not a JSON number/);
  assert.throws(() => bitsFromRpcAmount(true), /decimal text, not a JSON number/);
});

test("quoteRpcAmounts keeps 0.1 QBT exact through JSON.parse for value and amount", () => {
  const raw = '{"vin":[{"prevout":{"value":0.10000000,"scriptPubKey":{"hex":"00"}}}],"unspents":[{"amount":0.00010000}],"fee":-0.00020000,"other":1.5}';
  const quoted = quoteRpcAmounts(raw);
  assert.match(quoted, /"value":"0\.10000000"/);
  assert.match(quoted, /"amount":"0\.00010000"/);
  assert.match(quoted, /"fee":"-0\.00020000"/);
  assert.match(quoted, /"other":1\.5/);
  const body = JSON.parse(quoted) as { vin: { prevout: { value: unknown } }[]; unspents: { amount: unknown }[]; fee: unknown };
  assert.equal(body.vin[0]?.prevout.value, "0.10000000");
  assert.equal(body.unspents[0]?.amount, "0.00010000");
  assert.equal(body.fee, "-0.00020000");
  assert.equal(bitsFromRpcAmount(body.vin[0]?.prevout.value), 10_000_000n);
  assert.equal(bitsFromRpcAmount(body.unspents[0]?.amount), 10_000n);
  assert.equal(bitsFromRpcAmount(body.fee), -20_000n);
});

test("parsePrefetch defaults to 8 and stays inside 1 to 32", () => {
  assert.equal(parsePrefetch(undefined), DEFAULT_PREFETCH);
  assert.equal(parsePrefetch(""), 8);
  assert.equal(parsePrefetch("1"), 1);
  assert.equal(parsePrefetch("32"), 32);
  assert.throws(() => parsePrefetch("0"), /1 to 32/);
  assert.throws(() => parsePrefetch("33"), /1 to 32/);
  assert.throws(() => parsePrefetch("8.5"), /1 to 32/);
  assert.throws(() => parsePrefetch("nope"), /1 to 32/);
});

test("formatSyncLine matches the first-sync progress shape", () => {
  assert.equal(formatEta(12), "12s");
  assert.equal(formatEta(59.4), "59s");
  assert.equal(formatEta(12 * 60), "12m");
  assert.equal(formatEta(60 * 60 + 12 * 60), "1h 12m");
  assert.equal(formatEta(2 * 60 * 60), "2h");
  assert.equal(formatSyncLine(168000, 176956, 12.4, 12 * 60), "sync 168000/176956 (95%) 12.4 blocks/s, ETA 12m");
  assert.equal(formatSyncLine(56, 100, 1, 44), "sync 56/100 (56%) 1.0 blocks/s, ETA 44s");
  assert.equal(formatSyncLine(162142, 177157, 1.8, 2 * 3600 + 18 * 60, 161948), "sync 162142/177157 (1%) 1.8 blocks/s, ETA 2h 18m");
});
