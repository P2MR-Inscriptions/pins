<!-- SPDX-License-Identifier: Apache-2.0 -->

# Contributing

PINS is the P2MR Inscription protocol in `docs/specs/` and the reference indexer and inscriber next to it. Anyone can contribute and anyone can take over the maintenance: this page, [GOVERNANCE.md](GOVERNANCE.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/STANDARDS-PROCESS.md](docs/STANDARDS-PROCESS.md) are written so that nothing depends on a particular person. [docs/README.md](docs/README.md) maps every document.

## Setup

Node.js 22.13 or newer, up to Node 24 (the `engines` range is `>=22.13 <25`). Node 22.12 and older lack `node:sqlite` without a flag, which the indexer needs. Continuous integration runs the tests on Node 22 and on Node 24, and `.nvmrc` names Node 22 for local use.

```text
npm ci
npm run build
npm run lint
npm run typecheck
npm test
```

`npm run build` and `npm run typecheck` both run `tsc --noEmit`. The programs run with `node --experimental-strip-types`. There is no compiler emit.

The package is marked `private`. Do not publish it to npm. The name `pins` is already an unrelated package.

## Proposing changes

What you want to change decides the path.

| You want to… | Path |
|---|---|
| Fix a bug, add a feature or improve a tool | Open an issue (*Bug* or *Feature*) or go straight to a pull request. [Submitting a change](#submitting-a-change) |
| Fix or improve a document | A pull request. A wording change to a specification is also recorded in `docs/specs/CHANGELOG.md` |
| Change a rule of PINS-1 to PINS-6, or add a standard | Open a *Spec proposal* issue and follow [docs/STANDARDS-PROCESS.md](docs/STANDARDS-PROCESS.md). A rule change is a new version of the standard, with vectors and a replay, and it never changes a result that is already on mainnet |
| Change something frozen (the marker, the envelope, the leaf preimage, the Merkle folding, a domain byte) | Not possible in this protocol. It is a new protocol with its own marker ([What not to change](#what-not-to-change)) |
| Take over maintenance | [GOVERNANCE.md](GOVERNANCE.md#becoming-a-maintainer) |

## Submitting a change

1. Fork the repository and make a branch.
2. Make the change, with a test when it changes behavior. Keep to one subject per pull request.
3. Run the checks of Setup, and in `explorer/` its `npm run typecheck` and `npm test` when the change touches the explorer or the indexer API.
4. Update `CHANGELOG.md` (or `explorer/CHANGELOG.md`, or `docs/specs/CHANGELOG.md` for a specification) with what changed.
5. Open a pull request and fill in its template. A change to a specification changes wording only, unless it says why it does not.

## Continuous integration and automation

Everything below lives in `.github/` and is plain configuration. You can read it, and you can run each check yourself with the commands above.

| Check | File | What it runs | Run it locally |
|---|---|---|---|
| `Typecheck and test` | `.github/workflows/ci.yml` | `npm ci`, `npm run lint`, `npm run typecheck`, `npm test` in the repository root | the four commands in Setup |
| `Explorer typecheck and test` | `.github/workflows/ci.yml` | `npm ci` in the root and in `explorer/`, then `npm run typecheck` and `npm run test` in `explorer/` | the same, from `explorer/` |
| `Dependency audit` | `.github/workflows/ci.yml` | `npm audit --audit-level=high` for the root and for `explorer/`. It reads the lock files and installs nothing | `npm audit --audit-level=high` in each folder |
| `Analyze (javascript-typescript)` | `.github/workflows/codeql.yml` | CodeQL code scanning on pull requests to `main`, on pushes to `main`, and weekly | no local command. Results are in the Security tab |

CI runs once per change: on a pull request, and on `main` after a merge. It runs the root and explorer jobs on Node 22 and Node 24, and the dependency audit on the version in `.nvmrc`. Dependencies are pinned to exact versions in both `package.json` files, and the lock files agree with them. Every action is pinned by commit SHA with its version in a comment, and the workflow token is read-only. `.github/dependabot.yml` opens weekly pull requests for newer actions and npm packages. When you add an action, pin it by SHA the same way, and give a job only the permissions it needs.

**Major updates of npm packages are made on purpose, not by the bot.** Dependabot opens pull requests for minor and patch updates (grouped) and for actions. It does not open one for a new major version of an npm package, in the root or in `explorer/`, because a major can break the build, and the two trees are linked: the explorer imports and typechecks the root indexer sources, so a major in one can fail the other. To take a major update, open one pull request that changes the root and `explorer/` together: update both `package.json` and both lock files, and make lint, typecheck, build and the tests of both pass (`npm run lint`, `npm run typecheck`, `npm run build`, `npm test`, then the same in `explorer/`). Say in the description why the major is wanted. Security updates are not held back by this rule: Dependabot still opens a pull request when a published advisory has a fix, even a major one.

## Branch protection

Branch protection on `main` requires the checks of the table above to be green before a pull request can merge. A red or a missing check blocks the merge. Do not ask for a check to be skipped: if a check is wrong or flaky, fix the check in its own pull request. Run the commands of [Setup](#setup) before you push, so that the pull request starts green.

## Documents

The documents are tested. `packages/protocol/docs-links.test.ts` fails on a broken link or heading anchor, and `packages/protocol/docs-commands.test.ts` reads every command in a code block of every Markdown file and fails when a command, a flag or a script it shows is not in the code (the options come from each tool's `--help`). When you rename a flag, change the documents that show it in the same pull request. A command block in a document must be runnable as written, with placeholders in capitals (`YOUR_NODE_DATADIR`).

## Wording

In any text a person reads (documents, specifications, comments, messages, labels, the explorer), write "P2MR Inscription" and never the bare word `inscription`, because an `ord` port exists on Qbit and the bare word does not say which one is meant. Code names, API paths (`/inscription`, `/inscriptions`), JSON keys, protocol field names, file names, flags and tests keep their names. `npm run check:terminology` lists every bare occurrence with the reason it is allowed and fails on any it cannot place. It also runs with `npm test`, and so does a test that every relative link in the Markdown files resolves, to a file and to a heading.

The verb is "inscribe". Write "inscribe" where you would say that someone puts a P2MR Inscription on the chain, and never the other verb. `npm run check:terminology` fails on it too. A code identifier that merely contains the word (`MintPlan`) is not the word and keeps its name.

## Changing the indexing path

The files that decide the `stateHash` are `packages/indexer/{chain,pins,collection,store,cbor,hash,address,paging}.ts`, `packages/protocol/{merkle,reserve,profile}.mjs`, `packages/collection/canonical.mjs` and `scripts/vectors.ts`. No test replays mainnet. A change to any of them is checked by replaying mainnet from block 161,948 to block 171,486 with `scripts/indexer-run.ts` on a node, as in [docs/examples/flatbits.md](docs/examples/flatbits.md), and the `stateHash` there must be the one the page records. Say in the pull request that you ran it.

## What not to change

Do not change the marker, the envelope layout, the leaf preimage, the Merkle folding, the reserve domain byte `0x01`, or the sale-order domain byte `0x02`. Those bytes are the protocol. A change there is a new marker, not a patch.

A collection's name, root, supply, and reserve groups are inputs (`--collection`, `--zip`). Do not hardcode a new collection into this tree, and do not add a transaction id or an address from one launch.

## Specs and license

Documents under `docs/specs/` are CC0-1.0. A wording edit is recorded in `docs/specs/CHANGELOG.md`. A change to a rule follows [the standards process](docs/STANDARDS-PROCESS.md).

Code and the other documents are [Apache-2.0](LICENSE). Copyright 2026 PINS contributors. See [NOTICE](NOTICE). A pull request licenses your changes to those files under Apache-2.0, and your changes under `docs/specs/` under CC0-1.0.

## Reports

Bugs, features and spec proposals: [GitHub issues](https://github.com/P2MR-Inscriptions/pins/issues). Vulnerabilities, and conduct that breaks the [code of conduct](CODE_OF_CONDUCT.md): GitHub private vulnerability reporting, as [SECURITY.md](SECURITY.md) describes. Do not attach keyfiles, seeds, or RPC passwords.
