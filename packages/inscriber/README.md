<!-- SPDX-License-Identifier: Apache-2.0 -->

# Inscriber

Builds, signs, and broadcasts the P2MR Inscriptions of a collection, or a single one with `--single`. The fourteen commands are `keygen`, `address`, `utxo`, `root`, `assign`, `plan`, `sign`, `broadcast`, `preflight`, `price`, `unsold-address`, `sale-reveal`, `unsold-transfer`, and `close`. The last four close a sale and a collection (PINS-5 §7 and §8.5); `records.ts` writes the three records, `close-sale.ts` plans and signs them, and `record-checks.ts` is what `preflight --record` runs.

`assign`, `plan`, and `preflight` require `--collection` and `--zip`. Those files name the collection. This package does not.

`keygen`, `address`, `assign`, and `sign` refuse an RPC URL. `broadcast` and `preflight` on testnet4 or mainnet require `--confirm-network` to repeat `--network`.

The air gap and the command list are in `docs/inscriber/README.md`.
