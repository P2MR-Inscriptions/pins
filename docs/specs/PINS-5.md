<!-- SPDX-License-Identifier: CC0-1.0 -->
# PINS-5: Collections and Provenance

| Field | Value |
|---|---|
| Standard | PINS-5 |
| Title | Collections and Provenance |
| Status | Draft. The construction below is the format. A collection's root, supply, and reserve groups are inputs, not constants of this document. |
| Type | Protocol, normative |
| License | CC0-1.0 |
| Requires | PINS-1, PINS-3, PINS-4 |

> Independent protocol, not affiliated with Qbit or Qbit-Org. Conventions: PINS-1 §2.

## 1. Abstract

PINS-5 lets anyone verify, from chain data alone, that an inscription is an authentic item of a
fixed-supply collection. It does not use parent/child inscriptions. Authenticity rests on on-chain
commitments made by one **issuer key**: a genesis inscription with a Merkle root over all items, a
leaf-list inscription and a closing inscription. An optional committed random sale order (section 8)
proves that buyers received items in an order fixed before the sale. A collection that has no sale
declares none, and is as authentic as one that does. Everything is final and immutable.

## 2. Keys

| Key | Role | Custody |
|---|---|---|
| Issuer key `K_iss` | signs the reveals of the genesis, the leaf list, every item, the closing, the price inscription (PINS-6 §5.1), and the sale-reveal inscriptions | SLH-DSA (PINS-1 F9), generated offline on a dedicated machine that never connects to a network; two encrypted backups in two separate physical places; never on a server; signature count tracked |
| Recovery key `K_rec` | recovery leaf of every commit (PINS-1 §9.3) | same custody as `K_iss`, different key |
| Sale key `K_sale` | owns the items offered in the primary sale and signs listings (PINS-6) | separate from `K_iss`; MAY be kept on a signing machine used only for listings |
| Creator wallet | receives the creator's fixed items (section 8.1) | creator's own P2MR wallet, separate from `K_iss` and `K_sale` |

`K_iss` signs the reveal transactions of the mint, then the closing and the sale reveal. In the
plan of §6.1 that is 17 reveals. The count follows the batching. It is not a
separate consensus limit, and it stays far under the 2^30 limit of SLH-DSA bounded30.

## 3. Genesis inscription

- Body: the canonical `collection.json` (PINS-4 §6); `content_type` `application/json`.
- Field 5 (PINS-4): a `pins-collection/1` map, keys in this order:

| Key | Type | Meaning | Worked example |
|---|---|---|---|
| `schema` | text | `pins-collection/1` | |
| `name` | text | collection name | set by the collection |
| `supply` | uint | number of items | set by the collection |
| `first` | uint | number of the first item | 1 |
| `name_prefix` | text | item name prefix (section 4) | `Item#` |
| `root` | text | 64 lowercase hex characters. The Merkle root (section 5). Not raw bytes | computed, not fixed here |
| `issuer` | text | 64 lowercase hex characters. The `K_iss` public key. Not raw bytes | |
| `item_type` | text | required `content_type` of items | `image/png` |
| `sale_commitment` | text | OPTIONAL. 64 lowercase hex characters. `SHA256(sale_secret)` (section 8). Not raw bytes. When present it comes right after `item_type`. Without it the genesis declares no sale | |
| `reserve` | map | OPTIONAL. The creator reserve groups (section 8.1). When present it MUST be the last key | |

`root`, `issuer`, and `sale_commitment` are text. Each is 64 lowercase hexadecimal characters (the 32-byte value written in hex). The reference encoder does not wrap them as CBOR byte strings. Readers compare the text.

