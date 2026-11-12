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
- Indexer: the sale reveal is the PINS-5 §8.5 inscription: signed by the issuer key, after the genesis, with field 5 `pins-sale-reveal/1`, the genesis root, and the committed secret. An inscription whose body is the bare secret no longer reveals the sale order. The closing inscription of PINS-5 §7 is read, and an item inscribed after it is not authentic. `/collection` reports it as `closingId`.
- Indexer: the default undo depth is 1,000 blocks, the minimum PINS-2 §4.3 recommends. It was 100, so a reorg deeper than that stopped the indexer and forced a resync. A database that kept fewer undo rows reaches the new depth as blocks arrive.
- Indexer: the database records the network, the envelope marker, the collection schema, the activation height and the genesis given with `--genesis`, and refuses to be opened or followed with other values. A database from before this is adopted on its first start and the values of that run are written. `follow` also refuses a store built for another network than the one it is asked to follow.
- Indexer: a node call that fails while polling (a restart, a timeout, a block index that is still loading) is logged and retried after 1 s, 2 s, 4 s and so on up to 60 s. The process stops after 30 failures in a row. It used to exit at the first failure. An error from the indexer itself still stops it at once.
- Indexer: node calls no longer block the process. `curl` runs as a child process without waiting on it, so the HTTP API answers during a call, including the 180 s limit of one. The credentials still go to curl on stdin only.
- Indexer: the `outputs` table no longer keeps every output for ever. A spent output is deleted once the undo of the block that spent it is, so a reorg within the undo depth still finds it. A database from before this is upgraded in place; its older outputs are kept, because it does not record which are spent.
- Inscriber: `broadcast` on testnet4 no longer scans the planned bytes against a hard-coded list of words and a hash. The list was unrelated to the protocol and is removed with its module. The testnet4 refusal of the `pins` marker stays.
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
