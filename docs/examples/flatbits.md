<!-- SPDX-License-Identifier: Apache-2.0 -->

# Worked example: FlatBits on mainnet

FlatBits is the first collection inscribed with PINS on Qbit mainnet. This page records it as a public example of the protocol, for two uses: **verify the example** (check on the public chain that the protocol gives the results recorded here), and **apply the same steps to your own collection**. The protocol, the inscriber, the indexer, and the explorer have no default collection, and nothing here is read by them.

## What this page holds, and what it does not

Everything below is public chain data: ids, heights, the Merkle root, the issuer public key, and what an indexer reports. This page and this repository hold no art, no key, no seed, no sale price, no reserve groups, no collection profile, no zip, no plan, and no leaf data beyond what is on chain. Nothing in the repository can rebuild FlatBits, re-inscribe it, or change it, and nothing here is meant to. The sale length and price are terms of that collection. They are not rules of the protocol and are not recorded here.

## A copy can never be authentic

FlatBits is identified by its genesis P2MR Inscription and its issuer key, not by its images. A P2MR Inscription is an authentic item of a collection only if it satisfies every rule of [PINS-5 §9](../specs/PINS-5.md), and three of them close the door on copies:

- It must be confirmed after the collection's genesis (rule 2).
- Its reveal leaf must start with the issuer key written in that genesis (rule 3). Someone who inscribes the same image bytes uses another key, so the copy is not an item of FlatBits.
- Only the first P2MR Inscription that meets the rules for a given number counts (rule 7). A later P2MR Inscription of an item that is already taken, by anyone, does not change which one is authentic.

All 10,000 numbers of FlatBits are taken by their original P2MR Inscriptions (see the table below), so re-inscribing the same data neither creates nor changes FlatBits. A person who inscribes copies publishes, at most, a different collection with a different genesis id and a different issuer key. The example is here to show how to verify a collection, not to supply one.

## What is on chain

| Item | Value |
|---|---|
| Genesis P2MR Inscription | `15d6f9c48865b579f7d1144e4d2d71d905c6fe04458bebc814052a3e39a07784i0` |
| Leaf list P2MR Inscription | `15d6f9c48865b579f7d1144e4d2d71d905c6fe04458bebc814052a3e39a07784i1` |
| Merkle root | `70768608a21dec18f611a643ed1f519a19df4a0eca35c65a62588d383dcaf7b2` |
| Issuer key | `569bdca31b68cab9cf1580abd42829ef042d43e3641d85361f6ad5e4db2799db` |
| Supply | 10,000 items, numbered from 1 |
| Item type | `image/png` |
| Fan-out transaction | block 161947 |
| Genesis reveal | block 161948 |
| 16 item reveals of 625 items | blocks 161949 to 161971 |

Sizes and fees of those transactions are in [PINS-5 §6.2](../specs/PINS-5.md).

The genesis field 5 is the CBOR map of PINS-5 §3. Its keys, in order, with the values read from the genesis P2MR Inscription:

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

An indexer of this repository that follows mainnet from block 161946 reports this result at these tips, and the same result every time on the same blocks:

| Tip height | `stateHash` |
|---|---|
| 161976 | `fb24a659…c167` |
| 161980 | `c67f15b9…6c4d` |
| 171486 | `2d8255401cc9bace5eeba394b83eb38865ec6713b8d2a8578009b77b76424112` |

At height 171486:

| Field | Value |
|---|---|
| P2MR Inscriptions | 10,002 (the genesis, the leaf list, and the 10,000 items) |
| Authentic items | 10,000 |
| `/collection` `status` | `present` |
| `/collection` `supply` | 10000 |
| `/collection` `root` | the Merkle root above |

`stateHash` is the value `/status` returns for the tip (see [docs/indexer/API.md](../indexer/API.md)). Two indexers that agree on the chain agree on it.

## Verify the example

You need a synced Qbit mainnet node run with `-txindex` and not pruned (see the README). Index the public chain and compare the results with this page:

```text
npm run indexer:serve -- \
  --db flatbits-check.sqlite \
  --rpc http://127.0.0.1:RPC_PORT/ \
  --network mainnet --confirm-network mainnet \
  --activation 161946 \
  --genesis 15d6f9c48865b579f7d1144e4d2d71d905c6fe04458bebc814052a3e39a07784i0
```

Give the RPC credentials as `QBIT_RPC_USER` and `QBIT_RPC_PASSWORD` in the environment, as the README describes. Then:

1. `/inscription/15d6f9c4…7784i0` and `/inscription/15d6f9c4…7784i1` are the genesis and the leaf list of the table above. Both are in the genesis reveal, block 161948.
2. `/collection` has `status` `present`, `supply` 10000, and `root` equal to the Merkle root of the table, and `issuer` equal to the issuer key. Its `authentic` count is 10,000. Later blocks cannot change that count: every number is already taken, and the first valid P2MR Inscription of a number is the only one that counts.
3. The digest the indexer stored for a block is in the `blocks` table of the database. `SELECT state_hash FROM blocks WHERE height = 171486` gives the digest recorded below. `/status` shows only the tip, and a tip above 171486 has another digest, because the digest includes the tip block (see [what `stateHash` covers](../indexer/API.md#state-hash)).
4. The 10,000 items are not on this page. Each is on chain, and `/pieces` lists them with their `authentic` flag.

If a value differs, one of the two sides is wrong, and the chain is the authority. The same steps work for any collection: replace the genesis id and compare with the values its issuer publishes.

## Apply the same steps to your own collection

The mint of FlatBits used a batch size of 625 and a supply of 10,000. In the tools both come from your profile (`supply`, `batchSize`). A collection of another size, for example 100 items in batches of 25, or one item, goes through the same `plan`, `sign`, and indexer path. You bring your own images, your own profile, your own issuer key, and your own addresses. None of these comes from FlatBits.

- To launch a collection, follow [COLLECTION-LAUNCH.md](../guides/COLLECTION-LAUNCH.md). Try it on regtest first.
- To feature your collection in the explorer, point `MANIFEST` at your own file, shaped like [`explorer/config/examples/flatbits.json`](../../explorer/config/examples/flatbits.json). That file is only the public data of this example: name, supply, genesis id, Merkle root, item type, and image size.
- To check your own collection the way this page checks FlatBits, record the same public values after the mint: genesis id, leaf list id, Merkle root, issuer key, heights, and the indexer result.
