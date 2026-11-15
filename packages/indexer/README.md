<!-- SPDX-License-Identifier: Apache-2.0 -->

# Indexer

Reads a local Qbit node and serves a read-only HTTP API on `127.0.0.1`. It follows the chain after the first catch-up. It does not broadcast.

`npm run indexer:serve` starts it. The routes, the optional `offset` and `limit` of the list endpoints, the standards that `/status` lists, and the per-tip cache are described in `docs/indexer/API.md`. Pass `--collection` with a collection profile when reserve checks should use that profile. The profile is not hardcoded here. Pass `--genesis` with a P2MR Inscription id when the collection view must use that genesis and not the first valid one. Confirmed parents from earlier blocks need the node's transaction index (`-txindex` in Qbit Core v1.0.1). The HTTP API does not listen until the catch-up at start has finished. On a first run against a synced mainnet node that can take several hours, and until it finishes `/status` and the explorer have nothing to reach. After the API is up, the indexer keeps polling for new blocks, and node calls run `curl` as a child process without blocking, so the HTTP API keeps answering while a call is in flight. When the node does not answer while the indexer is polling (a restart, a timeout, a block index that is still loading), the indexer logs it, waits 1 s, then 2 s, doubling up to 60 s, and tries again. After 30 failed calls in a row it stops with the last error. An error from the indexer itself, such as a refused chain, a reorg deeper than the undo log, or a pruned witness, stops it at once. A failure during the first catch-up at start also stops it.

Node may print an `ExperimentalWarning` about SQLite when the indexer starts. The tools use Node's built-in `node:sqlite`. The warning is harmless and can be ignored. A complete mainnet command, with a cookie login and the checks to run after catch-up, is in [the Flatbits example](../../docs/examples/flatbits.md#verify-the-example). Running the indexer as a service is in [the deploy guide](../../docs/guides/DEPLOY.md).

`npm run indexer:serve -- --help` prints the same list. Two flags are required, `--db` and `--rpc`, and the login is one of three kinds.

| Flag | Default | Meaning |
|---|---|---|
| `--db <file>` | none (required) | SQLite database. Created when missing. It records the network, marker, schema, activation height and genesis |
| `--rpc <url>` | none (required) | The node's RPC URL. A URL with credentials is refused |
| `--rpc-user`, `--rpc-password` | none | A user and a password. `QBIT_RPC_USER` and `QBIT_RPC_PASSWORD` keep them off the command line |
| `--rpc-cookie-file <file>` | none | The node's cookie file, read for every call. `QBIT_RPC_COOKIE_FILE`. Loopback RPC only |
| `--rpc-datadir <dir>` | none | The node's data directory; its cookie for `--network` is used. `QBIT_RPC_DATADIR` |
| `--network <name>` | `regtest` | `regtest`, `testnet4` or `mainnet` |
| `--confirm-network <name>` | none | Required on `testnet4` and `mainnet`: the same word as `--network` |
| `--port <n>` | `8787` | API port on `127.0.0.1` |
| `--activation <height>` | `161948` on mainnet, `0` otherwise | First block to index |
| `--marker <text>` | `pins` | Envelope marker. Mainnet accepts `pins` only |
| `--schema <name>` | `pins-collection/1` | Collection schema. Mainnet accepts the default only |
| `--poll <seconds>` | `15` | Gap between checks for new blocks and reorganisations |
| `--collection <file>` | none | A collection profile (JSON), so the indexer can reproduce the creator reserve |
| `--genesis <id>` | none | Accept only this P2MR Inscription ID as the genesis of the collection |
| `--allow-host <names>` | none | Comma-separated `Host` header values the API accepts besides `127.0.0.1`, `localhost` and `[::1]` |
| `--no-follow` | off | Do one catch-up, keep serving, and do not poll for new blocks |

The login is one kind only. A flag wins over the variable of the same kind. More on it is in [NODE-LOGIN.md](../../docs/guides/NODE-LOGIN.md).

The database file records the network, the envelope marker, the collection schema, the activation height and the genesis given with `--genesis`. Opening it with another network, marker, schema or genesis, or following it from another activation height, is refused with a message that names the original option. Use the original options, or a new database file. `store.resync()` forgets the chain data and the activation height, so the next start may use another one. A database from before these values were recorded is adopted on its first start: the values of that run are written, so start it with the options it was built with. The undo log keeps the last 1,000 blocks. A database that held fewer undo rows reaches that depth as new blocks arrive.

The `outputs` table holds the outputs that are unspent and the outputs spent in the last blocks the undo log covers. A spent output is deleted once the undo of the block that spent it is. A database without the spend column is upgraded in place, and its existing outputs count as unspent, because it does not say which are spent; a new database or a `store.resync()` followed by a full catch-up has the column filled. The P2MR Inscriptions themselves, with their bodies, are held in memory while the process runs. That is a limit of the reference indexer. A collection of 10,000 small images is a few megabytes, far below what it costs.

