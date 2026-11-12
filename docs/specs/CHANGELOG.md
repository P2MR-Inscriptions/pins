<!-- SPDX-License-Identifier: CC0-1.0 -->
# Specification changelog

Dates are the day the change was recorded. The documents stay CC0-1.0.

## 2026-11-12

Clarifications. They describe the deployed format and the reference indexer. No inscription that is valid
today becomes invalid.

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
- PINS-4 §2.1. The rules of the reference CBOR reader are normative: definite lengths, shortest
  arguments, no tags, floats, or `undefined`, text keys, valid UTF-8, a depth limit of 32, and the
  treatment of repeated keys.
- PINS-1 §4.3. Push decoding bounds: `OP_PUSHDATA1`, `OP_PUSHDATA2`, `OP_PUSHDATA4`, truncated pushes,
  non-minimal encodings, and no length limit in the reader.
- PINS-5 §6.1, PINS-1 §9.5.1, and the index. The regtest sizes, fees, and block counts are labeled as
  regtest figures. PINS-5 §6.2 records the mainnet figures: the fan-out in block 161947, the genesis
  reveal in block 161948, and the 16 item reveals in blocks 161949 to 161971, 6,175,047 bytes and
  6,175,124 bits in all.

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
