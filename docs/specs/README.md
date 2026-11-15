<!-- SPDX-License-Identifier: CC0-1.0 -->
# P2MR Inscriptions (PINS)

An independent, open protocol for P2MR Inscriptions on Qbit: content written directly into Qbit
transactions, bound to individual bits, tracked and transferred with ordinary Qbit transactions.

> P2MR Inscriptions is not affiliated with, endorsed by, or an official proposal of the Qbit project
> or Qbit-Org. "Qbit", "QBT" and "P2MR" only name the network and its native output type. The
> Ordinals protocol (2023) is cited as prior art; PINS reuses its field numbers and its
> first-in-first-out transfer rule, and is otherwise designed around Qbit's P2MR outputs and
> post-quantum signatures.

| | |
|---|---|
| Protocol marker | `pins` = `70 69 6e 73` (4 bytes, fixed; permanent now that it is in use on mainnet; see `collision-check.md`) |
| Output type | P2MR, witness v2, leaf version `0xc0` |
| Signatures | SLH-DSA-SHA2-128s-bounded30 (`OP_CHECKSIGPQC`) |
| Specification license | CC0-1.0 |
| Version | 1.0.0. PINS-1 through PINS-6 are one release. The verification record and the test vectors are listed below. |
| Verified against | Qbit Core v1.0.1 (`Qbit-Org/qbit`, `0439a7e5`), reviewed 15 November 2026; `@qbit-oss/protocol`, `@qbit-oss/pqc`, `@qbit-oss/api` 0.1.1 |

## Standards

| Standard | Title | Scope |
|---|---|---|
| [PINS-1](PINS-1.md) | Core P2MR Inscription | envelope, marker, fields, content, IDs, validity, size limits, commit/reveal, batching, recovery key |
| [PINS-2](PINS-2.md) | Indexing | P2MR Inscription numbering, activation height, reorgs, witness-pruning requirements, optional bit-numbering overlay |
| [PINS-3](PINS-3.md) | Transfer and Ownership | first-bit binding, FIFO, fees and coinbase, burns, wallet rules |
| [PINS-4](PINS-4.md) | Metadata | CBOR in field 5, item schema, traits |
| [PINS-5](PINS-5.md) | Collections and Provenance | issuer key, Merkle root, genesis, leaf list, closing, authenticity, committed sale order |
| [PINS-6](PINS-6.md) | PSBT Trades | atomic swap templates, signature types |

## Test vectors

[vectors/](vectors/README.md) holds JSON test vectors that another implementation can check itself against: the Merkle leaf, root and proof, the leaf list, the field 5 reader, canonical metadata, the canonical PNG, the genesis, reveal leaf envelopes, ownership, numbering and reorganisation over synthetic chains, the state hash, authenticity, the trade templates, and the reserve and sale order. They were produced by the reference code, and a test of the repository recomputes them. [vectors/regtest/runs.json](vectors/regtest/runs.json) records runs on a private regtest node. The vectors are examples of the rules above, not rules.

Not defined by PINS 1.0.0: recursion endpoints, delegation details, parent/child (tag 3 stays reserved), and a trustless launch with `OP_CHECKTEMPLATEVERIFY`. No field or rule above depends on them.

## Two dimensions

1. **P2MR Inscription (data).** PINS-1: content lives in an unexecuted `OP_FALSE OP_IF … OP_ENDIF`
   envelope of a revealed `0xc0` leaf script. It is committed by the P2MR root, never placed on
   the stack, and batched so that one post-quantum signature carries hundreds of items.
2. **Attribution to bits (ownership).** PINS-3: each P2MR Inscription is bound to one bit, and that bit
   moves by FIFO. Owners are derived from chain data alone. PINS-2 numbers P2MR Inscriptions and, as an
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
| Provenance | issuer key + Merkle root + leaf list + closing P2MR Inscription (PINS-5) |
| Creator reserve | groups fixed before launch, selected by PINS-5 §8.3. Not a numeric id range. The groups are not listed here |
| Sale | the items that are not reserved, permutation in PINS-5 §8.4, a length and a price per item that the collection decides (the protocol fixes neither), the price published as a `pins-price/1` P2MR Inscription when the sale opens, final after 6 confirmations |

## Verification record

Each row is a question about Qbit Core that the specifications depend on, and what was measured. Q5 to Q7, Q10, Q12 and Q13 were run on a private regtest node (Qbit Core v1.0.1). Their raw transactions are in [vectors/regtest/runs.json](vectors/regtest/runs.json), and an offline test replays them. Qbit Core v1.0.0 gave the same node results. Q1 to Q4, Q8 and Q9 rest on regtest measurements recorded in PINS-1 §9.5 and PINS-5 §6.1, and on the mainnet replay. The two policy rules that Qbit Core v1.0.1 added (PINS-1 F8) do not touch a reveal of this standard.

