<!-- SPDX-License-Identifier: Apache-2.0 -->

# Changelog

This file records the reference tools and the repository layout. Specification edits are in [docs/specs/CHANGELOG.md](docs/specs/CHANGELOG.md).

## Unreleased

- Indexer: `--genesis <inscription id>` makes the collection view accept only that inscription as its genesis. Without it, the first valid genesis in chain order is used, as before.
- Indexer: field 5 metadata whose `name` is not text, or whose `attributes` are not text pairs, is ignored. It no longer makes `/collection` and `/pieces` fail.
- Inscriber: the envelope reader takes only an empty push at a tag position as the body separator. An empty field value no longer ends the fields early. A multi-byte tag with an even first byte now makes the inscription opaque, as PINS-1 §5.4 says.
- Indexer: the CBOR reader keeps a map key named `__proto__` and a leading byte order mark in a text string. The content type of an inscription keeps a leading byte order mark.
- Indexer: an input counts as carrying inscriptions only when the control block has leaf version 0xc0 and the spent output is not known to be something other than P2MR (PINS-1 §4.2). The store keeps the output type, and an existing database is upgraded in place; its older outputs are not checked.
- Indexer: a P2MR spend without witness items stops the indexer with `witness pruned` (PINS-2 §2). The guard existed but was never called.
- Indexer: the block subsidy comes from the schedule of PINS-2 §5.1 and the height, not from the coinbase. A coinbase that claims less than the subsidy and the fees now leaves a lost tail, as PINS-3 §6 says, instead of shifting every fee bit.
- Specifications: clarifications that match the deployed format and the reference indexer. No valid inscription becomes invalid. See [docs/specs/CHANGELOG.md](docs/specs/CHANGELOG.md).

## 1.0.0

- Reference indexer and inscriber for PINS on Qbit, marker `pins`.
- Code, tools, and the guides are Apache-2.0. Copyright 2026 The PINS authors. See NOTICE.
- Specifications PINS-1 through PINS-6 under `docs/specs/` (CC0-1.0).
- The package installs, builds, lints, typechecks, and tests from this directory alone.
- Repository links point at https://github.com/P2MR-Inscriptions/pins.
- No collection name, root, or transaction id is a default of this tree.
- Mainnet activation height is 161948, the block containing the first `pins` envelope. Regtest stays 0. Testnet4 has no published activation height.
- Clone the repository to run it. Node's type stripping does not work from `node_modules`, so this package is not published to npm.
