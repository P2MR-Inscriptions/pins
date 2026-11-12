<!-- SPDX-License-Identifier: CC0-1.0 -->
# Specification changelog

Dates are the day the change was recorded. The documents stay CC0-1.0.

## 2026-11-12

Clarifications. They describe the deployed format and the reference indexer. No inscription that is valid
today becomes invalid.

- PINS-5 §2 and §6.1. The reveal count is stated for any `supply` and `batch` (`1 + ceil(supply / batch)`). The 10,000-item figures are labeled as the worked example.
- PINS-5 §6.2. The mainnet record names its collection, the public example of [docs/examples/flatbits.md](../examples/flatbits.md).
- PINS-1 §9.5.1. The recommended batching is labeled as the one for that example.
- PINS-5 §8.5, PINS-6 §5.1 and §6, and the index. The 30-day sale length and the 1 USD creator revenue are removed. They were terms of one collection. No tool or indexer enforced either: no code measures a sale length, and the checks on a price inscription are only that its three fields are well formed. The protocol now fixes no sale length and no price. `price_bits` is the price of one sale item in bits as the issuer declares it, `price_sources` the issuer's record of where the price comes from, `price_time` its UTC timestamp. The median rule is no longer part of the specification. No field was added, and no inscription that is valid today becomes invalid.
- PINS-5 §6. Field 5 of the leaf list is optional. The leaf list on mainnet has none. When present it
  is `pins-leaflist/1` with `root` as a byte string. The section now states which inscription the
  reference indexer takes as the leaf list: it is in the transaction of the genesis, and its leaves
  fold to the genesis root. It is no longer described as optionally sharing that transaction.
- PINS-5 §3. The genesis map has exactly the nine listed keys in order. `reserve` is an optional last
  key, and its shape and the checks on it are specified. The checks on `name`, `supply`, `first`,
  `item_type`, and `issuer` are stated. Genesis choice is described, including the indexer option
  `--genesis <inscription id>`.
- PINS-5 §8.1. Where an indexer gets the reserve groups: the `reserve` key, a collection profile, or
  nowhere.
- PINS-5 §8.1. The protocol fixes no reserve size. It is the sum of the collection's group counts and
  extra count.
- PINS-6 §5.1. No tool or indexer computes the median or checks `price_bits` against `price_sources`.
  Readers check that the three price fields are well formed. The protocol fixes no price.
- PINS-4 §2.1. The rules of the reference CBOR reader are normative: definite lengths, shortest
  arguments, no tags, floats, or `undefined`, text keys, valid UTF-8, a depth limit of 32, and the
  treatment of repeated keys.
- PINS-1 §4.3. Push decoding bounds: `OP_PUSHDATA1`, `OP_PUSHDATA2`, `OP_PUSHDATA4`, truncated pushes,
  non-minimal encodings, and no length limit in the reader.
- PINS-5 §6.1, PINS-1 §9.5.1, and the index. The regtest sizes, fees, and block counts are labeled as
  regtest figures. PINS-5 §6.2 records the mainnet figures: the fan-out in block 161947, the genesis
  reveal in block 161948, and the 16 item reveals in blocks 161949 to 161971, 6,175,047 bytes and
  6,175,124 bits in all.
- PINS-1 §4.1, §5.1 and §8. An empty push in a value position is a value, and only an empty push in a
  tag position is the body separator. A tag of more than one byte is unknown, and one whose first byte
  is even makes the inscription opaque. A leading U+FEFF in `content_type` is kept.
- PINS-1 §4.2. In restricted-output mode the only spendable output that is not P2MR is PayToAnchor, so
  the spent-output rule excludes only that spend.
- PINS-2 §2. An input that spends a P2MR output with no witness items is a gap in the witness data,
  and the indexer must stop.
- PINS-2 §5 and PINS-3 §6. The subsidy schedule of PINS-2 §5.1 applies to every indexer, because it
  fixes where fee bits sit in the coinbase. The text gives the stepdown interval of testnet4 and
  regtest, and says the subsidy is never read from the coinbase.
- PINS-5 §7, §8.5 and §9. The checks of the reference indexer for the closing inscription and for the
  sale reveal are stated: signer, position after the genesis, exact keys in order, and the values
  of `root`, `count` and `sale_secret`. An item inscribed after the closing is not authentic. A bare
  secret as an inscription body is not a sale reveal. The reference indexer does not read the unsold
  address commitment, does not compare sale transactions with the sale order, and checks rule 5 with
  the leaf list only.