| # | Question | Result | Standard |
|---|---|---|---|
| Q1 | Is a full-size reveal accepted and mined? | Reveals of 345,083 to 372,817 bytes and the 326,064-byte genesis reveal were accepted and mined. The standard limit is 400,000 bytes: a reveal of 400,004 bytes was rejected `tx-size` | PINS-1 §9.5 |
| Q2 | How high does the stack of a reveal peak? | 3,712 bytes (3,680-byte signature and 32-byte key). The envelope is not counted | PINS-1 §9.5 |
| Q3 | A commit and its reveals as unconfirmed descendants against the 404 kvB limits | 17 reveals funded by one confirmed fan-out all fit. A second large reveal that shares an unconfirmed ancestor is rejected `too-long-mempool-chain` | PINS-1 §9.5.1, PINS-5 §6.1 |
| Q4 | Does a batch reveal with 625 outputs pass sigops, validation weight and relay? | Yes. Reveals of 625 outputs, weight 345,083 and 48,167 bytes, were mined | PINS-1 §9.5.1 |
| Q5 | Does the recovery leaf spend cleanly and reveal nothing? | Yes: TV1-7 was accepted and mined, and the indexer found no P2MR Inscription in it | PINS-1 §9.3 |
| Q6 | Does `p2mrSighash` of `@qbit-oss/protocol` match Core for the custom leaf? | Yes. Every reveal of the runs was signed with it and accepted, and the hand-assembled witness is the one recorded in `raw_hex` | PINS-1 §9.1 |
| Q7 | Are non-minimal pushes inside an unexecuted branch standard? | Yes: the reveal was accepted and mined, and the indexer read the P2MR Inscription. Indexers accept them (PINS-1 §4.3) | PINS-1 §9.2 |
| Q8 | Reveal overhead, items per reveal, transactions for one image set | 3,855 bytes of fixed overhead, 625 items per reveal, 18 transactions for the 10,000-item example (PINS-1 §9.5.1) | PINS-1, PINS-4 |
| Q9 | Genesis and leaf list in one reveal, items in later reveals recognised after the genesis | Done on regtest (the 326,064-byte reveal) and on mainnet: the replay of blocks 161,948 to 171,486 finds the genesis, the leaf list and 10,000 authentic items (PINS-5 §6.2, PINS-2 §4.4) | PINS-5 |
| Q10 | Reorganisation rollback, and a block without witnesses | A reorganisation of depth 2 on regtest: numbers were reused and the final state hash equals that of a fresh run (TV2-2). A block whose P2MR spend has no witness item is refused and changes nothing (TV2-4) | PINS-2 |
| Q11 | Two readings of the rules agree on a chain that covers every edge case | The reference indexer and a second reading of PINS-2 §4.4 give the same state hash on every case of the synthetic vectors and on the mainnet replay (TV2-3, TV3-1 to TV3-5, state hash) | PINS-2, PINS-3 |
| Q12 | A `0x83` listing completed end to end | TV6-1: a listing signed `SIGHASH_SINGLE\|ANYONECANPAY`, completed with the clean template, mined, and the indexer shows the buyer as owner. TV6-3: the listing is rejected once the seller spends the P2MR Inscription. | PINS-6 |
| Q13 | Real dust and fee numbers | An output of 2,855 bits is accepted and 2,854 is rejected `dust`. At 3,883 bytes a fee of 970 bits is rejected `min relay fee not met` and 971 is accepted (250 bits/kvB) | PINS-1, PINS-6 |

## Test vectors

Where each vector is. A file in `vectors/` is a check of the reference code against the rule, written so that another implementation can run it. A run on a regtest node is in `vectors/regtest/runs.json`.

| Vector | Standard | Where |
|---|---|---|
| TV1-1 to TV1-7 | PINS-1 §11 | `vectors/envelope.json` (script level) and `vectors/regtest/runs.json` (regtest runs) |
| TV2-1 | PINS-2 §6 | computed in the table of PINS-2 §6 |
| TV2-2 | PINS-2 §6 | `vectors/chain.json` (synthetic) and `vectors/regtest/runs.json` (regtest reorganisation) |
| TV2-3 | PINS-2 §6 | `vectors/numbering.json` |
| TV2-4 | PINS-2 §6 | `vectors/chain.json` |
| State hash | PINS-2 §4.4 | `vectors/state-hash.json` |
| TV3-1 to TV3-5 | PINS-3 §10 | `vectors/ownership.json` |
| TV4-1 | PINS-4 §7 | `vectors/metadata.json`, `vectors/merkle-leaf.json` |
| TV4-2 | PINS-4 §7 | `vectors/png.json` |
| TV4-3 | PINS-4 §7 | `vectors/authenticity.json` |
| TV5-1 | PINS-5 §11 | `vectors/merkle-root.json` |
| TV5-2 | PINS-5 §11 | `vectors/authenticity.json` (`item_set_root`) |
| TV5-3, TV5-4 | PINS-5 §11 | `vectors/authenticity.json` |
| TV5-5, TV5-7 | PINS-5 §11 | `vectors/reserve.json` |
| TV5-6 | PINS-5 §11 | `vectors/merkle-leaf.json` |
| TV6-1, TV6-3 | PINS-6 §9 | `vectors/regtest/runs.json` |
| TV6-2 | PINS-6 §9 | `vectors/trade.json` |

## Fixed choices

1. Marker `pins`: fixed, because it is in use on mainnet.
2. A creator reserve is selected by PINS-5 §8 from groups fixed before launch. Not a numeric id range. The groups are collection configuration and are not listed here.
3. The protocol fixes no sale length (PINS-5 §8.5). The collection decides it and tells its buyers. Unsold items go to an address committed before close.
4. Price: the protocol fixes no price. The issuer declares `price_bits`, the price of one sale item in bits, in a separate `pins-price/1` P2MR Inscription, not the genesis (PINS-6 §5.1). The first valid one wins. No re-pricing.
5. `CONFIRMATIONS_FINAL` = 6 for the marketplace.
6. The protocol repository is https://github.com/P2MR-Inscriptions/pins. That URL is not a consensus constant.
7. A collection's Merkle root is fixed in its genesis. This specification does not publish one.

## Network constants and inputs

1. Mainnet `ACTIVATION_HEIGHT` is 161948 (PINS-2 §3). Testnet4 and regtest start at height 0.
2. The `unsold_address` of a collection is an input of that collection. The field is specified in PINS-5 §8.5, and the issuer commits the address before close.

## Changelog

[CHANGELOG.md](CHANGELOG.md) records changes to these documents.

## License

All documents in this directory are placed in the public domain under CC0-1.0
(https://creativecommons.org/publicdomain/zero/1.0/).
