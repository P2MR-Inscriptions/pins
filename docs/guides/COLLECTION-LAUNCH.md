<!-- SPDX-License-Identifier: Apache-2.0 -->

# Launch a collection

This repository is the protocol. It does not name a collection, a Merkle root, or reserve groups. Those live in a collection profile and a zip that you pass on the command line. Keep that profile and that zip out of this tree.

## Profile

`--collection` is a JSON file. `packages/protocol/profile.mjs` accepts these fields:

| Field | Rule |
|---|---|
| `name` | non-empty string |
| `namePrefix` | string. Item names are this prefix plus the decimal item number |
| `supply` | positive integer |
| `first` | non-negative integer. The first item number |
| `schema` | non-empty string. Mainnet genesis uses `pins-collection/1` |
| `itemType` | non-empty string, for example `image/png` |
| `root` | 64 lowercase hex characters. Must equal the Merkle root of the zip |
| `reserveGroups` | non-empty array. Each group has `trait_type`, `value`, and a positive `count` |
| `reserveExtra` | non-negative integer. Extra items taken after the groups |

`reserveCount` is not a field you write. The parser sets it to the sum of the group counts plus `reserveExtra`, and refuses a sum larger than `supply`.

The groups are collection configuration. This repository does not list them.

## Zip

`--zip` is the canonical zip. It must contain `images/`, `json/`, and `collection.json`. `assign`, `plan`, `sign`, and `preflight` read it and refuse a Merkle root that does not equal the profile.

`images/N.png` and `json/N.json` are numbered from 1. `scripts/canonical-batch.ts`, which those commands call, reads ids 1 through 10,000. The profile's `supply` does not change that loop. A zip with a different count fails when a file in that range is missing. That limit is this loader, not a consensus rule. `collection.json` is inscribed as compact JSON with `largeImageFormat` removed and one trailing newline (PINS-4 §6).

Do not bake either path into the tool. The next collection passes different files.

## Order of commands

Offline, with no RPC URL: `keygen`, then `address`, then `assign` with `--collection` and `--zip`.

Fund the address from `address` with one QBT payment. That address is the issuer funding address. Do not use it as Reserve, Sale, Change, or Revenue.

Online, no keyfile: `plan` with the same profile and zip, the public JSON, the assignment, one funding outpoint, and the three addresses.

Offline again: `sign` with the same profile and zip. `sign` refuses an RPC URL.

Online: `preflight`, then `broadcast`. Testnet4 and mainnet need `--confirm-network` equal to `--network`.

`price` is a later offline command. It builds the sale-open inscription and does not broadcast. Omit `--schema` on mainnet. The launch text stays `pins-price/1`.

The indexer takes `--collection` when you want `reserveMode` `configured`. Without it, the indexer still marks an inscription authentic when the leaf matches. It does not invent a collection.

Command lines are in [the inscriber guide](../inscriber/README.md) and in the repository [README](../../README.md).