- The genesis reveal leaf MUST start with `<K_iss> OP_CHECKSIGPQC` (PINS-1 §9.1).
- Its inscription ID `G` identifies the collection.
- A reader accepts the map only when its keys are the eight keys from `schema` to `item_type`, in
  that order, then `sale_commitment` if the genesis declares a sale, then `reserve` if it declares
  one. A different key set, another order, or `reserve` in any other position makes the inscription
  not a genesis. `sale_commitment`, when present, MUST be 64 lowercase hexadecimal characters of text,
  or the inscription is not a genesis. `issuer` MUST equal the key at the start of the
  reveal leaf. `name` MUST be non-empty, `supply` a positive integer, `first` a non-negative integer,
  and `item_type` non-empty.
- `reserve`, when present, is `{ "groups": [ { "trait_type": text, "value": text, "count": uint }, ... ],
  "extra": uint }`. Writers SHOULD write `groups` before `extra`, and `trait_type`, `value`, `count`
  in that order. The reference reader checks only that `reserve` is a map whose `groups` is an array
  of maps with text `trait_type`, text `value` and numeric `count`, and that `extra` is numeric. It
  does not check key order inside `reserve`, ignores other keys inside it, and does not check that
  the counts can be met. A `reserve` that fails those checks makes the inscription not a genesis.
  A reserve that cannot be met leaves the genesis and every item's authenticity unchanged. Only the
  reserve and sale-order checks of section 8 fail. The reference inscriber writes no `reserve` key.
- More than one valid genesis can exist, because anyone can inscribe a map of this shape under their own
  key. Authenticity (section 9) is always judged against one chosen `G`. An indexer follows the genesis
  its operator names. The reference indexer takes that from `--genesis <inscription id>`. Without it,
  the reference collection view uses the first valid genesis in chain order. Items signed by another
  issuer are not items of `G` either way (section 9, rule 3).
- The genesis map MUST NOT contain `price_bits`, `price_sources`, or `price_time`. There is no public
  market price for native QBT to freeze at mint. The price is a separate inscription (PINS-6 §5.1),
  published when the sale opens. A genesis that includes any of those three keys is not valid.

## 4. Items

Item `n` (`first ≤ n < first + supply`) is one inscription whose:

- body is the canonical image (PINS-4 §5), `content_type` = `item_type`;
- field 5 is a `pins-item/1` map (PINS-4 §3) whose `meta.name` is `name_prefix` followed by the
  decimal number `n` with no leading zeros (for example `Item#1`);
- reveal leaf starts with `<K_iss> OP_CHECKSIGPQC`.

Items carry no reference to `G`. The number `n` read from the name is cross-checked by the Merkle
leaf, which commits to `n`. Items MUST be inscribed after `G` in chain order. The whole supply is
inscribed at launch, in batches (PINS-1 §9.4), in increasing number order.

## 5. Merkle commitment

### 5.1 Construction

```
leaf_n   = SHA256( u32be(n) || SHA256(body_n) || SHA256(meta_n) )     # 68-byte preimage
parent   = SHA256( left || right )                                     # 64-byte preimage
```

- `body_n`: the exact inscribed body (canonical PNG bytes);
- `meta_n`: the exact inscribed field 5 bytes (canonical CBOR, PINS-4 §2);
- leaves are ordered by `n` ascending, from `first` to `first + supply - 1` (positional, never sorted);
- a level with an odd number of nodes duplicates its last node (`parent = SHA256(x || x)`);
- `root` is the single node of the top level.

There is no separate leaf function. `packages/collection/canonical.mjs` builds each 68-byte preimage
and folds the tree inside the private function `merkleRoot`. That function is not exported. Leaves
and internal nodes are domain-separated by preimage length (68 vs 64 bytes). The duplicated-last-node
ambiguity (two trees with the same root) cannot be exploited because `supply` is fixed in the genesis
and every leaf commits to its own number: a proof for a position `≥ supply` or a leaf whose number
does not match its position MUST be rejected.

### 5.2 Root

The root is the top node of §5.1 over that collection's items. It is written in the genesis.
This document does not fix a root, a supply, or a manifest. The operator computes the root from
the zip and puts the same hex in the collection profile. The inscriber refuses a profile root
that does not match the zip.

