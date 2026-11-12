<!-- SPDX-License-Identifier: CC0-1.0 -->
# Collision check: marker `pins` and name "P2MR Inscriptions" / PINS

Date: 2026-11-04. Read-only checks against the tips below. This file is a record of that scan.
It is not a description of the chain after those tips, and it does not identify a later mint.

## 1. On-chain scan (Qbit)

Method: a local scan script (raw scan data kept off the repository) walked every block of the public explorers (esplora/mempool API), fetched
every block with more than one transaction, and decoded the revealed leaf script of every P2MR input,
recording the first push after every `OP_FALSE OP_IF`.

| Network | Explorer | Tip | Blocks with non-coinbase txs | Txs scanned | Envelopes found | `pins` |
|---|---|---|---|---|---|---|
| mainnet | mempool.qbit.org | 160,950 | 27,092 | 211,833 | 0 | 0 |
| testnet4 | mempool-testnet.qbit.org | 201,912 | 3,431 | 18,821 | 3 (`ord`) | 0 |

Testnet4 envelopes (an unknown third party tested Ordinals-style inscriptions on 2026-09-10,
18:42–18:51 UTC):

| Height | Txid | Content |
|---|---|---|
| 120,128 | `1e6aaf5b2fa90fa4f124fe6dcaa8d0dc0d76597199745daff04a97585ec398f2` | `ord`, `application/octet-stream`, 271,628-byte leaf script (WebP sprite sheet) |
| 120,129 | `c118b9dbf56860f41d7f52951e1cb4a98fd55404492889d5557612bc16da54f8` | `ord`, `application/octet-stream`, 256,495-byte leaf script |
| 120,136 | `94080b6941773225e46dfda4cc660f2b2cf33db5d9b70c8f7c5b4e8731f87df8` | `ord`, `text/html`, CBOR metadata "The Qbit logo, awake in your terminal…", tag 17 `properties` title "Qbit" |

All three use exactly the leaf shape of PINS-1 (`<pubkey> OP_CHECKSIGPQC OP_FALSE OP_IF …`), depth-0
control block `c1`, one 10,000-bit P2MR output. This shows that large P2MR envelopes relayed and were
mined on testnet4 (before PR #263), and that an `ord` port to Qbit exists somewhere. No public source
for it was found on GitHub.

## 2. Off-chain search

| Where | Query | Result |
|---|---|---|
| GitHub code | `PROTOCOL_ID` + `pins` + inscription | no protocol using `pins` as marker; hits are MetaID (`metaid`), Radiant Glyph (`gly`), unrelated |
| GitHub repos | `p2mr inscription`, `pins inscriptions`, `qbit ord inscriptions` | none relevant |
| GitHub users/orgs | `p2mr-inscriptions`, `pins-protocol` | free |
| npm | `p2mr-inscriptions`, `pins-protocol`, `p2mr-pins` | free; `pins` taken (unrelated, 2022) |
| Web | "P2MR Inscriptions", "PINS" inscription protocol | no existing use found that day; PINs Network (an ERC-20 social token); BIP-360 uses "P2MR" for a draft output type on another network |
| X | "P2MR inscriptions", "PINS-1" | no relevant post; one user asked on 2026-11-03 whether Qbit "will have inscriptions" |
| Domains (RDAP) | `p2mrinscriptions.com/.org`, `p2mr-inscriptions.org`, `pinsprotocol.org` | not registered; `pins.dev` registered |

## 3. Assessment

- **Marker `pins`: free on the day of the scan.** No envelope with this marker was found on Qbit
  mainnet through height 160,950 (blocks 160,951 to 161,947 are not scanned: section 4), or on testnet4 through height 201,912. Decision
  (2026-11-04): `pins` is the marker. This scan did not identify any earlier inscription, and
  it is not a claim that none exists after those tips.
- **Name overlap to know about (not a blocker):**
  - MetaID, on other networks, calls each of its inscriptions a "PIN" (Personal Information Node) and
    uses the same `<txid>i<n>` ID format. Its marker is `metaid`, so indexers cannot confuse them,
    but people might.
  - "P2MR" is also the name of the draft BIP-360 output type on another network. The `pins` marker
    and the "on Qbit" wording keep them apart.
  - An `ord` port exists on Qbit testnet4. If it launches on mainnet, Qbit will have two inscription
    namespaces. Separate markers mean separate, non-conflicting indexes; PINS keeps the Ordinals
    field numbers, so content tooling stays compatible.
- **Fallback markers (not needed, kept for the record):** `pmri` (`70 6d 72 69`, "P2MR inscription", 4 bytes, no known
  use) or `p2mi` (`70 32 6d 69`). Neither appeared in any search hit.

## 4. Open: blocks 160,951 to 161,947

**Status: OPEN. Not yet run.**

The mainnet scan in section 1 ends at height 160,950. Mainnet `ACTIVATION_HEIGHT` is 161,948 (PINS-2), so blocks 160,951 to 161,947 inclusive (997 blocks) lie between the end of that scan and the activation height. No scan of that range is recorded in this file. Until one is, this file does not show that those blocks hold no envelope, and the statement in section 3 that no envelope with the marker `pins` was found covers height 160,950 and below only.

What the result decides: an indexer that starts at 161,948 gives the same numbers as one that starts earlier only if the range has no `pins` envelope.

Method, the same as section 1 so that the results compare: for every block in the range that has more than one transaction, decode the revealed leaf script of every P2MR input and record the first push after every `OP_FALSE OP_IF`. Count the envelopes and the ones whose first push is `pins` (`70 69 6e 73`). It needs a synced Qbit mainnet node that serves full blocks with their witness data. The check is read-only.

When the scan has been run, its date, the node version, the range, the counts and the digest of the result are recorded here, and this section is changed from open to closed. If it finds a `pins` envelope, that is a finding for PINS-2 and is recorded here as one.

## License

This document is placed in the public domain under CC0-1.0.
