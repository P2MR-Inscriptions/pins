<!-- SPDX-License-Identifier: CC0-1.0 -->

# Test vectors

Language-independent checks for another implementation of PINS. Each file is JSON. The values were produced by the reference code of this repository, and `packages/protocol/vectors.test.ts` and `packages/protocol/vectors-chain.test.ts` recompute every file on each test run and fail on a difference. The Merkle files and the state hash are also checked there by a second reading of the rule that shares no code with the repository.

Bytes are lowercase hex. A case marked `error` or `valid: false` is a case the reader must refuse. Nothing here is a rule: the specifications in the folder above are the rules, and a vector is an example of one. The regtest runs are in [regtest/runs.json](regtest/runs.json). A file in this folder is a check of the reference code against a rule. A file in `regtest/` is a record of runs on a private regtest node.

| File | What it checks | Specification |
|---|---|---|
| `merkle-leaf.json` | the leaf of one item, from its number, body and metadata, with the two digests and the 68-byte preimage; a number outside 0 to 4294967295 | PINS-5 §5.1 |
| `merkle-root.json` | the root of 1 to 9, 16 and 17 leaves, every level, the duplicated last node, and the empty list | PINS-5 §5.1 |
| `merkle-proof.json` | proofs for every position of trees of 1, 2, 3, 4, 5, 7 and 9 leaves, and proofs that must be refused (wrong root, wrong leaf, wrong sibling, wrong depth, a position at or after the count) | PINS-5 §5.1 |
| `leaf-list.json` | the root of a leaf list body, and the lengths that have none | PINS-5 §6 |
| `cbor.json` | the field 5 reader: values it accepts, and the encodings it must refuse (non-shortest integers, indefinite lengths, tags, floats, `undefined`, non-text keys, bad UTF-8, depth 33, trailing bytes) | PINS-4 §2.1 |
| `metadata.json` | the canonical CBOR of an item's metadata, and records that are refused | PINS-4 §2 |
| `genesis.json` | the encoding of a genesis field 5, and field 5 maps that are, or are not, taken as the genesis of a collection | PINS-5 §3 |
| `genesis-example.json` | the real genesis of the public example collection, read from mainnet, and its re-encoding | PINS-5 §3 |
| `envelope.json` | reveal leaf scripts and what a reader finds in them: fields, body, flags, chunk boundaries at 520 and 521 bytes, field 5 of 600, 1040 and 1041 bytes written as a repeated tag and chunk, three envelopes in one leaf, and scripts with no envelope | PINS-1 §4 |
| `reserve.json` | reserve ranks, a reserve selection, the sale seed and the sale order, with test seeds | PINS-5 §8 |
| `ownership.json` | TV3-1 to TV3-5: five synthetic chains (a transfer, a split and a merge, fee and coinbase and a lost tail, a burn, an unbound reveal), the exact blocks, the table after the last block, the state hash after each block | PINS-3 §10 |
| `numbering.json` | TV2-3: numbering over inputs and transactions, pointers, the flags, fees to the coinbase, lost, burned, PayToAnchor, unbound, a same-block spend | PINS-2 §6 |
| `chain.json` | TV2-2: a reorganisation of depth 2, step by step; TV2-4: a P2MR spend with no witness item | PINS-2 §6 |
| `state-hash.json` | the preimage and the hash of one P2MR Inscription for each shape of field 1 (none, plain, space, LF, `%`, the text `%0a`, bytes that are not UTF-8, empty), the empty state, the chain of TV2-3, and the mainnet checkpoint | PINS-2 §4.4 |
| `authenticity.json` | TV5-2, TV5-3, TV5-4, TV4-3: the root of an item set; a forged copy; an item after the closing; metadata with keys reordered | PINS-5 §9, PINS-4 §7 |
| `png.json` | TV4-2: a 24×24 image, its canonical PNG, the hash of the inflated scanlines and of the file | PINS-4 §5.1 |
| `trade.json` | TV6-2: where the P2MR Inscription lands in the compact template (§4.2) and in the clean template (§4.1) | PINS-6 §4 |
| `regtest/runs.json` | the runs on a regtest node: 24 reveal transactions (TV1-1 to TV1-7, Q7, Q13) with the node result and what the indexer found, the reorganisation of TV2-2, the trade of TV6-1 and the listing of TV6-3. `packages/indexer/regtest-runs.test.ts` replays the reveal transactions offline | PINS-1 §11, PINS-2 §6, PINS-6 §9 |

The leaves of the Merkle files are SHA-256 of the text `leaf <index>`. The public key of the envelope scripts is 32 bytes of `0x02`. The example collection appears only through public chain data (ids, root, issuer key, height, field 5). No art and no private value is in this folder.

Not covered here: signatures and signing plans (they belong to the tools, not to the specifications), and the PSBT of a trade (it is in the regtest record).

The synthetic chains use filler output scripts (`OP_2` and 32 repeated bytes), a mainnet subsidy of 21,000,000,000 bits and ids derived from the SHA-256 of a label. `regtest/runs.json` is not produced by `scripts/vectors.ts`: it is the record of runs that were made once on a node, and the test only reads it.

## Regenerate

```bash
node --experimental-strip-types scripts/vectors.ts --write   # rewrite the files
node --experimental-strip-types scripts/vectors.ts           # check them, no output when equal
```
