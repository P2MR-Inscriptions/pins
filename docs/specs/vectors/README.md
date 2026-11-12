<!-- SPDX-License-Identifier: CC0-1.0 -->

# Test vectors

Language-independent checks for another implementation of PINS. Each file is JSON. The values were produced by the reference code of this repository, and `packages/protocol/vectors.test.ts` recomputes every file on each test run and fails on a difference. The Merkle files are also checked there by a second reading of PINS-5 §5.1 that shares no code with the repository.

Bytes are lowercase hex. A case marked `error` or `valid: false` is a case the reader must refuse. Nothing here is a rule: the specifications in the folder above are the rules, and a vector is an example of one.

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

The leaves of the Merkle files are SHA-256 of the text `leaf <index>`. The public key of the envelope scripts is 32 bytes of `0x02`. The example collection appears only through public chain data (ids, root, issuer key, height, field 5). No art and no private value is in this folder.

Not covered here: signatures and signing plans (they belong to the tools, not to the specifications), PSBT trades, and the canonical PNG encoder, whose output depends on the zlib build.

## Regenerate

```bash
node --experimental-strip-types scripts/vectors.ts --write   # rewrite the files
node --experimental-strip-types scripts/vectors.ts           # check them, no output when equal
```
