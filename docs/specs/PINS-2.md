<!-- SPDX-License-Identifier: CC0-1.0 -->
# PINS-2: Indexing

| Field | Value |
|---|---|
| Standard | PINS-2 |
| Title | Indexing |
| Version | 1.0.0. Mainnet `ACTIVATION_HEIGHT` is 161948. |
| Type | Protocol, normative |
| License | CC0-1.0 |
| Requires | PINS-1, PINS-3 |

> Independent protocol, not affiliated with Qbit or Qbit-Org. Conventions, key words and the list of
> verified Qbit revisions are those of PINS-1 §2.

## 1. Abstract

PINS-2 defines what an indexer must store and compute so that two independent implementations,
given the same chain, produce the same P2MR Inscription numbers, the same locations and the same owners.
Part A covers P2MR Inscription numbering, activation and reorgs. Part B defines an OPTIONAL bit-numbering
overlay derived exactly from Qbit's subsidy schedule.

## 2. Data requirements

The items are numbered; "PINS-2 §2 item 2" is the witness rule.

1. An indexer MUST process every block from the activation height (section 3) to the tip, with full
   witness data.
2. Qbit Core offers opt-in witness pruning: `-prunewitnesses` (default `0`) discards witnesses of
   blocks deeper than the coinbase maturity (1,000 blocks) and cannot be combined with `-txindex`
   (`src/init.cpp:492,1000-1001`). An indexer's node MUST NOT run with `-prunewitnesses=1`. An indexer
   MUST NOT treat a block whose witnesses are missing as having no P2MR Inscriptions; it MUST stop and
   report the gap. A spend of a P2MR output always carries a leaf script and a control block, so an
   input that spends one with no witness items is such a gap.
3. An indexer MAY use `-txindex`; it is not required by this standard.
4. Indexers SHOULD expose the activation height, the last indexed block hash and the PINS standard
   versions they implement.

## 3. Activation height

- `ACTIVATION_HEIGHT` (mainnet) is the height of the block that contains P2MR Inscription number 0. It is
  fixed in this document and does not change afterwards.
  Value: **161948**, the block containing the first `pins` envelope on mainnet.
- Envelopes in blocks below `ACTIVATION_HEIGHT` are not P2MR Inscriptions (PINS-1 §7.1). This prevents
  anyone from claiming low numbers before the protocol is published.
- When every block from an earlier start up to but not including this height contains no `pins`
  envelope, that earlier start and a start at 161948 produce the same P2MR Inscriptions, numbers, and
  owners. The constant remains 161948, because that is the block that contains P2MR Inscription number 0.
- Test networks: the activation height of testnet4 and of regtest is 0. A regtest or testnet4
  indexer starts at the first block. The scan of 2026-11-04 found no `pins` envelope on testnet4
  through height 201,912 (`collision-check.md`), so a start at 0 and a later start agree up to
  there.
- **Blocks 160,951 to 161,947.** The scan of 2026-11-15 covers the 997 blocks between the end of
  the first mainnet scan and the activation height. It found no envelope of any marker in them: 803
  blocks with more than one transaction, 40,527 transactions, 0 envelopes
  (`collision-check.md` §4). Together with the first scan (heights 0 to 160,950), no `pins` envelope
  exists on mainnet below 161,948. An indexer that starts at 161,948 and one that starts at any
  lower height give the same P2MR Inscriptions, numbers and owners.
- The mainnet check of 2026-11-04 found no `pins` envelope through height 160,950 (see
  `collision-check.md`).

## 4. Part A: P2MR Inscription numbering

### 4.1 Order

Every P2MR Inscription (PINS-1 §7.2, all flags included) gets the next number in a single sequence that
starts at 0. Order is:

1. block height, ascending;
2. transaction position in the block, ascending;
3. envelope index `n` in the transaction (PINS-1 §6.1), ascending.

Numbers are assigned only to P2MR Inscriptions in blocks of the active chain. Mempool P2MR Inscriptions have
no number.

### 4.2 Event log

For each block an indexer SHOULD record an ordered list of events, so that rollback and audit are
simple:

| Event | Fields |
|---|---|
| `inscribed` | P2MR Inscription ID, number, initial location or `unbound`, flags |
| `transferred` | P2MR Inscription ID, old location, new location (or `fee` / `burned` / `lost`) |

### 4.3 Reorgs

1. On a reorg, the indexer MUST undo the events of every disconnected block in reverse order and
   then apply the blocks of the new branch. Numbers freed by the undo are reused by the new branch.
2. An indexer MUST keep undo data for at least the deepest reorg it is willing to follow. It SHOULD
   keep at least 1,000 blocks (one coinbase maturity).
