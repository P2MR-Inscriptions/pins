<!-- SPDX-License-Identifier: Apache-2.0 -->

# Inscriber

This page describes the reference inscriber. It inscribes a collection: a genesis P2MR Inscription and the items of a zip. With `--single` on `plan`, `sign` and `preflight` it inscribes one stand-alone P2MR Inscription instead: a body file, a content type, no genesis and no collection (see [Single P2MR Inscription](#single-p2mr-inscription) below).

The reference inscriber builds one confirmed fan-out, then the reveals. Postage is 10,000 bits.
A reveal heavier than 400,000 bytes is refused. How many pieces are reserved is the
collection profile, not a default in this tool. The reserve size is the sum of the profile's
`reserveGroups` counts and `reserveExtra`. No command and no library call assumes a size.
`plan` refuses an assignment whose reserve is not that size, and `sign` refuses a plan that
uses the `pins` marker unless the profile gives it that size.

The number of items is the profile's `supply`, and the number of items in each reveal is its
`batchSize`. Neither has a default in the tool. The loader reads items 1 through `supply` and
refuses a zip with one more, and `plan` refuses a profile without `batchSize`.

The tool assigns the profile's reserve items to the creator address, the rest to a sale holding
address, and every change output to a third address. The sale itself is not run by this tool
(see [the sale guide](../guides/SALE-AND-TRADE.md)).

A profile with `"sale": false` declares no sale. The tool then needs no sale secret, no reserve, no
commitment and no `--sale` address, and every item goes to the creator address. See
[the launch guide](../guides/COLLECTION-LAUNCH.md#a-collection-with-no-sale). Everything below is the path with a sale.

## Air gap

The reference inscriber has fourteen commands: `keygen`, `address`, `utxo`, `root`, `assign`, `plan`, `sign`, `broadcast`, `preflight`, `price`, `unsold-address`, `sale-reveal`, `unsold-transfer` and `close`. Only `utxo`, `broadcast` and `preflight` talk to a node, and all three need `--rpc`. `keygen`, `address`, `root`, `assign`, `sign`, `price`, `unsold-address`, `sale-reveal`, `unsold-transfer` and `close` refuse an RPC URL. `plan` reads the funding output from a file (`utxo.json`) and never calls a node, so it can run on an online watch-only machine with no node credentials. `price` builds the sale-open P2MR Inscription and does not broadcast. `unsold-address`, `sale-reveal` and `close` build and sign the three records that close a sale and a collection (PINS-5 §7 and §8.5), each as one P2MR Inscription, and `unsold-transfer` builds the unsigned PSBTs that move the unsold items to the committed address: [Close the sale](../guides/SALE-AND-TRADE.md#close-the-sale). The numbered steps below are the launch itself: `keygen`, `assign`, `plan`, `sign`, `broadcast`. `address` gives the funding address, and `preflight` checks a plan and a signed plan against a node before `broadcast`.

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

Qbit Wallet can pay the funding address. It cannot sign the reveal leaves.

> **Warning.** Qbit Wallet has no code for PINS: it does not know which output holds a P2MR Inscription, and it can spend that output as plain value, as change or as a payment. Do not keep a P2MR Inscription in a Qbit Wallet account that you spend from. To move one, use the PINS tools (`npm run inscribe`, and the sale library for a trade) and broadcast the signed transaction with `qbit-cli sendrawtransaction`.

The launch sequence is the collection-launch guide.

The default network is regtest. `broadcast` on mainnet or testnet4 is refused unless
`--network` names that chain and `--confirm-network` is exactly the same word.

`--mine` asks a regtest node to mine while it waits. It is refused on every other network.

## Commands

Every command has a `--help` page that lists all of its options: `npm run inscribe -- --help` lists the commands, and `npm run inscribe -- <command> --help` the options of one.

```text
node --experimental-strip-types packages/inscriber/cli.ts keygen --out issuer.key
node --experimental-strip-types packages/inscriber/cli.ts address --pub issuer.key.pub.json --network regtest
node --experimental-strip-types packages/inscriber/cli.ts utxo --pub issuer.key.pub.json --network regtest --rpc http://127.0.0.1:18452/ --rpc-user YOUR_RPC_USER --rpc-password YOUR_RPC_PASSWORD --out utxo.json
node --experimental-strip-types packages/inscriber/cli.ts root --zip collection.zip --collection profile.json
node --experimental-strip-types packages/inscriber/cli.ts assign --key issuer.key --collection profile.json --zip collection.zip --out reserve.json
node --experimental-strip-types packages/inscriber/cli.ts plan --pub issuer.key.pub.json --assignment reserve.json --collection profile.json --zip collection.zip --utxo utxo.json --creator <address> --sale <address> --change <address> --fee-rate 1 --out plan.json
node --experimental-strip-types packages/inscriber/cli.ts sign --key issuer.key --plan plan.json --collection profile.json --zip collection.zip --out plan.signed.json
node --experimental-strip-types packages/inscriber/cli.ts broadcast --plan plan.signed.json --rpc http://127.0.0.1:18452/ --rpc-user YOUR_RPC_USER --rpc-password YOUR_RPC_PASSWORD --mine
# or, with the node's cookie instead of a user and password: --rpc-datadir YOUR_NODE_DATADIR (see docs/guides/NODE-LOGIN.md)
node --experimental-strip-types packages/inscriber/cli.ts preflight --network mainnet --confirm-network mainnet --plan plan.json --signed plan.signed.json --assignment reserve.json --collection profile.json --zip collection.zip --utxo utxo.json --pub issuer.key.pub.json --key issuer.key --rpc http://127.0.0.1:RPC_PORT/ --rpc-user YOUR_RPC_USER --rpc-password YOUR_RPC_PASSWORD
node --experimental-strip-types packages/inscriber/cli.ts price --pub issuer.key.pub.json --price price.json --genesis <txid>i0 --utxo utxo.json --creator <address> --sale <address> --change <address> --fee-rate 1 --network regtest --root <64 hex> --out price-plan.json
node --experimental-strip-types packages/inscriber/cli.ts unsold-address --key issuer.key --pub issuer.key.pub.json --collection profile.json --utxo utxo.json --creator <address> --change <address> --unsold-address <address> --fee-rate 1 --network regtest --out unsold-address.signed.json
node --experimental-strip-types packages/inscriber/cli.ts sale-reveal --key issuer.key --pub issuer.key.pub.json --collection profile.json --assignment reserve.json --utxo utxo.json --creator <address> --change <address> --fee-rate 1 --network regtest --out sale-reveal.signed.json
node --experimental-strip-types packages/inscriber/cli.ts unsold-transfer --items sale-coins.json --funding fee-coins.json --unsold-address <address> --change <address> --fee-rate 1 --network regtest --out unsold
node --experimental-strip-types packages/inscriber/cli.ts close --key issuer.key --pub issuer.key.pub.json --collection profile.json --utxo utxo.json --creator <address> --change <address> --fee-rate 1 --network regtest --out close.signed.json
```

`npm run mainnet:preflight` is the preflight command. It reads `--key`, re-runs the reserve selection the indexer will run, checks the sale-secret hash against `sale_commitment`, and wipes the secret. Without `--key` those rows fail. Every row must be `PASS` before broadcast. `plan` does not take a price file. A price is optional. It belongs to a collection that declares a sale, and `price` refuses a `--collection` profile with `"sale": false`. `price` builds the sale-open P2MR Inscription and does not broadcast. `unsold-address`, `sale-reveal` and `close` build and sign the three records that close a sale and a collection (PINS-5 §7 and §8.5), each as one P2MR Inscription, and `unsold-transfer` builds the unsigned PSBTs that move the unsold items to the committed address: [Close the sale](../guides/SALE-AND-TRADE.md#close-the-sale). The tool holds no price: `price_bits`, `price_sources`, and `price_time` are read from the `--price` file, and only their form is checked. `--schema` on `price` is the rehearsal mask, the same value the indexer takes (`c/1` derives price text `p/1`). Omit it on mainnet. The launch text stays `pins-price/1`.

Where each output goes is one rule (`packages/inscriber/destination.ts`), used by `plan` to build a plan and by `sign` to check it:

- The genesis and the leaf list go to `--creator`.
- An item goes to `--creator` when it is in the reserve, and to `--sale` otherwise. A collection with no sale has no reserve and no `--sale`. Its items go to `--creator`, or to `--holder` when you pass one.
- The last output of every reveal is change. It goes to `--change`.

The funding address is the issuer address from `address`. These addresses are all different, and `preflight` checks it. An address that receives payments outside the launch is not a flag on `plan` or `preflight`, and must not be passed as any of them.

`sign` checks each unsigned raw transaction against `--creator`, `--sale`, and `--change`, and checks the fan-out input against `--utxo`. The address strings inside the plan are not a second source. The reveal control block must be a valid P2MR path from the reveal leaf to the commit root. The fan-out control block must match the issuer recovery leaf. A plan whose addresses or funding outpoint were replaced is refused while those four inputs stay the ones you passed to `plan`. `sign` does not accept a plan that omits them. A library call to `signPlan` requires the same `SignExpectations` object. There is no default that reads the plan.

`sign` rebuilds the genesis and each reveal leaf from the zip with the same code `plan` uses (`revealGroups` and `groupLeaf` in `plan.ts`), and compares them with the plan: the leaves, the names and the order of the reveals, the item number carried by each output, and the address of each output under the destination rule. The issuer key comes from the keyfile. The genesis field 5 is rebuilt from the profile, the root, and, for a collection with a sale on mainnet, the hash of the keyfile's own sale secret, not the commitment the plan carries. A collection with no sale has no commitment and no sale secret is read. The reveals are grouped by the profile's `batchSize`, so `sign` needs it with `--collection`, as `plan` does. A plan with the `pins` marker is refused without the zip. A plan that is not what the zip makes is refused, so a plan made on the online machine cannot get other content signed with the issuer key. `sign` also refuses a marker other than `pins` when the plan says mainnet, as `plan` does.

`sign` also signs the plan that `price` writes. That plan has no item and no reserve, so `sign` needs `--collection` and `--assignment` and no `--zip`. The price plan is not rebuilt from a zip. It is rebuilt from its own price record: one P2MR Inscription whose body is the price text of the record's schema, as plain text, with the record as field 5, and nothing else, so the issuer key signs no other content. The price field does not carry the sale commitment. `sign` takes it from the assignment, which `assign` wrote, and refuses the plan unless the hash of the keyfile's sale secret equals it. It also checks that the price field is well formed with the price schema of the collection.

`unsold-address`, `sale-reveal` and `close` each build one P2MR Inscription of PINS-5 and sign it with the issuer key in the same command, so they need `--key` and run on the offline machine. The record is one stand-alone P2MR Inscription: its body is the schema text, its content type is `text/plain`, and its field 5 is the map of PINS-5 §7 or §8.5 with exactly its three keys. They write a signed plan that `broadcast` sends, and `preflight --record unsold-address|sale-reveal|close` checks that plan against the node and the files (the root of `--collection`, the supply for the closing, the sale commitment of `--assignment` for the sale reveal, the address for the commitment). `sale-reveal` refuses a keyfile whose secret does not hash to the `saleCommitment` of the assignment, and writes its plan with mode `0600`, because the plan holds the secret until it is broadcast. `unsold-transfer` builds the unsigned PSBTs that move the unsold items to the committed address and signs nothing. The steps, in order, with the checks to run between them, are in [Close the sale](../guides/SALE-AND-TRADE.md#close-the-sale).

## Single P2MR Inscription

`plan --single`, `sign --single` and `preflight --single` inscribe one P2MR Inscription with no collection. The flags are `--body <file>`, `--content-type <mime>`, and optionally `--metadata <file>`, together with the flags every plan takes (`--pub`, `--utxo`, `--creator`, `--change`, `--fee-rate`, `--network`). The collection flags (`--collection`, `--zip`, `--assignment`, `--sale`, `--holder`, `--root`) are refused with `--single`, and `--body`, `--content-type` and `--metadata` are refused without it. `assign` has no `--single`: there is no reserve.

- The plan is one fan-out and one reveal named `inscription`. The reveal has two outputs: the P2MR Inscription output (10,000 bits) to `--creator`, and change to `--change`. The id of the P2MR Inscription is the txid of that reveal and `i0`; `plan` prints it.
- The body is written as the file holds it, in the envelope of PINS-1. It must not be empty. The content type must be an ASCII MIME type of at most 255 characters. `--metadata` is JSON in the item record form (`{"meta": {"name": ..., "attributes": [...]}}`), written as canonical field 5. It can never be a collection genesis, because only that record form is accepted.
- `sign --single` rebuilds the reveal leaf from the files with the same code `plan` uses (`revealGroups` and `groupLeaf` in `plan.ts`) and the issuer key of the keyfile, and compares it with the plan, together with the output addresses, as it does for a collection. A plan for other content is refused. The plan carries `"single": true` and `"noSale": true` and an empty `root`. `sign` accepts such a plan only when you pass `--single` with the files, and refuses a plan without that flag, so the plan cannot choose the path.
- `preflight --single` runs the node, address, funding, fee-rate, weight and signed-body rows, and adds `single P2MR Inscription` (the plan has no sale, holder or root) and `P2MR Inscription content` (the signed leaf is the leaf of these files). It has no root, quota, genesis or reserve rows.
- `broadcast` is the same command: it sends the fan-out, waits for it, then sends the reveal.

`--dry-run` on `plan` or `sign` prints the summary and does not write the output file.

The passphrase is read from the terminal with echo off. Tests may set `PINS_KEY_PASSPHRASE`. Do not set
that variable for a real key: other processes of the same user can see it. The tool does not print the passphrase or the secret bytes. A new key file is created with mode 0600 and is not overwritten if that path already exists.

The keyfile is JSON: scrypt parameters (`n`, `r`, `p`), a salt, and an AES-256-GCM envelope around the issuer secret, the recovery secret, and, unless `keygen --no-sale` was used, the sale secret. `keygen` writes `n = 131072` (2^17, which takes 128 MiB of memory and about half a second to stretch the passphrase), `r = 8`, `p = 1`, and the two keys each come from their own random draw. A keyfile with `n = 16384` (2^14) opens unchanged, with the same keys: that is the minimum cost the tool accepts, and it does not rewrite a file. The tool raises Node's scrypt memory limit to what the file's cost needs, so a file with `n = 131072` opens too. To get the stronger cost for an existing key, run `keygen` again and move the collection to the new key only if you have not inscribed yet; a key that already signed a collection stays as it is. Before the passphrase is stretched, the tool checks the parameters in the file. It refuses a file with a version or key derivation other than `1` and `scrypt`, with `n` that is not a power of two, with a cost below the minimum (`n` below 16384, or `r` below 8), or with a cost far above it (`n` above 2^20, `r` above 16, `p` above 16, more than 2^26 for `n*r*p`, or more than 1 GiB of memory), and it says which value is out of range. The ceiling is well above the default so that a stronger setting still opens. A wrong passphrase still fails at the authentication check.

`utxo.json` is one object: `txid`, `vout`, `value` (bits, as a decimal string), and
`script` (hex). The output must be the issuer key's own P2MR address.

### Getting `utxo.json` from your own node

The funding address belongs to the issuer key, not to a wallet, so a wallet's `listunspent` never shows it. `utxo` asks your node for the output and writes the file:

```text
node --experimental-strip-types packages/inscriber/cli.ts utxo --pub issuer.key.pub.json --network regtest --rpc http://127.0.0.1:18452/ --rpc-user YOUR_RPC_USER --rpc-password YOUR_RPC_PASSWORD --out utxo.json
```

- It asks the node for the outputs that pay the address (`scantxoutset`), and writes the one that does. If the address has no output, or several, it stops and lists them. With several, `--txid <txid>` picks the payment (it also needs the node's `txindex=1`, to read the transaction, and `gettxout` to check that the output is unspent).
- It checks that the node is on the chain `--network` names, and prints the address, the output, its value and its confirmations. `preflight` wants 6 confirmations on the funding output, so `utxo` says so when it has fewer.
- `--dry-run` prints and writes nothing. The file is the same four fields as above, with no more keys. It is read-only: the command never sends anything.
- By hand, `qbit-cli getrawtransaction <txid> true` gives `vout[n].value` (in QBT, so multiply by 100,000,000 for bits) and `vout[n].scriptPubKey.hex`. `utxo` does that and the bits arithmetic for you.

### The Merkle root before the profile

The profile's `root` is the Merkle root of the zip, so it is known only after the zip exists. `root` reads the zip with the loader `plan` uses and prints the root:

```text
node --experimental-strip-types packages/inscriber/cli.ts root --zip collection.zip --supply 12
node --experimental-strip-types packages/inscriber/cli.ts root --zip collection.zip --collection profile.json
```

The first form needs the number of items (`first` is 1). It prints `merkle root <hex>` and `items <n>`: put the value in the profile. The second form reads `supply` from the profile and checks its `root`: it says that the profile has this root, or stops and names the root it expects. It is offline and refuses an RPC URL.

The ports in the examples are Qbit regtest's: RPC 18452 and P2P 18460. [Try it on your own regtest node](../guides/REGTEST.md) starts a node on them.

## Regtest measurement

A regtest run at 1 bit per vbyte confirmed the fan-out first, then the reveals.
Fee and weight follow the zip. They are not constants of this tool.

The zip is untrusted input and is only read. The tool lists it with the system `unzip` (Info-ZIP), which must be on the PATH, and refuses it before it writes anything when an entry has an absolute path, a `..` segment, a backslash or a drive letter, is a link or a special file, or repeats another entry's name. It also refuses more than 200,000 entries, an entry above 64 MiB, or more than 1 GiB in all. A real collection is far below that (a zip of 10,000 items has about 20,000 entries and 16 MB). It extracts into an empty folder and never overwrites. `plan` and `sign` do this for the zip they read.
