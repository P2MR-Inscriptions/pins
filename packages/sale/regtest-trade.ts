// SPDX-License-Identifier: Apache-2.0

/**
 * A runnable trade of one P2MR Inscription on a local regtest node (PINS-6, Draft). Regtest only.
 *
 *   node --experimental-strip-types packages/sale/regtest-trade.ts \
 *     --rpc http://127.0.0.1:18452/ --rpc-user USER --rpc-password PASSWORD \
 *     --indexer http://127.0.0.1:8787 --id <P2MR Inscription id> \
 *     --seller-wallet seller --buyer-wallet buyer --price 50000 --mine
 *
 * The seller and the buyer are two wallets of the same Qbit Core node. The seller wallet holds the P2MR Inscription
 * in a plain `mr(pk(...))` output. The buyer wallet holds three other coins. The script builds the clean template of
 * PINS-6 section 4.1 with `primarySalePsbt`, has the buyer check it with `checkPurchasePsbt` against the indexer,
 * has the seller wallet sign input 2 with `SIGHASH_SINGLE | SIGHASH_ANYONECANPAY` (`0x83`), checks the PSBT again,
 * has the buyer wallet sign the other inputs, broadcasts, and waits until the indexer shows the buyer as the owner.
 *
 * What this shows and what it does not: Qbit Core's own wallet can sign `0x83` (`walletprocesspsbt` with the sighash
 * type `SINGLE|ANYONECANPAY`), so here one node plays both sides. Qbit Wallet (the browser extension, v1.0.7, PINS-6
 * section 7) signs only `SIGHASH_DEFAULT`, so a holder cannot make a `0x83` listing with it today. Nothing here keeps
 * a signing key online outside the node's wallets, and the script refuses any network but regtest.
 */
import { pathToFileURL } from "node:url";
import { bytesToHex, hexToBytes, buildControlBlock, p2mrLeafHash, p2mrScriptPubKey, parsePsbt, psbtUnsignedTransaction, serializePsbt, type Psbt, singleKeyLeafScript, P2MR_LEAF_VERSION_V1, addressToScriptPubKey } from "@qbit-oss/protocol";
import { httpRpc, type Rpc } from "../indexer/follow.ts";
import { DUST_BITS, checkPurchasePsbt, offsetsFromOutputAnswer, outpointsOf, type PurchaseReport } from "./checks.ts";
import { primarySalePsbt, type SaleCoin } from "./psbt.ts";

export type Unspent = { txid: string; vout: number; amount: number; scriptPubKey: string; desc?: string };

/** The 32-byte key of a descriptor `mr(pk(<64 hex>))#checksum`, the plain single-key P2MR output of a Qbit Core wallet. */
export function pubkeyFromDescriptor(desc: string): Uint8Array {
  const match = /^mr\(pk\(([0-9a-f]{64})\)\)(#[a-z0-9]{8})?$/.exec(desc);
  if (!match) throw new Error(`not a plain single-key P2MR descriptor: ${desc}`);
  return hexToBytes(match[1]);
}

/** Whole bits of a QBT amount the node printed with eight decimals. */
export function bitsOf(amount: number): bigint {
  return BigInt(Math.round(amount * 100_000_000));
}

/** A coin of the template from what the node says, with the leaf script and control block of its single key. */
export function saleCoin(txid: string, vout: number, valueBits: bigint, scriptPubKeyHex: string, desc: string): SaleCoin {
  const leafScript = singleKeyLeafScript(pubkeyFromDescriptor(desc));
  const expected = bytesToHex(p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)));
  if (expected !== scriptPubKeyHex) throw new Error(`output ${txid}:${vout} is not the plain single-key P2MR output of its descriptor`);
  return {
    txid: hexToBytes(txid).reverse(),
    vout,
    value: valueBits,
    scriptPubKey: hexToBytes(scriptPubKeyHex),
    leafScript,
    controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
  };
}

/**
 * The buyer's three coins: the two smallest are the paddings `a` and `b`, the largest pays the price and the fee.
 * `exclude` holds outpoints the indexer says carry a P2MR Inscription; those are never spent as padding or funding.
 */
