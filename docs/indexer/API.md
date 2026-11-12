<!-- SPDX-License-Identifier: Apache-2.0 -->

# Indexer HTTP API

Read-only JSON API for the reference PINS indexer. It listens on `127.0.0.1` only.
Every response sets:

- `X-Content-Type-Options: nosniff`
- `Content-Security-Policy: default-src 'none'; sandbox`
- `Cache-Control: no-store`

`/content/:id` uses the inscription's recorded content type instead of JSON. Those bytes are not executed.
A recorded content type that is not a plain header value (empty, or with a control or non-ASCII character) is served as `application/octet-stream`. `/inscription/{id}` still shows the recorded value.

A request whose `Host` header is not `127.0.0.1`, `localhost` or `[::1]` (any port) gets `403`. That keeps a web page on another site from reading the API through DNS rebinding. Behind a reverse proxy that passes its own host name, start the indexer with `--allow-host name[,name]`. A path with a bad percent escape, such as `/content/%zz`, gets `400`.

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
      summary: Tip height and hash, state hash, inscription count, undo rows, and the activation height the database started from
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
        "400": { description: Bad percent escape in the path }
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
        "400": { description: Bad percent escape in the path }
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
        "400": { description: Bad percent escape in the path }
        "404": { description: Missing }
        "200":
          description: Body bytes
          content:
            application/octet-stream:
              schema: { type: string, format: binary }
```

## State hash

`/status` returns `stateHash`, the SHA-256 of a canonical text snapshot after the tip block. Two indexers that follow the same chain to the same tip produce the same digest. The digest includes the tip, so it changes with every block, and two digests are comparable only when both indexers are at the same tip. The text starts with one line `block <height> <hash>` for the tip. Then comes one line per inscription, sorted by inscription number, and it is hashed as it is.

**What the digest covers.** For each inscription it covers: the number, the id, the SHA-256 of the body, the content type, the location (`txid:vout:offset`, or `unbound`, `lost`, and the other non-located states), the owner address, the height at which the inscription was last placed, and its flags. The location already includes the effect of a pointer field (field 2), and the flags include a bad pointer. `/pieces/N` and `/inscription/id` both send `location.script` and `ownerScript` as lowercase hex. A located script is not a JSON object of byte indexes. `ownerAddress` is the address of that same script.

**What it does not cover.**

- **Metadata and other field values.** The bytes of field 5 (metadata) and the values of the other fields are not in the digest. Two indexers that read an item's metadata differently can have the same `stateHash`. Metadata is optional in an inscription, and an inscription without it is as valid as one with it.
- **Where metadata is bound instead.** For an item of a collection, the metadata is part of the item's Merkle leaf (PINS-5 §5.1), which is compared with the collection's Merkle root. So for an authentic item, the metadata is fixed by the root: a different field 5 would not match the leaf and the item would not be authentic. That is a check made by `/collection` and `/pieces`, and its result is not part of `stateHash`. To compare two indexers on a collection, compare those responses as well as the digest. The root itself is in the genesis field 5, which the digest does not cover either.
- **Creation data.** The height and position of the block and transaction that created the inscription (`createdHeight`, `createdIndex`) and the public key that opened the reveal leaf (`leafIssuer`) are not covered.
- **Derived views.** Authenticity, the reserve, the sale order, the price, and the closing inscription are computed from inscriptions and are not in the digest.
- **Undo data.** The rows kept to undo recent blocks are not covered.

The preimage and the digest are the same for every collection and for inscriptions that belong to none. The recorded values for the public example are on the [example page](../examples/flatbits.md). A change to what the digest covers would change every recorded value, so the format is fixed. The store keeps the digest of every block it has applied in the `blocks` table (`height`, `hash`, `state_hash`). `/status` shows only the tip, so to compare an earlier height read that table, for example `SELECT state_hash FROM blocks WHERE height = 171486`.

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
is a height whose stored hash is not the node's hash, or a fetched block whose parent is not the stored tip: the indexer disconnects to the fork and
applies the new blocks, including a reorg that arrives while it is polling. A node call that fails while polling is retried after 1 s, 2 s, 4 s and so on up to 60 s, and the process stops after 30 failures in a row. Undo rows are kept
for the last 1,000 blocks (configurable). A deeper reorg throws and names `store.resync()` followed
by `follow()` from the activation height.

The sale order stays `pending` until the block at genesis height + 6 is indexed and has 6 confirmations. The mix is `SHA256(sale_secret || internal block hash)`, the header hash in internal byte order, not the reversed display hex (PINS-5 §8.2). A reorg that replaces that block changes the order on the next read. The reserve is the PINS-5 §8 selection. `/collection` reports `reserveMode` (`configured` when the process was given a profile, `declared` when genesis field 5 or the collection document contains a `reserve` object, otherwise `none`) and `reserveVerified`. It does not list the groups. A genesis that carries no `sale_commitment` declares no sale: `orderStatus` is `none`, `seedRevealed` is false, and `priceStatus` is `none`, and no sale reveal or price inscription is read for it. Otherwise `priceStatus` is `pending` until the first valid price inscription by the genesis issuer, then `ready`, with `priceBits`, `priceSources`, `priceTime`, and `priceId`. The launch text is `pins-price/1`. A rehearsal indexer started with `--schema c/1` derives `p/1` and ignores the launch text. A later price inscription is ignored. A genesis without those price keys is valid. `seedRevealed` is true once the issuer has inscribed the `pins-sale-reveal/1` record of PINS-5 §8.5 with the committed secret. `closingId` is the id of the `pins-close/1` closing inscription of PINS-5 §7, once there is one. An inscription after it is not an authentic item. If reserve selection throws, `/collection` still returns the collection: `reserveVerified` is false, `reserveReason` is the quota message, and `orderStatus` is `failed`. The sale field stays `waiting_for_wallet` until a wallet can complete `0x83`. A sale is still not open while `priceStatus` is `pending`.
