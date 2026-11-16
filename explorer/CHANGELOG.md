<!-- SPDX-License-Identifier: Apache-2.0 -->

# Changelog

## Unreleased

- Default `RATE_PER_MINUTE` is 2000 and `MAX_CONCURRENCY` is 128, so a gallery page of 104 images does not hit a 429 or a 503. The limits still cap a client that keeps asking far faster.
- Image and text previews retry failed loads with backoff and honour `Retry-After`, then show "Preview unavailable".
- P2MR Inscription numbers are always written `P2MR Inscription #N` (global, counted from 0). A collection item also shows its own number, for example `Flatbits #12 of 10,000`, on its page. Lists and captions label a collection item as `Item #12`.
- SVG previews are no longer drawn with `image-rendering: pixelated`. Raster images keep it.
- `.env.example` and the README include a mainnet cookie login (`QBIT_RPC_URL` and `QBIT_RPC_DATADIR`).

## 1.0.0

Read-only loopback explorer for PINS. It reads the indexer of this repository, takes an optional collection manifest (`config/examples/flatbits.json` is an example) and serves the page, `/api/*` and the content frame described in `README.md`. It logs in to the node with a cookie or with a user and password.