- PINS-4 §2.1. A leading U+FEFF in a text string is kept, and a map key named `__proto__` is an
  ordinary key.

Relaxation. No inscription that is valid today becomes invalid, and a genesis that carries
`sale_commitment` reads exactly as before.

- PINS-5 §3. `sale_commitment` is optional. The genesis map is the eight keys from `schema` to
  `item_type`, then `sale_commitment` if present, then `reserve` if present. A map without
  `sale_commitment` is now a genesis, and it declares no sale. Every map accepted before is still
  accepted, with the same fields. The rule is the same for the launch schema and a rehearsal schema.
- PINS-5 §8. The sale secret, sale reveal, sale order and reserve selection apply only to a genesis
  that carries `sale_commitment`. A collection without a sale is authentic by section 9 alone.
- PINS-6 §5.1. A price inscription counts only for a genesis that carries `sale_commitment`. For
  one without it, `/collection` reports `orderStatus` `none` and `priceStatus` `none`.

## 2026-11-06

- PINS-2 §3. Mainnet `ACTIVATION_HEIGHT` is 161948, the block containing the first `pins` envelope
  on mainnet. Regtest stays height 0. No testnet4 height is set. TV2-2, TV2-3, and TV2-4 remain
  open.

## 2026-11-05

- Status lines. They no longer point at one mainnet mint. No field, hash, or byte layout changed.
  The regtest size worksheet in PINS-5 §6.1 is unchanged.

- PINS-5 §3. `root`, `issuer`, and `sale_commitment` are 64 lowercase hex characters (text). They are not CBOR byte strings. This matches the reference encoder. The encoder itself is unchanged.

- PINS-5 §3 and PINS-6 §5.1. The genesis map no longer carries `price_bits`, `price_sources`, or
  `price_time`. A genesis that includes any of those keys is not valid. The price is a separate
  `pins-price/1` inscription, published when the sale opens and signed by the same issuer key.
  The first valid one wins. Later ones are ignored. The median rule moved with it.

## 2026-11-04

- PINS-6 §4.3. The buyer chooses the receive output before signing. The default is the signing
  wallet. Another P2MR address on the same network is allowed. The buyer's `SIGHASH_DEFAULT`
  signature covers that output. The seller's `0x83` signature does not. The indexer owner and the
  6-confirmation finality are unchanged. Qbit Wallet v1.0.7 shows such an output as
  **Unrecognised** and still offers to sign it.

## 2026-11-04

Regtest measurements from a private regtest node. The normative text was updated to match.
The raw log is not in this repository.
Nothing in this entry was broadcast on testnet4 or mainnet.

- PINS-1 §9.5. The standard cap is 400,000 serialized bytes. A body of 393,800 bytes measured
  400,004 and was rejected `tx-size` on `v1.0.0` and on `1.x.x`. The fixed overhead of a
  625-output reveal with a change output and a leaf of at least 65,536 bytes is 3,855 bytes,
  not 3,857.
- PINS-1 §9.5.1. The 16 in-order batches of 625 canonical items weigh 345,083 to 372,817 bytes
  (5,844,107 bytes together). The genesis reveal weighs 326,064 bytes. Both ends of that range,
  and the genesis, were mined.
- PINS-1 §9.5. Peak stack of a reveal is 3,712 bytes: the 3,680-byte `SIGHASH_DEFAULT` signature
  plus the 32-byte public key. A local `1.x.x` build logged that peak on every P2MR script check
  in the run, including the 372,817-byte reveal. The envelope is not added to the stack.
- PINS-5 §6.1. The 17 reveals are funded by one confirmed fan-out, then broadcast together.
  All 17 fit in the mempool. They take 4 blocks of at most 5 reveals, plus the fan-out's block.
  Fees for the 6,174,719 bytes at 1 / 5 / 10 bits/vB are 0.06174719 / 0.30873595 / 0.61747190 QBT.
- PINS-6 §7. Qbit Wallet `v1.0.7` is still the latest release. Its regtest path is an Esplora
  indexer at `http://127.0.0.1:3002`, not a custom qbitd RPC URL.
