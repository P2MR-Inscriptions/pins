<!-- SPDX-License-Identifier: Apache-2.0 -->

# Indexer HTTP API

Read-only JSON API for the reference PINS indexer. It listens on `127.0.0.1` only.
Every response sets:

- `X-Content-Type-Options: nosniff`
- `Content-Security-Policy: default-src 'none'; sandbox`
- `Cache-Control: no-store`

A response to a request the API handles also carries `X-Indexed-Tip: <height>:<hash>`, the tip the answer was computed for. It is absent while the index is empty. See [Reading a whole list](#reading-a-whole-list).

`/content/:id` uses the P2MR Inscription's recorded content type instead of JSON. Those bytes are not executed.
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
      summary: Tip height and hash, state hash, P2MR Inscription count, undo rows, the activation height the database started from, the standards the indexer implements, and the schema texts it reads
      responses:
        "200":
          description: Indexer status
  /inscription/{id}:
    get:
      summary: One P2MR Inscription by id (`<txid>i<n>`)
      parameters:
        - in: path
          name: id
          required: true
          schema: { type: string }
      responses:
        "200": { description: P2MR Inscription }
        "400": { description: Bad percent escape in the path }
        "404": { description: Missing }
  /inscriptions:
    get:
      summary: P2MR Inscriptions by number, optionally filtered by owner address. Every row unless limit is given.
      parameters:
        - in: query
          name: owner
          schema: { type: string }
        - in: query
          name: offset
          schema: { type: integer, minimum: 0, default: 0 }
        - in: query
          name: limit
          schema: { type: integer, minimum: 1, maximum: 1000 }
      responses:
        "200": { description: "List with total, offset and limit" }
        "400": { description: Bad offset or limit }
  /output/{outpoint}:
    get:
      summary: P2MR Inscriptions at txid:vout, by number. Every row unless limit is given.
      parameters:
        - in: path
          name: outpoint
          required: true
          schema: { type: string, example: "abc:0" }
        - in: query
          name: offset
          schema: { type: integer, minimum: 0, default: 0 }
        - in: query
          name: limit
          schema: { type: integer, minimum: 1, maximum: 1000 }
      responses:
        "200": { description: "P2MR Inscriptions at that output, with total, offset and limit" }
        "400": { description: Bad percent escape in the path, or bad offset or limit }
  /pieces:
    get:
      summary: One page of collection pieces. offset is the first index, limit is 1 to 1000 (default 100). authentic=1 returns only pieces the indexer marks authentic.
      parameters:
        - in: query
          name: offset
          schema: { type: integer, minimum: 0, default: 0 }
        - in: query
          name: limit
          schema: { type: integer, minimum: 1, maximum: 1000, default: 100 }
        - in: query
          name: authentic
          schema: { type: string, enum: ["1"] }
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
      summary: Raw P2MR Inscription body
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

## Reading lists

Three endpoints return lists: `/inscriptions` (the path is fixed; it lists P2MR Inscriptions), `/output/{outpoint}` and `/pieces`. They share one rule, so a client written for one works on the others.

| Query parameter | Meaning |
|---|---|
| `offset` | Index of the first row. A whole number from 0. Default 0. |
| `limit` | Number of rows. A whole number from 1 to 1000. |

- **Digits only.** `1e1`, `0x10`, `-1`, `1.5`, ` 5` and an empty value are refused with `400` and `{ "error": "offset must be a whole number from 0 and limit a whole number from 1 to 1000" }`. A `limit` of 1001 or more is refused too: it is never cut down to 1000 without saying so.
- **The answer says what it holds.** Every list answer has `total` (the rows of the whole list, after the `owner` or `authentic` filter), `offset`, and `limit` (the limit that applied, or `null` when the request set none). The rows are under `inscriptions` (`/inscriptions`, `/output/{outpoint}`) or `pieces` (`/pieces`). An `offset` at or past `total` gives an empty list and the same `total`.
- **Order.** `/inscriptions` and `/output/{outpoint}` list by P2MR Inscription number, `/pieces` by piece number. The order does not change between two pages read at the same tip.
- **With no `limit`.** `/pieces` gives 100 rows, as it always did. `/inscriptions` and `/output/{outpoint}` give every row, as they did before paging existed. That keeps a client written for that behaviour from receiving a list cut short without knowing it. The whole list is not bounded: for the public example (10,002 P2MR Inscriptions) it is 14.7 MB, and it grows with the chain. New code should always send `limit`. `limit=1000` is a good page.
- **Keys.** The existing keys are unchanged. `total`, `offset` and `limit` were added to `/inscriptions` and `/output/{outpoint}`; `/pieces` had them.

```
GET /inscriptions?owner=<address>&offset=0&limit=2
{ "total": 5, "offset": 0, "limit": 2, "inscriptions": [ { "id": "…i0", "number": 0, … }, { "id": "…i1", "number": 1, … } ] }
```

### Reading a whole list

A block can arrive between two pages, and then the list may have changed. Every answer carries `X-Indexed-Tip` (`<height>:<hash>`), so a client can tell without another request: if the value differs from the first page, start again. A complete read:

```js
// Reads every row of a list endpoint at one tip. `key` is "inscriptions" or "pieces".
async function readAll(base, path, key) {
  for (;;) {
    const rows = [];
    let tip = null;
    let total = 0;
    let moved = false;
    do {
      const response = await fetch(`${base}${path}?offset=${rows.length}&limit=1000`);
      const body = await response.json();
      const seen = response.headers.get("x-indexed-tip");
      if (tip !== null && seen !== tip) { moved = true; break; }
      if (body[key].length === 0 && rows.length < body.total) throw new Error("the list did not add up");
      tip = seen;
      total = body.total;
      rows.push(...body[key]);
    } while (rows.length < total);
    if (!moved) return rows;
  }
}
```

The explorer reads `/inscriptions` this way, 1000 rows at a time, and drops a snapshot whose tip moved. An indexer from before paging ignores `offset` and `limit` and sends every row with no `total`; the explorer takes that as the whole list.

## Status

`/status` answers:

| Key | Meaning |
|---|---|
| `network`, `chain` | The network the indexer follows and the chain name of its node. |
| `height`, `hash` | The tip. `-1` and `null` while the index is empty. |
| `stateHash` | The digest of the state at the tip. See [State hash](#state-hash). |
| `inscriptions` | The number of P2MR Inscriptions indexed. |
| `undoBlocks` | The blocks the undo log can still roll back. |
| `activationHeight` | The height the database started from, or `null`. |
| `standards` | The standards of [docs/specs](../specs/README.md) this indexer implements. |
| `schemas` | The `schema` texts of the records it reads from field 5. |

```
"standards": [ { "id": "PINS-1", "status": "draft" }, { "id": "PINS-2", "status": "draft" }, { "id": "PINS-3", "status": "draft" }, { "id": "PINS-4", "status": "draft" }, { "id": "PINS-5", "status": "draft" } ],
"schemas": { "collection": "pins-collection/1", "price": "pins-price/1", "leafList": "pins-leaflist/1", "saleReveal": "pins-sale-reveal/1", "close": "pins-close/1" }
```

- **`standards`** lists PINS-1 to PINS-5. PINS-6 (trades between wallets and marketplaces) is not listed, because the indexer reads no PSBT. `status` is the status line of the document. The documents carry no version number: they are Draft, and every change to one is recorded in [docs/specs/CHANGELOG.md](../specs/CHANGELOG.md). A client that depends on a standard should check that its id is in the list, and treat a status other than `draft` as news worth reading. The list comes from `STANDARDS` in `packages/protocol/index.mjs`, and a test compares it with the index and the status line of every document.
- **`schemas`** are the texts the indexer accepts. These carry a version (`/1`), which is how a record format would change. `collection` and `price` are the launch texts unless the indexer was started with a rehearsal `--schema`. `leafList`, `saleReveal` and `close` are fixed. A record with another schema text is ignored, as PINS-5 says.

## Caching

The indexer keeps the answer of the costly reads until the tip changes, so a gallery or an explorer polling it does not make it recompute the collection for every request:

- the collection view, used by `/collection`, `/pieces` and `/pieces/{n}`;
- the list of P2MR Inscriptions as the API shows them, with an index by output, used by `/inscriptions` and `/output/{outpoint}`.

The key is the tip: its height, block hash and state hash. The state changes only when a block is applied or disconnected, and either one changes the tip. So the first request after a new block, or after a reorg (even one that ends at the same height with another block), computes the answer again, and the others share it. One tip is kept at a time and nothing is written to disk. The answers are the same as without the cache: on the mainnet replay to block 171486, `/collection`, `/pieces`, the rows of `/inscriptions` and `/status` (apart from the keys added here) are byte for byte what the version before returned. `/status`, `/inscription/{id}` and `/content/{id}` are not cached: they read the store directly, as before. `Cache-Control: no-store` is for the client's own cache and is unchanged. A program that embeds the indexer and changes `store.indexer` other than by `commit`, `disconnect` or `resync` would see stale answers until the next block.

Measured on the mainnet replay to block 171486 (10,002 P2MR Inscriptions, 10,000 collection pieces), one machine: `/collection` and `/pieces` took about 410 ms for every request before. The first request at a tip takes the same time, and the following ones 1 to 3 ms. A whole `/inscriptions` answer is 14.7 MB and takes about 80 ms to serialize. Eleven pages of 1000 take about 140 ms in all, and each page 6 to 7 ms.

## State hash

`/status` returns `stateHash`, the SHA-256 of a canonical text snapshot after the tip block. Two indexers that follow the same chain to the same tip produce the same digest. The digest includes the tip, so it changes with every block, and two digests are comparable only when both indexers are at the same tip. The text starts with one line `block <height> <hash>` for the tip. Then comes one line per P2MR Inscription, sorted by P2MR Inscription number, and it is hashed as it is.

**What the digest covers.** For each P2MR Inscription it covers: the number, the id, the SHA-256 of the body, the content type, the location (`txid:vout:offset`, or `unbound`, `lost`, and the other non-located states), the owner address, the height at which the P2MR Inscription was last placed, and its flags. The location already includes the effect of a pointer field (field 2), and the flags include a bad pointer. `/pieces/N` and `/inscription/id` both send `location.script` and `ownerScript` as lowercase hex. A located script is not a JSON object of byte indexes. `ownerAddress` is the address of that same script.

**What it does not cover.**

- **Metadata and other field values.** The bytes of field 5 (metadata) and the values of the other fields are not in the digest. Two indexers that read an item's metadata differently can have the same `stateHash`. Metadata is optional in a P2MR Inscription, and a P2MR Inscription without it is as valid as one with it.
- **Where metadata is bound instead.** For an item of a collection, the metadata is part of the item's Merkle leaf (PINS-5 §5.1), which is compared with the collection's Merkle root. So for an authentic item, the metadata is fixed by the root: a different field 5 would not match the leaf and the item would not be authentic. That is a check made by `/collection` and `/pieces`, and its result is not part of `stateHash`. To compare two indexers on a collection, compare those responses as well as the digest. The root itself is in the genesis field 5, which the digest does not cover either.
- **Creation data.** The height and position of the block and transaction that created the P2MR Inscription (`createdHeight`, `createdIndex`) and the public key that opened the reveal leaf (`leafIssuer`) are not covered.
- **Derived views.** Authenticity, the reserve, the sale order, the price, and the closing P2MR Inscription are computed from P2MR Inscriptions and are not in the digest.
- **Undo data.** The rows kept to undo recent blocks are not covered.

The preimage and the digest are the same for every collection and for P2MR Inscriptions that belong to none. The recorded values for the public example are on the [example page](../examples/flatbits.md). A change to what the digest covers would change every recorded value, so the format is fixed. The store keeps the digest of every block it has applied in the `blocks` table (`height`, `hash`, `state_hash`). `/status` shows only the tip, so to compare an earlier height read that table, for example `SELECT state_hash FROM blocks WHERE height = 171486`.

## Performance

On the regtest chain that holds the 50-piece end-to-end collection and the full 10,000-piece mint
(1,143 blocks, 10,055 P2MR Inscriptions), one sync took 26.2 seconds. That is 43.6 blocks per second.
Resident memory moved from 82 MB to 201 MB.

## Sync

`follow` in `packages/indexer/follow.ts` reads `getblock` verbosity 3 and catches up to the
current tip. A parent confirmed in an earlier block is loaded with `getrawtransaction`, which
needs the node's transaction index. Qbit Core v1.0.0 documents that as `-txindex` (default off).
Do not prune blocks or witnesses. An output created earlier in the same block is read from that
block. The store keeps whether each output is P2MR. An input that spends an output known not to be
P2MR carries no P2MR Inscription (PINS-1 §4.2), and a P2MR spend without witness items stops the indexer
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

The sale order stays `pending` until the block at genesis height + 6 is indexed and has 6 confirmations. The mix is `SHA256(sale_secret || internal block hash)`, the header hash in internal byte order, not the reversed display hex (PINS-5 §8.2). A reorg that replaces that block changes the order on the next read. The reserve is the PINS-5 §8 selection. `/collection` reports `reserveMode` (`configured` when the process was given a profile, `declared` when genesis field 5 or the collection document contains a `reserve` object, otherwise `none`) and `reserveVerified`. It does not list the groups. A genesis that carries no `sale_commitment` declares no sale: `orderStatus` is `none`, `seedRevealed` is false, and `priceStatus` is `none`, and no sale reveal or price P2MR Inscription is read for it. Otherwise `priceStatus` is `pending` until the first valid price P2MR Inscription by the genesis issuer, then `ready`, with `priceBits`, `priceSources`, `priceTime`, and `priceId`. The launch text is `pins-price/1`. A rehearsal indexer started with `--schema c/1` derives `p/1` and ignores the launch text. A later price P2MR Inscription is ignored. A genesis without those price keys is valid. `seedRevealed` is true once the issuer has inscribed the `pins-sale-reveal/1` record of PINS-5 §8.5 with the committed secret. `closingId` is the id of the `pins-close/1` closing P2MR Inscription of PINS-5 §7, once there is one. A P2MR Inscription after it is not an authentic item. If reserve selection throws, `/collection` still returns the collection: `reserveVerified` is false, `reserveReason` is the quota message, and `orderStatus` is `failed`. The sale field stays `waiting_for_wallet` until a wallet can complete `0x83`. A sale is still not open while `priceStatus` is `pending`.
