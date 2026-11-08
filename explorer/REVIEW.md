# Explorer 1.0.1 validation notes

Checked on 8 Nov 2026 with Node 22.23.4. The pages were also opened in Chrome 156 against the mock indexer. This package does not change the PINS protocol. The indexer pin remains `3e014f4ff156a35eea4b8613e37116fd124aa719`. Explorer 1.0.1 is not a production release. The page checks below are from 1.0.0. Version 1.0.1 changes development startup only.

The footer sentence is `PINS is an independent protocol.`

## Qbit, read from qbit.org on 8 Nov 2026

| Statement on the Qbit page | Where it was read |
| --- | --- |
| Peer-to-peer network, asset QBT, own genesis, Qbit Core derived from Bitcoin Core 30.2 | https://qbit.org/architecture, Core Architecture |
| Pay-to-Merkle-Root, 32-byte witness program, witness version 2 | https://qbit.org/p2mr §1–§2 and https://qbit.org/consensus, terminology |
| Public key is not in an unspent output | https://qbit.org/architecture, P2MR Output Model, and https://qbit.org/wallet |
| SLH-DSA-SHA2-128s-bounded30, SLH-DSA / SPHINCS+, 3,680 bytes | https://qbit.org/architecture, signature rows |
| Block subsidy starts at 210 QBT, no slow start, step every 43,200 blocks, sum slightly under the cap | https://qbit.org/consensus §4.3 |
| No premine | https://qbit.org/architecture, Fixed Monetary Architecture |
| Money-range cap 210,000,000 QBT | https://qbit.org/consensus §4.3, `MAX_MONEY` |
| 1 QBT = 100,000,000 bits | https://qbit.org/consensus, terminology, “Qbit bit” |
| Leaf version `0xc0`, Merkle path must match, `OP_CHECKSIGPQC` | https://qbit.org/p2mr §4 and §8 |
| Qbit Wallet is a free Chrome extension; keys stay on the device; Chrome 114; Brave and Edge can use the same listing | https://qbit.org/wallet |

The page does not say “no outside token allocation.” That phrase appears on https://qbit.org and on the architecture page next to “no premine.” It is not the subsidy rule in consensus §4.3, and it does not describe later transfers of coins that were already mined.

The consensus document still says some named launch parameters are not normative until a launch-parameter freeze. The numbers above are the ones §4.3 and the architecture page publish.

## PINS, read from the pinned commit

Commit `3e014f4ff156a35eea4b8613e37116fd124aa719`.

| Statement | Spec |
| --- | --- |
| Content is an unexecuted envelope in a revealed leaf at version `0xc0`. The marker is `pins`. Conforming indexers assign the same identifiers, numbers, and initial bit. | `docs/specs/PINS-1.md` §1 and §4 |
| Each inscription is bound to one bit. Later spends follow first-in-first-out. | `docs/specs/PINS-3.md` §1 and §3 |

PINS-3 is marked Draft. Its transfer test vectors are still TODO-regtest. The explorer shows the indexer snapshot. It does not recompute that rule.

## What this package does

| Behavior | Code |
| --- | --- |
| Listens only on loopback. Default port 8080. | `server/config.ts`, `server/profile.ts` |
| Indexer default is `http://127.0.0.1:8787`. `PINS_NETWORK` defaults to mainnet and may be `regtest` or `testnet4`. | `scripts/run-indexer.ts` |
| Setup fetches the pin into `vendor/pins` and applies `patches/0001`, `0002`, and `0005`. It does not reset a dirty tree and does not read `.env` or `data/`. | `scripts/setup-indexer.ts` |
| The explorer process calls only `getblockcount`, `getblockhash`, `getblockheader`, and `getrawtransaction`. | `server/rpc.ts` |
| With `QBIT_CONF` and no `QBIT_RPC_URL`, the indexer calls `127.0.0.1`. The explorer uses `rpcbind` only when that value is loopback. The port is `rpcport`, or 8352. | `scripts/credentials.ts`, `scripts/run-indexer.ts`, `server/config.ts` |
| Latest order is block height, transaction position in the block, then envelope index. | `server/index-cache.ts` `latestFirst`; PINS-1 §6 defines `n` |
| Collection piece reads are 100 at a time. | `server/index-cache.ts` |
| Text in a frame stops at 2,048 bytes. | `public/content-view.js` |
| An HTML page runs only after a click, with `sandbox="allow-scripts"` and `connect-src 'none'`. | `public/app.js`, `server/api.ts` |
| Authentic is shown only when the indexer boolean is true and the snapshot is not stale. | `public/app.js` |
| Green in the footer means the snapshot height equals the indexer tip. It is not a collection result. | `public/status-tone.js` |

The indexer HTTP API in the pinned `scripts/indexer-run.ts` starts after the first catch-up. A missing witness stops that process with `witness pruned`.

## Not checked

A synced mainnet node, the 10,000 Flatbits, a restart of a real index, and a live reorg were not run for this package. An earlier build was observed at height 165925 with 10002 inscriptions. This build does not repeat that observation and does not decide whether a collection is authentic.

Chrome 156 played WAV, MP3, Ogg Vorbis, WebM Opus, WebM VP8, and MP4 H.264 with AAC on synthetic fixtures. It did not play Ogg Theora. That is not a claim about every codec, site, or game. The sandbox does not cap processor time.
