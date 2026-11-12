<!-- SPDX-License-Identifier: CC0-1.0 -->
# P2MR Inscriptions (PINS)

An independent, open protocol for inscriptions on Qbit: content written directly into Qbit
transactions, bound to individual bits, tracked and transferred with ordinary Qbit transactions.

> P2MR Inscriptions is not affiliated with, endorsed by, or an official proposal of the Qbit project
> or Qbit-Org. "Qbit", "QBT" and "P2MR" only name the network and its native output type. The
> Ordinals protocol (2023) is cited as prior art; PINS reuses its field numbers and its
> first-in-first-out transfer rule, and is otherwise designed around Qbit's P2MR outputs and
> post-quantum signatures.

| | |
|---|---|
| Protocol marker | `pins` = `70 69 6e 73` (4 bytes, final; permanent once used on mainnet; see `collision-check.md`) |
| Output type | P2MR, witness v2, leaf version `0xc0` |
| Signatures | SLH-DSA-SHA2-128s-bounded30 (`OP_CHECKSIGPQC`) |
| Specification license | CC0-1.0 |
| Status | Draft. Regtest measurements from 2026-11-04 are recorded in the documents below. Vectors still marked TODO-regtest are open. |
| Verified against | `Qbit-Org/qbit` `v1.0.0` (`7ebcddb622`) and `1.x.x` (`b27130a7b9`, 2026-11-03); `Qbit-Org/qbit-wallet` `v1.0.7` (`eb9f77941a`); `@qbit-oss/protocol`, `@qbit-oss/pqc`, `@qbit-oss/api` 0.1.1 |

## Standards

| Standard | Title | Scope |
|---|---|---|
| [PINS-1](PINS-1.md) | Core Inscription | envelope, marker, fields, content, IDs, validity, size limits, commit/reveal, batching, recovery key |
| [PINS-2](PINS-2.md) | Indexing | inscription numbering, activation height, reorgs, witness-pruning requirements, optional bit-numbering overlay |
| [PINS-3](PINS-3.md) | Transfer and Ownership | first-bit binding, FIFO, fees and coinbase, burns, wallet rules |
| [PINS-4](PINS-4.md) | Metadata | CBOR in field 5, item schema, traits |
| [PINS-5](PINS-5.md) | Collections and Provenance | issuer key, Merkle root, genesis, leaf list, closing, authenticity, committed sale order |
| [PINS-6](PINS-6.md) | PSBT Trades | atomic swap templates, Qbit Wallet constraints |

## Test vectors

[vectors/](vectors/README.md) holds JSON test vectors that another implementation can check itself against: the Merkle leaf, root and proof, the leaf list, the field 5 reader, canonical metadata, the genesis, reveal leaf envelopes, and the reserve and sale order. They were produced by the reference code, and a test of the repository recomputes them. They are examples of the rules above, not rules.

Later candidates: recursion endpoints, delegation details, parent/child (tag 3, reserved),
trustless mint with `OP_CHECKTEMPLATEVERIFY`.

## Two dimensions

1. **Inscription (data).** PINS-1: content lives in an unexecuted `OP_FALSE OP_IF … OP_ENDIF`
   envelope of a revealed `0xc0` leaf script. It is committed by the P2MR root, never placed on
   the stack, and batched so that one post-quantum signature carries hundreds of items.
2. **Attribution to bits (ownership).** PINS-3: each inscription is bound to one bit, and that bit
   moves by FIFO. Owners are derived from chain data alone. PINS-2 numbers inscriptions and, as an
   optional overlay, every bit from Qbit's real subsidy schedule.

## What a collection supplies

These are inputs. This specification does not publish a name, a root, a supply, or a reserve list.