### 5.3 No circular dependency

An earlier draft put the genesis ID `G` in every item and had to exclude it from the leaf hash (the ID
depends on the genesis commit, which commits to `root`). The canonical data removes the problem:
items contain no collection reference, so the leaf hashes the whole inscribed metadata and body.
Indexers link an item to its collection through the issuer key and the leaf, not through a field.

## 6. Leaf-list inscription

- Body: `leaf_first || … || leaf_last` (32 × supply bytes; 320,000 bytes for 10,000 items, inside one
  standard reveal); `content_type` `application/octet-stream`.
- Field 5: OPTIONAL. When present it is `{ "schema": "pins-leaflist/1", "root": bytes(32) }`, keys in
  that order, where `root` is a CBOR byte string (not the hex text of section 3) equal to the genesis
  `root`. The leaf list on mainnet has no field 5: its envelope carries `content_type`
  (`application/octet-stream`) and `pointer` (PINS-3) and nothing else. The reference inscriber
  writes no field 5, and writers SHOULD follow it.
- Reveal leaf starts with `<K_iss> OP_CHECKSIGPQC`. It is inscribed in the reveal transaction of the
  genesis, after it (genesis first). On mainnet the genesis is `i0` and the leaf list is `i1`.
- Lets anyone check any item with one lookup (offset `32 × (n - first)`), without Merkle proofs.

The reference indexer takes as the leaf list of `G` the first inscription, in chain order, that is not
`G` and that:

1. is in the same transaction as `G`, and its reveal leaf starts with `<issuer> OP_CHECKSIGPQC`
   (`issuer` from `G`);
2. has `content_type` `application/octet-stream` and a body of exactly `32 × supply` bytes;
3. is not a `reinscription` and not `opaque`;
4. has no field 5, or a field 5 that meets the form above, and
5. has a body whose 32-byte leaves fold, by section 5.1, to the `root` of `G`.

The reference indexer does not check the order of the two inscriptions inside the transaction. It
looks for the leaf list only in the transaction of `G`. A leaf list inscribed elsewhere is not found.
A wrong field 5 excludes that candidate, and an absent one does not.

### 6.1 Funding the mint

One 10,000-item mint inscribes the genesis and the items as 17 reveals: the genesis reveal (collection
document plus the leaf list) and 16 reveals of 625 items. Each reveal spends its own commit output.

1. Build the 17 commit roots.
2. Broadcast one fan-out transaction that pays those 17 commit outputs. Its change output is last,
   so it does not sit in front of a commit.
3. Confirm the fan-out. One confirmation is enough for the reveals to stop being its descendants.
4. Broadcast all 17 reveals. They spend confirmed outputs, so they do not share an unconfirmed
   ancestor and the 404,000-byte descendant limit does not join them together.
5. Mine them. A block holds at most 2,000,000 weight. In the regtest run each block took 5 reveals
   (block weights 1,779,919, 1,830,674 and 1,820,204) and the last block took the remaining 2
   (weight 733,422), so the 17 reveals took 4 blocks. Which blocks include the reveals is up to the
   miners, and a launch can take more blocks (section 6.2). The fan-out is one more block when it is
   not already confirmed.

Example measurements, from one regtest run on 2026-11-04 against `1.x.x` commit
`b27130a7b913de6516cd172a952cb70776f00d0c`. This is not the mainnet record. Section 6.2 has that.

| Piece | Bytes in the regtest run |
|---|---|
| Fan-out (17 commit outputs plus change) | 4,548 |
| 17 reveals | 6,170,171 |
| Total | 6,174,719 |

All 17 reveals were in the mempool together (`getmempoolinfo` `size` 17, `bytes` 6170171) and all
were mined. Their fees were 1 bit per byte (`total_fee` 0.06170171 QBT).

