<!-- SPDX-License-Identifier: Apache-2.0 -->

# Security policy

PINS P2MR Inscriptions are chain data. This repository is the specification and the reference indexer and inscriber.

## Reporting

Report a vulnerability through GitHub private vulnerability reporting: open the [Security tab of the repository](https://github.com/P2MR-Inscriptions/pins/security) and choose *Report a vulnerability*, or go straight to the [report form](https://github.com/P2MR-Inscriptions/pins/security/advisories/new). The report is private: only the maintainers see it. Maintainers acknowledge and respond as soon as they can, and publish an advisory when a fix affects users. Say what you found, how to reproduce it, and which version of the tools or which document it concerns. If you cannot use the form, open a public issue that says only that you have a security report and asks a maintainer to open a private channel. Put no detail in it.

Do not open a public issue for a secret, a key, a seed, or an RPC password. Do not paste those into a report.

## Supported versions

Security fixes go to the latest release and to `main`.

| Version | Supported |
|---|---|
| `main` | Yes |
| `1.0.x` (tags `v1.0.0` and `v1.0.1`): reference tools and explorer | Yes |

The specifications PINS-1 to PINS-6 have their own version (1.0.0, in the table at the top of each document). A report about them is handled like any other report.

## What this tree will not do

- There is no rollback command. `broadcast` does not withdraw a transaction. A second run skips a transaction the node already considers confirmed.
- The indexer undoes a block only when the node disconnects that block. The default undo depth is 1,000 blocks (PINS-2 §4.3). A deeper reorg throws. The process does not invent a chain and it does not broadcast.
- `keygen`, `address`, `assign`, `sign`, and `price` refuse an RPC URL. The issuer keyfile stays on the offline machine. The passphrase is read from the terminal. Tests may set `PINS_KEY_PASSPHRASE`. Do not set that variable for a real key.
- The HTTP API binds to `127.0.0.1` only.
- The reference indexer leaves a sale at `waiting_for_wallet`. It does not keep a sale key online.

## Operator notes

- Keep two encrypted copies of a keyfile, in two places, and do not store the passphrase with either copy.
- The keyfile's scrypt parameters are read from the file, so they are checked before use: a cost below the minimum (`n` = 2^14), or a cost far above what `keygen` writes (`n` = 2^17), is refused with a message. The issuer and recovery keys of a new keyfile come from separate random draws. A keyfile at the minimum cost opens unchanged.
- The funding address from `address` receives one QBT payment. Do not spend it with a wallet that does not understand the commit. Do not reuse it as Reserve, Sale, Change, or Revenue.
- Qbit Wallet can pay that address. It does not sign a reveal leaf. Qbit Wallet v1.0.9 does not sign `0x83`. Qbit Core's wallet does (`docs/guides/SALE-AND-TRADE.md`). An ordinary wallet may treat a plain P2MR output as asset-free and may consolidate it.
- A marketplace must not ask a seller for a private key or a seed phrase.
- RPC credentials belong to your local node. They are not a default of this repository.

## Scope

A report about Qbit Core, Qbit Wallet, or `@qbit-oss/*` belongs with those projects. This policy covers the documents and the reference tools in this repository.
