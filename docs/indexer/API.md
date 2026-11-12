<!-- SPDX-License-Identifier: Apache-2.0 -->

# Indexer HTTP API

Read-only JSON API for the reference PINS indexer. It listens on `127.0.0.1` only.
Every response sets:

- `X-Content-Type-Options: nosniff`
- `Content-Security-Policy: default-src 'none'; sandbox`
- `Cache-Control: no-store`

`/content/:id` uses the inscription's recorded content type instead of JSON. Those bytes are not executed.

The sale field is always `waiting_for_wallet`. The sale stays closed until Qbit Wallet can complete a pre-signed `0x83` offer. The indexer does not use an online sale key.

## OpenAPI

```yaml
openapi: 3.0.3
info:
  title: PINS indexer
  version: "1"
paths:
  /status:
    get:
      summary: Tip height, state hash, inscription count, and undo rows
      responses:
        "200":
          description: Indexer status
  /inscription/{id}:
    get:
      summary: One inscription by id txidi n
      parameters:
        - in: path
          name: id
          required: true
          schema: { type: string }
      responses:
        "200": { description: Inscription }
        "404": { description: Missing }
  /inscriptions:
    get:
      summary: Inscriptions, optionally filtered by owner address
      parameters:
        - in: query
          name: owner
          schema: { type: string }
      responses:
        "200": { description: List }
  /output/{outpoint}:
    get:
      summary: Inscriptions at txid:vout
      parameters:
        - in: path
          name: outpoint
          required: true
          schema: { type: string, example: "abc:0" }
      responses:
        "200": { description: Inscriptions at that output }
  /pieces:
    get:
      summary: One page of collection pieces. offset is the first index, limit is 1 to 100. authentic=1 returns only pieces the indexer marks authentic.
      parameters:
        - in: query
          name: offset
          schema: { type: integer }
        - in: query
          name: limit
          schema: { type: integer, maximum: 100 }
      responses:
        "200": { description: Page }
        "400": { description: Bad offset or limit }
  /pieces/{n}:
    get:
      summary: Collection piece n, authenticity, location, and finality
      parameters:
        - in: path
          name: n
          required: true
          schema: { type: integer }
      responses:
        "200": { description: Piece }
        "404": { description: Outside the collection }
  /collection:
    get:
      summary: Genesis, supply, sale status, priceStatus, and the verified order when a seed is revealed
      responses:
        "200": { description: Collection }
  /content/{id}:
    get:
      summary: Raw inscription body
      parameters:
        - in: path
          name: id
          required: true
          schema: { type: string }
      responses:
        "200":
          description: Body bytes
          content:
            application/octet-stream:
              schema: { type: string, format: binary }
```

## State hash

`/status` returns `stateHash`, the SHA-256 of a canonical text snapshot after the tip block.
Two indexers that follow the same regtest chain produce the same digest. The snapshot lists
inscriptions by number and includes the body hash, content type, location, owner address, location
height, and flags. `/pieces/N` and `/inscription/id` both send `location.script` and `ownerScript` as lowercase hex. A located script is not a JSON object of byte indexes. `ownerAddress` is the address of that same script.

## Performance

On the regtest chain that holds the 50-piece end-to-end collection and the full 10,000-piece mint
(1,143 blocks, 10,055 inscriptions), one sync took 26.2 seconds. That is 43.6 blocks per second.
Resident memory moved from 82 MB to 201 MB.

## Sync

`follow` in `packages/indexer/follow.ts` reads `getblock` verbosity 3 and catches up to the
current tip. A parent confirmed in an earlier block is loaded with `getrawtransaction`, which
needs the node's transaction index. Qbit Core v1.0.0 documents that as `-txindex` (default off).
Do not prune blocks or witnesses. An output created earlier in the same block is read from that
block. The store keeps whether each output is P2MR. An input that spends an output known not to be
P2MR carries no inscription (PINS-1 §4.2), and a P2MR spend without witness items stops the indexer
with `witness pruned` (PINS-2 §2). A database written before the store kept that flag is upgraded in
place, and the outputs it already holds count as unknown: they are not checked. Rebuild the index
with `resync()` to check every input. Each of those calls is synchronous, so the API does not answer while one is in progress. It follows regtest unless the caller names `testnet4` or `mainnet`, and the node's
`chain` must be `regtest`, `testnet4`, or `main`. `npm run indexer:serve` (the same process as
`npm run indexer:run`) is that caller for an operator. After the first catch-up it keeps polling
`getblockcount` and `getbestblockhash` (default every 15 seconds, `--poll` to change it). A new
height or a new tip hash calls `follow` again. Pass `--no-follow` to serve the API from the
catch-up snapshot and ignore later blocks. Output amounts are taken from transaction hex. A reorg
is a height whose stored hash is not the node's hash: the indexer disconnects to the fork and
applies the new blocks, including a reorg that arrives while it is polling. A node call that fails while polling is retried after 1 s, 2 s, 4 s and so on up to 60 s, and the process stops after 30 failures in a row. Undo rows are kept
for the last 1,000 blocks (configurable). A deeper reorg throws and names `store.resync()` followed
by `follow()` from the activation height.

The sale order stays `pending` until the block at genesis height + 6 is indexed and has 6 confirmations. The mix is `SHA256(sale_secret || internal block hash)`, the header hash in internal byte order, not the reversed display hex (PINS-5 §8.2). A reorg that replaces that block changes the order on the next read. The reserve is the PINS-5 §8 selection. `/collection` reports `reserveMode` (`configured` when the process was given a profile, `declared` when genesis field 5 or the collection document contains a `reserve` object, otherwise `none`) and `reserveVerified`. It does not list the groups. A genesis that carries no `sale_commitment` declares no sale: `orderStatus` is `none`, `seedRevealed` is false, and `priceStatus` is `none`, and no sale reveal or price inscription is read for it. Otherwise `priceStatus` is `pending` until the first valid price inscription by the genesis issuer, then `ready`, with `priceBits`, `priceSources`, `priceTime`, and `priceId`. The launch text is `pins-price/1`. A rehearsal indexer started with `--schema c/1` derives `p/1` and ignores the launch text. A later price inscription is ignored. A genesis without those price keys is valid. `seedRevealed` is true once the issuer has inscribed the `pins-sale-reveal/1` record of PINS-5 §8.5 with the committed secret. `closingId` is the id of the `pins-close/1` closing inscription of PINS-5 §7, once there is one. An inscription after it is not an authentic item. If reserve selection throws, `/collection` still returns the collection: `reserveVerified` is false, `reserveReason` is the quota message, and `orderStatus` is `failed`. The sale field stays `waiting_for_wallet` until a wallet can complete `0x83`. A sale is still not open while `priceStatus` is `pending`.
