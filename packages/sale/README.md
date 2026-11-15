<!-- SPDX-License-Identifier: Apache-2.0 -->

# PSBT trades (library)

Code for the trade of PINS-6: a buyer pays and receives a P2MR Inscription in one Qbit transaction, or nothing happens. The seller signs one input with `0x83` (`SIGHASH_SINGLE | SIGHASH_ANYONECANPAY`), the buyer completes and signs the rest.

This is a **library**. There is no HTTP route, no wallet and no sale server in this repository. You call these functions from your own program (a marketplace, a sale server, a wallet). The library itself never signs, never broadcasts, and never talks to a node or an indexer. One runnable example, `regtest-trade.ts` (below), does all of that on a regtest node, so you can see one trade from start to end. It changes no rule of the indexer: ownership is decided by the indexer's FIFO rule (PINS-3 §3) whatever these checks say. The checks only keep a builder from making a bad trade and let a buyer refuse to sign one.

## Where it fits

| Step | Who | Tool |
|---|---|---|
| Inscribe a single P2MR Inscription, or a collection with or without a sale | creator | the inscriber, [single guide](../../docs/guides/SINGLE-INSCRIPTION.md) and [launch guide](../../docs/guides/COLLECTION-LAUNCH.md) |
| Follow the chain, read who holds what | anyone | the indexer and its API, [API.md](../../docs/indexer/API.md) |
| Look at it | anyone | the explorer (`explorer/`) |
| **Build the trade PSBT** | seller or sale server | `primarySalePsbt` (this package) |
| **Check the PSBT before signing** | buyer | `checkPurchasePsbt` (this package) |
| Sign (seller `0x83`, buyer default), finalize, extract | seller, buyer | `signP2mrPsbt`, `finalizeP2mrPsbt`, `extractP2mrTransaction` of `@qbit-oss/protocol` (its file `node_modules/@qbit-oss/protocol/docs/signing-and-finalization.md`) |
| Broadcast | buyer | your node's `sendrawtransaction` |
| **Move the unsold items** to the committed address (PINS-5 §8.5) | issuer | `unsoldTransferPsbt` and `verifyUnsoldTransferPsbt` (this package), or the `unsold-transfer` command of the inscriber |
| Wait 6 confirmations, then read the new owner | anyone | the indexer, `/inscription/{id}` (PINS-2 §4.3) |

