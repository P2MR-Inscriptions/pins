<!-- SPDX-License-Identifier: Apache-2.0 -->

# Worked example: FlatBits on mainnet

FlatBits is the first collection inscribed with PINS on Qbit mainnet. This page records it as a public example of the protocol: what is on chain, and what an indexer reports for it. It is an example only. The protocol, the inscriber, the indexer, and the explorer have no default collection, and nothing here is read by them. This page holds no art, no key, no seed, and no sale price. The reserve groups are not listed.

## What is on chain

| Item | Value |
|---|---|
| Genesis inscription | `15d6f9c48865b579f7d1144e4d2d71d905c6fe04458bebc814052a3e39a07784i0` |
| Leaf list inscription | `15d6f9c48865b579f7d1144e4d2d71d905c6fe04458bebc814052a3e39a07784i1` |
| Merkle root | `70768608a21dec18f611a643ed1f519a19df4a0eca35c65a62588d383dcaf7b2` |
| Issuer key | `569bdca31b68cab9cf1580abd42829ef042d43e3641d85361f6ad5e4db2799db` |
| Supply | 10,000 items, numbered from 1 |
| Item type | `image/png` |
| Fan-out transaction | block 161947 |
| Genesis reveal | block 161948 |
| 16 item reveals of 625 items | blocks 161949 to 161971 |

Sizes and fees of those transactions are in [PINS-5 §6.2](../specs/PINS-5.md).

The genesis field 5 is the CBOR map of PINS-5 §3. Its keys, in order, with the values read from the genesis inscription:

```json
{
  "schema": "pins-collection/1",
  "name": "Flatbits",
  "supply": 10000,
  "first": 1,
  "name_prefix": "Flatbit#",
  "root": "70768608a21dec18f611a643ed1f519a19df4a0eca35c65a62588d383dcaf7b2",
  "issuer": "569bdca31b68cab9cf1580abd42829ef042d43e3641d85361f6ad5e4db2799db",
  "item_type": "image/png",
  "sale_commitment": "7e4a8a5a4782633d851e3de7cf06f096e6e6802ac68e34a9cfd816e624bcc8b6"
}
```

## What an indexer reports

An indexer of this repository that follows mainnet from block 161946 reports this result, and the same result every time on the same blocks:

| Tip height | `stateHash` |
|---|---|
| 161976 | `fb24a659…c167` |
| 161980 | `c67f15b9…6c4d` |
| 171486 | `2d8255401cc9bace5eeba394b83eb38865ec6713b8d2a8578009b77b76424112` |

At height 171486:

| Field | Value |
|---|---|
| Inscriptions | 10,002 (the genesis, the leaf list, and the 10,000 items) |
| Authentic items | 10,000 |
| `/collection` `status` | `present` |
| `/collection` `supply` | 10000 |
| `/collection` `root` | the Merkle root above |

`stateHash` is the value `/status` returns (see [docs/indexer/API.md](../indexer/API.md)). Two indexers that agree on the chain agree on it.

## The same collection in the tools

- The explorer ships its manifest as an example: [`explorer/config/examples/flatbits.json`](../../explorer/config/examples/flatbits.json). Point `MANIFEST` at it to feature this collection, or at your own file.
- The mint of this collection used a batch size of 625 and a supply of 10,000. In the tools both come from the profile (`supply`, `batchSize`). A collection of another size, for example 100 items in batches of 25, goes through the same `plan`, `sign`, and indexer path.
- To launch a different collection, follow [COLLECTION-LAUNCH.md](../guides/COLLECTION-LAUNCH.md).
