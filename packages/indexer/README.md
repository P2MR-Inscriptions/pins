<!-- SPDX-License-Identifier: Apache-2.0 -->

# Indexer

Reads a local Qbit node and serves a read-only HTTP API on `127.0.0.1`. It follows the chain after the first catch-up. It does not broadcast.

`npm run indexer:serve` starts it. The routes are in `docs/indexer/API.md`. Pass `--collection` with a collection profile when reserve checks should use that profile. The profile is not hardcoded here.
