<!-- SPDX-License-Identifier: Apache-2.0 -->

# PINS Explorer

A local, read-only explorer for PINS. It listens on loopback. It does not sign, broadcast, or open a public port. A manifest can feature one collection. `config/examples/flatbits.json` is a real public example of one, not a separate protocol and not a default.

PINS is an independent protocol.

## Requirements

Node.js 22.13 or newer, and older than 25. The root indexer needs `node:sqlite`, which is not available without a flag before 22.13. `npm` installs the tools of this package and of the repository root, which holds the indexer. A synced Qbit node with RPC on loopback is required for a real index. The mock UI does not need one.

## Fresh install

This directory is `explorer/` inside the PINS repository. The explorer uses the indexer of that repository, so install the tools of the repository root once, then the tools of this package. Run the commands below from `explorer/`.

```bash
npm --prefix .. ci --ignore-scripts
npm ci --ignore-scripts
cp .env.example .env
```

Fill `QBIT_RPC_URL` and one login: `QBIT_RPC_USER` with `QBIT_RPC_PASSWORD`, or the node's cookie with `QBIT_RPC_COOKIE_FILE` (the file) or `QBIT_RPC_DATADIR` (the node's data directory, with `PINS_NETWORK` naming the network), or set `QBIT_CONF` to a `qbit.conf` that contains `rpcuser` and `rpcpassword`. A node started without `rpcuser` writes a cookie, so the data directory is all it takes. The cookie is read for every call and accepted only for an RPC URL on this machine. The files are read as text. Values are not passed to a shell.

```bash
npm run indexer
npm start
```

`npm run indexer` starts `scripts/indexer-run.ts` of this repository from the repository root, the same process as `npm run indexer:serve` there. It stores the index in `data/index.sqlite` in this directory and passes the genesis id of the manifest as `--genesis`. The explorer has no copy of the indexer.

## Over a regtest node of your own