| Fee rate | Fee for the 6,174,719 bytes of the regtest run |
|---|---|
| 1 bit/vB | 6,174,719 bits = 0.06174719 QBT |
| 5 bits/vB | 30,873,595 bits = 0.30873595 QBT |
| 10 bits/vB | 61,747,190 bits = 0.61747190 QBT |

The minimum relay fee is lower (250 bits per kvB). Postage is not part of this fee.

A second large reveal that spends the same unconfirmed parent is still rejected. The regtest probe
recorded `too-long-mempool-chain, exceeds descendant size limit for tx 459f4ebaf47fbfe17b04d2ec8ddbee99c62d2ac1737dd28b69c11296dd456a16 [limit: 404000]`.

### 6.2 Mainnet record

The first 10,000-item mint on mainnet used the plan of section 6.1. These figures were read from the
chain on 2026-11-12 (`mempool.qbit.org`). Fees are 1 bit per byte for every reveal.

| Transaction | Block | Bytes | Fee in bits |
|---|---|---|---|
| Fan-out (17 commit outputs plus change) | 161947 | 4,548 | 4,625 |
| Genesis reveal: the genesis `i0` and the leaf list `i1` | 161948 | 326,392 | 326,392 |
| 16 item reveals of 625 items each | one reveal in each of 16 of the 23 blocks 161949 to 161971 | 345,083 to 372,817 each, 5,844,107 together | 5,844,107 together |
| **Those 18 transactions** | | **6,175,047** | **6,175,124** |

The genesis reveal is 328 bytes larger than in the regtest run (326,392 against 326,064). The fan-out
has the same size as in the regtest run, and the 16 item reveals have the same range and total. The
fee of the fan-out is 77 bits above its size. The 17 reveals were not mined together: they took 17
blocks in a span of 24 (161948 to 161971).

## 7. Closing inscription

- Body: empty or a short text; field 5: `{ "schema": "pins-close/1", "root": bytes(32), "count": supply }`.
- Reveal leaf starts with `<K_iss> OP_CHECKSIGPQC`.
- SHOULD be inscribed right after the last item batch is confirmed. After it is confirmed, no new
  inscription can become an authentic item, even one signed by `K_iss`.
- It MUST NOT contain `sale_secret` (that would reveal the sale order before the sale; see §8).

The reference indexer takes as the closing of `G` the first inscription, in chain order (PINS-2 §4.1),
that comes after `G`, whose reveal leaf starts with `<issuer> OP_CHECKSIGPQC`, that is not a
`reinscription` and not `opaque`, and whose field 5 has exactly the keys `schema`, `root` and `count`,
in that order. `schema` is `pins-close/1`, `root` is a 32-byte byte string equal to the `root` of `G`,
and `count` is an unsigned integer equal to `supply`. It sets no condition on the content type or the
body. An inscription that comes after the closing in chain order is not an item of `G`.

## 8. Creator reserve and sale order

This section applies to a genesis that carries `sale_commitment`. A genesis without it declares no
sale. For it there is no sale secret, no sale reveal, no sale order and no price (PINS-6 §5.1). An
inscription that looks like a sale reveal or a price inscription for such a genesis is not read, and
no check of this section runs. A `reserve` key on such a genesis is accepted, and no selection is run
for it. Authenticity (section 9) does not depend on any of it.

### 8.1 Reserve

A collection does not have to reserve a numeric id range. Before mint it fixes an ordered list of
groups. Each group is a `trait_type`, a `value`, and a `count`, plus a count of extra items taken
from whatever is left. Those values are collection configuration. This document does not list them.

Where an indexer gets the groups:

1. A genesis MAY declare them in its `reserve` key (section 3). When it does, those groups are used.
2. Otherwise they come from configuration given to the indexer. The reference indexer takes a
   collection profile (`--collection`) and uses it only when its `name`, `supply`, `first`,
   `name_prefix`, `item_type` and `root` equal those of the genesis.
3. With neither, the reserve set cannot be derived from chain data. The reference indexer then treats
   every item as part of the sale set.

