<!-- SPDX-License-Identifier: Apache-2.0 -->

# Documentation

A map of everything in `docs/`, and of the files at the top of the repository that a contributor needs. Start with the row that matches what you want to do.

## I want to…

| I want to… | Read |
|---|---|
| See it work in five minutes | [Five minutes on regtest](guides/QUICKSTART.md) |
| Inscribe a single P2MR Inscription | [Single P2MR Inscriptions](guides/SINGLE-INSCRIPTION.md) |
| Launch a collection | [Launch a collection](guides/COLLECTION-LAUNCH.md), then [the mainnet checklist](guides/MAINNET-CHECKLIST.md) |
| Rehearse everything on a private node | [Try it on your own regtest node](guides/REGTEST.md) |
| Sell or trade a P2MR Inscription | [Sell and trade](guides/SALE-AND-TRADE.md) |
| Connect a tool to my node | [Log in to your node](guides/NODE-LOGIN.md) |
| Read the chain with my own program | [The indexer API](indexer/API.md) |
| Write my own indexer, inscriber or marketplace | [Implementing PINS independently](IMPLEMENTING.md) |
| Understand how the code is built | [Architecture](ARCHITECTURE.md) |
| Look up a word | [Glossary](GLOSSARY.md) |
| Propose a change to a rule | [How to propose a change to the standards](STANDARDS-PROCESS.md) |
| Change the code or the documents | [CONTRIBUTING.md](../CONTRIBUTING.md) |
| Know who decides | [GOVERNANCE.md](../GOVERNANCE.md) |
| Report a vulnerability | [SECURITY.md](../SECURITY.md) |

## The standards

[docs/specs](specs/README.md) holds PINS-1 to PINS-6 (CC0-1.0), the verification record, the [test vectors](specs/vectors/README.md), the [changelog of the standards](specs/CHANGELOG.md) and the [collision scan](specs/collision-check.md) of the marker.

| Standard | Title |
|---|---|
| [PINS-1](specs/PINS-1.md) | Core P2MR Inscription |
| [PINS-2](specs/PINS-2.md) | Indexing |
| [PINS-3](specs/PINS-3.md) | Transfer and ownership |
| [PINS-4](specs/PINS-4.md) | Metadata |
| [PINS-5](specs/PINS-5.md) | Collections and provenance |
| [PINS-6](specs/PINS-6.md) | PSBT trades |

## The tools

| Tool | Documents |
|---|---|
| Inscriber | [docs/inscriber/README.md](inscriber/README.md), [packages/inscriber/README.md](../packages/inscriber/README.md) |
| Indexer | [packages/indexer/README.md](../packages/indexer/README.md) (every option), [docs/indexer/API.md](indexer/API.md) (every route) |
| Sale library | [packages/sale/README.md](../packages/sale/README.md) |
| Protocol core | [packages/protocol/README.md](../packages/protocol/README.md) |
| Explorer | [explorer/README.md](../explorer/README.md) |

## Reference

- [Pinned versions](PINNED_VERSIONS.md): the Qbit Core version and the upstream projects the documents depend on, each read from its source.
- [The Flatbits example](examples/flatbits.md): a collection on mainnet as public chain data, and how to check it.
- [Assets](assets/README.md): the logo files and where they come from.
- [CHANGELOG.md](../CHANGELOG.md): what changed in the tools. The standards have their own.
- [CITATION.cff](../CITATION.cff): how to cite PINS.

## Keeping the documents true

Three tests read the documents on every run: `packages/protocol/docs-links.test.ts` (every link and heading anchor), `packages/protocol/docs-commands.test.ts` (every command and flag in a code block exists in the code) and `packages/protocol/terminology.test.ts` with `npm run check:terminology` (the words). A document that falls out of step with the code fails CI.
