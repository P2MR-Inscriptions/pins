<!-- SPDX-License-Identifier: Apache-2.0 -->

# Security policy

PINS inscriptions are chain data. This repository is the specification and the reference indexer and inscriber.

## Reporting

Report a vulnerability through [GitHub security advisories](https://github.com/P2MR-Inscriptions/pins/security/advisories/new).

Do not open a public issue for a secret, a key, a seed, or an RPC password. Do not paste those into a report.

## What this tree will not do

- There is no rollback command. `broadcast` does not withdraw a transaction. A second run skips a transaction the node already considers confirmed.
- The indexer undoes a block only when the node disconnects that block. The default undo depth is 1,000 blocks (PINS-2 §4.3). A deeper reorg throws. The process does not invent a chain and it does not broadcast.
- `keygen`, `address`, `assign`, `sign`, and `price` refuse an RPC URL. The issuer keyfile stays on the offline machine. The passphrase is read from the terminal. Tests may set `PINS_KEY_PASSPHRASE`. Do not set that variable for a real key.
- The HTTP API binds to `127.0.0.1` only.
- The reference indexer leaves a sale at `waiting_for_wallet`. It does not keep a sale key online.

## Operator notes

- Keep two encrypted copies of a keyfile, in two places, and do not store the passphrase with either copy.
- The funding address from `address` receives one QBT payment. Do not spend it with a wallet that does not understand the commit. Do not reuse it as Reserve, Sale, Change, or Revenue.
- Qbit Wallet v1.0.7 can pay that address. It cannot sign a reveal leaf. It cannot yet create a `0x83` listing (PINS-6 §7). An ordinary wallet may treat a plain P2MR output as asset-free and may consolidate it.
- A marketplace must not ask a seller for a private key or a seed phrase.
- RPC credentials belong to your local node. They are not a default of this repository.

## Scope

A report about Qbit Core, Qbit Wallet, or `@qbit-oss/*` belongs with those projects. This policy covers the documents and the reference tools in this repository.
