<!-- SPDX-License-Identifier: Apache-2.0 -->

# Five minutes on regtest

This page inscribes one P2MR Inscription on a private Qbit regtest node and reads it back from the indexer. It is the shortest path through the tools. Every command is on this page in order, in one terminal, and a test keeps the commands and flags in step with the code (`packages/protocol/docs-commands.test.ts`).

Regtest is a private chain on your computer. The coins have no value, and nothing here touches mainnet or a public network. Every command names `--network regtest` or talks to the node that step 1 starts.

## You need

- Node.js 22.13 to 24 and a clone of this repository.
- `qbitd` and `qbit-cli` of Qbit Core v1.0.1 on your `PATH`, and `curl`. [Try it on your own regtest node, section 1](REGTEST.md#1-install) downloads and checks them.

## 1. Start a node and make coins

The node gets its own data folder and its own ports (P2P 18460, RPC 18452). It has no user and no password: the tools log in with the cookie that the node writes into its data folder ([Log in to your node](NODE-LOGIN.md)). Coinbase coins mature after 1,000 blocks on Qbit, so the node mines 1,001.

```bash
cd pins            # the folder of your clone
npm ci --ignore-scripts
export PINS="$PWD" W="$HOME/pins-quickstart"
export NODE_URL=http://127.0.0.1:18452/ INDEXER=http://127.0.0.1:8787
mkdir -p "$W/node" "$W/work"
cat > "$W/node/qbit.conf" <<'CONF'
[regtest]
server=1
txindex=1
listen=0
rpcport=18452
port=18460
fallbackfee=0.00001
CONF
qbitd -regtest -datadir="$W/node" -daemon
q()  { qbit-cli -regtest -datadir="$W/node" "$@"; }
qw() { local wallet="$1"; shift; q -rpcwallet="$wallet" "$@"; }
until q getblockchaininfo > /dev/null 2>&1; do sleep 1; done
for name in funds holder; do q -named createwallet wallet_name="$name" > /dev/null; done
q generatetoaddress 1001 "$(qw funds getnewaddress)" > /dev/null
qw funds getbalance
```

`txindex=1` is for the inscriber, which reads a transaction that is already confirmed. The indexer does not need it. The last command prints the coins that matured.

## 2. Start the indexer

The indexer follows the node and answers over HTTP on `127.0.0.1`. It runs in the background of this terminal. The first catch-up reads every block and takes from a few seconds to a minute.

```bash
node --no-warnings --experimental-strip-types "$PINS/scripts/indexer-run.ts" --network regtest --db "$W/index.sqlite" --rpc "$NODE_URL" --rpc-datadir "$W/node" --port 8787 --poll 2 > "$W/indexer.log" 2>&1 &
INDEXER_PID=$!
until curl -sf "$INDEXER/status" > /dev/null; do sleep 2; done
curl -s "$INDEXER/status"; echo
```

`inscriptions` in the answer is the number of P2MR Inscriptions the indexer has found (the key is the API's name). It is 0 now.

## 3. Inscribe

The key is encrypted with a passphrase. On regtest `PINS_KEY_PASSPHRASE` answers the prompt. Set it only for a key that has no value. `keygen` and `address` need no network, and on mainnet you run them on an offline machine ([Inscriber](../inscriber/README.md#air-gap)).

```bash
export PINS_KEY_PASSPHRASE=regtest-only-passphrase
inscribe() { node --no-warnings --experimental-strip-types "$PINS/packages/inscriber/cli.ts" "$@"; }
cd "$W/work"
inscribe keygen --no-sale --out issuer.key
FUNDING=$(inscribe address --pub issuer.key.pub.json --network regtest | awk '/ funding address / {print $NF; exit}')
qw funds sendtoaddress "$FUNDING" 1
q generatetoaddress 6 "$(qw funds getnewaddress)" > /dev/null
inscribe utxo --pub issuer.key.pub.json --network regtest --rpc "$NODE_URL" --rpc-datadir "$W/node" --out utxo.json
```

`keygen` wrote `issuer.key` (encrypted) and `issuer.key.pub.json` (public). `address` printed the funding address of that key, which only that key can spend. The payment has 6 confirmations because `preflight` asks for them, and `utxo.json` is the one output that pays the address.

Write a body, name two addresses, and plan. The P2MR Inscription goes to `--creator`, the change to `--change`. They must differ from each other and from the funding address.

```bash
echo "hello from regtest" > note.txt
CREATOR=$(qw holder getnewaddress); CHANGE=$(qw funds getnewaddress)
inscribe plan --single --body note.txt --content-type "text/plain;charset=utf-8" --pub issuer.key.pub.json --utxo utxo.json --creator "$CREATOR" --change "$CHANGE" --fee-rate 1 --network regtest --out plan.json | tee plan.txt
SINGLE_ID=$(awk '/^P2MR Inscription id/ {print $4}' plan.txt)
echo "$SINGLE_ID"
```

`plan` prints the fees, the addresses and the id of the P2MR Inscription: the txid of the reveal, then `i0`. Nothing is broadcast yet. `sign` runs with the key and the same files, `preflight` asks the node whether the plan is valid, and `broadcast` sends it and mines the blocks (`--mine` is refused on any chain but regtest). The wallet name in the RPC URL tells `--mine` which wallet gets the blocks.

```bash
inscribe sign --single --body note.txt --content-type "text/plain;charset=utf-8" --key issuer.key --plan plan.json --utxo utxo.json --creator "$CREATOR" --change "$CHANGE" --out plan.signed.json
inscribe preflight --single --body note.txt --content-type "text/plain;charset=utf-8" --network regtest --plan plan.json --signed plan.signed.json --utxo utxo.json --pub issuer.key.pub.json --rpc "$NODE_URL" --rpc-datadir "$W/node"
inscribe broadcast --plan plan.signed.json --network regtest --mine --rpc "${NODE_URL}wallet/funds" --rpc-datadir "$W/node"
```

Every `preflight` row says `PASS`.

## 4. Read it back

The indexer sees the new block within a few seconds.

```bash
sleep 4
curl -s "$INDEXER/inscription/$SINGLE_ID"; echo
curl -s "$INDEXER/content/$SINGLE_ID"; echo
curl -s "$INDEXER/status"; echo
```

The first answer has the content type, the body hash, the location (`txid`, `vout`, `offset`) and `ownerAddress`, which is `$CREATOR`. The second is the body, `hello from regtest`. `/status` now counts 1 P2MR Inscription and carries the `stateHash`: any other indexer that follows the same blocks to the same tip computes the same digest (PINS-2 §4.4).

## 5. Stop and clean up

```bash
kill "$INDEXER_PID"
q stop
cd "$PINS" && rm -rf "$W"
```

The fields of the answer, the other routes and the explorer are in [the indexer API](../indexer/API.md) and [the explorer](../../explorer/README.md). A collection, a collection with a sale commitment and a trade are in [Try it on your own regtest node](REGTEST.md). Mainnet is in [the mainnet launch checklist](MAINNET-CHECKLIST.md).
