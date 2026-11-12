<!-- SPDX-License-Identifier: Apache-2.0 -->

# Try it on your own regtest node

This guide takes you from nothing to a P2MR Inscription you minted, found, and traded, on a Qbit node that runs only on your machine. It uses only this repository and the node. You can follow it whether you want to mint a single P2MR Inscription, a collection without a sale commitment, or a collection with a sale commitment: the first sections are shared, then each path has its own section.

Regtest is a private test chain on your computer. Blocks are made on demand, coins have no value, and nothing here touches mainnet or a public network. Every command below names `--network regtest` or runs against the regtest node you start in section 1. `broadcast` refuses any other network until you also type its name in `--confirm-network`, and this guide never does. `--mine`, which makes blocks, works on regtest only.

Every command block below was run, in this order, on a fresh regtest node. The specifications stay Draft; this guide describes what the reference tools do.

| Section | What you do |
|---|---|
| [1. Install](#1-install) | The repository, Node.js, `unzip`, the Qbit node |
| [2. Start a regtest node](#2-start-a-regtest-node) | A node with its own data folder and ports |
| [3. Wallets and coins](#3-wallets-and-coins) | Three wallets, and 1,001 blocks so there are coins to spend |
| [4. Start the indexer](#4-start-the-indexer) | The read side, and how to look at what you mint |
| [5. A single P2MR Inscription](#5-a-single-p2mr-inscription) | One body, no collection |
| [6. A collection without a sale commitment](#6-a-collection-without-a-sale-commitment) | A made-up sample, every item to its holder |
| [7. A collection with a sale commitment](#7-a-collection-with-a-sale-commitment) | A reserve, a sale holding address, the price |
| [8. Find what you minted](#8-find-what-you-minted) | The indexer API and the explorer |
| [9. Trade a P2MR Inscription](#9-trade-a-p2mr-inscription) | A buyer pays and receives it in one transaction, signed with `0x83` |
| [10. Start over](#10-start-over) | Stop and delete everything |

## 1. Install

You need Node.js 22.13 or newer (and older than 25), `curl`, `unzip` (Info-ZIP, the collection reader runs it), and a clone of this repository.

```bash
cd pins            # the folder of your clone
npm ci
export PINS="$PWD"
export W="$HOME/pins-regtest"      # everything this guide writes goes here
mkdir -p "$W"
```

The commands below call the inscriber through one function, so that you can run them from any folder:

```bash
inscribe() { node --no-warnings --experimental-strip-types "$PINS/packages/inscriber/cli.ts" "$@"; }
```

You also need the Qbit node, `qbitd` and `qbit-cli`. Download the release for your system from the [Qbit releases](https://github.com/Qbit-Org/qbit/releases) page and check its hash against the `SHA256SUMS` of the same release (the release also carries signatures for that file, and [qbit.org](https://qbit.org) says how to verify them). This guide used release `v1.0.0` for Linux on x86-64:

```bash
# not run by the guide check: it downloads 80 MB
mkdir -p "$W/qbit" && cd "$W/qbit"
curl -LO https://github.com/Qbit-Org/qbit/releases/download/v1.0.0/qbit-1.0.0-x86_64-linux-gnu.tar.gz
curl -LO https://github.com/Qbit-Org/qbit/releases/download/v1.0.0/SHA256SUMS
grep ' qbit-1.0.0-x86_64-linux-gnu.tar.gz$' SHA256SUMS | sha256sum -c
tar xzf qbit-1.0.0-x86_64-linux-gnu.tar.gz
export PATH="$W/qbit/qbit-1.0.0/bin:$PATH"
```

Check that both programs run: `qbitd -version` and `qbit-cli -version`. The node's own guide is [doc/user/run-node.md](https://github.com/Qbit-Org/qbit/blob/main/doc/user/run-node.md) in its repository.

## 2. Start a regtest node

The node needs its own data folder and its own ports, so it cannot meet a mainnet or testnet4 node you may run. Qbit's ports are P2P 8355 and RPC 8352 on mainnet, 48355 and 48352 on testnet4, and **18460 and 18452 on regtest**. The RPC port is not Bitcoin's 18443. This guide fixes them in a config file anyway, so that you can see them.

```bash
mkdir -p "$W/node"
cat > "$W/node/qbit.conf" <<'CONF'
[regtest]
server=1
txindex=1
listen=0
rpcuser=pins
rpcpassword=pins-regtest-only
rpcport=18452
port=18460
fallbackfee=0.00001
CONF
qbitd -regtest -datadir="$W/node" -daemon
```

`txindex=1` is required: the indexer reads the parents of earlier blocks through it, and `utxo` below reads the funding transaction. `listen=0` keeps the node from accepting peers, `rpcuser` and `rpcpassword` are for this local test only, and `fallbackfee` lets the node's wallet pay a fee without a fee estimate (a regtest chain has none).

Two helpers, one for the node and one for a wallet of the node, and the RPC options the inscriber and the indexer take:

```bash
q()  { qbit-cli -regtest -datadir="$W/node" "$@"; }
qw() { local wallet="$1"; shift; q -rpcwallet="$wallet" "$@"; }
export NODE_URL=http://127.0.0.1:18452/
export RPC_USER=pins RPC_PASSWORD=pins-regtest-only
sleep 3; q getblockchaininfo | grep -E '"(chain|blocks)"'
```

It prints `"chain": "regtest"` and `"blocks": 0`. If it says the node is not ready, wait a few seconds and run `q getblockchaininfo` again. `q stop` stops the node.

## 3. Wallets and coins

Make three wallets: `funds` pays for everything, `holder` receives the P2MR Inscriptions you mint, and `buyer` plays the buyer in section 9.

```bash
for name in funds holder buyer; do q -named createwallet wallet_name="$name" > /dev/null; done
```

**Never pay from the wallet that holds P2MR Inscriptions.** A wallet picks the coins it spends by value. A P2MR Inscription sits in an ordinary 10,000-bit output, so a payment from the same wallet can spend it as an input, and the P2MR Inscription then moves with that output to wherever the transaction sends the first bit (PINS-3, first in first out). The `holder` wallet in this guide only receives, and signs a trade. If a P2MR Inscription ever ends up where you did not mean it to, the indexer shows where (section 8).

Coinbase coins on Qbit mature after **1,000** blocks (Bitcoin's is 100), so mine 1,001 blocks into `funds`. Regtest makes a block on request:

```bash
q generatetoaddress 1001 "$(qw funds getnewaddress)" > /dev/null
qw funds getbalance
```

It prints the coins that matured. When a section below says "mine blocks", it is `q generatetoaddress N "$(qw funds getnewaddress)"`.

## 4. Start the indexer

The indexer follows your node and answers over HTTP on `127.0.0.1`. Start it now, in a second terminal (set `PINS`, `W`, `NODE_URL`, `RPC_USER` and `RPC_PASSWORD` there too), and leave it running. The first catch-up reads every block and takes about a minute on a fresh regtest chain:

```bash
# second terminal
cd "$PINS"
npm run indexer:serve -- --network regtest --db "$W/index.sqlite" --rpc "$NODE_URL" --rpc-user "$RPC_USER" --rpc-password "$RPC_PASSWORD" --port 8787 --poll 2
```

`--poll 2` makes it look for a new block every 2 seconds (the default is 15). It prints `Indexer is following regtest at http://127.0.0.1:8787` when its API is up. In your first terminal:

```bash
export INDEXER=http://127.0.0.1:8787
until curl -sf "$INDEXER/status" > /dev/null; do sleep 2; done   # wait until it answers
curl -s "$INDEXER/status"
```

`height` is the tip your node has, and `inscriptions` is the number of P2MR Inscriptions it has found (the key name is the API's, see [the API](../indexer/API.md)). It is 0 now.

## 5. A single P2MR Inscription

Each mint uses its own folder and its own issuer key. The key is encrypted with a passphrase. On regtest you can set `PINS_KEY_PASSPHRASE` so that the commands do not ask. Do that only for a key of no value: other processes of your user can read it. The inscriber reads the passphrase from the terminal when the variable is not set.

```bash
export PINS_KEY_PASSPHRASE=regtest-only-passphrase
mkdir -p "$W/single" && cd "$W/single"
inscribe keygen --no-sale --out issuer.key
inscribe address --pub issuer.key.pub.json --network regtest
```

`keygen` wrote `issuer.key` (encrypted) and `issuer.key.pub.json` (public). `address` printed the **funding address** of that key. Only this key can spend it, so a wallet cannot, and `listunspent` of a wallet never shows it. Pay it in one payment from `funds`, mine blocks until the payment has 6 confirmations, then write `utxo.json` with the `utxo` command. It asks the node for the one output that pays the address and writes `txid`, `vout`, `value` in bits and `script`:

```bash
FUNDING=$(inscribe address --pub issuer.key.pub.json --network regtest | awk 'NR==1 {print $4}')
qw funds sendtoaddress "$FUNDING" 1
q generatetoaddress 6 "$(qw funds getnewaddress)" > /dev/null
inscribe utxo --pub issuer.key.pub.json --network regtest --rpc "$NODE_URL" --rpc-user "$RPC_USER" --rpc-password "$RPC_PASSWORD" --out utxo.json
cat utxo.json
```

`sendtoaddress` takes QBT (1 QBT is 100,000,000 bits) and `utxo.json` is in bits: `{"txid":"…","vout":0,"value":"100000000","script":"5220…"}`. If the address received several payments, `utxo` lists them and asks you to name one with `--txid`. `preflight` wants 6 confirmations on the funding output, and `utxo` tells you when it has fewer.

Write the body, name three addresses, and plan. The P2MR Inscription goes to `--creator` (the `holder` wallet), and the leftover of the mint, the mint change, goes to `--change` (the `funds` wallet). They must differ from each other and from the funding address.

```bash
echo "hello from regtest" > note.txt
CREATOR=$(qw holder getnewaddress); CHANGE=$(qw funds getnewaddress)
inscribe plan --single --body note.txt --content-type "text/plain;charset=utf-8" --pub issuer.key.pub.json --utxo utxo.json --creator "$CREATOR" --change "$CHANGE" --fee-rate 1 --network regtest --out plan.json | tee plan.txt
SINGLE_ID=$(awk '/^P2MR Inscription id/ {print $4}' plan.txt)
echo "$SINGLE_ID"
```

`plan` prints the fees, the addresses and the **P2MR Inscription id**, which is the txid of the reveal followed by `i0`. The commands above keep it in `SINGLE_ID`. `sign` runs offline with the key and the same files, `preflight` asks the node about the plan, and `broadcast` sends it. With more than one wallet loaded, `--mine` needs to know which wallet makes its blocks, so the RPC URL of `broadcast` names one:

```bash
inscribe sign --single --body note.txt --content-type "text/plain;charset=utf-8" --key issuer.key --plan plan.json --utxo utxo.json --creator "$CREATOR" --change "$CHANGE" --out plan.signed.json
inscribe preflight --single --body note.txt --content-type "text/plain;charset=utf-8" --network regtest --plan plan.json --signed plan.signed.json --utxo utxo.json --pub issuer.key.pub.json --rpc "$NODE_URL" --rpc-user "$RPC_USER" --rpc-password "$RPC_PASSWORD"
inscribe broadcast --plan plan.signed.json --network regtest --mine --rpc "${NODE_URL}wallet/funds" --rpc-user "$RPC_USER" --rpc-password "$RPC_PASSWORD"
```

Every `preflight` row must say `PASS`. `broadcast` sends the fan-out, mines a block, then sends the reveal and mines again (`--mine` is refused on any chain but regtest). Read the result (the indexer needs a few seconds to see the new block):

```bash
sleep 4; curl -s "$INDEXER/inscription/$SINGLE_ID"; echo
```

The answer has the content type, the body hash, the location (`txid`, `vout`, `offset`) and `ownerAddress`, which is `$CREATOR`. Where it is shown is the subject of section 8.

## 6. A collection without a sale commitment

A collection is a genesis P2MR Inscription plus the items of a zip that match its Merkle root. The repository can write a made-up sample for you: twelve small pictures called "Dot #N", named "Example Dots", with no connection to any real collection. It writes the folder, `collection.zip`, two profiles (one with a sale, one without) and a price file.

```bash
cd "$PINS" && npm run --silent example:collection -- --out "$W/sample"
ls "$W/sample" "$W/sample/collection"
```

The zip has the layout every collection zip has: `images/1.png` … `images/12.png`, `json/1.json` … `json/12.json` and `collection.json`. For your own art, put the same three things in a folder and zip them with any tool (for example `zip -r collection.zip images json collection.json`). The files are described in [the launch guide](COLLECTION-LAUNCH.md#zip) and PINS-4.

The profile has to state the Merkle root of the zip, and the root comes from the zip, so ask for it first. `root` is offline, reads the zip with the same code `plan` uses, and prints the root:

```bash
inscribe root --zip "$W/sample/collection.zip" --supply 12
cat "$W/sample/profile.nosale.json"
```

The profile of the sample already carries that root (`npm run example:collection` computed it). With your own zip, write the printed value into the profile's `root`, and run `root` again with `--collection profile.json` instead of `--supply`: it checks the profile's root and supply.

Now the mint. A collection with no sale has no reserve and no sale secret, so the keyfile is made `--no-sale`, `assign` needs no key, and there is no `--sale` address. Every item goes to `--creator`:

```bash
mkdir -p "$W/nosale" && cd "$W/nosale"
cp "$W/sample/collection.zip" "$W/sample/profile.nosale.json" .
inscribe keygen --no-sale --out issuer.key
FUNDING=$(inscribe address --pub issuer.key.pub.json --network regtest | awk 'NR==1 {print $4}')
qw funds sendtoaddress "$FUNDING" 1
q generatetoaddress 6 "$(qw funds getnewaddress)" > /dev/null
inscribe utxo --pub issuer.key.pub.json --network regtest --rpc "$NODE_URL" --rpc-user "$RPC_USER" --rpc-password "$RPC_PASSWORD" --out utxo.json
inscribe assign --collection profile.nosale.json --zip collection.zip --out assignment.json
CREATOR=$(qw holder getnewaddress); CHANGE=$(qw funds getnewaddress)
inscribe plan --pub issuer.key.pub.json --assignment assignment.json --collection profile.nosale.json --zip collection.zip --utxo utxo.json --creator "$CREATOR" --change "$CHANGE" --fee-rate 1 --network regtest --out plan.json
inscribe sign --key issuer.key --plan plan.json --collection profile.nosale.json --zip collection.zip --creator "$CREATOR" --change "$CHANGE" --utxo utxo.json --out plan.signed.json
inscribe preflight --network regtest --plan plan.json --signed plan.signed.json --assignment assignment.json --collection profile.nosale.json --zip collection.zip --utxo utxo.json --pub issuer.key.pub.json --rpc "$NODE_URL" --rpc-user "$RPC_USER" --rpc-password "$RPC_PASSWORD"
inscribe broadcast --plan plan.signed.json --network regtest --mine --rpc "${NODE_URL}wallet/funds" --rpc-user "$RPC_USER" --rpc-password "$RPC_PASSWORD" | tee broadcast.txt
tail -n 1 broadcast.txt > broadcast.json
```

`broadcast` prints a progress line for each transaction it sends and confirms, and then one line of JSON with the txids. The last line is the result, so the commands above keep it in `broadcast.json`. The first reveal is the genesis, so the **genesis id** is that txid and `i0`:

```bash
NOSALE_GENESIS="$(node -p 'JSON.parse(require("fs").readFileSync("broadcast.json","utf8")).reveals[0]')i0"
echo "$NOSALE_GENESIS"
sleep 4; curl -s "$INDEXER/inscriptions?owner=$CREATOR&limit=3" | head -c 600; echo
```

Optionally pass `--holder <address>` to `plan` and `sign` to send the items to another address than the creator. The genesis and the leaf list stay with the creator.

## 7. A collection with a sale commitment

The same collection, with a reserve that stays with the creator and a sale set that goes to a sale holding address. The sale secret is made by `keygen` (leave out `--no-sale`), kept inside the encrypted keyfile, and never written anywhere else. `assign` records only its SHA-256, the **sale commitment**, which the genesis carries. What the secret is for, and what to do with it, is in [Sell and trade](SALE-AND-TRADE.md).

```bash
mkdir -p "$W/sale" && cd "$W/sale"
cp "$W/sample/collection.zip" "$W/sample/profile.sale.json" "$W/sample/price.json" .
cat profile.sale.json
inscribe keygen --out issuer.key
FUNDING=$(inscribe address --pub issuer.key.pub.json --network regtest | awk 'NR==1 {print $4}')
qw funds sendtoaddress "$FUNDING" 1
q generatetoaddress 6 "$(qw funds getnewaddress)" > /dev/null
inscribe utxo --pub issuer.key.pub.json --network regtest --rpc "$NODE_URL" --rpc-user "$RPC_USER" --rpc-password "$RPC_PASSWORD" --out utxo.json
inscribe assign --key issuer.key --collection profile.sale.json --zip collection.zip --out assignment.json
```

The profile's `reserveGroups` and `reserveExtra` give the reserve (here one item of `Tone` `0` and one more, so two reserved and ten for sale). `assign` selects them from the secret and says how many ids it wrote.

Three addresses: the creator (the genesis, the leaf list and the reserve), the **sale holding address** (the items for sale), and the change. The sale holding address is the one whose key signs the sale listings, so it belongs to `holder` here.

```bash
CREATOR=$(qw funds getnewaddress); SALE=$(qw holder getnewaddress); CHANGE=$(qw funds getnewaddress)
inscribe plan --pub issuer.key.pub.json --assignment assignment.json --collection profile.sale.json --zip collection.zip --utxo utxo.json --creator "$CREATOR" --sale "$SALE" --change "$CHANGE" --fee-rate 1 --network regtest --out plan.json
inscribe sign --key issuer.key --plan plan.json --collection profile.sale.json --zip collection.zip --creator "$CREATOR" --sale "$SALE" --change "$CHANGE" --utxo utxo.json --out plan.signed.json
inscribe preflight --network regtest --plan plan.json --signed plan.signed.json --assignment assignment.json --collection profile.sale.json --zip collection.zip --utxo utxo.json --pub issuer.key.pub.json --key issuer.key --rpc "$NODE_URL" --rpc-user "$RPC_USER" --rpc-password "$RPC_PASSWORD"
inscribe broadcast --plan plan.signed.json --network regtest --mine --rpc "${NODE_URL}wallet/funds" --rpc-user "$RPC_USER" --rpc-password "$RPC_PASSWORD" | tee broadcast.txt
tail -n 1 broadcast.txt > broadcast.json
SALE_GENESIS="$(node -p 'JSON.parse(require("fs").readFileSync("broadcast.json","utf8")).reveals[0]')i0"
echo "$SALE_GENESIS"
```

`preflight` here has more rows than before, because it also takes `--key`: it opens the keyfile, hashes the sale secret and compares it with the genesis's `sale_commitment`, and re-runs the reserve selection the indexer will run. Every row must be `PASS`.

The sale opens with the issuer's price P2MR Inscription. The price is the issuer's own number: `price.json` holds `price_bits` (a positive whole number of bits), `price_sources` (a list of text, your record of where the number comes from) and `price_time` (`YYYY-MM-DDTHH:MM:SSZ`). The sample file is only a rehearsal value. `price` writes a plan like `plan` does; it spends a new funding output, so pay the funding address again:

```bash
qw funds sendtoaddress "$FUNDING" 0.1
q generatetoaddress 6 "$(qw funds getnewaddress)" > /dev/null
inscribe utxo --pub issuer.key.pub.json --network regtest --rpc "$NODE_URL" --rpc-user "$RPC_USER" --rpc-password "$RPC_PASSWORD" --out utxo-price.json
inscribe price --pub issuer.key.pub.json --price price.json --genesis "$SALE_GENESIS" --collection profile.sale.json --utxo utxo-price.json --creator "$CREATOR" --sale "$SALE" --change "$CHANGE" --fee-rate 1 --network regtest --out price-plan.json
inscribe sign --key issuer.key --plan price-plan.json --collection profile.sale.json --assignment assignment.json --creator "$CREATOR" --sale "$SALE" --change "$CHANGE" --utxo utxo-price.json --out price-plan.signed.json
inscribe broadcast --plan price-plan.signed.json --network regtest --mine --rpc "${NODE_URL}wallet/funds" --rpc-user "$RPC_USER" --rpc-password "$RPC_PASSWORD"
```

## 8. Find what you minted

**By id.** `plan` printed the id of a single P2MR Inscription, and the genesis id of a collection is the first `reveals` txid of `broadcast`, followed by `i0`. The indexer answers for any id:

```bash
curl -s "$INDEXER/inscription/$SINGLE_ID"
curl -s "$INDEXER/content/$SINGLE_ID"; echo
```

`/inscription/{id}` is the record: `number`, `contentType`, `bodySha256`, `location` (`state` `located` with `txid`, `vout` and `offset` as a decimal string, or `lost`), `ownerAddress` and `ownerScript`, and flags such as `reinscription`. `/content/{id}` is the body, with the recorded content type.

**By owner.** Each section above sent its P2MR Inscriptions to an address of a wallet, so ask for that address (the `holder` wallet holds those of sections 5 and 6, and the sale items of section 7):

```bash
curl -s "$INDEXER/inscriptions?owner=$SALE&limit=3" | head -c 700; echo
curl -s "$INDEXER/inscriptions?limit=3&offset=0" | head -c 300; echo
```

`/inscriptions` lists by number (0 is the first one found), `owner`, `offset` and `limit` filter and page it. `/output/{txid}:{vout}` lists what one output holds, and `/status` says how far the indexer has read.

**A collection.** `/collection` answers for one genesis. A chain with two collections, as this one has, needs to be told which: stop the indexer in the second terminal and start it again on a new database file, with the genesis and the profile of the collection you want. `reserveMode` is then `configured`, and after the price P2MR Inscription `priceStatus` is `ready`:

```bash
# second terminal: stop the indexer with Ctrl+C, then
cd "$PINS"
npm run indexer:serve -- --network regtest --db "$W/index-sale.sqlite" --rpc "$NODE_URL" --rpc-user "$RPC_USER" --rpc-password "$RPC_PASSWORD" --port 8787 --poll 2 --genesis "$SALE_GENESIS" --collection "$W/sale/profile.sale.json"
```

```bash
sleep 90   # a new database reads the chain again
curl -s "$INDEXER/collection"; echo
```

**In the explorer.** The explorer is a local, read-only web page on top of the indexer. It needs no manifest and no node login for this. In a third terminal (from the repository, after `npm --prefix explorer ci`):

```bash
# third terminal
cd "$PINS/explorer" && npm ci --ignore-scripts
MANIFEST= INDEXER_URL=http://127.0.0.1:8787 PORT=8081 npm start
```

Open `http://127.0.0.1:8081/`. The home page lists the latest P2MR Inscriptions; the search box takes an id, a transaction id or an address; a page for one P2MR Inscription is `http://127.0.0.1:8081/#/inscription/<id>`, and an address page is `#/address/<address>`. Leave `MANIFEST` empty (as above) or the explorer features the public Flatbits example, which does not exist on your regtest chain. The explorer's own page is [explorer/README.md](../../explorer/README.md).

## 9. Trade a P2MR Inscription

A trade is one transaction in which the buyer pays the seller and receives the P2MR Inscription (PINS-6, Draft). The seller signs only the input that holds the P2MR Inscription and the output that pays the seller, with the hash type `0x83` (`SIGHASH_SINGLE | SIGHASH_ANYONECANPAY`); the buyer adds padding, funding and a change output and signs the rest. [Sell and trade](SALE-AND-TRADE.md) explains the template, the checks and what is not covered. Here, run it.

The seller is the `holder` wallet, which holds the P2MR Inscription of section 5 (a P2MR Inscription of the collection in section 7 sits there too). The buyer is the `buyer` wallet, which needs three coins of its own: two small ones for the padding and one that pays the price and the fee. Make them from `funds`, which holds no P2MR Inscription:

```bash
for amount in 0.0001 0.00012 0.01; do qw funds sendtoaddress "$(qw buyer getnewaddress)" "$amount" > /dev/null; done
q generatetoaddress 1 "$(qw funds getnewaddress)" > /dev/null
sleep 4
cd "$PINS"
node --no-warnings --experimental-strip-types packages/sale/regtest-trade.ts --rpc "$NODE_URL" --rpc-user "$RPC_USER" --rpc-password "$RPC_PASSWORD" --indexer "$INDEXER" --id "$SINGLE_ID" --seller-wallet holder --buyer-wallet buyer --price 50000 --mine
```

It prints each step: where the P2MR Inscription is, the template it built, the buyer's check against the indexer (`ok: true`, with nothing left unchecked), the seller's `0x83` signature, the transaction id, and, after it mines 6 blocks, that the indexer shows the buyer as the owner. Then look at it yourself:

```bash
curl -s "$INDEXER/inscription/$SINGLE_ID"; echo
```

The wallet support is not the same everywhere. Qbit Core's wallet signs `0x83` (`walletprocesspsbt` with the sighash type `SINGLE|ANYONECANPAY`), which is what this example uses on both sides. Qbit Wallet, the browser extension, signs only `SIGHASH_DEFAULT` as of v1.0.7, so with it a holder cannot make a `0x83` listing; PINS-6 §7 lists what was verified. The example works on regtest only.

## 10. Start over

```bash
q stop
sleep 3
rm -rf "$W"
```

Stop the indexer and the explorer with Ctrl+C. Everything this guide made is in `$W`, and nothing outside it.
