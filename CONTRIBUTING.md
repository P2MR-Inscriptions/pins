<!-- SPDX-License-Identifier: Apache-2.0 -->

# Contributing

PINS is the inscription protocol in `docs/specs/` and the reference indexer and inscriber next to it.

## Setup

Node.js 22 is required. `node -v` must start with `v22`.

```text
npm ci
npm run build
npm run lint
npm run typecheck
npm test
```

`npm run build` and `npm run typecheck` both run `tsc --noEmit`. The programs run with `node --experimental-strip-types`. There is no compiler emit.

The package is marked `private`. Do not publish it to npm. The name `pins` is already an unrelated package.

## What not to change

Do not change the marker, the envelope layout, the leaf preimage, the Merkle folding, the reserve domain byte `0x01`, or the sale-order domain byte `0x02`. Those bytes are the protocol. A change there is a new marker, not a patch.

A collection's name, root, supply, and reserve groups are inputs (`--collection`, `--zip`). Do not hardcode a new collection into this tree, and do not add a transaction id or an address from one mint.

## Specs and license

Documents under `docs/specs/` are CC0-1.0. Edit the normative text only when the byte layout is unchanged, and record the edit in `docs/specs/CHANGELOG.md`.

Code and the other documents are [Apache-2.0](LICENSE). Copyright 2026 The PINS authors. See [NOTICE](NOTICE). A pull request licenses your changes to those files under Apache-2.0, and your changes under `docs/specs/` under CC0-1.0.

## Reports

Bugs and features: [GitHub issues](https://github.com/P2MR-Inscriptions/pins/issues). Vulnerabilities: [SECURITY.md](SECURITY.md). Do not attach keyfiles, seeds, or RPC passwords.
