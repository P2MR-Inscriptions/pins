<!-- SPDX-License-Identifier: Apache-2.0 -->

# Pinned Qbit versions

One list of the Qbit and package versions that this repository was written and checked against. Update it when a pin changes. A package is listed as a dependency of this tree only when the code imports it.

| Component | Pin | Role |
|---|---|---|
| Qbit Core | [Qbit-Org/qbit](https://github.com/Qbit-Org/qbit) **v1.0.1** (13 November 2026), tag commit `0439a7e5b37fb3f7e4ddfb735b68961445a882c8`. Linux tarball `qbit-1.0.1-x86_64-linux-gnu.tar.gz`, SHA-256 `5f3ce43c3525328f4f0cdcc898516e274a16e170e4ed91ccf648bbb1094f6cb6` | `qbitd`, `qbit-cli`, regtest and testnet4 |
| Normative P2MR profile | `doc/consensus/p2mr-v1.md` at tag `v1.0.1` | Consensus behavior. Not BIP-360. |
| `@qbit-oss/pqc` | **0.1.1** | External SLH-DSA signer. A dependency of this tree. |
| `@qbit-oss/protocol` | **0.1.1** | Addresses, PSBT, sighash. A dependency of this tree. |
| `@qbit-oss/api` | **0.1.1** | Esplora and mempool client. Not a dependency of this tree. |
| `@qbit-oss/rpc` | **0.1.0** | Typed JSON-RPC client for a Qbit node. Not a dependency of this tree: `packages/indexer/rpc.ts` is its own small client and follows this package's cookie rules ([Log in to your node](guides/NODE-LOGIN.md)). |
| Qbit Wallet | [Qbit-Org/qbit-wallet](https://github.com/Qbit-Org/qbit-wallet) **v1.0.9** (12 November 2026), tag commit `6565770f3c86a6eb4dbc9e26f51862379650f6ee` | Browser extension cited by PINS-6. It does not know about PINS: see the warning below. |
| qbit-explorer | [Qbit-Org/qbit-explorer](https://github.com/Qbit-Org/qbit-explorer) **v1.2.0** (12 November 2026), tag commit `16bd08273de9eaa1cdc4d56ba398a70b89dee0d6` | Qbit's own block explorer. Not the explorer of this repository (`explorer/`). |
| qbit-electrs | [Qbit-Org/qbit-electrs](https://github.com/Qbit-Org/qbit-electrs) **v3.3.0-qbit.1** (25 June 2026), tag commit `5da0ce5f2da657dab6dd74b8108cb2b3e17da1e2` | General Electrum index. Not a P2MR Inscription index. |

Every value above was read from the upstream release page, tag or package registry on 15 November 2026. The Linux tarball hash is the one in the release's `SHA256SUMS`, and it is also what `sha256sum` gives for the file. The Core tag commit was read from the tag in a clone of Qbit-Org/qbit. The wallet, explorer and electrs commits are the commits the annotated tags point to.

## Figures the specifications rely on

These come from the Qbit Core v1.0.1 source (`src/consensus`, `src/kernel/chainparams.cpp`, `src/chainparamsbase.cpp`, `src/policy`, `doc/consensus/p2mr-v1.md`), not from memory:

| Item | Value |
|---|---|
| Unit | 1 QBT = 100,000,000 bits |
| Supply cap | 210,000,000 QBT, mining only |
| Signature | 3,680 bytes, 32-byte public key, SLH-DSA-SHA2-128s-bounded30 |
| Leaf in force | `0xc0`. Depth-0 control byte `0xc1` |
| Initial stack | 1,000 items, 16,384 bytes each, 131,072 bytes total, per input |
| Weight | `WITNESS_SCALE_FACTOR = 1`. Standard transaction 400,000. Block 2,000,000 |
| Coinbase maturity | `COINBASE_MATURITY = 1000` blocks, so a regtest chain needs 1,001 blocks before the first coinbase can be spent |
| Ports | RPC and P2P: mainnet 8352 and 8355, testnet4 48352 and 48355, regtest **18452 and 18460** |
| Relay / dust | 250 bits/kvB minimum relay, 750 bits/kvB dust |
| Address HRP | mainnet `qb`, testnet4 `tq`, regtest `qbrt`. Bech32m, witness version 2 (`…1z…`) |
| Validation budget per non-empty PQC check | **3,683** in `p2mr-v1.md` and `src/script/p2mr_sizing.h` |

The 3,683 figure is in force on mainnet, regtest and, from height 60,000, testnet4. Testnet4 blocks below height 60,000 keep the original 3,730 (`doc/reference/p2mr-validation-weight-v2.md` and `nP2MRValidationWeightV2Height` in the Core source; future block time v2 activates at the same height). `qbit.org/consensus` section 5.10 says 3,730, which is the testnet4 value before that height. Follow the profile. No specification here uses the 3,730 figure, and a P2MR Inscription reveal does not depend on it.

`rawmr` outputs are expert-only. Qbit Core's wallet will not sign them. A P2MR Inscription signer has to be external.

The npm packages of this tree are pinned to exact published versions (`package.json` has no `^` or `~`), not to git revisions.

## Qbit Wallet does not know about PINS

Qbit Wallet v1.0.9 treats every P2MR output as plain value. It does not read the PINS envelope, does not know which output holds a P2MR Inscription, and can spend such an output as ordinary change or as a payment. Do not hold a P2MR Inscription in a Qbit Wallet account that you also spend from. Move one with the PINS tools (`npm run inscribe`, and the sale library for a trade) and broadcast with `qbit-cli sendrawtransaction`. See [Sell and trade](guides/SALE-AND-TRADE.md#qbit-wallet-and-p2mr-inscriptions).
