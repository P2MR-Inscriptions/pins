<!-- SPDX-License-Identifier: Apache-2.0 -->

# Sell and trade P2MR Inscriptions

This guide covers what happens after the mint: how a P2MR Inscription is sold, what the sale secret of a collection is and what to do with it, and how the PSBTs of a primary sale are served. PINS-6 (Draft) is the rule, [packages/sale](../../packages/sale/README.md) is the library, and [Try it on your own regtest node](REGTEST.md#9-trade-a-p2mr-inscription) runs a trade end to end.

It says plainly what the repository does and does not contain. It contains the library that builds and checks a trade PSBT, and a regtest example that runs one. It contains **no sale server and no wallet**, and no command that closes a sale.

## Who sells what

| What | Who sells | How |
|---|---|---|
| A single P2MR Inscription, or an item of any collection, owned by someone | its owner | One listing: the owner builds the template, signs one input with `0x83`, and gives the PSBT to the buyer (PINS-6 §3 and §4) |
| An item of the sale set of a collection with a sale commitment, still held by the sale holding address | the issuer's sale server | Primary sale, one listing per item, released in the committed order (PINS-6 §6) |
| An item of a collection with no sale commitment | nobody, until someone owns it | Such a collection declares no primary sale, no price and no sale order (PINS-5 §8). Its items go to the creator, or to `--holder`, and an owner sells them as above |

## The trade in one transaction

The template has four inputs and four outputs. The buyer pays two small padding coins and a funding coin, the seller's output holding the P2MR Inscription is the third input, and the buyer's receive output gets exactly that output's value:

| Index | Inputs | Outputs |
|---|---|---|
| 0 | buyer padding `a` | padding return `a + b` |
| 1 | buyer padding `b` | the buyer receives the P2MR Inscription |
| 2 | the seller's output, signed `0x83` | the seller's payment, `price` |
| 3 | buyer funding | change |

The seller's `0x83` signature commits to its own input and to the output at the same index (the payment) and to nothing else, so the buyer can add the rest. The buyer commits to everything with the default hash type. Because a P2MR Inscription moves with the first bit of an output (PINS-3, first in first out), the two paddings in front make the P2MR Inscription land in output 1 and nowhere else. The buyer checks that before signing, with `checkPurchasePsbt`, and the check reads what each input holds from the indexer.

The pieces, all in `packages/sale` and `@qbit-oss/protocol`:

1. `primarySalePsbt` builds the PSBT and refuses numbers that do not fit (dust, a negative fee, a wrong receive value).
2. The seller (or the sale server) signs input 2 with `0x83`.
3. `checkPurchasePsbt` (buyer): is the P2MR Inscription at offset 0 of the seller's output, does it land in the buyer's own receive output, does any input of the buyer hold a P2MR Inscription, is every output P2MR, `OP_RETURN` or anchor? The buyer must also compare the inputs with its own node (`gettxout`), because a PSBT can state an amount the chain does not hold. A non-empty `notChecked` list means "not safe yet".
4. The buyer signs, finalizes, extracts, and sends. After 6 confirmations the indexer shows the new owner.

`packages/sale/regtest-trade.ts` does all of it against a regtest node and the indexer, with Qbit Core's wallet on both sides, for one P2MR Inscription. Read it as the reference for your own program. [REGTEST.md](REGTEST.md#9-trade-a-p2mr-inscription) has the command. Run with `--dry-run` it stops after the buyer's check, and with `--mine` it makes the blocks.

### Wallet support

| Wallet | `0x83` listing (seller) | Buyer completes |
|---|---|---|
| Qbit Core wallet (`walletprocesspsbt` with `SINGLE\|ANYONECANPAY`) | works, used by the regtest example | works |
| Qbit Wallet browser extension, v1.0.7 | does not sign `0x83`, only the default hash type | works for the default hash type |

So a holder cannot list with the extension today. PINS-6 §7 records what was verified and on which date. The library does not need a wallet: it builds PSBTs and checks them, and any signer that can produce `0x83` can complete the seller's step. Whether and when a wallet adds `0x83` is up to the wallet.

Two practical rules, both learned on regtest:

- **The seller's wallet must not pay for anything from the coins that hold P2MR Inscriptions.** The node's wallet picks coins by value, and an ordinary payment can spend an output that holds a P2MR Inscription and send it away. Keep P2MR Inscriptions in a wallet that only receives and signs trades.
- **A buyer's coins must not hold a P2MR Inscription.** The example looks each of the buyer's coins up in the indexer and leaves out any that hold one.

## The sale secret

A collection with a sale commitment has a 32-byte `sale_secret` (PINS-5 §8.2). `keygen` draws it and writes it into the encrypted keyfile, with the issuer and recovery keys. `keygen --no-sale` draws none, and `assign` does not write the secret anywhere: its output has the reserve ids, the sale ids and `saleCommitment`, the SHA-256 of the secret, and that is what the genesis carries.

What the secret does:

- It selects the creator reserve (`selectReserve`). The selection is public in effect: the reserve items are sent to the creator at mint.
- It sets the order in which the sale items are sold. The order also needs the hash of the block `H_seed` (6 blocks after the genesis is confirmed), so it cannot be known before then, even by the issuer. `saleSeed(secret, blockHash)` and `saleOrder(ids, seed)` in `packages/protocol/reserve.mjs` compute it.

What to do with it:

1. **Keep the keyfile.** It is the only place the secret lives, and `preflight --key` and `assign` open it with your passphrase. Keep two encrypted copies in two places, apart from the passphrase, as `keygen` says. There is no recovery from a lost passphrase.
2. **Do not publish or paste the secret anywhere before close.** Whoever learns it can compute the sale order as soon as `H_seed` is known and buy the item they want (PINS-5 §8.2). Tell buyers that the issuer knows it from the start; the protocol does not hide that.
3. **At close, publish it** in the sale-reveal P2MR Inscription (PINS-5 §8.5, field 5 `{schema: "pins-sale-reveal/1", root, sale_secret}`, issued by the issuer key), so anyone can check the reserve and the order. The reference indexer reads it and sets `saleRevealed`.
4. **Before close, commit the address for unsold items** in a `pins-unsold-address/1` P2MR Inscription (PINS-5 §8.5). The indexer does not read it.

**Not in this repository yet:** a command that opens the keyfile to build the sale-reveal P2MR Inscription, one that builds the unsold-address commitment, and one that moves unsold items. `price` is the only post-mint command there is. A program that closes a sale today writes those two records itself with the same envelope and signing code the inscriber uses (`packages/inscriber/price.ts` is the closest model). Run on regtest, the walk-through in [REGTEST.md](REGTEST.md) covers the mint, the price, the indexer and a trade, and stops before the close.

## How primary sale PSBTs are served

The reference does not ship a server, so this is what a sale server has to do. The rules are PINS-6 §6; the steps follow from them.

1. **Hold the sale key.** The sale holding address (`--sale` at plan and sign) is controlled by `K_sale`, a key that is not the issuer key. Whoever signs `0x83` listings needs it online, so keep it apart from the keyfile and give it no more than the sale holding address.
2. **Know the order.** After `H_seed`, compute `order` from the secret (offline, on the machine that has the keyfile) and give the server only what it needs to release the next item. The server must not publish the order.
3. **Release one listing at a time.** The k-th sale delivers `order[k]`. For the next id, read `/inscription/{id}` from the indexer and check that it is located at the sale holding address at offset 0. Never publish listings in advance: a published PSBT lets anyone choose that item.
4. **Build and sign when a buyer asks.** The buyer gives a receive address (P2MR, not the sale holding address) and the three coins it will use. The server builds the template with `primarySalePsbt` (price is the `price_bits` of the price P2MR Inscription, `seller_payment = price_bits`), signs input 2 with `0x83`, and returns the PSBT. It never sees the buyer's keys.
5. **Wait for 6 confirmations** before releasing the next item to someone else, as PINS-6 §6 says. If the transaction is lost in a reorg, offer the same item again first.
6. **The buyer checks and signs.** The buyer runs `checkPurchasePsbt` with the indexer's `/output` answers and its own node, signs, finalizes and broadcasts.

On regtest you can play both roles with `regtest-trade.ts`, using the `holder` wallet's address as the sale holding address: take an id from `/inscriptions?owner=<address>` and pass it as `--id`. The example reads the location and the price you pass; it does not read the order, so for a real sale the order check stays with your server.
