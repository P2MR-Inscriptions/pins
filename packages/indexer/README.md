<!-- SPDX-License-Identifier: Apache-2.0 -->

# Indexer

Reads a local Qbit node and serves a read-only HTTP API on `127.0.0.1`. It follows the chain after the first catch-up. It does not broadcast.

`npm run indexer:serve` starts it. The routes are in `docs/indexer/API.md`. Pass `--collection` with a collection profile when reserve checks should use that profile. The profile is not hardcoded here. Pass `--genesis` with an inscription id when the collection view must use that genesis and not the first valid one. Confirmed parents from earlier blocks need the node's transaction index (`-txindex` in Qbit Core v1.0.0). Catch-up calls `curl` with `spawnSync`, so this process does not answer HTTP during one of those calls.