A collection with a sale lists its items for sale this way (PINS-6 §6, the price is the issuer's `price_bits`). A collection with no sale, and a single P2MR Inscription, can still be sold by their owner with the same template (PINS-6 §3 and §4). The checks do not depend on a collection.

## What `primarySalePsbt` builds

The clean template of PINS-6 §4.1, for the primary sale of §6:

| Index | Inputs | Outputs |
|---|---|---|
| 0 | buyer padding `a` | padding return, `a + b` |
| 1 | buyer padding `b` | **the buyer receives the P2MR Inscription**, exactly the value `v_U` of the seller's output |
| 2 | seller output `U`, with `PSBT_IN_SIGHASH_TYPE = 0x83` | seller payment, `price` |
| 3 | buyer funding | change |

The seller's signature is not in the result: the PSBT carries the `0x83` requirement, and the seller adds the signature. Inputs 0, 1 and 3 have no sighash type, so the buyer signs them with `SIGHASH_DEFAULT`, which commits to every output.

`primarySalePsbt` refuses, and says which number is wrong (`checkPrimarySale` gives the same list without building):

- `a + b` below the dust threshold of 2,855 bits (`DUST_BITS`);
- a receive output that is not exactly the value of `U`, or below dust;
- a seller payment or a change output below dust (fold a tiny change into the fee);
- outputs that exceed the inputs (a negative fee);
- an amount that is not a whole number of bits, or two inputs that are the same output;
- a script that Qbit's restricted-output mode does not allow (the protocol library refuses it);
- after building, anything `checkPurchasePsbt` finds in the result, in strict mode.

It does not choose the receive address, check its network, or know the sale holding address. Do that first (PINS-6 §4.3), and pass the holding address to `checkPurchasePsbt` as `holdingScripts` when the buyer checks.

## What `checkPurchasePsbt` checks (PINS-6 §4.4)

It takes a PSBT, as an object or as bytes (bytes are parsed with a size limit, and hostile bytes give a problem, not an exception), and returns `{ ok, complete, problems, warnings, notChecked, fee, landing }`. `assertPurchasePsbt` throws a `PurchaseCheckError` that carries the same report.

| PINS-6 §4.4 | Check | Needs |
|---|---|---|
| 1 | `U` holds the expected P2MR Inscription at offset 0, and what else it holds (warning) | `heldAt` |
| 2 | The bit lands, by FIFO, in the receive output, at the expected offset, and not in another output, the fee or a burn (`OP_RETURN`) | the PSBT |
| 3 | No input of the buyer holds a P2MR Inscription | `heldAt` |
| 4 | Every output is P2MR, `OP_RETURN` or PayToAnchor, and no P2MR output is dust | the PSBT |
| §4.3 | The receive output is P2MR, is the script the buyer chose, and is not a sale holding address | `expectedReceiveScript`, `holdingScripts` |
| §3, §4.1 | The seller input is signed with `0x83` and has an output at its own index. Every other input is signed with the default sighash. The type is read from the signature (see below) | the PSBT |
| §4.1 | The fee is not negative, every input has its witness UTXO, no two inputs are the same output | the PSBT |
| §4.4 | Every input is the unspent output the node holds: the amount and the script of its witness UTXO are the ones `gettxout` reports | `utxoAt` |
| §4.4 | The script of every input is in the tree of the output it spends: a leaf script of the PSBT (or the script and control block of a final witness) hashes along its control block to the output's Merkle root | the PSBT |

For the compact template of PINS-6 §4.2 pass `sellerInput: 1`, `receiveOutput: 0` and `landingOffset: a`. PayToAnchor outputs are accepted but not dust-checked.

### The check fails closed

The amounts and scripts of the inputs are read **from the PSBT**, and a PSBT can state an amount or a script that the chain does not hold. So a trade is `ok` only when every check ran:

- `complete` is `true` when nothing is in `notChecked` and the PSBT was read to the end. It is `false` when `heldAt` or `utxoAt` was not given, when the indexer does not know an input (`heldAt` returned `undefined`), when an input has no leaf script to check, or when the PSBT could not be read.
- A check that was skipped is listed in `notChecked` and, by default, is a problem (`not-checked`): `ok` is `false` and `assertPurchasePsbt` throws. Only a report with `ok: true` and `complete: true` is safe to sign.
- `allowNotChecked: true` accepts the skipped checks. Use it only when your program verifies those facts another way. `ok` can then be `true` while `complete` stays `false`, so the gap stays visible in the report. A real problem is a problem with the option too.
- `primarySalePsbt` has no node and no indexer, so it builds with `allowNotChecked: true` and what it returns is `complete: false`. The buyer runs the full check on the PSBT, with both lookups, before signing.

### Where the sighash type comes from

Qbit Core drops `PSBT_IN_SIGHASH_TYPE` when it signs and finalizes an input, so a signed PSBT does not say which type it used. The type is in the signature: a P2MR signature of 3680 bytes is `SIGHASH_DEFAULT`, and one of 3681 bytes is the 3680-byte signature followed by its type byte (`0x83` for the listing). `sighashTypeOfSignature` reads it, and the check reads every signature of an input (final witness and partial signatures) before it falls back to the PSBT field, and to the default when an input has neither. A field that disagrees with a signature is a problem (`sighash-conflict`). The recorded regtest trade TV6-1 (a `0x83` signature of 3681 bytes between three default ones of 3680) is in the tests.

### The node: `utxoAt`

`utxoAt(txid, vout)` returns the `{ value, scriptPubKey }` the node holds at an output, or `undefined` when it holds none. Fill it from `gettxout <txid> <vout> true` with `utxoFromGetTxOut`, which turns the node's `null` (spent or unknown) into `undefined` and refuses an answer that has no amount or script:

```ts
const answer = await rpc("gettxout", [txid, vout, true]); // include the mempool
chain.set(`${txid}:${vout}`, utxoFromGetTxOut(answer));
```

An input that the node holds as another amount (`utxo-amount`), with another script (`utxo-script`), or not at all (`utxo-missing`) is a problem. The amount is in bits: `bitsOf(0.0001)` is `10000n`.

## Example

```ts
import { primarySalePsbt } from "./psbt.ts";
import { checkPurchasePsbt, offsetsFromOutputAnswer, outpointsOf, utxoFromGetTxOut, type ChainUtxo } from "./checks.ts";

// Seller or sale server: build. `sale` holds the four input coins, the scripts, price, postage, change.
const psbt = primarySalePsbt(sale); // throws if a number of PINS-6 section 4.1 is wrong

// Buyer: before signing, ask the indexer what each input holds and the node what each input is, then check.
const held = new Map<string, bigint[] | undefined>();
const chain = new Map<string, ChainUtxo | undefined>();
for (const { txid, vout } of outpointsOf(psbt)) {
  const answer = await (await fetch(`${INDEXER}/output/${txid}:${vout}?limit=1000`)).json();
  held.set(`${txid}:${vout}`, offsetsFromOutputAnswer(answer)); // undefined when the indexer does not know the output
  chain.set(`${txid}:${vout}`, utxoFromGetTxOut(await rpc("gettxout", [txid, vout, true])));
}
const report = checkPurchasePsbt(psbt, {
  expectedReceiveScript: myScript,
  holdingScripts: [saleHoldingScript],
  expectedSellerPayment: price,
  heldAt: (txid, vout) => held.get(`${txid}:${vout}`),
  utxoAt: (txid, vout) => chain.get(`${txid}:${vout}`),
  strict: true,
});
// `ok` is false when a problem was found or a check was skipped. `report.complete` says that every check ran.
if (!report.ok) throw new Error(JSON.stringify(report, (_key, value) => (typeof value === "bigint" ? value.toString() : value)));
// Only now sign the buyer's inputs, finalize, extract and broadcast.
```

`txid` in `heldAt`, in `utxoAt`, in `outpointsOf` and in the indexer API is the usual display-order hex. A PSBT stores outpoints in internal byte order, which these functions reverse for you.

`offsetsFromOutputAnswer` reads the answer of `/output/{txid}:{vout}` ([API.md](../../docs/indexer/API.md#output)). It gives the offsets of the P2MR Inscriptions the output holds (`[]` for an output the indexer knows that holds none), and `undefined` for `known: false`, an output the indexer has no record of. It throws on an answer that has no `known` flag, that lists rows for an unknown output, or that is only one page of a longer list, so none of those is read as "holds nothing".

## The unsold transfer (`unsold.ts`)

At the close of a sale, the sale items nobody bought go to the `unsold_address` the issuer committed (PINS-5 §8.5). `unsold.ts` builds that transfer as an unsigned PSBT and reads the commitment. It signs nothing and talks to no node.

| Function | What it does |
|---|---|
| `keyCoin(txid, vout, value, key)` | A coin of the plain single-key P2MR output of `key`, with its script, leaf script and control block taken from the key |
| `checkUnsoldTransfer(transfer)` | The numbers and shapes of a transfer: at least one item and at most `UNSOLD_MAX_ITEMS`, P2MR scripts, no duplicate input, nothing below dust, the change not going to the unsold address, an item not already at it |
| `unsoldTransferPsbt(transfer)` | The PSBT. Inputs `0 .. n-1` are the items, input `n` is a plain fee coin. Output `i` pays the unsold address the value of input `i`, and the last output is the fee coin's change. It throws, naming every problem, and reads its own PSBT back with the verifier before it returns it |
| `verifyUnsoldTransferPsbt(psbt, { unsoldScript, items })` | Reads any PSBT and names what stops it from being that shape: an output that is not the unsold address, a value that is not its input's, a change to the unsold address, a fee below 0, a missing UTXO, a duplicate input |
| `unsoldTransferWeight`, `unsoldTransferFee`, `unsoldChunks`, `UNSOLD_MAX_ITEMS` | The signed size (weight equals size on Qbit), the fee at a rate, and the split of a longer list into standard transactions: at most 104 items each |
| `unsoldCommitmentOf(rows, collection)` | The `pins-unsold-address/1` commitment of a collection, from the rows of the indexer's `/inscriptions`, by the rule of PINS-5 §8.5: the first valid one after the genesis, before the sale reveal, in chain order |

By first in, first out (PINS-3 §3), the bits of input `i` are the bits of output `i`, so every P2MR Inscription of an item keeps its offset, and the fee coin, last, puts no bit into an item output. The fee coin must hold no P2MR Inscription: the library cannot see that, so the caller checks it with the indexer's `/output/{txid}:{vout}`. `unsold-transfer` of the inscriber is the command line of this module, and [Close the sale](../../docs/guides/SALE-AND-TRADE.md#close-the-sale) walks through it. `unsold.test.ts` covers it with the real FIFO function of `checks.ts` and the size measured on Qbit Core v1.0.1.

## Run a trade on regtest

`regtest-trade.ts` sells one P2MR Inscription between two wallets of a regtest node. Qbit Core's wallet signs on both sides, with `0x83` for the seller. It is an example of how the pieces fit, for regtest only (it refuses to run against another chain), and not a marketplace.

```text
node --experimental-strip-types packages/sale/regtest-trade.ts --rpc http://127.0.0.1:18452/ --rpc-user USER --rpc-password PASSWORD --indexer http://127.0.0.1:8787 --id <P2MR Inscription id> --seller-wallet holder --buyer-wallet buyer --price 50000 --mine
```

| Flag | Meaning |
|---|---|
| `--rpc` and the login: `--rpc-user` with `--rpc-password`, `--rpc-cookie-file` or `--rpc-datadir` | The regtest node ([Log in to your node](../../docs/guides/NODE-LOGIN.md)). The two wallets are named by `--seller-wallet` and `--buyer-wallet` |
| `--indexer` | The indexer API (default `http://127.0.0.1:8787`) |
| `--id` | The P2MR Inscription to sell. It must be at offset 0 of an output the seller wallet owns |
| `--price` | The seller's payment, in bits |
| `--fee` | The transaction fee in bits (default 20,000) |
| `--mine` | Mine 6 blocks to the buyer so the indexer shows the new owner. Without it the transaction stays in the mempool |
| `--dry-run` | Build, sign the seller input and run the buyer's check, then stop before the buyer signs and sends |

What it does, in order: reads the P2MR Inscription and its output from the indexer and the node; picks three coins of the buyer wallet (the two smallest are the paddings, the largest funds the price and the fee), leaving out any coin that holds a P2MR Inscription or that the indexer does not know; builds the template with `primarySalePsbt`; runs `checkPurchasePsbt` in strict mode with the indexer's `/output` answers and the node's `gettxout` answers, and stops unless the report is `ok` and `complete`; has the seller wallet sign input 2 with `SINGLE|ANYONECANPAY`; checks that signing changed no output; has the buyer wallet sign and finalize; checks that the seller input's witness ends with `83`; sends; and waits until the indexer lists the buyer's address as the owner.

Wallet support: Qbit Core's wallet signs `0x83` (this example). Qbit Wallet v1.0.9, the browser extension, does not sign `0x83`; the buyer's side with the default hash type works in both. The signature types are in PINS-6 §7, and [the wallet table](../../docs/guides/SALE-AND-TRADE.md#wallet-support) has the detail. [Sell and trade](../../docs/guides/SALE-AND-TRADE.md) covers the sale secret and how a primary sale is served, and [the regtest guide](../../docs/guides/REGTEST.md#9-trade-a-p2mr-inscription) runs this from a fresh node.

## Tests

`checks.test.ts`, `checks-fail-closed.test.ts`, `psbt.test.ts` and `unsold.test.ts` run with the root tests (`npm test`). `checks-fail-closed.test.ts` covers `complete` and `allowNotChecked`, `utxoAt`, the sighash type read from the real transaction of TV6-1, and the script check. `checks.test.ts` includes a comparison of `fifoLanding` with the indexer's own placement on 300 random transactions (payout, burn, fee), a check that a sale built here gives the buyer the P2MR Inscription in the indexer, and a read of the real `/output` endpoint.
