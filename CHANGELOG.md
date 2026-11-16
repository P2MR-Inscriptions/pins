<!-- SPDX-License-Identifier: Apache-2.0 -->

# Changelog

This file records the reference tools and the repository layout. Specification edits are in [docs/specs/CHANGELOG.md](docs/specs/CHANGELOG.md).

## Unreleased

- Indexer: lists, owner and output queries, and the collection records read from a SQLite index (number, owner, location, issuer, created height). The in-memory map holds only the working set of a reorganisation. Bodies stay in the database and are read on demand. The state hash is still the PINS-2 SHA-256 of the whole preimage at every block; unchanged line bytes are reused so the text is not re-encoded. That full digest is a known per-block cost and cannot be bounded without changing the digest. Answers for the existing routes are unchanged when the optional query keys (`sort=latest`, `txid`, `locTxid`, `createdHeight`, `number`) are omitted.
- Explorer: a preview of the latest 1000 P2MR Inscriptions is kept, not a snapshot of the whole list. Detail, content, address, transaction and block views query the indexer as they are requested. `MAX_INSCRIPTIONS` still caps the collection piece list.

- Indexer: first sync fetches `getblock` verbosity 0 (raw bytes) and reads prevouts from outputs already stored; a block that spends an unknown output is fetched again at verbosity 3 (exact 8-decimal amounts, no float, no `getrawtransaction` fallback). A bounded window of later blocks is prefetched (default 8, `--prefetch` / `PINS_PREFETCH`) and applied in height order. Catch-up writes blocks in bounded SQLite transactions (default 64, atomic per batch, resumes from the last committed tip after a crash). A throttled progress line on stderr reports the catch-up percent from the start height, not from height 0. The state hash of each committed block is still the PINS-2 digest and is still stored per block; unchanged P2MR Inscription lines are reused as bytes so catch-up does not re-encode the whole set. A pruned node may not have undo data.

- Documents: a complete mainnet indexer example with a cookie login, a first-sync note (the HTTP API does not listen until catch-up finishes), the Node SQLite warning, how to copy a Qbit data directory, and a deploy guide (`docs/guides/DEPLOY.md`) with systemd units, a reverse-proxy example, LAN firewall advice, and an SSH tunnel.
- Explorer: default `RATE_PER_MINUTE` is 2000 and `MAX_CONCURRENCY` is 128, so a 104-image gallery page stays under the limits. Failed content previews are retried with backoff and honour `Retry-After`.

## 1.0.0

First public release of the PINS reference tools and specifications.

- Specifications PINS-1 to PINS-6 under `docs/specs/` (CC0-1.0), version 1.0.0, with test vectors and a record of regtest runs.
- Indexer (`packages/indexer`): follows a local Qbit Core v1.0.1 node, applies PINS-1 to PINS-3, serves a read-only API on `127.0.0.1`, and publishes a `stateHash` (PINS-2 §4.4) per tip. Bodies are read from SQLite on demand. Blocks apply atomically and reorganisations are undone from the stored undo log.
- Inscriber (`packages/inscriber`): fourteen commands (`keygen`, `address`, `utxo`, `root`, `assign`, `plan`, `sign`, `broadcast`, `preflight`, `price`, `unsold-address`, `sale-reveal`, `unsold-transfer`, `close`) with full `--help`. The last four close a sale and a collection (PINS-5 §7 and §8.5): the unsold-address commitment, the sale reveal, the transfer of the unsold items as unsigned PSBTs, and the closing P2MR Inscription. `preflight --record` checks the three records before `broadcast`. The sale guide shows how to pay the plain fee coins of the transfer and how to confirm with the indexer that none carries a P2MR Inscription. Single P2MR Inscriptions (`--single`), collections with and without a sale commitment, an offline signer, encrypted keyfiles (scrypt N=2^17).
- Node login: cookie or user and password, read for every call, in the indexer, the inscriber, the trade example and the explorer (`docs/guides/NODE-LOGIN.md`).
- Sale library (`packages/sale`): builds and checks `0x83` PSBT trades (PINS-6).
- Explorer (`explorer/`, version 1.0.0): local, read-only, loopback only.
- Mainnet `ACTIVATION_HEIGHT` is 161948. Regtest and testnet4 start at 0. The replay of mainnet to block 171,486 gives stateHash `2d8255401cc9bace5eeba394b83eb38865ec6713b8d2a8578009b77b76424112` (10,002 P2MR Inscriptions, 10,000 authentic).
- Documents for adopting and maintaining PINS without its first authors: `GOVERNANCE.md`, `docs/STANDARDS-PROCESS.md`, `docs/ARCHITECTURE.md`, `docs/IMPLEMENTING.md`, `docs/GLOSSARY.md`, a map in `docs/README.md`, the five-minute regtest example (`docs/guides/QUICKSTART.md`), the mainnet launch checklist, `CITATION.cff`, and a *Spec proposal* issue template. `packages/protocol/docs-commands.test.ts` keeps every command and flag in a document equal to the code.
- Node.js 22.13 to 24. Dependencies are pinned to exact versions. CI runs on Node 22 and 24, with CodeQL and a dependency audit. Not published to npm (type stripping does not run from `node_modules`).

Known limitations:

- Qbit Wallet v1.0.9 does not sign `0x83`. Qbit Core's wallet does. The trade is run end to end with the wallet of a regtest node (TV6-1). Qbit Wallet cannot be pointed at a regtest node, so it is not part of the recorded runs (`docs/guides/SALE-AND-TRADE.md`).
- A block whose witnesses were discarded by a node started with `-prunewitnesses=1` stops the indexer (PINS-2 §2). The rule is tested with a block fed to the engine (TV2-4), not with a pruning node.
- The bytes of a canonical PNG depend on the zlib build (PINS-4 §5.1). The inflated scanlines do not.
