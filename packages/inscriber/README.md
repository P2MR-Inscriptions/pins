<!-- SPDX-License-Identifier: Apache-2.0 -->

# Inscriber

Builds, signs, and broadcasts a PINS mint. The commands are `keygen`, `address`, `assign`, `plan`, `sign`, `broadcast`, `preflight`, and `price`.

`assign`, `plan`, and `preflight` require `--collection` and `--zip`. Those files name the collection. This package does not.

`keygen`, `address`, `assign`, and `sign` refuse an RPC URL. `broadcast` and `preflight` on testnet4 or mainnet require `--confirm-network` to repeat `--network`.

The air gap and the command list are in `docs/inscriber/README.md`.