3. Applications MUST NOT present a sale, transfer or P2MR Inscription as final before it has
   `CONFIRMATIONS_FINAL` confirmations. Recommended value: 6 (Qbit targets 60-second blocks,
   `src/kernel/chainparams.cpp:152-154`). A marketplace that adopts that value treats a sale as final after 6
   confirmations.

### 4.4 State hash

The state hash of a tip is the SHA-256 digest of one byte string, written as 64 lowercase hex
characters. Two indexers that have processed the same chain to the same tip MUST give the same
state hash. It covers the tip block and every P2MR Inscription, and nothing else. It is not chained:
the hash of a block does not depend on the hash of the previous one, so an indexer that starts at the
activation height and one that replays from an earlier block give the same value at the same tip.

**Preimage.** The preimage is a list of lines joined by one LF (`0x0a`), with no LF after the last
line and no byte-order mark. The first line is

```
block <height> <hash>
```

with `height` the decimal height of the tip and `hash` the block hash of the tip as the node
displays it (64 lowercase hex characters). Then comes one line for each P2MR Inscription that has a
number at the tip (every one, with every flag), in ascending order of number:

```
<number> <id> <body_sha256> <content_type> <place> <owner> <location_height> <flags>
```

The fields are separated by one space (`0x20`). Fields 1, 2, 3 and 5 to 8 contain no space and no LF.

| Field | Value |
|---|---|
| `number` | the number of PINS-2 §4.1, decimal, no sign, no leading zero |
| `id` | the ID of PINS-1 §6.1, `<txid>i<n>` |
| `body_sha256` | SHA-256 of the body (PINS-1 §8, all body pushes concatenated), 64 lowercase hex characters. The digest of the empty string when the body is empty |
| `content_type` | the bytes of the value of field 1, see below |
| `place` | `<txid>:<vout>:<offset>`, the bitpoint of PINS-3 §2 with decimal numbers, when the P2MR Inscription has a location; otherwise one of the words `unbound`, `burned`, `lost` (PINS-3 §2) |
| `owner` | the owner of PINS-3 §2: for an output script `OP_2 <32 bytes>`, its bech32m address of witness version 2 with the human-readable part of the network (`qb` on mainnet); for an `OP_RETURN` script, the empty string; for every other script, `script:` and the script as lowercase hex. The empty string when the place is `unbound`, `burned` or `lost` |
| `location_height` | decimal height of the block whose transaction (or coinbase) last placed the P2MR Inscription: its reveal block, or the block of the latest transfer, including the one that burned it or lost it. For an `unbound` one, the reveal block |
| `flags` | the flags of PINS-1 §7.2 that the P2MR Inscription carries, sorted by byte value of their names, joined by `,`. A flag that was set twice is written twice. The empty string when there is none. `unbound` is a place, not a flag: it is never in this list |

At a tip every P2MR Inscription is located, `unbound`, `burned` or `lost`: a bit that became fee is
placed by the coinbase of its own block (PINS-3 §6).

**Field 1 (`content_type`).** Field 1 is raw bytes in the envelope (PINS-1 §5.1.1): it can hold spaces,
LF or bytes that are not UTF-8, and every such value is a P2MR Inscription. In the preimage the
value is the bytes of the first field 1 value of the envelope (the first one, when the field
repeats), with two escapes and no others: the byte `0x0a` is written as the three bytes `%0a`
(`0x25 0x30 0x61`) and the byte `0x25` as the three bytes `%25` (`0x25 0x32 0x35`). Every other
byte, including a space, is copied as it is. A missing field 1 and an empty one both give the empty
string. There is no length prefix. The escape keeps a value from adding a line, and the line can be
split without ambiguity: the first three and the last four fields contain no space, so the first
three spaces and the last four spaces of a line delimit the content type.

**Check.** `vectors/state-hash.json` gives the preimage and the hash of one P2MR Inscription for a
missing field 1, a plain type, a type with a space, with LF, with `%`, with the text `%0a`, with bytes
that are not UTF-8, and an empty one; the hash of an empty state; and the hash of the numbering chain
of TV2-3. The reference indexer replayed from block 161,948 to block 171,486 of mainnet gives
`2d8255401cc9bace5eeba394b83eb38865ec6713b8d2a8578009b77b76424112`, with 10,002 P2MR Inscriptions
(10,000 authentic items of the public example, PINS-5 §6.2), and a second, independent evaluation
of this section on the same rows gives the same value.

## 5. Part B: bit-numbering overlay (OPTIONAL)

Ownership (PINS-3) does not depend on the bit numbers of this overlay. It does depend on the subsidy
of section 5.1, which sets where the fee bits sit in the coinbase (PINS-3 §6), so every indexer MUST
use that schedule. An indexer that implements the numbering MUST follow this section exactly, so that
every implementation gives each bit the same number.

