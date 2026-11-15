<!-- SPDX-License-Identifier: CC0-1.0 -->
# Collision check: marker `pins` and name "P2MR Inscriptions" / PINS

Dates: 2026-11-04 (sections 1 to 3) and 2026-11-15 (sections 4 and 5). Read-only checks against the tips and ranges below. This file is a record of those scans. It describes no block outside them.

## 1. On-chain scan (Qbit)

Method: a local scan script (raw scan data kept off the repository) walked every block of the public explorers (esplora/mempool API), fetched
every block with more than one transaction, and decoded the revealed leaf script of every P2MR input,
recording the first push after every `OP_FALSE OP_IF`.

| Network | Explorer | Tip | Blocks with non-coinbase txs | Txs scanned | Envelopes found | `pins` |
|---|---|---|---|---|---|---|
| mainnet | mempool.qbit.org | 160,950 | 27,092 | 211,833 | 0 | 0 |
| testnet4 | mempool-testnet.qbit.org | 201,912 | 3,431 | 18,821 | 3 (`ord`) | 0 |

Testnet4 envelopes (an unknown third party tested Ordinals-style envelopes on 2026-09-10,
18:42–18:51 UTC):

| Height | Txid | Content |
|---|---|---|
| 120,128 | `1e6aaf5b2fa90fa4f124fe6dcaa8d0dc0d76597199745daff04a97585ec398f2` | `ord`, `application/octet-stream`, 271,628-byte leaf script (WebP sprite sheet) |
| 120,129 | `c118b9dbf56860f41d7f52951e1cb4a98fd55404492889d5557612bc16da54f8` | `ord`, `application/octet-stream`, 256,495-byte leaf script |
| 120,136 | `94080b6941773225e46dfda4cc660f2b2cf33db5d9b70c8f7c5b4e8731f87df8` | `ord`, `text/html`, CBOR metadata "The Qbit logo, awake in your terminal…", tag 17 `properties` title "Qbit" |

All three use exactly the leaf shape of PINS-1 (`<pubkey> OP_CHECKSIGPQC OP_FALSE OP_IF …`), depth-0
control block `c1`, one 10,000-bit P2MR output. This shows that large P2MR envelopes relayed and were
mined on testnet4 (before `Qbit-Org/qbit#263`), and that an `ord` port to Qbit exists. Section 5 names it.

## 2. Off-chain search

| Where | Query | Result |
|---|---|---|
| GitHub code | `PROTOCOL_ID` + `pins` + `inscription` | no protocol using `pins` as marker; hits are MetaID (`metaid`), Radiant Glyph (`gly`), unrelated |
| GitHub repos | `p2mr inscription`, `pins inscriptions`, `qbit ord inscriptions` | none relevant |
| GitHub users/orgs | `p2mr-inscriptions`, `pins-protocol` | free |
| npm | `p2mr-inscriptions`, `pins-protocol`, `p2mr-pins` | free; `pins` taken (unrelated, 2022) |
| Web | "P2MR Inscriptions", `"PINS" inscription protocol` | no existing use found that day; PINs Network (an ERC-20 social token); BIP-360 uses "P2MR" for an output type proposed on another network |
| X | `"P2MR inscriptions"`, `"PINS-1"` | no relevant post; one user asked on 2026-11-03 whether Qbit `"will have inscriptions"` |
| Domains (RDAP) | `p2mrinscriptions.com/.org`, `p2mr-inscriptions.org`, `pinsprotocol.org` | not registered; `pins.dev` registered |

## 3. Assessment

- **Marker `pins`: free on the day of the scan.** No envelope with this marker was found on Qbit
  mainnet through height 160,950 (blocks 160,951 to 161,947 are covered by section 4), or on testnet4 through height 201,912. Decision
  (2026-11-04): `pins` is the marker. This scan did not identify any earlier P2MR Inscription, and
  it is not a claim that none exists after those tips.
- **Name overlap to know about (not a blocker):**
  - MetaID, on other networks, calls each of its on-chain records a "PIN" (Personal Information Node) and
    uses the same `<txid>i<n>` ID format. Its marker is `metaid`, so indexers cannot confuse them,
    but people might.
  - "P2MR" is also the name of the BIP-360 output type proposed on another network. The `pins` marker
    and the "on Qbit" wording keep them apart.
  - An `ord` port exists on Qbit testnet4 and on mainnet (section 5): Qbit has two namespaces of
    items, those of `ord` and P2MR Inscriptions. Separate markers mean separate, non-conflicting
    indexes. No input of the mainnet scan carries both markers. PINS keeps the Ordinals field
    numbers, so content tooling stays compatible.
