# PINS Explorer

A local, read-only explorer for PINS. It listens on loopback. It does not sign, broadcast, or open a public port. A manifest can feature one collection. `config/examples/flatbits.json` is a real public example of one, not a separate protocol and not a default.

PINS is an independent protocol.

## Requirements

Node.js 22.12 or newer, and older than 23. `npm` installs the tools of this package and of the repository root, which holds the indexer. A synced Qbit node with RPC on loopback is required for a real index. The mock UI does not need one.

## Fresh install

This directory is `explorer/` inside the PINS repository. The explorer uses the indexer of that repository, so install the tools of the repository root once, then the tools of this package. Run the commands below from `explorer/`.

```bash
npm --prefix .. ci --ignore-scripts
npm ci --ignore-scripts
cp .env.example .env
```

Fill `QBIT_RPC_URL`, `QBIT_RPC_USER`, and `QBIT_RPC_PASSWORD`, or set `QBIT_CONF` to a `qbit.conf` that contains `rpcuser` and `rpcpassword`. The files are read as text. Values are not passed to a shell.

```bash
npm run indexer
npm start
```

`npm run indexer` starts `scripts/indexer-run.ts` of this repository from the repository root, the same process as `npm run indexer:serve` there. It stores the index in `data/index.sqlite` in this directory and passes the genesis id of the manifest as `--genesis`. The explorer has no copy of the indexer.

## An existing install

An install made with an earlier version kept a separate copy of the indexer in `vendor/pins`. That copy is no longer used. Keep `.env`, `data/`, and `config/`, including `data/index.sqlite` and its `-wal` and `-shm` files. After copying the new source files over the same relative paths, run `npm --prefix .. ci --ignore-scripts` once, stop the old indexer, and start `npm run indexer`. The explorer directory must sit inside a checkout of the PINS repository. Restart the explorer afterwards.

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

The RPC password is placed in the indexer process environment. It is not an npm, node, or curl argument. `npm --silent` only suppresses npm's log line. Curl reads the user from stdin.

The genesis id is read from the file that `MANIFEST` names. Without `MANIFEST` the explorer looks for `config/manifest.json`. If that file is absent, no collection is featured and the indexer is started without `--genesis`. When a manifest is read, the indexer is started with its genesis id as `--genesis`. `.env.example` sets `MANIFEST=config/examples/flatbits.json`, the FlatBits manifest, as a worked example of a real mainnet collection. Replace that line with your own manifest. The manifest is collection configuration, not a protocol rule, and the page names its items "item" (`#/item/12`) for every collection.

## Limits

Explorer 1.0.1 is this package only. It does not change the indexer and it is not a production release. The page was checked with the mock indexer. A separate mainnet run of an earlier build reached height 165925 and 10002 inscriptions; this build does not repeat that check, and it does not decide whether every item of a collection is authentic. While the indexer is catching up, each RPC call is a blocking `spawnSync`, so its own HTTP server does not answer during that call. This is not a production release.

The indexer still returns every inscription in one response, and this process keeps that snapshot in memory. The browser asks for one page of images, not the whole collection. One indexer process follows one genesis id.

## What a frame can show

The card, the home feature, and the detail frame keep their size. PNG, JPEG, GIF, and WebP are drawn inside that frame. A broken image stays in the frame and says the preview is unavailable. Text and JSON are shown as plain text, cut off after 2048 bytes. SVG is drawn as an image. Its scripts do not run.

Audio and video use the browser’s own controls in that frame. Nothing plays until a click, and a grid does not request those bytes before the click. A `text/html` page runs only after a click, in an iframe whose sandbox is `allow-scripts` and whose response forbids network, forms, and the parent origin. Stop closes it. The sandbox does not cap processor time. Pages that need other files, a wallet, or the network are not loaded. SVG is not treated as a page.

Other types, including PDF and arbitrary bytes, stay in the same frame with the content type and a download. A leaf list is named as a leaf list. It is not marked authentic or invalid because of that. The detail frame has a fullscreen control for that frame only. The inscribed page cannot request fullscreen itself.

Chrome 156 on this package played WAV, MP3, Ogg Vorbis, WebM Opus, WebM VP8, and MP4 H.264 with AAC. The same Chrome did not play Ogg Theora, and that file stayed in the frame as preview unavailable. This is not a claim that every codec, site, or game will play. `REVIEW.md` records what was checked and what was not.
