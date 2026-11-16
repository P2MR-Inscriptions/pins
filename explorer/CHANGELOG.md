<!-- SPDX-License-Identifier: Apache-2.0 -->

# Changelog

## Unreleased

- Default `RATE_PER_MINUTE` is 2000 and `MAX_CONCURRENCY` is 128, so a gallery page of 104 images does not hit a 429 or a 503. The limits still cap a client that keeps asking far faster.
- Image and text previews retry failed loads with backoff and honour `Retry-After`, then show "Preview unavailable".
- The home introduction says that the explorer shows P2MR Inscriptions that its indexer reads from a Qbit node, instead of naming "this computer".
- Every page except the collection view writes only the global number (counted from 0): `Pins #N` on the thumbnails of the home page and of the latest list (the large latest hero keeps `P2MR Inscription #N`), and `P2MR Inscription #N` in the title and facts of a P2MR Inscription page. The list is titled "Latest P2MR Inscriptions" and is newest first. A collection item's own number (for example `Flatbit #12`, from the name prefix of the genesis) appears only in the collection view and in the Collection facts of an item. The menu entry for the collection is named after it, for example "Flatbits Collection".
- SVG previews are no longer drawn with `image-rendering: pixelated`. Raster images keep it.
- `.env.example` and the README include a mainnet cookie login (`QBIT_RPC_URL` and `QBIT_RPC_DATADIR`).
- The search box takes the global P2MR Inscription number only: `7`, `#7`, `10,001`, `no. 7`, `inscription #7`, `Pins #7`, `P2MR Inscription #7`, in any case. Searching by a collection's own item number (`item 12`, `piece 12`, a bare `#12` as an item) is removed, so a search can no longer open an empty item page. The placeholder, the API error text, the README and the How it works guide say so. A number too large to be exact is "not recognized".
- The collection view says "item", not "piece", and a collection whose name already ends in "Collection" is not titled "Collection Collection".
- The How it works guide explains `Pins #N`, `P2MR Inscription #N` and the item number of a collection.

## 1.0.0

Read-only loopback explorer for PINS. It reads the indexer of this repository, takes an optional collection manifest (`config/examples/flatbits.json` is an example) and serves the page, `/api/*` and the content frame described in `README.md`. It logs in to the node with a cookie or with a user and password.
