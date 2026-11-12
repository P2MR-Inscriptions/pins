<!-- SPDX-License-Identifier: Apache-2.0 -->

# Contributing

PINS is the inscription protocol in `docs/specs/` and the reference indexer and inscriber next to it.

## Setup

Node.js 22.13 or newer, up to Node 24 (the `engines` range is `>=22.13 <25`). Node 22.12 and older lack `node:sqlite` without a flag, which the indexer needs. `.nvmrc` names Node 22, the version that continuous integration runs. The tests also pass on Node 24.

```text
npm ci
npm run build
npm run lint
npm run typecheck
npm test
```

`npm run build` and `npm run typecheck` both run `tsc --noEmit`. The programs run with `node --experimental-strip-types`. There is no compiler emit.

The package is marked `private`. Do not publish it to npm. The name `pins` is already an unrelated package.

## Continuous integration and automation

Everything below lives in `.github/` and is plain configuration. You can read it, and you can run each check yourself with the commands above.

| Check | File | What it runs | Run it locally |
|---|---|---|---|
| `Typecheck and test` | `.github/workflows/ci.yml` | `npm ci`, `npm run lint`, `npm run typecheck`, `npm test` in the repository root | the four commands in Setup |
| `Explorer typecheck and test` | `.github/workflows/ci.yml` | `npm ci` in the root and in `explorer/`, then `npm run typecheck` and `npm run test` in `explorer/` | the same, from `explorer/` |
| `Dependency audit` | `.github/workflows/ci.yml` | `npm audit --audit-level=high` for the root and for `explorer/`. It reads the lock files and installs nothing | `npm audit --audit-level=high` in each folder |
| `Analyze (javascript-typescript)` | `.github/workflows/codeql.yml` | CodeQL code scanning on pull requests to `main`, on pushes to `main`, and weekly | no local command. Results are in the Security tab |

CI runs once per change: on a pull request, and on `main` after a merge. It uses the Node version in `.nvmrc`. Every action is pinned by commit SHA with its version in a comment, and the workflow token is read-only. `.github/dependabot.yml` opens weekly pull requests for newer actions and npm packages. When you add an action, pin it by SHA the same way, and give a job only the permissions it needs.

## What not to change

Do not change the marker, the envelope layout, the leaf preimage, the Merkle folding, the reserve domain byte `0x01`, or the sale-order domain byte `0x02`. Those bytes are the protocol. A change there is a new marker, not a patch.

A collection's name, root, supply, and reserve groups are inputs (`--collection`, `--zip`). Do not hardcode a new collection into this tree, and do not add a transaction id or an address from one mint.

## Specs and license

Documents under `docs/specs/` are CC0-1.0. Edit the normative text only when the byte layout is unchanged, and record the edit in `docs/specs/CHANGELOG.md`.

Code and the other documents are [Apache-2.0](LICENSE). Copyright 2026 The PINS authors. See [NOTICE](NOTICE). A pull request licenses your changes to those files under Apache-2.0, and your changes under `docs/specs/` under CC0-1.0.

## Reports

Bugs and features: [GitHub issues](https://github.com/P2MR-Inscriptions/pins/issues). Vulnerabilities: [SECURITY.md](SECURITY.md). Do not attach keyfiles, seeds, or RPC passwords.
