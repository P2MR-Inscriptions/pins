<!-- SPDX-License-Identifier: Apache-2.0 -->

# Mainnet launch checklist

A launch on mainnet spends real QBT and cannot be undone: there is no rollback command, and `broadcast` does not withdraw a transaction. Go through this page from top to bottom for every launch, single or collection. Each box says what to check and where the how is. Do not skip a box because the same step passed on regtest.

## 1. Before you spend anything

- [ ] **You rehearsed the same launch on regtest,** with the same kind of input and the same commands: [Five minutes on regtest](QUICKSTART.md) for a single P2MR Inscription, [Try it on your own regtest node](REGTEST.md) for a collection.
- [ ] **Your tools are the tools you tested.** `git status` is clean, `npm ci` ran, and `npm run lint`, `npm run typecheck`, `npm test` and `npm run check:terminology` pass on Node.js 22.13 to 24.
- [ ] **Your node is Qbit Core v1.0.1** ([docs/PINNED_VERSIONS.md](../PINNED_VERSIONS.md)), fully synced, with `-txindex`, and not run with `-prunewitnesses=1`. Its RPC port on mainnet is 8352.
- [ ] **The login is the node's cookie or a user and password in the environment,** never a flag typed into shared shell history ([Log in to your node](NODE-LOGIN.md)).
- [ ] **Your inputs are final.** For a collection: the zip, the profile (`supply`, `batchSize`, `sale`), and the Merkle root that `root` prints, written into the profile. A collection's name, root and supply cannot change after the genesis ([The Merkle root before the profile](COLLECTION-LAUNCH.md#the-merkle-root-before-the-profile)).
- [ ] **You decided the sale terms** if there is a sale: the length, the price and the address for unsold items are terms of your collection, and the protocol fixes none of them ([SALE-AND-TRADE.md](SALE-AND-TRADE.md)).

## 2. The key

- [ ] **`keygen` and `address` ran on a machine with no network,** and `sign` will run there too ([Inscriber, air gap](../inscriber/README.md#air-gap)).
- [ ] **Two encrypted copies of the keyfile exist, in two places,** apart from the passphrase. A lost passphrase cannot be recovered.
- [ ] **`PINS_KEY_PASSPHRASE` is not set.** It is for tests only.
- [ ] **The keyfile has a sale secret only if the collection has a sale** (`keygen --no-sale` otherwise). The secret is never pasted anywhere before the sale closes ([SALE-AND-TRADE.md](SALE-AND-TRADE.md)).
- [ ] **You do not use Qbit Wallet to hold or move a P2MR Inscription.** It has no code for PINS and can spend its output as plain value.

## 3. Funding

- [ ] **The funding address is the one `address` printed,** and you pay it once, from a wallet you do not use for P2MR Inscriptions.
- [ ] **The payment has 6 confirmations,** and `utxo` wrote `utxo.json` from your own node.
- [ ] **The creator address, the change address and, with a sale, the sale address differ from each other and from the funding address,** and you control them. The funding address is not Reserve, Sale, Change or Revenue. The creator address and the sale address are in wallets you do not pay from: they receive P2MR Inscriptions, and a payment can spend one (PINS-3 §8).

## 4. Plan, sign, check

- [ ] **`plan` ran online, with no key,** and printed fees you accept. On mainnet pass the fee rate you chose, not the regtest `1`.
- [ ] **`sign` ran offline** with the same files and the same three addresses as `plan`. It does not read them from the plan.
- [ ] **`preflight` ran with `--network mainnet --confirm-network mainnet`,** and every row says `PASS`. For a collection give it `--key`, or the reserve and sale rows fail. The command is `npm run mainnet:preflight` ([Inscriber](../inscriber/README.md#commands)).
- [ ] **Postage and weight are as expected:** 10,000 bits on every item output, and no reveal heavier than 400,000 weight (the `reveal weight` row).
- [ ] **The marker is `pins` and the schema is the default.** Mainnet refuses any other.

## 5. Broadcast

- [ ] **`broadcast` runs with `--network mainnet --confirm-network mainnet` and without `--mine`.** It sends the fan-out and waits for it to confirm, then sends each reveal and waits, so that no item can be placed before the genesis.
- [ ] **If it stops, you run the same command again.** It skips every transaction that is already confirmed. You do not rebuild the plan.
- [ ] **You keep the signed plan and its output** (the fan-out txid, the reveal txids) until the launch is verified.

## 6. After the launch

- [ ] **Run an indexer over the launch** (`--network mainnet --confirm-network mainnet --activation 161948`, and `--genesis <id>` for a collection) and read the result from it, not from your own tool: [Verify the example](../examples/flatbits.md#verify-the-example) shows the same steps for Flatbits.
- [ ] **`/inscription/{id}` shows the content type, the body hash and the owner you intended,** after the transactions have 6 confirmations.
- [ ] **For a collection:** `/collection` has `status` `present`, the `supply` and `root` of your profile, and `authentic` equal to the supply.
- [ ] **Publish what is public:** the genesis id, the Merkle root, the issuer key, the heights, and the `stateHash` of a block you name. Do not publish the keyfile, the passphrase, the sale secret, a seed, or the plan. [The Flatbits page](../examples/flatbits.md) is the model.
- [ ] **The sale,** if any, is run by your own program or server: this repository holds no key online and ships no sale server ([What this repository does not do](COLLECTION-LAUNCH.md#what-this-repository-does-not-do)).
- [ ] **If you leave the indexer or the explorer running,** follow [the deploy guide](DEPLOY.md): systemd units, a reverse proxy, and how to reach the explorer on a LAN without opening the node's RPC.

## If something is wrong

Do not send anything else until you know why. The chain is the authority: read the P2MR Inscriptions from an indexer, not from the plan. A P2MR Inscription that landed where you did not intend stays there, and an output that holds one is moved like any other output, by a transaction you sign with the PINS tools. A problem in the tools or the documents is a bug: report it ([SECURITY.md](../../SECURITY.md) for anything that involves a key or a secret, an issue for the rest).