| Input | Where it is fixed |
|---|---|
| Item bodies and field 5 | the zip the operator passes. Canonical PNG and CBOR: PINS-4. Encoder: `packages/collection/canonical.mjs` |
| Genesis document | canonical `collection.json`, inscribed as JSON (PINS-4 §6, PINS-5 §3) |
| Merkle root | PINS-5 §5.1, written in the genesis. The inscriber checks it against the profile |
| Postage | 10,000 bits per item in the reference inscriber (dust threshold 2,855, PINS-1 F14) |
| Regtest size measurement | one 10,000-item image run: 16 reveals of 625 (345,083–372,817 bytes) plus 1 genesis reveal (326,064 bytes), funded by one confirmed fan-out (PINS-5 §6.1). 6,174,719 bytes with that fan-out, which is 0.06174719 QBT at 1 bit/vB on that measurement. That run is not a mainnet record (PINS-5 §6.2 has the mainnet figures) and it does not fix a supply |
| Provenance | issuer key + Merkle root + leaf list + closing inscription (PINS-5) |
| Creator reserve | groups fixed before mint, selected by PINS-5 §8.3. Not a numeric id range. The groups are not listed here |
| Sale | the items that are not reserved, permutation in PINS-5 §8.4, a length and a price per item that the collection decides (the protocol fixes neither), the price published later as a `pins-price/1` inscription when the sale opens, final after 6 confirmations |

## Open questions only regtest can settle

These questions were the regtest list. Measurements that were settled are recorded in
[CHANGELOG.md](CHANGELOG.md), PINS-1 §9.5, and PINS-5 §6.1. A row that still says TODO-regtest
does not have its vector copied into this index. The raw regtest log is not part of this repository.

| # | Question | Standard |
|---|---|---|
| Q1 | A full-size reveal (about 393,800-byte body) is accepted by `testmempoolaccept` and mined, on `v1.0.0` and on `1.x.x` with the 1 MiB stack-byte policy | PINS-1 |
| Q2 | The peak stack of a reveal stays near 3.7 KB with `SCRIPT_VERIFY_P2MR_STACK_BYTES` | PINS-1 |
| Q3 | A commit and its reveals as unconfirmed descendants against the 404 kvB limits | PINS-1 |
| Q4 | A batch reveal with 625 outputs passes sigops, validation weight and relay | PINS-1 |
| Q5 | The recovery leaf (depth-1 control block) spends cleanly and reveals nothing | PINS-1 |
| Q6 | `@qbit-oss/protocol` `p2mrSighash` matches Core for the custom leaf; a hand-assembled witness is accepted | PINS-1 |
| Q7 | Non-minimal pushes inside an unexecuted branch are standard (expected: yes), so indexers must accept them | PINS-1 |
| Q8 | Exact reveal overhead, items per reveal, and transaction count for one image set | PINS-1, PINS-4 |
| Q9 | Genesis and leaf list in one reveal; items in later reveals are recognized in chain order after the genesis | PINS-5 |
| Q10 | Reorg rollback, and an indexer facing a `-prunewitnesses` node | PINS-2 |
| Q11 | Two independent indexers produce identical numbers and owners on a synthetic chain covering every edge case | PINS-2, PINS-3 |
| Q12 | A `0x83` listing completed end to end, with padding inputs, buyer signing in Qbit Wallet on regtest | PINS-6 |
| Q13 | Real dust and fee numbers with default `-dustrelayfee` and `-minrelaytxfee` | PINS-1, PINS-6 |

## Decisions recorded here

1. Marker `pins`: final.
2. A creator reserve is selected by PINS-5 §8 from groups fixed before mint. Not a numeric id range. The groups are collection configuration and are not listed here.
3. The protocol fixes no sale length (PINS-5 §8.5). The collection decides it and tells its buyers. Unsold items go to an address committed before close.
4. Price: the protocol fixes no price. The issuer declares `price_bits`, the price of one sale item in bits, in a separate `pins-price/1` inscription, not the genesis (PINS-6 §5.1). The first valid one wins. No re-pricing.
5. `CONFIRMATIONS_FINAL` = 6 for the marketplace.
6. The protocol repository is https://github.com/P2MR-Inscriptions/pins. That URL is not a consensus constant.
7. A collection's Merkle root is fixed in its genesis. This specification does not publish one.

## Still open

1. The concrete `unsold_address`. The field is specified. The address itself is chosen by the issuer and
   committed before close.
2. A testnet4 `ACTIVATION_HEIGHT`. PINS-2 does not set one. Mainnet is 161948. Regtest indexers should use height 0.
3. Qbit Wallet cannot sign `0x83` listings yet (PINS-6 §7); secondary sales need the interactive
   fallback until it can.

## Changelog

[CHANGELOG.md](CHANGELOG.md) records changes to these documents.

## License

All documents in this directory are placed in the public domain under CC0-1.0
(https://creativecommons.org/publicdomain/zero/1.0/).
