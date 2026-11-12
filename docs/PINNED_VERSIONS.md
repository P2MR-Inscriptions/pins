<!-- SPDX-License-Identifier: Apache-2.0 -->

# Pinned Qbit versions

One list of the Qbit and package versions that this repository was written and checked against. Update it when a pin changes. A package is listed as a dependency of this tree only when the code imports it.

| Component | Pin | Role |
|---|---|---|
| Qbit Core | [Qbit-Org/qbit](https://github.com/Qbit-Org/qbit) **v1.0.0** (16 July 2026) | `qbitd`, `qbit-cli`, regtest and testnet4 |
| Normative P2MR profile | `doc/consensus/p2mr-v1.md` at tag `v1.0.0` | Consensus behavior. Not BIP-360. |
| `@qbit-oss/pqc` | **0.1.1** | External SLH-DSA signer. A dependency of this tree. |
| `@qbit-oss/protocol` | **0.1.1** | Addresses, PSBT, sighash. A dependency of this tree. |
| `@qbit-oss/api` | **0.1.1** | Esplora and mempool client. Not a dependency of this tree. |
| Qbit Wallet | [Qbit-Org/qbit-wallet](https://github.com/Qbit-Org/qbit-wallet) **v1.0.7** (`eb9f77941a`) | Browser extension cited by PINS-6. |
| qbit-electrs | [Qbit-Org/qbit-electrs](https://github.com/Qbit-Org/qbit-electrs) | General Electrum index. Not a P2MR Inscription index. No commit pin yet. |

The Core pin was reviewed on 2 November 2026. No newer Qbit Core release was on the public releases page that day. On 5 November 2026 the npm dependencies in this tree are the 0.1.1 pins above. This note does not record a second review of the Core tree.

## Figures the specifications rely on

These come from Qbit Core v1.0.0, not from memory:

| Item | Value |
|---|---|
| Unit | 1 QBT = 100,000,000 bits |
| Supply cap | 210,000,000 QBT, mining only |
| Signature | 3,680 bytes, 32-byte public key, SLH-DSA-SHA2-128s-bounded30 |
| Leaf in force | `0xc0`. Depth-0 control byte `0xc1` |
| Initial stack | 1,000 items, 16,384 bytes each, 131,072 bytes total, per input |
| Weight | `WITNESS_SCALE_FACTOR = 1`. Standard transaction 400,000. Block 2,000,000 |
| Relay / dust | 250 bits/kvB minimum relay, 750 bits/kvB dust |
| Address HRP | mainnet `qb`, testnet4 `tq`, regtest `qbrt`. Bech32m, witness version 2 (`…1z…`) |
| Coinbase maturity | 1,000 blocks |
| Validation budget per non-empty PQC check | **3,683** in `p2mr-v1.md` and `src/script/p2mr_sizing.h` |

When the Core pin was reviewed, `qbit.org/consensus` section 5.10 said 3,730 while the tag and `main` profile said 3,683. Follow the profile. No specification here uses the 3,730 figure.

`rawmr` outputs are expert-only. Qbit Core's wallet will not sign them. A P2MR Inscription signer has to be external.

The npm packages are pinned to their published 0.1.1 releases, not to git revisions.
