<!-- SPDX-License-Identifier: Apache-2.0 -->

# Log in to your node

The indexer (`npm run indexer:serve`), the inscriber commands that talk to a node (`utxo`, `broadcast`, `preflight`) and the regtest trade example (`packages/sale/regtest-trade.ts`) call your Qbit Core node over JSON-RPC. They all take the same login options, in one of three ways. Give one, not a mix.

The explorer (`explorer/`) takes the same three ways as environment variables only, in its `.env` (`QBIT_RPC_URL` and one login, with `PINS_NETWORK` naming the network of the cookie under `QBIT_RPC_DATADIR`). It also reads `QBIT_CONF`. See [explorer/README.md](../../explorer/README.md#settings).

| Way | Flags | Environment variables | Use it when |
|---|---|---|---|
| Cookie file | `--rpc-cookie-file <path>` | `QBIT_RPC_COOKIE_FILE` | You know the path of the node's `.cookie` |
| Data directory | `--rpc-datadir <dir>` | `QBIT_RPC_DATADIR` | You know the node's data directory. The cookie in it is the one of the `--network` you chose |
| User and password | `--rpc-user <user>` and `--rpc-password <password>` | `QBIT_RPC_USER` and `QBIT_RPC_PASSWORD` | The node has `rpcuser` and `rpcpassword` (or `rpcauth`) in `qbit.conf` |

A flag wins over the variable of the same kind. Two different ways at once (for example a user and a cookie file) are refused with an error that says so.

## The cookie

A Qbit Core node that has no `rpcuser` and `rpcpassword` writes a new cookie, `.cookie`, in its data directory every time it starts. The file holds one line, `__cookie__:<64 hex digits>`, readable by the user that runs the node. It needs no password in your shell history and no copy in a script.

- On mainnet the file is `<datadir>/.cookie`. On the other networks it is in a subdirectory named for the network: `<datadir>/regtest/.cookie`, `<datadir>/testnet4/.cookie`. `--rpc-datadir` adds that subdirectory for you, from `--network` (regtest when you give none). `--rpc-cookie-file` takes the path as it is.
- The file is read again for every call, so a node that restarts, and writes a new cookie, needs no restart of the indexer or the inscriber. While the node is starting and has not written the file yet, the indexer waits and tries again.
- A cookie is accepted only when `--rpc` is on your own machine (`127.0.0.1`, `::1` or `localhost`). The cookie is a password for a node you can read the files of, and it does not go over a network.
- A file that is missing, larger than 1 KiB, or not `user:password` on one line is an error that gives the cause (`ENOENT`, `ETOOBIG`, `EMALFORMED`, `EACCES`) and never the content.

A complete copy of a node's data directory can be moved to another machine. Stop the node first, copy the directory, then start the node on the new machine with that directory. The chain data is kept, so the node does not resync. Adjust `qbit.conf` bind addresses if the new machine needs different ones. The cookie file is written again when the node starts; an indexer or explorer that logs in with `--rpc-datadir` or `QBIT_RPC_DATADIR` reads the new cookie on the next call.

```text
# regtest node started with -datadir=$HOME/qbit-regtest and no rpcuser
npm run indexer:serve -- --db index.sqlite --rpc http://127.0.0.1:18452/ --rpc-datadir "$HOME/qbit-regtest" --network regtest
npm run inscribe -- utxo --pub issuer.key.pub.json --network regtest --rpc http://127.0.0.1:18452/ --rpc-datadir "$HOME/qbit-regtest" --out utxo.json
```

```text
# mainnet node with the default data directory and no rpcuser
npm run indexer:serve -- --db index.sqlite --rpc http://127.0.0.1:8352/ --rpc-datadir ~/.qbit --network mainnet --confirm-network mainnet
```

## User and password

`--rpc-user` and `--rpc-password` write the words on this process's own command line, so they can show in the process list and in shell history. The environment variables do not. The login goes to the node in the `Authorization` header only. It is never put in the URL (a URL with credentials is refused), in a log line or in an error message. A user cannot contain `:`, and neither part can be empty or have a control character.

## What the client does

The client is `packages/indexer/rpc.ts`. It uses Node's built-in `fetch` and no other package, sends one POST per call, does not follow a redirect, and stops a call after 180 seconds. A call that fails because the node is down, loading its block index or restarting is tried again by the indexer. A rejected login (HTTP 401) is tried again when it came from a cookie, which the next read may fix, and is an error at once when it came from a password.