The genesis inscribed on mainnet has no `reserve` key, so for it the groups are configuration (case 2).

The creator reserve is the set chosen by §8.3. The creator keeps those items. At mint they are sent
to the creator's wallet. That assignment is public, and that is intended. The items not reserved are
the sale set, held by `K_sale`. What the creator later does with the reserve is out of scope.

### 8.2 Secret

1. The issuer draws a 32-byte random `sale_secret` and puts `SHA256(sale_secret)` in the genesis
   as `sale_commitment`. The reserve ranking uses `sale_secret` itself. It does not use a future
   block hash, so the reserve can be assigned at mint.
2. `H_seed` = height of the block confirming `G` + 6.
3. `sale_seed = SHA256(sale_secret || blockhash(H_seed))`. The block hash is 32 bytes in internal
   byte order (the header hash, not the reversed display hex). This mixed seed is used only for the
   sale permutation (§8.4). The issuer cannot choose the block hash and cannot change `sale_secret`.

`sale_secret` MUST stay secret until the sale-reveal inscription (§8.5). The issuer knows it from
the moment it is drawn. Buyers MUST be told that. Anyone who learns it before close can compute the
sale order once `H_seed` is known and can time purchases.

### 8.3 Reserve selection

```
rank(n) = SHA256( sale_secret || 0x01 || uint32be(n) )
```

`n` is the item number, from 1. Ranks are compared as unsigned 32-byte strings. A tie keeps the
lower `n`.

For each group, in that fixed order: drop items already reserved, keep items whose metadata
has that exact `trait_type` and `value`, sort them by `rank(n)`, and take the first `count`.
Then sort the items not yet reserved by the same rank and take the extra count, the lowest ranks.
Those items are the reserve. The rest are the sale set.

The byte `0x01` is the reserve domain. It MUST NOT be reused as the sale order. Items that just miss
a group have low ranks; sorting the sale by the same rank would place them at the front.

The group order is normative. An item that matches two groups is claimed by the earlier group when its
rank falls inside that group's take. The order changes which items are reserved, so the collection
fixes it before mint.

Reference: `selectReserve` in `packages/protocol/reserve.mjs`. The dummy seed
`PINS RESERVE TEST SEED!!NOT REAL` (32 ASCII bytes) is a test vector only, not the launch secret.

### 8.4 Sale permutation

```
a = sale item numbers, ascending
ctr = 0
def draw():                                          # 64-bit unsigned integer
    x = first 8 bytes of SHA256(sale_seed || 0x02 || uint32be(ctr)), big-endian
    ctr += 1
    return x
for i = len(a) - 1 down to 1:
    m = i + 1
    limit = 2^64 - (2^64 mod m)
    repeat x = draw() until x < limit                # rejection sampling, no modulo bias
    j = x mod m
    swap a[i], a[j]
order = a                                            # order[0] is sold first
```

`sale_seed` is the mixed seed from §8.2. The byte `0x02` keeps this draw off the reserve ranking.
Reference: `saleOrder` in `packages/protocol/reserve.mjs`.

The k-th primary sale, in chain order of the sale transactions, MUST deliver `order[k]`.

### 8.5 Thirty days, reveal, unsold items

The sale lasts 30 × 86,400 seconds, measured from the timestamp of the block that contains `G`.

At close the issuer publishes a separate inscription. Field 5 is
`{ "schema": "pins-sale-reveal/1", "root": bytes(32), "sale_secret": bytes(32) }`.
The reveal leaf starts with `<K_iss> OP_CHECKSIGPQC`. Anyone checks `SHA256(sale_secret)` against
`sale_commitment`, rebuilds the reserve and `order`, and compares `order` with the sale transactions.

