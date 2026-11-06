<!-- SPDX-License-Identifier: Apache-2.0 -->

# Mint tool

The reference minter builds one confirmed fan-out, then the reveals. Postage is 10,000 bits.
A reveal heavier than 400,000 bytes is refused. How many pieces are reserved is the
collection profile, not a default in this tool.

The sale stays closed until a wallet can complete a pre-signed offer. The tool still
assigns the profile's reserve ids to the creator address, the rest to a sale holding
address, and every mint change output to a third address.

## Air gap

Four mint commands. Only `plan` and `broadcast` touch a network. `price` is also offline. It builds the sale-open inscription and does not broadcast.

1. `keygen` and `assign` run on the offline machine. `keygen` writes an encrypted keyfile
   and a public JSON file. Make two encrypted copies of the keyfile and keep them apart.
   Do not store the passphrase with either copy. `assign` reads the keyfile and writes the
   reserve and sale id lists and `saleCommitment` (SHA-256 of the sale secret). It does not write the sale secret.
2. `plan` runs online, watch-only. It reads the public keys, the id lists, the canonical
   zip, and one funding UTXO. It writes unsigned transactions. It has no secret.
3. `sign` runs offline. It checks the Merkle root against
   the root in `--collection`, checks every reveal
   weight, checks postage, recomputes the reserve from the keyfile, refuses a reserve the indexer would not reproduce, and only then signs.
   `sign` refuses an RPC URL.
4. `broadcast` runs online. It sends the fan-out and waits for one confirmation.
   With `--mine` (regtest only) it then sends all 17 reveals before mining any of them.
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

`npm run mainnet:preflight` is the preflight command. It reads `--key`, re-runs the reserve selection the indexer will run, checks the sale-secret hash against `sale_commitment`, and wipes the secret. Without `--key` those rows fail. Every row must be `PASS` before broadcast. `plan` does not take a price file. `price` builds the sale-open inscription and does not broadcast. `--schema` on `price` is the rehearsal mask, the same value the indexer takes (`c/1` derives price text `p/1`). Omit it on mainnet. The launch text stays `pins-price/1`.

`--creator`, `--sale`, and `--change` are Reserve, Sale, and Change. The funding address is the issuer address from `address`. Revenue is a fifth wallet. It receives buyer payments and is not a flag on `plan` or `preflight`. Do not pass it as `--sale` or as the funding address.

`--dry-run` on `plan` or `sign` prints the summary and does not write the output file.

The passphrase is read from the terminal. Tests may set `PINS_KEY_PASSPHRASE`. Do not set
that variable for a real key. The tool does not print the passphrase or the secret bytes.

`utxo.json` is one object: `txid`, `vout`, `value` (bits, as a decimal string), and
`script` (hex). The output must be the issuer key's own P2MR address.

## Regtest measurement

A regtest run at 1 bit per vbyte confirmed the fan-out first, then the reveals.
Fee and weight follow the zip. They are not constants of this tool.
