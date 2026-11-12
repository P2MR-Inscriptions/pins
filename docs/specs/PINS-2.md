<!-- SPDX-License-Identifier: CC0-1.0 -->
# PINS-2: Indexing

| Field | Value |
|---|---|
| Standard | PINS-2 |
| Title | Indexing |
| Status | Mainnet `ACTIVATION_HEIGHT` is 161948. TV2-2, TV2-3, and TV2-4 are open. |
| Type | Protocol, normative |
| License | CC0-1.0 |
| Requires | PINS-1, PINS-3 |

> Independent protocol, not affiliated with Qbit or Qbit-Org. Conventions, key words and the list of
> verified Qbit revisions are those of PINS-1 §2.

## 1. Abstract

PINS-2 defines what an indexer must store and compute so that two independent implementations,
given the same chain, produce the same inscription numbers, the same locations and the same owners.
Part A covers inscription numbering, activation and reorgs. Part B defines an OPTIONAL bit-numbering
overlay derived exactly from Qbit's subsidy schedule.

## 2. Data requirements

1. An indexer MUST process every block from the activation height (section 3) to the tip, with full
   witness data.
2. Qbit Core offers opt-in witness pruning: `-prunewitnesses` (default `0`) discards witnesses of
   blocks deeper than the coinbase maturity (1,000 blocks) and cannot be combined with `-txindex`
   (`src/init.cpp:492,991-992`). An indexer's node MUST NOT run with `-prunewitnesses=1`. An indexer
   MUST NOT treat a block whose witnesses are missing as having no inscriptions; it MUST stop and
   report the gap. A spend of a P2MR output always carries a leaf script and a control block, so an
   input that spends one with no witness items is such a gap.
3. An indexer MAY use `-txindex`; it is not required by this standard.
4. Indexers SHOULD expose the activation height, the last indexed block hash and the PINS standard
   versions they implement.

## 3. Activation height

- `ACTIVATION_HEIGHT` (mainnet) is the height of the block that contains inscription number 0. It is
  fixed in this document and does not change afterwards.
  Value: **161948**, the block containing the first `pins` envelope on mainnet.
- Envelopes in blocks below `ACTIVATION_HEIGHT` are not inscriptions (PINS-1 §7.1). This prevents
  anyone from claiming low numbers before the protocol is published.
- When every block from an earlier start up to but not including this height contains no `pins`
  envelope, that earlier start and a start at 161948 produce the same inscriptions, numbers, and
  owners. The constant remains 161948, because that is the block that contains inscription number 0.
- Test networks: testnet4 and regtest activation heights are separate constants. Regtest indexers
  SHOULD use height 0. This document does not set a testnet4 height.
- The chain scan done on 2026-11-04 found no `pins` envelope on mainnet through height 160,950, or
  on testnet4 through height 201,912 (see `collision-check.md`).

## 4. Part A: inscription numbering

### 4.1 Order

Every inscription (PINS-1 §7.2, all flags included) gets the next number in a single sequence that
starts at 0. Order is:

1. block height, ascending;
2. transaction position in the block, ascending;
3. envelope index `n` in the transaction (PINS-1 §6.1), ascending.

Numbers are assigned only to inscriptions in blocks of the active chain. Mempool inscriptions have
no number.

### 4.2 Event log

For each block an indexer SHOULD record an ordered list of events, so that rollback and audit are
simple:

| Event | Fields |
|---|---|
| `inscribed` | inscription ID, number, initial location or `unbound`, flags |
| `transferred` | inscription ID, old location, new location (or `fee` / `burned` / `lost`) |

### 4.3 Reorgs

1. On a reorg, the indexer MUST undo the events of every disconnected block in reverse order and
   then apply the blocks of the new branch. Numbers freed by the undo are reused by the new branch.
2. An indexer MUST keep undo data for at least the deepest reorg it is willing to follow. It SHOULD
   keep at least 1,000 blocks (one coinbase maturity).
3. Applications MUST NOT present a sale, transfer or inscription as final before it has
   `CONFIRMATIONS_FINAL` confirmations. Recommended value: 6 (Qbit targets 60-second blocks,
   `src/kernel/chainparams.cpp:152-154`). A marketplace that adopts that value treats a sale as final after 6
   confirmations.

### 4.4 Determinism checks

Two independent implementations MUST produce byte-identical outputs for the reference export
(inscription ID, number, height, location, flags) on the shared test chain (TODO-regtest, README
Q11).

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

- `first(h) = Σ subsidy(k)` for `0 ≤ k < h`. Block `h` mints the bit numbers
  `[first(h), first(h) + subsidy(h))`.
- Genesis (`h = 0`) mints `[0, 21,000,000,000)`. Its coinbase is never connected to the UTXO set
  (`src/validation.cpp:2688-2690`; `src/kernel/chainparams.cpp:102-111,199`), so these bits exist but can
  never move.
- The last bit number is `20,999,999,761,876,799`; the total, genesis included, is
  `20,999,999,761,876,800` bits, which fits in an unsigned 64-bit integer.
- Implementations MUST use 64-bit unsigned (or wider) integers.

### 5.3 Flow

Bit ranges flow by the same first-in-first-out rule as PINS-3 §3:

- non-coinbase transaction: input ranges are concatenated in input order and assigned to outputs in
  output order by value; the remainder is the transaction's fee ranges;
- coinbase: the input space is the newly minted range followed by the fee ranges of the block's
  transactions in block order; it is assigned to the coinbase outputs in order. Ranges left over are
  **lost** (numbered, never movable);
- bits assigned to an `OP_RETURN` output are **burned**.

### 5.4 Notation

- Primary notation: the decimal bit number.
- OPTIONAL "stepdown notation" `E.B.O`: stepdown epoch `E = floor(h / 43,200)`, block within the
  epoch `B = h mod 43,200`, offset `O` inside the block's minted range.
- Rarity schemes based on halvings or difficulty periods do not apply to Qbit (monthly stepdowns,
  ASERT difficulty, two mining lanes) and are not part of PINS.

### 5.5 Consistency with ownership

For any inscription, the bit number of its location computed by this overlay MUST be consistent with
the bitpoint location of PINS-3: the bitpoint `(outpoint, offset)` maps to exactly one bit number.

## 6. Test vectors

| Vector | Content | Status |
|---|---|---|
| TV2-1 | `subsidy(h)` for h = 0, 43,199, 43,200, 160,950, 20,735,999, 20,736,000 | computed: 21,000,000,000; 21,000,000,000; 20,092,800,000; 18,394,280,067 (matches the mainnet explorer reward of block 160,950); 1; 0 |
| TV2-2 | Numbering across a reorg of depth 2 with inscriptions in both branches | TODO-regtest |
| TV2-3 | Synthetic chain covering fees to coinbase, lost bits, `OP_RETURN`, unbound, opaque, duplicates, bad pointer | TODO-regtest |
| TV2-4 | Indexer with a `-prunewitnesses` node stops and reports the gap | TODO-regtest |

TV2-1 is computed. TV2-2, TV2-3, and TV2-4 are open. They stay TODO-regtest until they are produced on a private regtest node.

## 7. Copyright

This document is placed in the public domain under CC0-1.0.
