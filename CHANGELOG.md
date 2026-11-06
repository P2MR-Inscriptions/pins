<!-- SPDX-License-Identifier: Apache-2.0 -->

# Changelog

This file records the reference tools and the repository layout. Specification edits are in [docs/specs/CHANGELOG.md](docs/specs/CHANGELOG.md).

## 1.0.0

- Reference indexer and inscriber for PINS on Qbit, marker `pins`.
- Code, tools, and the guides are Apache-2.0. Copyright 2026 The PINS authors. See NOTICE.
- Specifications PINS-1 through PINS-6 under `docs/specs/` (CC0-1.0).
- The package installs, builds, lints, typechecks, and tests from this directory alone.
- Repository links point at https://github.com/P2MR-PINS-Protocol/pins.
- No collection name, root, or transaction id is a default of this tree.
- Mainnet activation height is 161948, the block containing the first `pins` envelope. Regtest stays 0. Testnet4 has no published activation height.
- Clone the repository to run it. Node's type stripping does not work from `node_modules`, so this package is not published to npm.
