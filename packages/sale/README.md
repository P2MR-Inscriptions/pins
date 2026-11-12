<!-- SPDX-License-Identifier: Apache-2.0 -->

# PSBT trades (library)

Code for the trade of PINS-6 (Draft): a buyer pays and receives a P2MR Inscription in one Qbit transaction, or nothing happens. The seller signs one input with `0x83` (`SIGHASH_SINGLE | SIGHASH_ANYONECANPAY`), the buyer completes and signs the rest.

This is a **library**. There is no command line, no HTTP route and no wallet in this repository for a trade. You call these functions from your own program (a marketplace, a sale server, a wallet). It never signs, never broadcasts, and never talks to a node or an indexer by itself. It changes no rule of the indexer: ownership is decided by the indexer's FIFO rule (PINS-3 §3) whatever these checks say. The checks only keep a builder from making a bad trade and let a buyer refuse to sign one.

## Where it fits

| Step | Who | Tool |
|---|---|---|
| Mint a single P2MR Inscription, or a collection with or without a sale | creator | the inscriber, [README](../../README.md#single-inscriptions) and [launch guide](../../docs/guides/COLLECTION-LAUNCH.md) |
| Follow the chain, read who holds what | anyone | the indexer and its API, [API.md](../../docs/indexer/API.md) |
| Look at it | anyone | the explorer (`explorer/`) |
| **Build the trade PSBT** | seller or sale server | `primarySalePsbt` (this package) |
| **Check the PSBT before signing** | buyer | `checkPurchasePsbt` (this package) |
| Sign (seller `0x83`, buyer default), finalize, extract | seller, buyer | `signP2mrPsbt`, `finalizeP2mrPsbt`, `extractP2mrTransaction` of `@qbit-oss/protocol` (its `docs/signing-and-finalization.md`) |
| Broadcast | buyer | your node's `sendrawtransaction` |
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

It takes a PSBT, as an object or as bytes (bytes are parsed with a size limit, and hostile bytes give a problem, not an exception), and returns `{ ok, problems, warnings, notChecked, fee, landing }`. `assertPurchasePsbt` throws a `PurchaseCheckError` that carries the same report.

| PINS-6 §4.4 | Check | Needs |
|---|---|---|
| 1 | `U` holds the expected P2MR Inscription at offset 0, and what else it holds (warning) | `heldAt` |
| 2 | The bit lands, by FIFO, in the receive output, at the expected offset, and not in another output, the fee or a burn (`OP_RETURN`) | the PSBT |
| 3 | No input of the buyer holds a P2MR Inscription | `heldAt` |
| 4 | Every output is P2MR, `OP_RETURN` or PayToAnchor, and no P2MR output is dust | the PSBT |
| §4.3 | The receive output is P2MR, is the script the buyer chose, and is not a sale holding address | `expectedReceiveScript`, `holdingScripts` |
| §3, §4.1 | The seller input requires `0x83` and has an output at its own index. Every other input requires the default sighash | the PSBT |
| §4.1 | The fee is not negative, every input has its witness UTXO, no two inputs are the same output | the PSBT |

A check that needs an option you did not give is listed in `notChecked`, never silently skipped, and a program should treat a non-empty `notChecked` as "not yet safe". For the compact template of PINS-6 §4.2 pass `sellerInput: 1`, `receiveOutput: 0` and `landingOffset: a`.

The amounts and scripts of the inputs are read **from the PSBT**. A PSBT can state an amount the chain does not hold, so compare the inputs with your node (`gettxout`) before you sign. PayToAnchor outputs are accepted but not dust-checked.

## Example

```ts
import { primarySalePsbt } from "./psbt.ts";
import { checkPurchasePsbt, offsetsFromOutputAnswer, outpointsOf } from "./checks.ts";

// Seller or sale server: build. `sale` holds the four input coins, the scripts, price, postage, change.
const psbt = primarySalePsbt(sale); // throws if a number of PINS-6 section 4.1 is wrong

// Buyer: before signing, ask the indexer what each input holds, then check.
const table = new Map<string, bigint[]>();
for (const { txid, vout } of outpointsOf(psbt)) {
  const answer = await (await fetch(`${INDEXER}/output/${txid}:${vout}?limit=1000`)).json();
  table.set(`${txid}:${vout}`, offsetsFromOutputAnswer(answer));
}
const report = checkPurchasePsbt(psbt, {
  expectedReceiveScript: myScript,
  holdingScripts: [saleHoldingScript],
  expectedSellerPayment: price,
  heldAt: (txid, vout) => table.get(`${txid}:${vout}`),
  strict: true,
});
if (!report.ok || report.notChecked.length > 0) throw new Error(JSON.stringify(report));
// Only now sign the buyer's inputs, finalize, extract and broadcast.
```

`txid` in `heldAt`, in `outpointsOf` and in the indexer API is the usual display-order hex. A PSBT stores outpoints in internal byte order, which these functions reverse for you.

## Tests

`checks.test.ts` and `psbt.test.ts` run with the root tests (`npm test`). They include a comparison of `fifoLanding` with the indexer's own placement on 300 random transactions (payout, burn, fee), a check that a sale built here gives the buyer the P2MR Inscription in the indexer, and a read of the real `/output` endpoint.
