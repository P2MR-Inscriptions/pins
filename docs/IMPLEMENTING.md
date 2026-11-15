<!-- SPDX-License-Identifier: Apache-2.0 -->

# Implementing PINS independently

You can write your own indexer, inscriber, marketplace or explorer without this repository's code and without asking anyone. The standards in [docs/specs](specs/README.md) are CC0-1.0, the vectors in [docs/specs/vectors](specs/vectors/README.md) are language-independent, and the mainnet replay gives a result you can compare with. This page says what to build, in what order, and how to know you got it right.

## What you can implement

| You build | You implement | Optional |
|---|---|---|
| **A reader or indexer** | PINS-1 (reading), PINS-2, PINS-3 | PINS-4 (field 5), PINS-5 (collections), PINS-2 part B (bit numbering) |
| **A writer or inscriber** | PINS-1 §9 (writer rules), and PINS-4 and PINS-5 for items and collections | |
| **A marketplace** | PINS-6, and the reader of PINS-1 to PINS-3 to know what each output holds | |

State which version of each standard you implement. An indexer says so in its status (PINS-2 §2 item 4), as `/status` of the reference indexer does with `standards`.

## The order that works

1. **Read the chain.** You need every block from the activation height with full witness data. A node run with `-prunewitnesses=1` cannot be used, and a block with missing witnesses is a gap you stop at, not a block with no P2MR Inscriptions (PINS-2 §2). Mainnet's activation height is 161,948. Regtest and testnet4 start at 0.
2. **Find the envelopes** (PINS-1 §4). Scan the revealed leaf scripts of P2MR spends. Check your reader against [`envelope.json`](specs/vectors/envelope.json): fields, chunk boundaries at 520 and 521 bytes, several envelopes in one leaf, and scripts with none.
3. **Number and place** (PINS-2 §4.1, PINS-3). Number the P2MR Inscriptions by block height, transaction position and envelope index (PINS-2 §4.1). Bind each to its bit, move it first in first out, and handle fees, the coinbase, burns, unbound and lost P2MR Inscriptions. Check against [`numbering.json`](specs/vectors/numbering.json) and [`ownership.json`](specs/vectors/ownership.json), which carry the state after every block.
4. **Undo blocks** (PINS-2 §4.3). Keep undo data for the deepest reorganisation you will follow, at least 1,000 blocks if you can. Check against [`chain.json`](specs/vectors/chain.json): a reorganisation of depth 2, step by step, and a block whose P2MR spend has no witness.
5. **Compute the state hash** (PINS-2 §4.4). It is the one number that two indexers compare. Check the preimage and digest against [`state-hash.json`](specs/vectors/state-hash.json).
6. **Collections, if you want them.** The reader of field 5 ([`cbor.json`](specs/vectors/cbor.json), [`metadata.json`](specs/vectors/metadata.json)), the genesis ([`genesis.json`](specs/vectors/genesis.json)), the Merkle leaf, root and proof ([`merkle-*.json`](specs/vectors/README.md)), authenticity ([`authenticity.json`](specs/vectors/authenticity.json)), and the reserve and sale order ([`reserve.json`](specs/vectors/reserve.json)).
7. **Replay mainnet.** Index the public chain from block 161,948 to block 171,486 and compare with [the Flatbits example](examples/flatbits.md): the `stateHash` of block 171,486 is `2d8255401cc9bace5eeba394b83eb38865ec6713b8d2a8578009b77b76424112`, with 10,002 P2MR Inscriptions, 10,000 of them authentic items. If you also match the two earlier tips of that page, you agree with the reference at every step they cover.

An implementation that passes the vectors and the replay agrees with every other one on every number, location and owner.

## Rules that are easy to get wrong

- **Never place or number from anything but the rules.** The only field that changes where a P2MR Inscription lands is `pointer` (PINS-1 §5.5). Do not add a field that does.
- **Unknown tags.** An unknown odd tag is ignored. An unknown even tag makes the P2MR Inscription opaque: recognised, numbered and tracked, but not interpreted or rendered (PINS-1 §5.4).
- **Field values are raw bytes** (PINS-1 §5.1.1). The state hash writes a content type with `%0a` for a line feed and `%25` for `%`, so two readers that treat the bytes the same give the same line.
- **Finality is an application rule.** Do not show a sale, a transfer or a P2MR Inscription as final before 6 confirmations (`CONFIRMATIONS_FINAL`, PINS-2 §4.3).
- **The first valid wins.** For an item number and for a price, the first P2MR Inscription that meets the rules is the one that counts (PINS-5 §9, PINS-6 §5.1). A second one does not replace it.
- **A copy is never authentic.** Authenticity is bound to the original genesis and the issuer key (PINS-5 §9), not to the body.
- **Read output values from the transaction hex,** as the reference does, and not from JSON numbers.

## Comparing with the reference

The reference indexer ([packages/indexer](../packages/indexer/README.md)) stores the `stateHash` of every block it applied, in the `blocks` table (`height`, `hash`, `state_hash`). To find a difference, run both over the same blocks and compare the two lists of digests. The first height at which they differ is the first block your implementation reads differently, and the lines of the preimage at that height say which P2MR Inscription. The digest includes the tip, so compare digests at the same height only.

The digest does not cover metadata, authenticity, the reserve, the sale order or the price. To compare those, compare `/collection` and `/pieces` of the two indexers ([the API](indexer/API.md)).

## Writing, not only reading

A writer follows PINS-1 §9: the reveal leaf, the commit and reveal, batching and the size limits (a standard transaction is 400,000 weight). Build a P2MR Inscription, then read it back with an indexer that is not yours before you trust your writer. The [five-minute example](guides/QUICKSTART.md) does this with the reference tools on a private regtest node, and [regtest/runs.json](specs/vectors/regtest/runs.json) records transactions that a Qbit Core node accepted. Qbit Wallet has no code for PINS and can spend an output that holds a P2MR Inscription as plain value: do not use it to hold or move one.

## Extending PINS

Add a field with an odd tag, or a new standard, and old indexers still agree with you on every number and owner. Anything that changes a location, a number or an owner needs another marker and is another protocol (PINS-1 §5.5). A change to the rules of PINS-1 to PINS-6 goes through [the standards process](STANDARDS-PROCESS.md), and none of them can change what mainnet already shows.

## Reporting a difference

If your implementation and the reference disagree on a chain, the chain and the standard decide. Open an issue with the block height, the first digest that differs and the transaction. A real difference between the standard and the reference code is fixed in the code and recorded in [docs/specs/CHANGELOG.md](specs/CHANGELOG.md), or in the text of the standard, as [the standards process](STANDARDS-PROCESS.md) describes.