- **Fallback markers (not needed, kept for the record):** `pmri` (`70 6d 72 69`, "P2MR Inscription", 4 bytes, no known
  use) or `p2mi` (`70 32 6d 69`). Neither appeared in any search hit.

## 4. Closed: blocks 160,951 to 161,947

Date: 2026-11-15. Result: **no envelope**.

The scan of section 1 ends at height 160,950, and mainnet `ACTIVATION_HEIGHT` is 161,948 (PINS-2 §3). This scan covers the 997 blocks between them, 160,951 to 161,947 inclusive.

Method, the same as section 1: for every block of the range that has more than one transaction, decode the revealed leaf script of every P2MR input (the second-to-last witness item once an optional annex is removed) and record the first push after every `OP_FALSE OP_IF`. The raw blocks were read from the public explorer of section 1 (the raw block endpoint) and checked before use: the double SHA-256 of every 80-byte header equals the block hash the explorer lists for that height, and every block's previous hash is the hash of the block before it, from 160,950 to 161,947.

| Item | Value |
|---|---|
| Range | 160,951 to 161,947 (997 blocks) |
| First block hash | `3f267f5795fbf8d297f904502ce6fbe8b94df1b65bb751f6f565f42b0b5133b9` (height 160,951) |
| Last block hash | `0000000000000001961efbfa2adba2fde06548478a9fe7a5932b4011c522fa3b` (height 161,947) |
| Blocks with non-coinbase transactions | 803 |
| Transactions scanned | 40,527 |
| P2MR inputs read without a witness | 0 |
| Envelopes found | 0 |
| `pins` (`70 69 6e 73`) | 0 |
| Digest | `a3f412e2389f4fa9f5f296efdf8bf6523ece59d69b640f62cf55861146712dbe` |

The digest is the SHA-256 of the UTF-8 JSON text of the result `{"first", "last", "busy", "txs", "nowit", "found"}` (keys sorted, no spaces) where `first` and `last` are the first and last block hash above, `busy` and `txs` are the two counts, `nowit` is the number of inputs read without a witness and `found` is the list of envelopes, empty here. Anyone who repeats the scan on the same range gets the same digest.

What it decides: an indexer that starts at 161,948 gives the same numbers as one that starts earlier, because the range has no `pins` envelope. PINS-2 §3 states it.

## 5. Mainnet scan 160,950 to 171,486: `ord` and `pins`

Date: 2026-11-15, same method, the public explorer, heights 160,950 to 171,486, every block header checked as in section 4.

| Marker | Inputs with envelopes | Envelopes | Heights |
|---|---|---|---|
| `pins` | 17 | 10,002 | 161,948 to 161,971 |
| `ord` | 1,148 | 4,081 | 162,540 to 170,494, in 301 blocks |
| any other | 0 | 0 | none |

No input holds both markers, so no `ord` envelope is a P2MR Inscription and no P2MR Inscription is an `ord` envelope. The `ord` envelopes appeared after the activation height, so they do not affect the numbering of PINS-2 §4.

### 5.1 The `ord` port is qord

Checked on 2026-11-15 in the source of `github.com/djh58/qord` at commit `a4febe49e10eb6ba10ded6ab42098a5bec7be914` (2026-11-06), file `src/inscriptions/envelope.rs`:

- Its marker is the three bytes `ord` (`PROTOCOL_ID`, line 13). It reads an envelope as an empty push (`OP_FALSE`), then `OP_IF`, then a push of exactly `ord` (lines 107-132 and 156-163; the writer is at lines 292-294).
- It looks for that sequence anywhere in the leaf script of a P2MR input, and ignores a `<pubkey> OP_CHECKSIGPQC` prefix (test `p2mr_checksigpqc_prefix_is_ignored`).
- Its README and explorer call the items it indexes *qscriptions*, and say they count from the first block after genesis on every network.
- The PINS marker is the four bytes `pins` (`70696e73`, PINS-1 §4.1), at the same position in the envelope. A reader that requires the push to be exactly `ord`, and one that requires it to be exactly `pins`, accept disjoint sets of envelopes. A leaf script can hold one envelope of each.

Qbit Wallet issue `Qbit-Org/qbit-wallet#173` (`github.com/Qbit-Org/qbit-wallet/issues/173`, opened 2026-11-10) reports about 3,800 qscriptions at that date. Section 5's own count of `ord` envelopes is 4,081 up to height 171,486. The two numbers are taken on different days and the second counts envelopes, not qscriptions.

Result: the marker `pins` does not collide with the marker of qord. The two protocols share the chain and the bit, and each has its own index.

## License

This document is placed in the public domain under CC0-1.0.
