<!-- SPDX-License-Identifier: Apache-2.0 -->

# Mint tool

The reference minter builds one confirmed fan-out, then the reveals. Postage is 10,000 bits.
A reveal heavier than 400,000 bytes is refused. How many pieces are reserved is the
collection profile, not a default in this tool. The reserve size is the sum of the profile's
`reserveGroups` counts and `reserveExtra`. No command and no library call assumes a size.
`plan` refuses an assignment whose reserve is not that size, and `sign` refuses a plan that
uses the `pins` marker unless the profile gives it that size.

The number of items is the profile's `supply`, and the number of items in each reveal is its
`batchSize`. Neither has a default in the tool. The loader reads items 1 through `supply` and
refuses a zip with one more, and `plan` refuses a profile without `batchSize`.

The sale stays closed until a wallet can complete a pre-signed offer. The tool still
assigns the profile's reserve ids to the creator address, the rest to a sale holding
address, and every mint change output to a third address.

A profile with `"sale": false` declares no sale. The tool then needs no sale secret, no reserve, no
commitment and no `--sale` address, and every item goes to the creator address. See
[the launch guide](../guides/COLLECTION-LAUNCH.md#a-collection-with-no-sale). Everything below is the path with a sale.

## Air gap

Four mint commands. Only `plan` and `broadcast` touch a network. `price` is also offline. It builds the sale-open inscription and does not broadcast.

1. `keygen` and `assign` run on the offline machine. `keygen` writes an encrypted keyfile
   and a public JSON file. Make two encrypted copies of the keyfile and keep them apart.
   Do not store the passphrase with either copy. `assign` reads the keyfile and writes the
   reserve and sale id lists and `saleCommitment` (SHA-256 of the sale secret). It does not write the sale secret.
2. `plan` runs online, watch-only. It reads the public keys, the id lists, the canonical
   zip, and one funding UTXO. It writes unsigned transactions. It has no secret.
3. `sign` runs offline. It checks the Merkle root against
   the root in `--collection`, rebuilds the genesis and every reveal leaf from the zip and compares the bytes with the plan, checks every reveal
   weight, checks postage, recomputes the reserve from the keyfile, refuses a reserve the indexer would not reproduce, and only then signs.
   It also requires `--creator`, `--sale`, `--change`, and `--utxo`. Those are the same
   three addresses and the same funding file passed to `plan`. They are not read from
   the plan. Copying them out of the plan does not check anything. `sign` refuses an RPC URL.
4. `broadcast` runs online. It sends the fan-out and waits for one confirmation.
   With `--mine` (regtest only) it then sends all the reveals before mining any of them.
   They sit in the mempool together, and a block holds at most five. `prioritisetransaction`
   makes the regtest miner take the genesis reveal first and the batches in number order.
   That extra priority is not a fee. Without `--mine`, each reveal is confirmed before
   the next one is sent, so a public miner cannot place an item before the genesis.
   Running the command again skips a transaction that is already confirmed.

Qbit Wallet v1.0.7 can pay the funding address and can hold the reserve pieces. It cannot
sign the reveal leaves. The launch sequence is the collection-launch guide.

The default network is regtest. `broadcast` on mainnet or testnet4 is refused unless
`--network` names that chain and `--confirm-network` is exactly the same word.

`--mine` asks a regtest node to mine while it waits. It is refused on every other network.

## Commands

```text
node --experimental-strip-types packages/inscriber/cli.ts keygen --out issuer.key
node --experimental-strip-types packages/inscriber/cli.ts address --pub issuer.key.pub.json --network regtest
node --experimental-strip-types packages/inscriber/cli.ts assign --key issuer.key --collection profile.json --zip collection.zip --out reserve.json
node --experimental-strip-types packages/inscriber/cli.ts plan --pub issuer.key.pub.json --assignment reserve.json --collection profile.json --zip collection.zip --utxo utxo.json --creator <address> --sale <address> --change <address> --fee-rate 1 --out plan.json
node --experimental-strip-types packages/inscriber/cli.ts sign --key issuer.key --plan plan.json --collection profile.json --zip collection.zip --out plan.signed.json
node --experimental-strip-types packages/inscriber/cli.ts broadcast --plan plan.signed.json --rpc http://127.0.0.1:18443/ --rpc-user YOUR_RPC_USER --rpc-password YOUR_RPC_PASSWORD --mine
node --experimental-strip-types packages/inscriber/cli.ts preflight --network mainnet --confirm-network mainnet --plan plan.json --signed plan.signed.json --assignment reserve.json --collection profile.json --zip collection.zip --utxo utxo.json --pub issuer.key.pub.json --key issuer.key --rpc http://127.0.0.1:RPC_PORT/ --rpc-user YOUR_RPC_USER --rpc-password YOUR_RPC_PASSWORD
node --experimental-strip-types packages/inscriber/cli.ts price --pub issuer.key.pub.json --price price.json --genesis <txid>i0 --utxo utxo.json --creator <address> --sale <address> --change <address> --fee-rate 1 --network regtest --root <64 hex> --out price-plan.json
```

`npm run mainnet:preflight` is the preflight command. It reads `--key`, re-runs the reserve selection the indexer will run, checks the sale-secret hash against `sale_commitment`, and wipes the secret. Without `--key` those rows fail. Every row must be `PASS` before broadcast. `plan` does not take a price file. A price is optional. It belongs to a collection that declares a sale, and `price` refuses a `--collection` profile with `"sale": false`. `price` builds the sale-open inscription and does not broadcast. The tool holds no price: `price_bits`, `price_sources`, and `price_time` are read from the `--price` file, and only their form is checked. `--schema` on `price` is the rehearsal mask, the same value the indexer takes (`c/1` derives price text `p/1`). Omit it on mainnet. The launch text stays `pins-price/1`.

Where each output goes is one rule (`packages/inscriber/destination.ts`), used by `plan` to build a plan and by `sign` to check it:

- The genesis and the leaf list go to `--creator`.
- An item goes to `--creator` when it is in the reserve, and to `--sale` otherwise. A collection with no sale has no reserve and no `--sale`. Its items go to `--creator`, or to `--holder` when you pass one.
- The last output of every reveal is mint change. It goes to `--change`.

The funding address is the issuer address from `address`. These addresses are all different, and `preflight` checks it. An address that receives payments outside the mint is not a flag on `plan` or `preflight`, and must not be passed as any of them.

`sign` checks each unsigned raw transaction against `--creator`, `--sale`, and `--change`, and checks the fan-out input against `--utxo`. The address strings inside the plan are not a second source. The reveal control block must be a valid P2MR path from the reveal leaf to the commit root. The fan-out control block must match the issuer recovery leaf. A plan whose addresses or funding outpoint were replaced is refused while those four inputs stay the ones you passed to `plan`. `sign` does not accept a plan that omits them. A library call to `signPlan` requires the same `SignExpectations` object. There is no default that reads the plan.

`sign` rebuilds the genesis and each reveal leaf from the zip with the same code `plan` uses (`revealGroups` and `groupLeaf` in `plan.ts`), and compares them with the plan: the leaves, the names and the order of the reveals, the item number carried by each output, and the address of each output under the destination rule. The issuer key comes from the keyfile. The genesis field 5 is rebuilt from the profile, the root, and, for a collection with a sale on mainnet, the hash of the keyfile's own sale secret, not the commitment the plan carries. A collection with no sale has no commitment and no sale secret is read. The reveals are grouped by the profile's `batchSize`, so `sign` needs it with `--collection`, as `plan` does. A plan with the `pins` marker is refused without the zip. A plan that is not what the zip makes is refused, so a plan made on the online machine cannot get other content signed with the issuer key. `sign` also refuses a marker other than `pins` when the plan says mainnet, as `plan` does.

`sign` also signs the plan that `price` writes. That plan has no item and no reserve, so `sign` needs `--collection` and `--assignment` and no `--zip`. The price plan is not rebuilt from a zip. It is rebuilt from its own price record: one inscription whose body is the price text of the record's schema, as plain text, with the record as field 5, and nothing else, so the issuer key signs no other content. The price field does not carry the sale commitment. `sign` takes it from the assignment, which `assign` wrote, and refuses the plan unless the hash of the keyfile's sale secret equals it. It also checks that the price field is well formed with the price schema of the collection.

`--dry-run` on `plan` or `sign` prints the summary and does not write the output file.

The passphrase is read from the terminal with echo off. Tests may set `PINS_KEY_PASSPHRASE`. Do not set
that variable for a real key: other processes of the same user can see it. The tool does not print the passphrase or the secret bytes. A new key file is created with mode 0600 and is not overwritten if that path already exists.

`utxo.json` is one object: `txid`, `vout`, `value` (bits, as a decimal string), and
`script` (hex). The output must be the issuer key's own P2MR address.

## Regtest measurement

A regtest run at 1 bit per vbyte confirmed the fan-out first, then the reveals.
Fee and weight follow the zip. They are not constants of this tool.

The zip is untrusted input and is only read. The tool lists it with the system `unzip` (Info-ZIP), which must be on the PATH, and refuses it before it writes anything when an entry has an absolute path, a `..` segment, a backslash or a drive letter, is a link or a special file, or repeats another entry's name. It also refuses more than 200,000 entries, an entry above 64 MiB, or more than 1 GiB in all. A real collection is far below that (a zip of 10,000 items has about 20,000 entries and 16 MB). It extracts into an empty folder and never overwrites. `plan` and `sign` do this for the zip they read.