export function pickBuyerCoins(unspent: readonly Unspent[], priceBits: bigint, feeBits: bigint, exclude: ReadonlySet<string> = new Set()): { paddingA: Unspent; paddingB: Unspent; funding: Unspent } {
  const usable = unspent.filter((coin) => !exclude.has(`${coin.txid}:${coin.vout}`) && coin.desc !== undefined && /^mr\(pk\(/.test(coin.desc)).sort((x, y) => Number(bitsOf(x.amount) - bitsOf(y.amount)));
  if (usable.length < 3) throw new Error(`the buyer wallet needs three plain coins with no P2MR Inscription, it has ${usable.length}; pay it three times (see the regtest guide)`);
  const paddingA = usable[0];
  const paddingB = usable[1];
  const funding = usable[usable.length - 1];
  if (bitsOf(paddingA.amount) + bitsOf(paddingB.amount) < DUST_BITS) throw new Error(`the two smallest coins add up to less than the dust threshold of ${DUST_BITS} bits`);
  const need = priceBits + feeBits + DUST_BITS;
  if (bitsOf(funding.amount) < need) throw new Error(`the largest buyer coin holds ${bitsOf(funding.amount)} bits, and the price, the fee and a change output need ${need}`);
  return { paddingA, paddingB, funding };
}

function flags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[token.slice(2)] = true;
    else {
      out[token.slice(2)] = next;
      i += 1;
    }
  }
  return out;
}