The reference indexer takes as the sale reveal of `G` the first inscription, in chain order, that
comes after `G`, whose reveal leaf starts with `<issuer> OP_CHECKSIGPQC`, that is not a `reinscription`
and not `opaque`, and whose field 5 has exactly the keys `schema`, `root` and `sale_secret`, in that
order. `schema` is `pins-sale-reveal/1`, `root` is a 32-byte byte string equal to the `root` of `G`, and
`sale_secret` is a 32-byte byte string whose SHA-256 equals `sale_commitment`. An inscription whose
body is the bare secret is not a sale reveal. It sets no condition on the content type or the body.

Unsold sale items are then transferred to `unsold_address`, a P2MR address used only for that.
The concrete address is not chosen in this revision. Before close, the issuer MUST commit it in
another inscription, field 5
`{ "schema": "pins-unsold-address/1", "root": bytes(32), "address": text }`,
where `address` is the bech32m text of a witness-v2 P2MR address. That inscription is the
commitment. It MUST exist before close and MUST NOT be replaced afterward. Reserve items already
in the creator's wallet are not part of this transfer.

The reference indexer does not read the `pins-unsold-address/1` commitment, and it does not compare
sale transactions with `order`. Both checks are left to the reader of the chain.

## 9. Authenticity rule

An inscription `I` is the authentic item `n` of collection `G` if and only if all hold:

1. `G` is a genesis inscription as in section 3, not `opaque`, with a well-formed `pins-collection/1`
   map;
2. `I` is confirmed after `G` in chain order (PINS-2 §4.1) and before the closing inscription of `G`,
   if one exists (section 7);
3. `I`'s reveal leaf starts with `<issuer> OP_CHECKSIGPQC`, `issuer` taken from `G`;
4. `I`'s `content_type` equals `item_type`, and `meta.name` is `name_prefix` + decimal `n` with
   `first ≤ n < first + supply`;
5. `leaf_n` computed from `I` (section 5.1) equals leaf `n` of `root` (via the leaf list or a Merkle
   proof);
6. `I` is not a `reinscription` and not `opaque`;
7. `I` is the first inscription in chain order satisfying 1–6 for this `n`.

Copies of the images inscribed by anyone else fail rule 3. Re-inscriptions of the same item by the
issuer fail rule 7. The closing inscription freezes the set.

The reference indexer checks rule 5 against the leaf list (section 6) only. This revision defines no
inscription that carries a Merkle proof.

## 10. Security considerations

- Loss of `K_iss` before the mint ends stops the mint; the two backups are therefore REQUIRED.
- Theft of `K_iss` before closing allows inscribing missing numbers only; rule 7 protects items
  already inscribed. Closing right after the last batch removes this window.
- `K_sale` compromise exposes unsold inventory, not provenance.
- The issuer knows `sale_secret` from mint. The reserve set is visible because those items sit in
  the creator's wallet. The sale order stays hidden from everyone else until the reveal, except the
  issuer, who can compute it once `H_seed` exists. The check in §8.5 makes a deviation visible after
  close. It cannot stop the issuer from buying items through other addresses. Buyers MUST be told.

## 11. Test vectors

| Vector | Content | Status |
|---|---|---|
| TV5-1 | Root for a 5-item toy collection (odd-level duplication) | TODO-spec |
| TV5-2 | Root of a caller-supplied item set, computed by §5.1 | not fixed in this document |
| TV5-3 | Forged copy signed by another key rejected | TODO-regtest |
| TV5-4 | Item inscribed after closing rejected | TODO-regtest |
| TV5-5 | Reserve set for the dummy seed in §8.3. Digest `a4c10796…6c193d`. Not the launch secret | `selectReserve` in `packages/protocol/reserve.mjs` |
| TV5-6 | Leaf of item 1 from TV4-1/TV4-2 hashes | TODO-spec |
| TV5-7 | Sale order of ids 1..5 with `sale_secret` 32×`0x11` and block hash 32×`0x22` is `1,3,4,5,2` | `saleOrder` in `packages/protocol/reserve.mjs` |

## 12. Copyright

This document is placed in the public domain under CC0-1.0.
