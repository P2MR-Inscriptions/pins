// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { p2mrAddressFromPubkey, parsePsbt, psbtUnsignedTransaction } from "@qbit-oss/protocol";
import { UNSOLD_MAX_ITEMS, keyCoin, verifyUnsoldTransferPsbt } from "../sale/unsold.ts";
import { unsoldAddressScript } from "./records.ts";

const SALE_KEY = "05".repeat(32);
const FEE_KEY = "06".repeat(32);
const UNSOLD = p2mrAddressFromPubkey(Buffer.alloc(32, 7), "regtest");
const CHANGE = p2mrAddressFromPubkey(Buffer.alloc(32, 8), "regtest");

function cli(args: string[]): { status: number | null; out: string } {
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "packages/inscriber/cli.ts", ...args], { encoding: "utf8" });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

function files(count: number, fundingCount: number) {
  const dir = mkdtempSync(join(tmpdir(), "pins-unsold-"));
  const items = join(dir, "items.json");
  const funding = join(dir, "funding.json");
  writeFileSync(items, JSON.stringify(Array.from({ length: count }, (_, i) => ({ id: `${"aa".repeat(32)}i${i}`, txid: (i + 1).toString(16).padStart(64, "0"), vout: 1, value: "10000" }))));
  writeFileSync(funding, JSON.stringify(Array.from({ length: fundingCount }, (_, i) => ({ txid: (i + 900).toString(16).padStart(64, "0"), vout: 0, value: "1000000", pub: FEE_KEY }))));
  return { dir, items, funding, out: join(dir, "unsold") };
}

const base = (f: ReturnType<typeof files>): string[] => ["unsold-transfer", "--items", f.items, "--funding", f.funding, "--sale-pub", SALE_KEY, "--unsold-address", UNSOLD, "--change", CHANGE, "--fee-rate", "1", "--network", "regtest"];

test("unsold-transfer writes one unsigned PSBT per transaction, each of the shape of PINS-5 section 8.5", () => {
  const f = files(5, 2);
  const run = cli([...base(f), "--per-tx", "3", "--out", f.out]);
  assert.equal(run.status, 0, run.out);
  assert.match(run.out, /5 items in 2 transactions/);
  const script = unsoldAddressScript(UNSOLD, "regtest");
  for (const [index, count] of [[1, 3], [2, 2]]) {
    const bytes = Buffer.from(readFileSync(`${f.out}-${index}.psbt`, "utf8").trim(), "base64");
    assert.deepEqual(verifyUnsoldTransferPsbt(bytes, { unsoldScript: script, items: count }), []);
    assert.equal(psbtUnsignedTransaction(parsePsbt(bytes)).inputs.length, count + 1);
  }
  assert.equal(existsSync(`${f.out}-3.psbt`), false);
});

test("--dry-run writes nothing, and a count of fee coins that does not match the transactions is refused", () => {
  const f = files(4, 1);
  const dry = cli([...base(f), "--dry-run"]);
  assert.equal(dry.status, 0, dry.out);
  assert.equal(existsSync(`${f.out}-1.psbt`), false);
  const short = cli([...base(f), "--per-tx", "2", "--out", f.out]);
  assert.notEqual(short.status, 0);
  assert.match(short.out, /4 items at 2 per transaction are 2 transactions, and each needs its own fee coin; --funding has 1/);
  const tooMany = cli([...base(files(1, 1)), "--per-tx", String(UNSOLD_MAX_ITEMS + 1), "--dry-run"]);
  assert.match(tooMany.out, /per transaction/);
});

test("unsold-transfer refuses an unsold address of another network, a bad key and a node URL", () => {
  const f = files(2, 1);
  const mainnet = p2mrAddressFromPubkey(Buffer.alloc(32, 7), "mainnet");
  assert.match(cli([...base(f).map((value) => value === UNSOLD ? mainnet : value), "--dry-run"]).out, /HRP/);
  assert.match(cli([...base(f).map((value) => value === SALE_KEY ? "zz" : value), "--dry-run"]).out, /--sale-pub/);
  assert.match(cli([...base(f), "--rpc", "http://127.0.0.1:1/", "--dry-run"]).out, /offline/);
  assert.match(cli([...base(f).map((value) => value === CHANGE ? UNSOLD : value), "--dry-run"]).out, /must not go to the unsold address/);
});

test("unsold-transfer reads the rows of a wallet's listunspent as they are, and refuses a row that disagrees", () => {
  const dir = mkdtempSync(join(tmpdir(), "pins-unsold-"));
  const row = (n: number, key: string, over: Record<string, unknown> = {}) => ({
    txid: n.toString(16).padStart(64, "0"), vout: 0, amount: 0.0001, desc: `mr(pk(${key}))#abcdefgh`,
    scriptPubKey: Buffer.from(keyCoin(n.toString(16).padStart(64, "0"), 0, 10_000n, Buffer.from(key, "hex")).scriptPubKey).toString("hex"), ...over,
  });
  const write = (name: string, rows: unknown[]) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(rows));
    return path;
  };
  const common = (items: string, funding: string): string[] => ["unsold-transfer", "--items", items, "--funding", funding, "--sale-pub", SALE_KEY, "--unsold-address", UNSOLD, "--change", CHANGE, "--fee-rate", "1", "--network", "regtest", "--out", join(dir, "o")];
  const fee = write("fee.json", [row(900, FEE_KEY, { amount: 0.01 })]);
  const good = cli(common(write("items.json", [row(1, SALE_KEY), row(2, SALE_KEY)]), fee));
  assert.equal(good.status, 0, good.out);
  assert.equal(existsSync(join(dir, "o-1.psbt")), true);
  const both = cli(common(write("both.json", [row(1, SALE_KEY, { value: "10000" })]), fee));
  assert.match(both.out, /a value in bits or an amount in QBT, not both and not neither/);
  const other = cli(common(write("other.json", [row(1, FEE_KEY)]), fee));
  assert.match(other.out, /held by another key than --sale-pub/);
  const script = cli(common(write("script.json", [row(1, SALE_KEY, { scriptPubKey: "5220" + "00".repeat(32) })]), fee));
  assert.match(script.out, /not the plain single-key P2MR output/);
  const fraction = cli(common(write("fraction.json", [row(1, SALE_KEY, { amount: -1 })]), fee));
  assert.notEqual(fraction.status, 0);
});
