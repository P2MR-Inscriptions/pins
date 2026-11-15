<!-- SPDX-License-Identifier: Apache-2.0 -->

# Sell and trade P2MR Inscriptions

This guide covers what happens after the launch: how a P2MR Inscription is sold, what the sale secret of a collection is and what to do with it, and how the PSBTs of a primary sale are served. PINS-6 is the rule, [packages/sale](../../packages/sale/README.md) is the library, and [Try it on your own regtest node](REGTEST.md#9-trade-a-p2mr-inscription) runs a trade end to end.

> **Warning.** Qbit Wallet has no code for PINS: it does not know which output holds a P2MR Inscription, and it can spend that output as plain value, as change or as a payment. Do not keep a P2MR Inscription in a Qbit Wallet account that you spend from. Move a P2MR Inscription with the PINS tools and broadcast with `qbit-cli sendrawtransaction` ([details](#qbit-wallet-and-p2mr-inscriptions)).

It says plainly what the repository does and does not contain. It contains the library that builds and checks a trade PSBT, a regtest example that runs one, and the commands that close a sale ([Close the sale](#close-the-sale)). It contains **no sale server and no wallet**.

## Who sells what

| What | Who sells | How |
|---|---|---|
| A single P2MR Inscription, or an item of any collection, owned by someone | its owner | One listing: the owner builds the template, signs one input with `0x83`, and gives the PSBT to the buyer (PINS-6 §3 and §4) |
| An item of the sale set of a collection with a sale commitment, still held by the sale holding address | the issuer's sale server | Primary sale, one listing per item, released in the committed order (PINS-6 §6) |
| An item of a collection with no sale commitment | nobody, until someone owns it | Such a collection declares no primary sale, no price and no sale order (PINS-5 §8). Its items go to the creator, or to `--holder`, and an owner sells them as above |

## The trade in one transaction

The template has four inputs and four outputs. The buyer pays two small padding coins and a funding coin, the seller's output holding the P2MR Inscription is the third input, and the buyer's receive output gets exactly that output's value:

| Index | Inputs | Outputs |
|---|---|---|
| 0 | buyer padding `a` | padding return `a + b` |
| 1 | buyer padding `b` | the buyer receives the P2MR Inscription |
| 2 | the seller's output, signed `0x83` | the seller's payment, `price` |
| 3 | buyer funding | change |

The seller's `0x83` signature commits to its own input and to the output at the same index (the payment) and to nothing else, so the buyer can add the rest. The buyer commits to everything with the default hash type. Because a P2MR Inscription moves with the first bit of an output (PINS-3, first in first out), the two paddings in front make the P2MR Inscription land in output 1 and nowhere else. The buyer checks that before signing, with `checkPurchasePsbt`, and the check reads what each input holds from the indexer.

The pieces, all in `packages/sale` and `@qbit-oss/protocol`:

1. `primarySalePsbt` builds the PSBT and refuses numbers that do not fit (dust, a negative fee, a wrong receive value).
2. The seller (or the sale server) signs input 2 with `0x83`.
3. `checkPurchasePsbt` (buyer): is the P2MR Inscription at offset 0 of the seller's output, does it land in the buyer's own receive output, does any input of the buyer hold a P2MR Inscription, is every output P2MR, `OP_RETURN` or anchor? It also compares each input with the unspent output the node holds (`utxoAt`, from `gettxout`), because a PSBT can state an amount or a script the chain does not hold, and checks that every script is in the tree of the output it spends. It fails closed: the report is `ok` only when every check ran (`complete`), and a skipped check is listed in `notChecked` and makes it not `ok`, unless the caller sets `allowNotChecked`. It reads the sighash type from the signature (3680 bytes is the default, 3681 bytes ends with the type), so a finalized input is judged by what it was signed with.
4. The buyer signs, finalizes, extracts, and sends. After 6 confirmations the indexer shows the new owner.

`packages/sale/regtest-trade.ts` does all of it against a regtest node and the indexer, with Qbit Core's wallet on both sides, for one P2MR Inscription. Read it as the reference for your own program. [REGTEST.md](REGTEST.md#9-trade-a-p2mr-inscription) has the command. Run with `--dry-run` it stops after the buyer's check, and with `--mine` it makes the blocks.

### Wallet support

| Wallet | `0x83` listing (seller) | Buyer completes |
|---|---|---|
| Qbit Core wallet (`walletprocesspsbt` with `SINGLE\|ANYONECANPAY`) | works, used by the regtest example (TV6-1) | works |
| Qbit Wallet browser extension | no: Qbit Wallet v1.0.9 does not sign `0x83` | works for the default hash type |

Qbit Wallet v1.0.9 does not sign `0x83`. Qbit Core's wallet does. The rule that decides it is PINS-6 §7: the seller's input is signed `SIGHASH_SINGLE|ANYONECANPAY`, every other input `SIGHASH_DEFAULT`. The library does not need a wallet: it builds PSBTs and checks them, and any signer that can produce `0x83` can complete the seller's step.

What the extension does with a trade PSBT, from its source and its documentation:

- It signs every input the active account can sign and refuses `toSignInputs`. A PSBT that holds the buyer's inputs and the seller's pre-signed input is signed for the buyer's inputs only, and the seller's witness stays unchanged.
- It flags `SIGHASH_NONE` inputs as a risk and does not flag `SINGLE`, so no warning is expected for `0x83`.
- It classifies a plain P2MR output as asset-free and may offer to consolidate it, so a P2MR Inscription is at risk in an ordinary account of it. Keep P2MR Inscriptions in an address that is never used for ordinary payments.
- A website PSBT that pays an output the wallet does not own shows the address, a warning badge **Unrecognised**, and the line "Outputs to addresses this wallet does not recognise: N, paying X QBT". Signing stays available.
- On regtest its only endpoint is an Esplora origin (`http://127.0.0.1:3002`) that must return the regtest genesis at height 0, so it cannot be pointed at a node of your own. Its buyer step, `SIGHASH_DEFAULT` over the buyer's inputs and receive output, is the step TV6-1 ran with the wallet of a regtest node.

Two practical rules, both learned on regtest:

- **The seller's wallet must not pay for anything from the coins that hold P2MR Inscriptions.** The node's wallet picks coins by value, and an ordinary payment can spend an output that holds a P2MR Inscription and send it away. Keep P2MR Inscriptions in a wallet that only receives and signs trades.
- **A buyer's coins must not hold a P2MR Inscription.** The example looks each of the buyer's coins up in the indexer and leaves out any that hold one.

## Qbit Wallet and P2MR Inscriptions

Qbit Wallet has no code for PINS: it does not know which output holds a P2MR Inscription, and it can spend that output as plain value, as change or as a payment. Do not keep a P2MR Inscription in a Qbit Wallet account that you spend from. A wallet screen that shows a balance, a "send" button or an automatic change output is, for a P2MR Inscription, a way to lose it.

What to do instead:

1. Keep every P2MR Inscription you care about at an address whose key you control outside the wallet's spending accounts (the address of the holder you gave `plan` and `assign`), and check where it is with the indexer (`/inscription/{id}`, `/output/{outpoint}`).
2. To move one, build the transaction with the PINS tools so that FIFO placement (PINS-3) puts the P2MR Inscription where you mean it to go. For a sale, use the PSBT library of this repository and check the PSBT as the buyer ([packages/sale](../../packages/sale/README.md)).
3. Sign with a signer that knows the leaf, and broadcast the signed transaction with Qbit Core: `qbit-cli sendrawtransaction <hex>`.

Paying the funding address of a collection from Qbit Wallet is safe, because that output holds no P2MR Inscription.

## The sale secret

A collection with a sale commitment has a 32-byte `sale_secret` (PINS-5 §8.2). `keygen` draws it and writes it into the encrypted keyfile, with the issuer and recovery keys. `keygen --no-sale` draws none, and `assign` does not write the secret anywhere: its output has the reserve ids, the sale ids and `saleCommitment`, the SHA-256 of the secret, and that is what the genesis carries.

What the secret does:

- It selects the creator reserve (`selectReserve`). The selection is public in effect: the reserve items are sent to the creator at launch.
- It sets the order in which the sale items are sold. The order also needs the hash of the block `H_seed` (6 blocks after the genesis is confirmed), so it cannot be known before then, even by the issuer. `saleSeed(secret, blockHash)` and `saleOrder(ids, seed)` in `packages/protocol/reserve.mjs` compute it.

What to do with it:

1. **Keep the keyfile.** It is the only place the secret lives, and `preflight --key` and `assign` open it with your passphrase. Keep two encrypted copies in two places, apart from the passphrase, as `keygen` says. There is no recovery from a lost passphrase.
2. **Do not publish or paste the secret anywhere before close.** Whoever learns it can compute the sale order as soon as `H_seed` is known and buy the item they want (PINS-5 §8.2). Tell buyers that the issuer knows it from the start; the protocol does not hide that.
3. **At close, publish it** in the sale-reveal P2MR Inscription (PINS-5 §8.5, field 5 `{schema: "pins-sale-reveal/1", root, sale_secret}`, issued by the issuer key), so anyone can check the reserve and the order. The `sale-reveal` command makes it. The reference indexer reads it, and `/collection` then shows the order (`orderStatus`).
4. **Before close, commit the address for unsold items** in a `pins-unsold-address/1` P2MR Inscription (PINS-5 §8.5). The `unsold-address` command makes it. The indexer does not read it.

[Close the sale](#close-the-sale) runs these two steps, the transfer of the unsold items and the closing of the collection, with the commands that do them.

## Close the sale

The protocol fixes no sale length, so the issuer decides when the sale ends. Four offline commands of the inscriber write what PINS-5 §7 and §8.5 define, in this order. They are in `npm run inscribe -- --help`, and each has its own `--help`. They sign with the issuer key, so they run on the offline machine that holds the keyfile and ask for its passphrase. They only write files: `preflight --record` and `broadcast` talk to the node, as for the launch.

| Step | Command | What it writes | PINS-5 |
|---|---|---|---|
| 1 | `unsold-address` | The `pins-unsold-address/1` P2MR Inscription: the address that will receive the unsold items | §8.5 |
| 2 | `sale-reveal` | The `pins-sale-reveal/1` P2MR Inscription: the sale secret, which ends the sale | §8.5 |
| 3 | `unsold-transfer` | The unsigned PSBTs that move the unsold items to that address. It signs nothing | §8.5 |
| 4 | `close` | The `pins-close/1` P2MR Inscription: no item after it is authentic | §7 |

Each of steps 1, 2 and 4 spends a funding output of the issuer key, like `price`: pay the funding address (`address`), wait for 6 confirmations, and run `utxo` with `--txid` to write the file. Each makes one P2MR Inscription that goes to `--creator`, with the leftover going to `--change`. Both must differ from each other, from the funding address, and from the unsold address. The command also writes the plan already signed, so there is no separate `plan` and `sign`, and `broadcast` sends it.

**1. Commit the unsold address.** The address is yours to choose. Use a P2MR address that nothing else will ever use, and keep its key. Do this before step 2: only a commitment confirmed before the sale reveal, in chain order, counts, and the first valid one is the one that counts (PINS-5 §8.5).

```bash
inscribe unsold-address --key issuer.key --pub issuer.key.pub.json --collection profile.sale.json --utxo utxo-unsold.json --creator "$CREATOR" --change "$CHANGE" --unsold-address "$UNSOLD" --fee-rate 1 --network regtest --out unsold-address.signed.json
inscribe preflight --record unsold-address --network regtest --signed unsold-address.signed.json --collection profile.sale.json --utxo utxo-unsold.json --pub issuer.key.pub.json --rpc "$NODE_URL" --rpc-user "$RPC_USER" --rpc-password "$RPC_PASSWORD"
inscribe broadcast --plan unsold-address.signed.json --network regtest --mine --rpc "${NODE_URL}wallet/funds" --rpc-user "$RPC_USER" --rpc-password "$RPC_PASSWORD"
```

`preflight --record` checks the signed plan against the node and the files: the record is the one asked for, its `root` is the root of the collection profile, the address is a witness-v2 P2MR address of the network and is not the creator, the change or the funding address, and the leaf is the one the record makes. Every row must say `PASS`. After it is confirmed, `unsoldCommitmentOf` in `packages/sale/unsold.ts` reads the commitment from the rows of `/inscriptions` by the rule of PINS-5 §8.5, and a buyer or an auditor can do the same.

**2. Reveal the sale secret.** This ends the sale. The plan file holds the secret until it is broadcast, so the command writes it with mode `0600`, and `--assignment` makes it refuse a keyfile whose secret does not hash to the sale commitment. Check that every buyer has been served first: a sale item sold after the reveal can be bought by whoever computed the order.

```bash
inscribe sale-reveal --key issuer.key --pub issuer.key.pub.json --collection profile.sale.json --assignment assignment.json --utxo utxo-reveal.json --creator "$CREATOR" --change "$CHANGE" --fee-rate 1 --network regtest --out sale-reveal.signed.json
inscribe preflight --record sale-reveal --network regtest --signed sale-reveal.signed.json --collection profile.sale.json --assignment assignment.json --utxo utxo-reveal.json --pub issuer.key.pub.json --rpc "$NODE_URL" --rpc-user "$RPC_USER" --rpc-password "$RPC_PASSWORD"
inscribe broadcast --plan sale-reveal.signed.json --network regtest --mine --rpc "${NODE_URL}wallet/funds" --rpc-user "$RPC_USER" --rpc-password "$RPC_PASSWORD"
```

When it is confirmed and has 6 confirmations, `/collection` shows `orderStatus` `ready` and the `order` of the sale, and anyone can compare the sale transactions with it, as PINS-5 §8.5 says.

**3. Move the unsold items.** The unsold items are the sale items still at the sale address. `unsold-transfer` takes them as a list of outputs, and a list of fee coins, one for each transaction, and writes unsigned PSBTs. The list of items is the `listunspent` of the wallet that holds the sale key, for the sale address, as it is; the sale address must hold nothing but sale items. Count them against the indexer before you go on: `/inscriptions?owner=SALE_ADDRESS` must show the same number.

```bash
qw holder listunspent 1 9999999 "[\"$SALE\"]" > sale-coins.json
ITEMS=$(node -p 'JSON.parse(require("fs").readFileSync("sale-coins.json", "utf8")).length')
curl -s "$INDEXER/inscriptions?owner=$SALE&limit=1" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).total'
TRANSACTIONS=$(( (ITEMS + 103) / 104 ))
echo "$ITEMS items, $TRANSACTIONS transactions, $TRANSACTIONS fee coins"
```

The number the second command prints is the indexer's count of P2MR Inscriptions at the sale address, and it must equal `ITEMS`.

*The fee coins.* A fee coin is an output of the wallet that holds the sale key that carries no P2MR Inscription. The wallet that holds the sale key signs the whole transaction, so a coin of any other wallet cannot pay it. Make one fee coin for each transaction in three moves: pay a fresh address of the sale-key wallet from a wallet that holds no P2MR Inscription, wait for 6 confirmations, and read the coin back from the indexer before it is used. The coin must hold at least the fee plus the dust threshold of 2,855 bits, and the fee is the signed size times the fee rate. The size of a transaction of `n` items is `3,805 × (n + 1) + 12` bytes: 19,037 bytes for 4 items, 15,232 for 3, and at most 104 items. At 1 bit per byte, a coin of 50,000 bits (0.0005 QBT) pays for up to 11 items with its change; the example uses it.

```bash
FEE_TXIDS=$(for n in $(seq "$TRANSACTIONS"); do qw funds sendtoaddress "$(qw holder getnewaddress)" 0.0005; done)
q generatetoaddress 6 "$(qw funds getnewaddress)" > /dev/null
sleep 4
qw holder listunspent 6 9999999 | FEE_TXIDS="$FEE_TXIDS" node -e '
const rows = JSON.parse(require("fs").readFileSync(0, "utf8"));
const wanted = process.env.FEE_TXIDS.split(/\s+/).filter(Boolean);
const coins = rows.filter((row) => wanted.includes(row.txid));
(async () => {
  if (coins.length !== wanted.length) throw new Error(`${coins.length} of ${wanted.length} fee coins have 6 confirmations in the wallet`);
  for (const coin of coins) {
    const out = await (await fetch(`${process.env.INDEXER}/output/${coin.txid}:${coin.vout}?limit=1000`)).json();
    if (out.known !== true || out.spent !== false || out.total !== 0 || out.inscriptions.length !== 0) throw new Error(`${coin.txid}:${coin.vout} is not a known unspent output with no P2MR Inscription`);
  }
  console.log(JSON.stringify(coins));
})().catch((error) => { console.error(error.message); process.exit(1); });
' > fee-coins.json
```

`funds` is the wallet that pays and holds no P2MR Inscription (the regtest guide makes it so), and `holder` is the wallet of the sale key. The first command pays one fee coin for each transaction. The last reads the coins of the sale-key wallet that came from those payments and asks the indexer about each of them through `/output/{txid}:{vout}`. It prints the coins, and so fills `fee-coins.json`, only when every coin is **known** (the indexer has read the block that made it), **unspent**, and holds **no** P2MR Inscription. For any other answer it names the coin and stops, and the file stays empty: do not use that coin, pay another. An unknown answer is not an empty one ([the API](../indexer/API.md#output)), so a coin the indexer has not read yet is refused, and waiting a few seconds and running the last command again is enough.

On mainnet the commands are the same with your own wallets: `qw` is `qbit-cli -rpcwallet=<wallet>` on your node, `funds` is the wallet you pay from, `holder` is the wallet that holds the sale key, and `INDEXER` is your own indexer on mainnet. Do not mine: the payments need 6 confirmations, so run the last command when `listunspent 6` shows the coins, and size each coin for the fee rate of the day (`estimatesmartfee` on the node gives one). Take the fee coins from your own payment, not from a coin that someone else sent to the wallet: it may carry a P2MR Inscription, which only the check above shows. The sale-key wallet must not spend the fee coins for anything else before the transfer.

```bash
inscribe unsold-transfer --items sale-coins.json --funding fee-coins.json --unsold-address "$UNSOLD" --change "$FEE_CHANGE" --fee-rate 1 --network regtest --out unsold
```

The sale key is read from the `desc` of the rows (`--sale-pub` gives it as 64 hex characters instead), and every row must agree with it. A transaction moves up to 104 items (`--per-tx` chooses fewer), so the command writes `unsold-1.psbt`, `unsold-2.psbt` and so on, and tells you how many fee coins it needs: the list has exactly one for each transaction. `$FEE_CHANGE` is the address that receives the change of the fee coins. `--dry-run` prints the fee and the change of each transaction and writes nothing, so a coin that is too small is refused before anything is signed.

Each transaction has the items as its first inputs and the fee coin as its last input. Output `i` pays the unsold address exactly the value of input `i`, and the last output is the change of the fee coin. By first in, first out (PINS-3 §3), every P2MR Inscription of item `i` lands in output `i` at the offset it had, and no bit of the fee coin reaches an item output. The command checks that shape on the PSBT it made and refuses to write one that does not have it. `verifyUnsoldTransferPsbt` in `packages/sale/unsold.ts` checks a PSBT of this shape that someone else made. The wallet that holds the sale key and the fee coin signs each PSBT, and the node sends it:

```bash
SIGNED=$(qw holder walletprocesspsbt "$(cat unsold-1.psbt)" true DEFAULT)
HEX=$(q finalizepsbt "$(node -p 'JSON.parse(process.argv[1]).psbt' "$SIGNED")" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).hex')
q sendrawtransaction "$HEX"
```

Repeat for every PSBT, then mine or wait for the confirmations. The indexer then shows each of those P2MR Inscriptions with `ownerAddress` the unsold address.

**4. Close the collection.** The closing (PINS-5 §7) is independent of the sale: it works for a collection with a sale and for one without. After it is confirmed, no new P2MR Inscription can become an authentic item, even one signed by the issuer key. PINS-5 §7 says it SHOULD be inscribed right after the last item batch is confirmed, so the sale does not have to be over. Its `count` is the supply of the profile.

```bash
inscribe close --key issuer.key --pub issuer.key.pub.json --collection profile.sale.json --utxo utxo-close.json --creator "$CREATOR" --change "$CHANGE" --fee-rate 1 --network regtest --out close.signed.json
inscribe preflight --record close --network regtest --signed close.signed.json --collection profile.sale.json --utxo utxo-close.json --pub issuer.key.pub.json --rpc "$NODE_URL" --rpc-user "$RPC_USER" --rpc-password "$RPC_PASSWORD"
inscribe broadcast --plan close.signed.json --network regtest --mine --rpc "${NODE_URL}wallet/funds" --rpc-user "$RPC_USER" --rpc-password "$RPC_PASSWORD"
```

`/collection` then shows `closingId`. On mainnet, every one of these commands needs `--network mainnet`, and `preflight` and `broadcast` need `--confirm-network mainnet`, as for the launch. The creator address of these records must not be a wallet that you pay from: the postage output of each record holds a P2MR Inscription.

## How primary sale PSBTs are served

The reference does not ship a server, so this is what a sale server has to do. The rules are PINS-6 §6; the steps follow from them.

1. **Hold the sale key.** The sale holding address (`--sale` at plan and sign) is controlled by `K_sale`, a key that is not the issuer key. Whoever signs `0x83` listings needs it online, so keep it apart from the keyfile and give it no more than the sale holding address.
2. **Know the order.** After `H_seed`, compute `order` from the secret (offline, on the machine that has the keyfile) and give the server only what it needs to release the next item. The server must not publish the order.
3. **Release one listing at a time.** The k-th sale delivers `order[k]`. For the next id, read `/inscription/{id}` from the indexer and check that it is located at the sale holding address at offset 0. Never publish listings in advance: a published PSBT lets anyone choose that item.
4. **Build and sign when a buyer asks.** The buyer gives a receive address (P2MR, not the sale holding address) and the three coins it will use. The server builds the template with `primarySalePsbt` (price is the `price_bits` of the price P2MR Inscription, `seller_payment = price_bits`), signs input 2 with `0x83`, and returns the PSBT. It never sees the buyer's keys.
5. **Wait for 6 confirmations** before releasing the next item to someone else, as PINS-6 §6 says. If the transaction is lost in a reorg, offer the same item again first.
6. **The buyer checks and signs.** The buyer runs `checkPurchasePsbt` with the indexer's `/output` answers (`heldAt`) and its own node's `gettxout` answers (`utxoAt`), signs only if the report is `ok` and `complete`, then finalizes and broadcasts. A check that was not run makes the report not `ok`, so a buyer who skips a lookup does not sign by accident ([the library page](../../packages/sale/README.md#the-check-fails-closed)).

On regtest you can play both roles with `regtest-trade.ts`, using the `holder` wallet's address as the sale holding address: take an id from `/inscriptions?owner=<address>` and pass it as `--id`. The example reads the location and the price you pass; it does not read the order, so for a real sale the order check stays with your server.
