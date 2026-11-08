# PINS Explorer

A local, read-only explorer for PINS. It listens on loopback. It does not sign, broadcast, or open a public port. A manifest in `config/` can feature one collection. Flatbits is that configuration, not a separate protocol.

PINS is an independent protocol.

## Requirements

Node.js 22.12 or newer, and older than 23. `git` fetches the pinned indexer during setup. `npm` installs this package's tools and, during setup, the indexer's tools. A synced Qbit node with RPC on loopback is required for a real index. The mock UI does not need one.

## Fresh install

Use this only when `vendor/pins` is not already a working checkout.

```bash
npm ci --ignore-scripts
cp .env.example .env
```

Fill `QBIT_RPC_URL`, `QBIT_RPC_USER`, and `QBIT_RPC_PASSWORD`, or set `QBIT_CONF` to a `qbit.conf` that contains `rpcuser` and `rpcpassword`. The files are read as text. Values are not passed to a shell.

```bash
npm run setup
npm run indexer
npm start
```

`setup` fetches only PINS commit `3e014f4ff156a35eea4b8613e37116fd124aa719` into `vendor/pins` and applies `0001`, then `0002`, then `0005`. It does not reset a dirty tree, and it does not read or replace `.env` or `data/`. A patch that is already present is skipped. Run it again after a failed apply; it continues from the patches already present.

## In the PINS repository

This directory is `explorer/` inside the PINS repository. Run the commands below from `explorer/`, not from the repository root.

`npm run setup` fetches only commit `3e014f4ff156a35eea4b8613e37116fd124aa719` into `explorer/vendor/pins`, then applies `patches/0001`, `0002`, and `0005`. That checkout is separate from the repository you are reading. Setup does not use the parent tree as the indexer, and it does not modify protocol files outside `vendor/pins`. `vendor/` is ignored by the parent `.gitignore`.

An existing explorer that already indexes is updated by copying these source files over the same relative paths. Leave `.env`, `vendor/`, `data/`, and `config/` in place, including `data/index.sqlite` and its `-wal` and `-shm` files. Do not run `npm ci` or `npm run setup` again for that update. Restart only the explorer, and leave the indexer running.

## Try the interface

```bash
npm ci --ignore-scripts
npm test
npm run dev
```

`npm run dev` serves synthetic data and shows a mock banner. By default the mock listens on 127.0.0.1:8787 and the explorer on 127.0.0.1:8080. `MOCK_PORT` and `PORT` choose other ports. The explorer in that run reads `http://127.0.0.1:$MOCK_PORT` and does not keep a different indexer URL. If either port is already in use, the command stops with a nonzero status and does not attach to the process that holds the port.

```bash
MOCK_PORT=8788 PORT=8081 npm run dev
```

Ctrl+C stops the mock and the explorer that this command started. `npm test` uses loopback fixtures only.

`indexer` starts that process on 127.0.0.1:8787. The explorer listens on 127.0.0.1:8080. Do not run `setup` again on a checkout that already indexes.

The RPC password is placed in the indexer process environment. It is not an npm, node, or curl argument. `npm --silent` only suppresses npm's log line. Curl reads the user from stdin. See `patches/README.md`.

The genesis id is read from `config/manifest.flatbits.json` unless `MANIFEST` names another file. FlatBits is the manifest shipped with this package. It is collection configuration, not a hard-coded protocol rule.

## Limits

Explorer 1.0.1 is this package only. It does not change the pinned indexer and it is not a production release. The page was checked with the mock indexer. A separate mainnet run of an earlier build reached height 165925 and 10002 inscriptions; this build does not repeat that check, and it does not decide whether all 10,000 Flatbits are authentic. Restarting an indexer database that already contains height `-1` placeholders is covered by the output-identity tests, not by a second pass over a live database. While the indexer is catching up, each RPC call is a blocking `spawnSync`, so its own HTTP server does not answer during that call. This is not a production release.

The indexer still returns every inscription in one response, and this process keeps that snapshot in memory. The browser asks for one page of images, not the whole collection. One indexer process follows one genesis id.

## What a frame can show

The card, the home feature, and the detail frame keep their size. PNG, JPEG, GIF, and WebP are drawn inside that frame. A broken image stays in the frame and says the preview is unavailable. Text and JSON are shown as plain text, cut off after 2048 bytes. SVG is drawn as an image. Its scripts do not run.

Audio and video use the browser’s own controls in that frame. Nothing plays until a click, and a grid does not request those bytes before the click. A `text/html` page runs only after a click, in an iframe whose sandbox is `allow-scripts` and whose response forbids network, forms, and the parent origin. Stop closes it. The sandbox does not cap processor time. Pages that need other files, a wallet, or the network are not loaded. SVG is not treated as a page.

Other types, including PDF and arbitrary bytes, stay in the same frame with the content type and a download. A leaf list is named as a leaf list. It is not marked authentic or invalid because of that. The detail frame has a fullscreen control for that frame only. The inscribed page cannot request fullscreen itself.

Chrome 156 on this package played WAV, MP3, Ogg Vorbis, WebM Opus, WebM VP8, and MP4 H.264 with AAC. The same Chrome did not play Ogg Theora, and that file stayed in the frame as preview unavailable. This is not a claim that every codec, site, or game will play. `REVIEW.md` records what was checked and what was not.