You do not need a manifest, a `.env`, or the `indexer` script to look at P2MR Inscriptions you inscribed on regtest. Start the indexer of the repository root on your regtest node (`npm run indexer:serve`, see the [regtest guide](../docs/guides/REGTEST.md#4-start-the-indexer)), then, from `explorer/`:

```bash
npm ci --ignore-scripts
MANIFEST= INDEXER_URL=http://127.0.0.1:8787 PORT=8081 npm start
```

The empty `MANIFEST` matters: it keeps the explorer from featuring a collection that is not on your chain. The home page lists the latest P2MR Inscriptions, and the search box takes a P2MR Inscription id, a transaction id or an address. The pages are at `http://127.0.0.1:8081/#/inscription/<id>`, `#/address/<address>` and `#/tx/<txid>`. The same data is at `/api/inscription/<id>` and `/api/inscriptions?limit=20`.

## Try the interface

```bash
npm --prefix .. ci --ignore-scripts
npm ci --ignore-scripts
npm test
npm run dev
```

`npm run dev` serves synthetic data and shows a mock banner. By default the mock listens on 127.0.0.1:8787 and the explorer on 127.0.0.1:8080. `MOCK_PORT` and `PORT` choose other ports. The explorer in that run reads `http://127.0.0.1:$MOCK_PORT` and does not keep a different indexer URL. If either port is already in use, the command stops with a nonzero status and does not attach to the process that holds the port.

```bash
MOCK_PORT=8788 PORT=8081 npm run dev
```

Ctrl+C stops the mock and the explorer that this command started. `npm test` uses loopback fixtures only. One test starts the indexer from `packages/` on loopback with a small synthetic database, which is why the repository root needs `npm ci` first. `npm run dev` does not need it.

`indexer` starts that process on 127.0.0.1:8787. The explorer listens on 127.0.0.1:8080.

A password is placed in the indexer process environment. It is not an npm or node argument. `npm --silent` only suppresses npm's log line. The indexer sends the login to the node in an `Authorization` header. A cookie login passes only the path of the cookie file.

The genesis id is read from the file that `MANIFEST` names. Without `MANIFEST` the explorer looks for `config/manifest.json`. If that file is absent, no collection is featured and the indexer is started without `--genesis`. When a manifest is read, the indexer is started with its genesis id as `--genesis`. `.env.example` sets `MANIFEST=config/examples/flatbits.json`, the Flatbits manifest, as a worked example of a real mainnet collection. Replace that line with your own manifest. The manifest is collection configuration, not a protocol rule, and the page names its items "item" (`#/item/12`) for every collection.

## Settings

All of them are environment variables, read from the process or from `.env` (see `.env.example`, which has a comment for each).

| Variable | Default | Meaning |
|---|---|---|
| `HOST`, `PORT` | `127.0.0.1`, `8080` | Where the explorer listens. Loopback only |
| `INDEXER_URL` | `http://127.0.0.1:8787` | The indexer it reads. Loopback only |
| `INDEXER_PORT` | `8787` | Port of the indexer that `npm run indexer` starts. Keep it equal to the port in `INDEXER_URL` |
| `PINS_NETWORK` | `mainnet` | Network of that indexer (`mainnet`, `testnet4`, `regtest`), and of the cookie under `QBIT_RPC_DATADIR` |
| `MANIFEST` | `config/manifest.json` | The collection to feature. Empty: none |
| `QBIT_RPC_URL` | none | The node's RPC URL. Optional. Without RPC settings the explorer shows no block or transaction data from the node, and the indexer still serves everything else |
| `QBIT_RPC_USER`, `QBIT_RPC_PASSWORD` | none | A user and a password |
| `QBIT_RPC_COOKIE_FILE`, `QBIT_RPC_DATADIR` | none | A cookie login. Not together with a user and a password |
| `QBIT_CONF` | none | A `qbit.conf` for the user, the password and the port |
| `MAX_INSCRIPTIONS` | `200000` | The most P2MR Inscriptions the explorer keeps in memory. A bigger index is refused |
| `TRUSTED_HOSTS`, `TRUST_PROXY` | none | See below |
| `POLL_MS`, `CONTENT_MAX_BYTES`, `CONTENT_TIMEOUT_MS`, `SNAPSHOT_TIMEOUT_MS`, `RATE_PER_MINUTE`, `MAX_CONCURRENCY`, `EXPLORER_URL` | see `.env.example` | Polling, content and rate limits, and an external link |

## Limits

Explorer 1.0.0 is a viewer. It reads the indexer of this repository and changes nothing in it. It does not decide whether an item is authentic: the page shows what the indexer reports (`authentic` and `reason`). Node RPC is optional and read-only (`getblockcount`, `getblockhash`, `getblockheader`, `getrawtransaction`).

`npm test` checks the pages and the server against a mock indexer and against the indexer of `packages/` on a small synthetic database. The public example (10,002 P2MR Inscriptions) is checked at the indexer, by the mainnet replay of [docs/examples/flatbits.md](../docs/examples/flatbits.md). The explorer has no test against a synced mainnet node.

The explorer reads the list of P2MR Inscriptions from the indexer in pages of 1000, and this process keeps that snapshot in memory. The browser asks for one page of images, not the whole collection. One indexer process follows one genesis id.

The explorer answers only a `Host` header that names loopback, plus the names in `TRUSTED_HOSTS` (comma separated). Behind a reverse proxy on the same machine, set `TRUST_PROXY=1`: the explorer then reads `X-Forwarded-Host`, and it rate-limits by the last address in `X-Forwarded-For`, the one the proxy appended. A proxy that does not set that header leaves the limit per proxy connection, not per client. `INDEXER_URL` must stay on loopback, which is also what the indexer's own Host check allows.

## Search

`/api/search?q=` (the search box) takes a query of at most 128 characters after trimming. A longer one gets the same "not recognized" answer (`404`) as text that matches nothing. It recognizes: a P2MR Inscription id (`<txid>i<n>`), a transaction id, an address, a collection piece (`item 12`, `piece #12`, `#12`), a block (`block 5`, `block #5`), and a P2MR Inscription number (`7`, `no. 7`, `n° 7`, `inscription #7`). The patterns are in `server/search.ts`, and `test/search.test.ts` lists what each accepts and refuses.

## What a frame can show

The card, the home feature, and the detail frame keep their size. PNG, JPEG, GIF, and WebP are drawn inside that frame. A broken image stays in the frame and says the preview is unavailable. Text and JSON are shown as plain text, cut off after 2048 bytes. SVG is drawn as an image. Its scripts do not run.

Audio and video use the browser’s own controls in that frame. Nothing plays until a click, and a grid does not request those bytes before the click. A `text/html` page runs only after a click, in an iframe whose sandbox is `allow-scripts` and whose response blocks fetch, outside files, nested frames, and form posts. The sandbox keeps it off the parent origin. A policy cannot stop a frame from navigating itself, so such a page can still send its own frame to another address. Stop closes it. The sandbox does not cap processor time. Pages that need other files, a wallet, or the network are not loaded. SVG is not treated as a page.

Other types, including PDF and arbitrary bytes, stay in the same frame with the content type and a download. A leaf list is named as a leaf list. It is not marked authentic or invalid because of that. The detail frame has a fullscreen control for that frame only. The inscribed page cannot request fullscreen itself.

Chrome 156 on this package played WAV, MP3, Ogg Vorbis, WebM Opus, WebM VP8, and MP4 H.264 with AAC. The same Chrome did not play Ogg Theora, and that file stayed in the frame as preview unavailable. This is not a claim that every codec, site, or game will play. It was not tried on a synced mainnet node, a full 10,000-item collection, a restart of a real index or a live reorganisation; the tests run against the mock indexer and the indexer in `packages/`.