### 5.1 Subsidy

The subsidy of height `h` is computed exactly as Qbit Core's `GetBlockSubsidy`
(`src/validation.cpp:1963-1982`) with mainnet parameters (`src/kernel/chainparams.cpp:132-135`):

```
INITIAL   = 21,000,000,000 bits (210 QBT)
INTERVAL  = 43,200 blocks
NUM, DEN  = 598, 625

subsidy(h):
    s = INITIAL
    repeat floor(h / INTERVAL) times, while s > 0:
        s = (s / DEN) * NUM + ((s % DEN) * NUM) / DEN      # integer division
    return s
```

Testnet4 has the same parameters (`src/kernel/chainparams.cpp:334-337`). Regtest has `INTERVAL = 150`
and the same `NUM` and `DEN` (`src/kernel/chainparams.cpp:546-548`). The reference indexer reads the subsidy from this schedule
and never from the coinbase.

There is no halving: the subsidy steps down by the factor 598/625 every 43,200 blocks (about 30
days). It reaches 0 after 480 stepdowns; the last subsidized height is 20,735,999.

### 5.2 Numbering

- `first(h) = Σ subsidy(k)` for `0 ≤ k < h`. Block `h` issues the bit numbers
  `[first(h), first(h) + subsidy(h))`.
- Genesis (`h = 0`) issues `[0, 21,000,000,000)`. Its coinbase is never connected to the UTXO set
  (`src/validation.cpp:2689-2691`; `src/kernel/chainparams.cpp:102-111,199`), so these bits exist but can
  never move.
- The last bit number is `20,999,999,761,876,799`; the total, genesis included, is
  `20,999,999,761,876,800` bits, which fits in an unsigned 64-bit integer.
- Implementations MUST use 64-bit unsigned (or wider) integers.

### 5.3 Flow

Bit ranges flow by the same first-in-first-out rule as PINS-3 §3:

- non-coinbase transaction: input ranges are concatenated in input order and assigned to outputs in
  output order by value; the remainder is the transaction's fee ranges;
- coinbase: the input space is the newly issued range followed by the fee ranges of the block's
  transactions in block order; it is assigned to the coinbase outputs in order. Ranges left over are
  **lost** (numbered, never movable);
- bits assigned to an `OP_RETURN` output are **burned**.

### 5.4 Notation

- Primary notation: the decimal bit number.
- OPTIONAL "stepdown notation" `E.B.O`: stepdown epoch `E = floor(h / 43,200)`, block within the
  epoch `B = h mod 43,200`, offset `O` inside the block's issued range.
- Rarity schemes based on halvings or difficulty periods do not apply to Qbit (monthly stepdowns,
  ASERT difficulty, two mining lanes) and are not part of PINS.

### 5.5 Consistency with ownership

For any P2MR Inscription, the bit number of its location computed by this overlay MUST be consistent with
the bitpoint location of PINS-3: the bitpoint `(outpoint, offset)` maps to exactly one bit number.

## 6. Test vectors

| Vector | Content | Result |
|---|---|---|
| TV2-1 | `subsidy(h)` for h = 0, 43,199, 43,200, 160,950, 20,735,999, 20,736,000 | computed: 21,000,000,000; 21,000,000,000; 20,092,800,000; 18,394,280,067 (matches the mainnet explorer reward of block 160,950); 1; 0 |
| TV2-2 | Numbering across a reorganisation of depth 2 with P2MR Inscriptions in both branches | `vectors/chain.json`: the two disconnected blocks restore the earlier state hash, the numbers of the old branch are reused by the new one, and the state hash equals that of a fresh run. Regtest, `vectors/regtest/runs.json`: the same on a real node, with the state hash of every step |
| TV2-3 | Synthetic chain covering numbering over inputs and transactions, pointers, fees to coinbase, lost bits, `OP_RETURN`, PayToAnchor, unbound, `opaque`, `duplicate_field`, `bad_pointer`, `reinscription`, a same-block spend | `vectors/numbering.json`: 17 P2MR Inscriptions in five blocks, the table after the last block and the state hash after each block |
| TV2-4 | A P2MR spend with no witness item: the indexer stops and reports the gap | `vectors/chain.json`: the block is refused with `witness pruned: transaction <txid> spends P2MR without a witness` and the state does not change |

### 6.1 Verification of TV2-4

TV2-4 is a block fed to the rules engine: a node started with `-prunewitnesses=1` discards a
witness only once its block is more than 1,000 blocks deep, so the vector carries the block as the
indexer would receive it, with the witness of the P2MR spend removed. The rule it tests is the one of
§2 item 2, and it does not depend on how the witness was lost.

## 7. Copyright

This document is placed in the public domain under CC0-1.0.
