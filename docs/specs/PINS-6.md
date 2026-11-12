<!-- SPDX-License-Identifier: CC0-1.0 -->
# PINS-6: PSBT Trades

| Field | Value |
|---|---|
| Standard | PINS-6 |
| Title | PSBT Trades (atomic swaps) |
| Status | Draft. Regtest measurements are recorded. Vectors still marked TODO-regtest are open. |
| Type | Application, normative for marketplaces and wallets |
| License | CC0-1.0 |
| Requires | PINS-1, PINS-3 |

> Independent protocol, not affiliated with Qbit or Qbit-Org. Conventions: PINS-1 §2.

## 1. Abstract

PINS-6 defines a trustless sale: the buyer pays and receives the inscription in the same Qbit
transaction, or nothing happens. The seller pre-signs one input with
`SIGHASH_SINGLE | SIGHASH_ANYONECANPAY` (`0x83`); the buyer completes the transaction.

## 2. Qbit facts

| Fact | Source |
|---|---|
| Accepted hash types: `0x00, 0x01, 0x02, 0x03, 0x81, 0x82, 0x83`; anything else fails | `doc/consensus/p2mr-v1.md` §7 |
| `SIGHASH_SINGLE` on an input without an output at the same index fails (no `uint256::ONE` quirk) | `p2mr-v1.md` §7 |
| With `ANYONECANPAY`, the digest commits to the current outpoint, its spent output (amount and script) and sequence; with `SINGLE`, to the output at the same index only | `p2mr-v1.md` §7 "Message layout" |
| A non-default signature is 3,681 bytes (3,680 + type byte); `0x00` as a trailing byte is invalid | `p2mr-v1.md` §7 "Witness signature encoding" |
| PSBT P2MR fields: `0x19` script-path signature (key `pubkey \|\| leaf_hash`), `0x1d` leaf script (key = control block, value `script \|\| leaf_ver`), proprietary `qbit:0x01` merkle root | Qbit consensus specification §9.6 (https://qbit.org/consensus) |
| `@qbit-oss/protocol` 0.1.1 signs non-default types only with `allowNonDefaultSighash: true` and enforces `PSBT_IN_SIGHASH_TYPE` | package `docs/signing-and-finalization.md` |
| Dust threshold 2,855 bits per P2MR output | `src/policy/policy.cpp:34-75` |

## 3. Listing (seller)

The seller owns the inscribed output `U` (value `v_U`, inscribed bit at offset 0, PINS-3) and asks
price `P` bits.

1. The listing is a PSBT with one input `U` at index `s` and one output at index `s`:
   `seller_payment = P + v_U` to the seller's address (the seller gets back the postage, too).
2. The seller signs input `s` with hash type `0x83`. The PSBT MUST carry
   `PSBT_IN_SIGHASH_TYPE = 0x83`, the witness UTXO, the leaf script and the control block.
3. `s` is fixed by the template (section 4). Recommended: `s = 2`.
4. The listing can be cancelled only by spending `U` (for example to the seller's own address).
   Marketplaces MUST treat a listing as void as soon as `U` is spent or in the mempool.

## 4. Purchase templates (buyer)

FIFO (PINS-3 §3) decides where the inscribed bit goes. Because input `s` and output `s` are bound
together by `SINGLE`, the inscribed bit would land in `seller_payment` unless earlier inputs shift
it. Padding inputs move it into the buyer's output.

### 4.1 Clean template (RECOMMENDED)

| Index | Inputs | Outputs |
|---|---|---|
| 0 | buyer padding `a` | buyer padding return, value `a + b` |
| 1 | buyer padding `b` | **buyer receives the inscription**, value `v_U` |
| 2 | seller `U` (signed `0x83`) | seller payment `P + v_U` (primary sale: `price_bits`, §6) |
| 3.. | buyer funding | marketplace fee (optional), buyer change |

- Input-space offset of the inscribed bit: `a + b`. Output 0 covers `[0, a+b)`, output 1 covers
  `[a+b, a+b+v_U)`, so the bit lands at offset 0 of output 1.
- Requirements: `a + b ≥ 2,855` (output 0 must not be dust); output 1 value MUST equal `v_U` (or at
  least 1), and MUST be ≥ 2,855.
- The buyer signs inputs 0, 1 and 3.. with `SIGHASH_DEFAULT`, which commits to every output,
  including the receive output at index 1.

### 4.2 Compact template (ALLOWED)

| Index | Inputs | Outputs |
|---|---|---|
| 0 | buyer padding `a` | **buyer receives the inscription**, value `a + v_U` |
| 1 | seller `U` (signed `0x83`, `s = 1`) | seller payment `P + v_U` |
| 2.. | buyer funding | fee, change |

The inscribed bit lands at offset `a` of output 0, not at offset 0. Wallets that assume offset 0 MUST
NOT use this template. Output 0 is still the buyer-chosen receive output, and the buyer's
`SIGHASH_DEFAULT` signature commits to it.

### 4.3 Buyer-chosen receive address

The receive output's script is chosen by the buyer before any buyer signature:

1. **Default.** The P2MR address of the wallet account that signs the buyer inputs.
2. **Another address.** Any other P2MR address on the same network.

`SIGHASH_DEFAULT` commits to every output, so the buyer's signature covers the chosen script and
its value. The seller's `0x83` signature commits only to the seller-payment output at index `s`.
It does not select the receive script and cannot replace it.

A marketplace MUST reject a receive address whose network is not the sale's network, an address
that is not P2MR (a witness version other than 2, or a program that is not 32 bytes), and the sale
holding address that currently holds the unsold items. Testnet4 and signet share the `tq` human
readable part, so the address alone cannot tell them apart. The wallet's active network does.

The PSBT builder accepts any output script that restricted-output mode accepts. The checks above
sit in front of that builder. They are not a consensus rule.

The indexer records the owner from the output script that holds the inscribed bit after FIFO
(PINS-3). It does not record which key signed. Finality stays 6 confirmations (PINS-2 §4.3).
Paying a receive address other than the signing wallet changes neither rule.

### 4.4 Checks before signing (buyer side, REQUIRED)

1. Using an indexer, confirm that `U` holds the expected inscription at offset 0, and nothing else
   unexpected.
2. Recompute FIFO for the whole transaction and confirm the inscribed bit lands in the buyer-chosen receive output.
3. Confirm that none of the buyer's own inputs carries an inscription (padding inputs MUST be plain).
4. Confirm every output is P2MR, `OP_RETURN` or PayToAnchor (restricted-output mode) and not dust.

## 5. Fees and sizes

`WITNESS_SCALE_FACTOR = 1`, so every input costs its full witness. One single-key P2MR input is
at most 3,763 bytes, sighash-type byte included (`P2MR_V1_SINGLE_KEY_SPEND_SIZE`,
`src/script/p2mr_sizing.h:15-41`). A clean-template sale with one funding input has 4 inputs, about 15.1 kB. At the
minimum relay fee (250 bits/kvB) that is about 3,800 bits. TODO-regtest: exact sizes.

## 5.1 Price inscription

Native QBT has no public market price that a genesis inscription can freeze. `qbit.org` lists none,
and a ticker search is not a price for this asset. The genesis map MUST NOT carry `price_bits`,
`price_sources`, or `price_time`.

The issuer publishes one price inscription when the sale opens. It is authenticated the same way as
the sale-secret reveal: the reveal leaf starts with `<K_iss> OP_CHECKSIGPQC`, and `leafIssuer` MUST
equal the genesis `issuer`. A price inscription signed by any other key is ignored.

- Body: the UTF-8 text `pins-price/1` and one trailing newline. `content_type` `text/plain`.
- Field 5 is one CBOR map, keys in this order:

| Key | Type | Meaning |
|---|---|---|
| `schema` | text | `pins-price/1` |
| `genesis` | text | genesis inscription id `G` (`<txid>i<n>`) |
| `price_bits` | uint | price of one sale item, in bits, as the issuer declares it |
| `price_sources` | array of text | the issuer's record of where the price comes from, one non-empty entry per source |
| `price_time` | text | UTC timestamp `YYYY-MM-DDTHH:MM:SSZ` of the price |

The protocol fixes no price and no way to set one. A collection that ties its price to a market can
record, as `price_sources`, one entry per market and the price it listed, and derive `price_bits`
from them by a rule it publishes to its buyers (for example the median of the listed prices).
That rule is not part of this specification.

No tool and no indexer computes a price or checks `price_bits` against `price_sources`. The issuer
fills the three fields, and a reader checks only that they are well formed (below).

A price inscription belongs to a sale, so it counts only for a genesis that declares one, that is, one
that carries `sale_commitment` (PINS-5 §3). For a genesis without it, indexers read no price
inscription, and `/collection` reports `priceStatus` `none`.

Indexers MUST NOT treat a sale as open until a valid price inscription exists. Validity is: body
`pins-price/1` plus one trailing newline, `content_type` `text/plain`, schema `pins-price/1`,
`genesis` equal to this collection's genesis id, `leafIssuer` equal to the genesis issuer, the
three price fields well formed, and creation strictly after the genesis. The earliest valid
inscription wins. Order is creation height, then the creating transaction's index in that block,
then the inscription index `n`. Every later price inscription is ignored, including one from the
same issuer. The first one is immutable. A genesis whose map contains any price key is not a
valid genesis. For a genesis that declares a sale, `/collection` exposes `priceStatus` `pending` until
that inscription exists and `ready` after it, plus `priceBits`, `priceSources`, `priceTime`, and `priceId` of the winner.

## 6. Primary sale of a collection

1. The whole collection is inscribed at launch. Sale items (those not in the creator reserve, PINS-5 §8.1) go to `K_sale`.
   Reserve items go directly to the creator's wallet and are never listed in the primary sale.
2. Price: the creator revenue per item is the issuer's `price_bits`, paid in QBT, plus network fees paid by the buyer.
   The protocol fixes no amount. `price_bits` is fixed by the first valid price inscription
   and never changed during the sale. There is no re-pricing. A later price inscription is ignored.
3. Primary listings use `seller_payment = price_bits` (the creator gives the 10,000-bit postage to the
   buyer with the item), so the buyer pays `price_bits` + network fees and receives an output worth
   `v_U`. The buyer's funding inputs cover `price_bits`, the fee and the padding.
4. `K_sale` pre-signs one `0x83` listing per item. Random assignment: the sale server releases
   listings one at a time, in the committed order (PINS-5 §8.4); the k-th sale delivers `order[k]`.
   Listings MUST NOT be published in advance; a leaked listing lets anyone choose that item.
5. A sale is final after 6 confirmations (PINS-2 §4.3). Until then the server MUST NOT release the
   next listing of the order to someone else if the pending sale might be reorged out; if a sale
   disappears in a reorg, the same item is offered again before the next one in the order.
6. The collection decides how long the sale lasts (PINS-5 §8.5). At close, `sale_secret` is published in its own inscription
   so anyone can check the order. Unsold items go to the address committed before close.

## 7. Qbit Wallet compatibility (as of `v1.0.7`, 2026-11-02)

Verified in `Qbit-Org/qbit-wallet` at `eb9f77941a`:

| Behavior | Effect on PINS-6 | Source |
|---|---|---|
| Signs only `SIGHASH_DEFAULT`; `@qbit-oss/protocol` rejects other types unless `allowNonDefaultSighash` is set, and the wallet never sets it | **A holder cannot create a `0x83` listing with Qbit Wallet today** | `packages/keyring-service/src/keyring-service.ts:2734,2843`; wallet `CHANGELOG` "refuses … a sighash type other than `SIGHASH_DEFAULT`" |
| `signPsbt` signs every input the active account can sign; `toSignInputs` is rejected | buyer side works if the buyer's PSBT contains only the buyer's inputs plus the seller's pre-signed input | `docs/api/sign-transaction.md` |
| A PSBT whose input already carries another signer's final witness keeps it unchanged | the seller's `0x83` witness survives the buyer's signing | `docs/api/sign-transaction.md`; wallet `CHANGELOG` (#272) |
| Flags `SIGHASH_NONE` inputs as a risk; `SINGLE` is not flagged | no warning expected for `0x83` | `packages/tx-helpers/src/decode-psbt.ts:5-9` |
| Classifies plain P2MR outputs as asset-free, may consolidate them | inscriptions at risk in an ordinary Qbit Wallet account | `packages/wallet-background/src/utils/qbit-api.ts:2684-2702` |
| A website `signPsbt` may pay a P2MR output the wallet does not own. `statedRecipients` is empty for that call | The approval shows the address, a warning badge **Unrecognised**, and the line "Outputs to addresses this wallet does not recognise: N, paying X QBT". It does not raise the danger titled **Unrecognised output**, and signing stays available. That danger is for a script with no address, or for an extra output beside a recipient the request named | `packages/wallet-background/src/utils/qbit-psbt-spend-summary.ts` (`summarizeQbitPsbtSpend`); `apps/extension/src/ui/pages/Approval/components/SignPsbt/components/InputItem.tsx`; `apps/extension/src/_locales/en/messages.json` keys `unrecognised_output` and `unrecognised_outputs_summary`; test "shows the large unfamiliar output a dapp PSBT hides beside a small merchant output" |

The reference sale does not start until Qbit Wallet can complete a pre-signed `0x83` offer. No sale key is kept online. The interactive fallback
below, where the seller signs `SIGHASH_DEFAULT` while online, remains specified and is not in use.

The released extension is `v1.0.7` (`eb9f77941a`, 2026-11-02). There is no `v1.0.8` release.
Regtest in that build is not a qbitd RPC setting. The only regtest endpoint is the Esplora origin
`http://127.0.0.1:3002` (`packages/wallet-shared/src/constants/qbit-regtest.ts`), and the wallet
accepts it only when `GET /block-height/0` returns the pinned regtest genesis. A headless browser
cannot point the extension at an arbitrary regtest node.

Consequences:

- Primary sales work: the seller side is our own tooling (`@qbit-oss/pqc` with
  `allowNonDefaultSighash`), and the buyer signs with Qbit Wallet.
- Secondary sales by holders need either a PINS-aware signer, or the **interactive fallback**: the
  marketplace builds the whole transaction once a buyer commits; the buyer signs `SIGHASH_DEFAULT`
  first, then the seller signs `SIGHASH_DEFAULT`. This needs the seller online.
- TODO-regtest: an end-to-end clean-template sale signed by Qbit Wallet on regtest
  (`QBIT_REGTEST`), including padding inputs and fee check.

## 8. Security considerations

- A `0x83` listing is a public offer: anyone holding it can complete it at price `P`. It cannot be
  changed, only cancelled by spending `U`.
- The seller's signature commits to `U`'s amount and script, so a buyer cannot substitute another
  input value.
- Buyers MUST re-check the inscription location at signing time; a reorg or a cancelled listing can
  change it.
- Marketplaces MUST NOT ask sellers for private keys or seed phrases.

## 9. Test vectors

| Vector | Content | Status |
|---|---|---|
| TV6-1 | Listing PSBT (`0x83`) and completed clean-template transaction | TODO-regtest |
| TV6-2 | Compact template, offset `a` | TODO-regtest |
| TV6-3 | Listing invalidated by spending `U` | TODO-regtest |
| TV6-4 | Qbit Wallet buyer signature on regtest | TODO-regtest |

## 10. Copyright

This document is placed in the public domain under CC0-1.0.