function text(flag: Record<string, string | boolean>, name: string, fallback?: string): string {
  const value = flag[name];
  if (typeof value === "string" && value.length > 0) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function show(report: PurchaseReport): string {
  return JSON.stringify({ ok: report.ok, problems: report.problems, notChecked: report.notChecked, fee: String(report.fee) });
}

async function indexerJson(base: string, path: string): Promise<unknown> {
  const response = await fetch(new URL(path, base));
  if (!response.ok) throw new Error(`the indexer answered ${response.status} for ${path}`);
  return response.json();
}

export async function main(argv: string[]): Promise<void> {
  const flag = flags(argv);
  const base = text(flag, "rpc");
  const user = text(flag, "rpc-user");
  const password = text(flag, "rpc-password");
  const indexer = text(flag, "indexer", "http://127.0.0.1:8787");
  const id = text(flag, "id");
  const price = BigInt(text(flag, "price"));
  const fee = BigInt(text(flag, "fee", "20000"));
  const node = httpRpc(base, user, password);
  const info = await node.call<{ chain: string }>("getblockchaininfo");
  if (info.chain !== "regtest") throw new Error(`this example runs on regtest only; the node is on ${info.chain}`);
  const wallet = (name: string): Rpc => httpRpc(new URL(`wallet/${encodeURIComponent(name)}`, base).href, user, password);
  const seller = wallet(text(flag, "seller-wallet"));
  const buyer = wallet(text(flag, "buyer-wallet"));

  // 1. What is for sale, and where it is.
  const row = await indexerJson(indexer, `inscription/${id}`) as { id: string; location: { state: string; txid: string; vout: number; offset: string }; ownerAddress: string; burned?: boolean };
  if (row.location.state !== "located" || row.location.offset !== "0") throw new Error(`${id} is not at offset 0 of an output (state ${row.location.state}, offset ${row.location.offset}); the clean template sells an output whose first bit it is`);
  const out = await node.call<{ value: number; scriptPubKey: { hex: string } } | null>("gettxout", [row.location.txid, row.location.vout, true]);
  if (out === null) throw new Error("the output of that P2MR Inscription is spent or unknown to the node");
  const owner = await seller.call<{ ismine: boolean; desc?: string }>("getaddressinfo", [row.ownerAddress]);
  if (!owner.ismine || !owner.desc) throw new Error(`the seller wallet does not hold ${row.ownerAddress}; it is the owner of ${id}`);
  const inscribed = saleCoin(row.location.txid, row.location.vout, bitsOf(out.value), out.scriptPubKey.hex, owner.desc);
  say(`P2MR Inscription ${id} sits in ${row.location.txid}:${row.location.vout}, ${inscribed.value} bits, owned by ${row.ownerAddress}`);

  // 2. The buyer's coins, never one that carries a P2MR Inscription.
  const unspent = await buyer.call<Unspent[]>("listunspent", [1]);
  const carrying = new Set<string>();
  for (const coin of unspent) {
    const answer = await indexerJson(indexer, `output/${coin.txid}:${coin.vout}`);
    if (offsetsFromOutputAnswer(answer).length > 0) carrying.add(`${coin.txid}:${coin.vout}`);
  }
  const picked = pickBuyerCoins(unspent, price, fee, carrying);
  const coinOf = (coin: Unspent): SaleCoin => saleCoin(coin.txid, coin.vout, bitsOf(coin.amount), coin.scriptPubKey, coin.desc ?? "");
  const paddingA = coinOf(picked.paddingA);
  const paddingB = coinOf(picked.paddingB);
  const funding = coinOf(picked.funding);

  // 3. Build the clean template.
  const scriptOf = async (rpc: Rpc): Promise<Uint8Array> => addressToScriptPubKey(await rpc.call<string>("getnewaddress"), "regtest");
  const receiveScript = await scriptOf(buyer);
  const psbt = primarySalePsbt({
    paddingA,
    paddingB,
    inscribed,
    funding,
    receiveScript,
    paddingReturnScript: await scriptOf(buyer),
    sellerScript: await scriptOf(seller),
    changeScript: await scriptOf(buyer),
    price,
    postage: inscribed.value,
    changeValue: funding.value - price - fee,
  });
  say(`built the clean template: price ${price} bits, fee ${fee} bits`);

  // 4. The buyer checks it against the indexer before anything is signed.
  const check = async (bytes: Uint8Array, label: string): Promise<void> => {
    const table = new Map<string, bigint[]>();
    for (const { txid, vout } of outpointsOf(parsePsbt(bytes))) {
      table.set(`${txid}:${vout}`, offsetsFromOutputAnswer(await indexerJson(indexer, `output/${txid}:${vout}?limit=1000`)));
    }
    const report = checkPurchasePsbt(bytes, {
      expectedReceiveScript: receiveScript,
      expectedSellerPayment: price,
      heldAt: (txid, vout) => table.get(`${txid}:${vout}`),
      strict: true,
    });
    say(`buyer check (${label}): ${show(report)}`);
    if (!report.ok || report.notChecked.length > 0) throw new Error(`refusing to go on: ${show(report)}`);
  };
  await check(serializePsbt(psbt), "listing");
  if (flag["dry-run"] === true) {
    say("--dry-run: stopping before any signature");
    return;
  }

  // 5. The seller signs input 2 with 0x83. Qbit Core finalizes that input, which also drops its sighash field: the
  // sighash type is then the last byte of the signature in the witness. The outputs must be the ones the buyer checked.
  const listed = await seller.call<{ psbt: string; complete: boolean }>("walletprocesspsbt", [Buffer.from(serializePsbt(psbt)).toString("base64"), true, "SINGLE|ANYONECANPAY"]);
  say(`seller signed the listing with SINGLE|ANYONECANPAY (0x83); complete: ${listed.complete}`);
  if (listed.complete) throw new Error("the seller wallet completed the whole transaction; it holds a buyer input too. Use two wallets");
  const outputsOf = (value: Psbt): string[] => psbtUnsignedTransaction(value).outputs.map((output) => `${output.value}:${bytesToHex(output.scriptPubKey)}`);
  const sameOutputs = JSON.stringify(outputsOf(parsePsbt(new Uint8Array(Buffer.from(listed.psbt, "base64"))))) === JSON.stringify(outputsOf(psbt));
  if (!sameOutputs) throw new Error("the PSBT the seller wallet returned has other outputs than the listing the buyer checked");

  // 6. The buyer signs the other inputs, then finalizes. No sighash type is named: the buyer inputs carry none, so
  // they are signed with SIGHASH_DEFAULT, which commits to every output.
  const bought = await buyer.call<{ psbt: string; complete: boolean }>("walletprocesspsbt", [listed.psbt, true]);
  if (!bought.complete) throw new Error("the buyer wallet could not complete the transaction");
  const done = await node.call<{ hex: string; complete: boolean }>("finalizepsbt", [bought.psbt]);
  if (!done.complete) throw new Error("the PSBT is not complete after signing");
  const decoded = await node.call<{ vin: { txinwitness?: string[] }[] }>("decoderawtransaction", [done.hex]);
  const sellerSignature = decoded.vin[2]?.txinwitness?.[0] ?? "";
  if (!sellerSignature.endsWith("83")) throw new Error("input 2 is not signed with 0x83");
  if (decoded.vin.some((input, index) => index !== 2 && (input.txinwitness?.[0] ?? "").length === 0)) throw new Error("an input has no witness");
  const txid = await node.call<string>("sendrawtransaction", [done.hex]);
  say(`broadcast ${txid}`);
  if (flag.mine === true) {
    await node.call("generatetoaddress", [6, await buyer.call<string>("getnewaddress")]);
    say("mined 6 blocks");
  }

  // 7. Read the new owner from the indexer, after the 6 confirmations of PINS-2 section 4.3.
  const want = bytesToHex(receiveScript);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const now = await indexerJson(indexer, `inscription/${id}`) as { ownerScript: string; location: { txid: string } };
    if (now.ownerScript === want) {
      say(`the indexer shows the buyer as owner of ${id}, in ${now.location.txid}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("the indexer does not show the buyer as the owner yet. Mine 6 blocks (--mine) and look at /inscription/<id> again");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "trade failed"}\n`);
    process.exit(1);
  });
}
