<!-- SPDX-License-Identifier: Apache-2.0 -->

# Launch a collection

This repository is the protocol. It does not name a collection, a Merkle root, or reserve groups. Those live in a collection profile and a zip that you pass on the command line. Keep that profile and that zip out of this tree.

This guide is for anyone who wants to launch their own collection: your own images, your own profile, your own issuer key, your own addresses. Rehearse on regtest first. The public example, [FlatBits](../examples/flatbits.md), shows what a finished mainnet collection looks like on chain and what an indexer reports for it, so you can check your own result against the same kind of record. It is not a template that this repository ships: its art, keys, profile and plan are not here. To mint a single inscription with no collection, use `--single` (see [Single inscriptions](../../README.md#single-inscriptions)).

The specifications are Draft and some regtest vectors are open ([list](../specs/README.md#open-test-vectors)). Read them before a mainnet launch, and do the launch on a network you control first.

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
| `sale` | optional boolean, `true` when left out. `false` declares a collection with no sale (see below) |
| `reserveGroups` | non-empty array. Each group has `trait_type`, `value`, and a positive `count`. Not allowed with `sale: false` |
| `reserveExtra` | non-negative integer. Extra items taken after the groups. Not allowed with `sale: false` |
| `batchSize` | positive integer. The number of items in each reveal. An operator setting that is not on-chain and has no default. `plan` and `sign` refuse a profile without it (`sign` rebuilds the reveals the way `plan` cut them). `assign` and `preflight` do not need it; `sign` of a price plan does not either |

`reserveCount` is not a field you write. The parser sets it to the sum of the group counts plus `reserveExtra`, and refuses a sum larger than `supply`. It is the only reserve size the tools use. There is no default size: `plan` refuses an assignment of another size, and `sign` refuses a plan with a sale and the `pins` marker when it is not given the profile.

The groups are collection configuration. This repository does not list them.

## A collection with no sale

A profile with `"sale": false` has no `reserveGroups` and no `reserveExtra`. The tool then writes a genesis with the eight base keys and no `sale_commitment` (PINS-5 §3), and every item goes to the creator address, or to the holder when you name one.

- `keygen --no-sale` makes a keyfile with no sale secret. A keyfile that has one still works, and the secret is not used.
- `assign` takes no `--key`. It writes an empty assignment (no reserve, no sale ids, no commitment), so the later commands read the same file as before.
- `plan` and `sign` take no `--sale`. Give them `--creator`, `--change`, and `--utxo`. They refuse a `--sale`, and an assignment that has a reserve or a commitment.
- `plan` and `sign` take an optional `--holder`: the address that receives the items, when it is not the creator. The genesis and the leaf list still go to the creator. The holder is its own address, not the creator or the change address. `sign` needs the same `--holder` as `plan`, and refuses a plan whose holder is not the one you pass, or that has one when you pass none. `preflight` adds a holder row. A profile with a sale refuses `--holder`: its items go to `--sale`.
- `preflight` needs no `--key`. It skips the seed hash, reserve reproduction, and sale complement rows. Its sale commitment row passes only when the genesis has none.
- A plan carries `"noSale": true`. `sign` refuses a plan and a profile that disagree about the sale.

A profile without `sale`, or with `"sale": true`, works as before.

## Zip

`--zip` is the canonical zip. It must contain `images/`, `json/`, and `collection.json`. `assign`, `plan`, `sign`, and `preflight` read it and refuse a Merkle root that does not equal the profile.

`images/N.png` and `json/N.json` are numbered from 1, and the profile's `first` must be 1: the reference inscriber numbers items from 1 and refuses another value. `scripts/canonical-batch.ts`, which those commands call, reads ids 1 through the profile's `supply`. A zip that lacks one of them is refused, and so is a zip that has an item after the last one. The size of the image is not checked by the inscriber. `plan` puts `batchSize` items in each reveal, in order, and the last reveal holds the rest. Choose a size whose reveals stay under the weight limit; `plan` refuses one that does not (PINS-1 §9.5 measures one size). `collection.json` is inscribed as compact JSON with `largeImageFormat` removed and one trailing newline (PINS-4 §6).

Do not bake either path into the tool. The next collection passes different files.

## Order of commands

Offline, with no RPC URL: `keygen`, then `address`, then `assign` with `--collection` and `--zip`.

Fund the address from `address` with one QBT payment. That address is the issuer funding address. Do not use it as Reserve, Sale, Change, or Revenue.

Online, no keyfile: `plan` with the same profile and zip, the public JSON, the assignment, one funding outpoint, and the three addresses.

Offline again: `sign` with the same profile and zip. `sign` refuses an RPC URL.

Online: `preflight`, then `broadcast`. Testnet4 and mainnet need `--confirm-network` equal to `--network`.

`price` is a later offline command. It builds the sale-open inscription and does not broadcast. Sign its plan with `sign`, using the same profile and the assignment from `assign`. No zip is needed for it. Omit `--schema` on mainnet. The launch text stays `pins-price/1`.

A price is optional, and it belongs to a sale. A collection with no sale has none: `price` refuses a profile with `"sale": false`, and the indexer reads no price inscription for a genesis without `sale_commitment` (PINS-6 §5.1). The tool holds no price value. `price_bits`, `price_sources`, and `price_time` come from the file given with `--price`, and the tool and the indexer check only that they are well formed.

The indexer takes `--collection` when you want `reserveMode` `configured`. Without it, the indexer still marks an inscription authentic when the leaf matches. It does not invent a collection.

Command lines are in [the inscriber guide](../inscriber/README.md) and in the repository [README](../../README.md).
