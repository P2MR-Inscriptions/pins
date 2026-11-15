<!-- SPDX-License-Identifier: CC0-1.0 -->
# PINS-3: Transfer and Ownership

| Field | Value |
|---|---|
| Standard | PINS-3 |
| Title | Transfer and Ownership |
| Version | 1.0.0 |
| Type | Protocol, normative |
| License | CC0-1.0 |
| Requires | PINS-1 |

> Independent protocol, not affiliated with Qbit or Qbit-Org. Conventions and verified Qbit
> revisions: PINS-1 §2.

## 1. Abstract

Every P2MR Inscription is bound to exactly one bit, the **inscribed bit**. Ownership follows that bit
through ordinary Qbit transactions by a first-in-first-out (FIFO) rule. The owner is whoever controls
the output that currently holds the bit. This binding and the FIFO rule are mandatory for every
conforming indexer and wallet. No bit-number index is required (PINS-2 Part B is optional).

## 2. Definitions

- **Bitpoint**: `<txid>:<vout>:<offset>`, the position of one bit inside one output, `offset` being
  counted in bits from the start of the output's value (`0 ≤ offset < value`).
- **Location** of a P2MR Inscription: the bitpoint of its inscribed bit, or one of the terminal states
  `unbound`, `burned`, `lost`.
- **Owner**: the `scriptPubKey` (displayed as its `qb1…` address) of the output holding the location.
- **Input space** of a transaction: the concatenation, in input order, of the value ranges of its
  inputs. Input `i` covers `[S_i, S_i + value_i)` where `S_i` is the sum of the values of inputs
  `0..i-1`.
- **Output space**: likewise, in output order.

## 3. FIFO rule

For a non-coinbase transaction with input space size `I` and output space size `O` (`O ≤ I`):

- the bit at input-space offset `x` with `x < O` moves to the output `k` such that
  `T_k ≤ x < T_k + value_k` (`T_k` = sum of values of outputs `0..k-1`), at offset `x − T_k`;
- a bit with `O ≤ x < I` becomes part of the **fee**; its fee offset is `x − O`.

Zero-value outputs hold no bits and are skipped.

## 4. Initial binding (reveal)

For the envelope with index `n` located in input `i` of the reveal transaction:

1. If it has a valid `pointer` `p` (PINS-1 §5.2 and §7.2, `p < O`), the initial input-space offset
   is `x = p`. The pointer is an offset into the **output** space; since the first `O` bits of the
   input space map one-to-one onto the output space, `x = p` lands on output-space offset `p`.
2. Otherwise `x = S_i`, the first bit of input `i`.
3. If `x ≥ I` (possible only when input `i` and every later input have zero value), the P2MR Inscription
   is `unbound`: it is numbered but has no location and no owner, forever.
4. Otherwise the inscribed bit is the bit at offset `x`, placed by the FIFO rule (section 3). If
   `x ≥ O`, the bit goes to the fee (section 6).

Several P2MR Inscriptions MAY be bound to the same bit. The second and later ones carry the
`reinscription` flag (PINS-1 §7.2). They move together.

## 5. Transfers

1. A P2MR Inscription moves only when the output holding it is spent. The FIFO rule (section 3) gives its
   new bitpoint.
2. A transfer that should deliver a P2MR Inscription to a recipient MUST place the inscribed bit inside
   the recipient's output. The simple form: spend the inscribed output as input 0 with the inscribed
   bit at offset 0, and make output 0 the recipient's output with a value of at least 1 bit more
   than the offset (in practice: the postage, default 10,000 bits).
3. The postage value of an output is not part of the P2MR Inscription; it travels with it and belongs
   to the owner.
4. Every output MUST be at or above the dust threshold (2,855 bits for P2MR,
   `src/policy/policy.cpp:34-75`) to be relayed.

## 6. Fees and the coinbase

1. A bit that becomes fee is placed in the coinbase transaction of the block that confirms the
   transaction:
   - the coinbase input space is: the subsidy range of the block first, then the fee ranges of the
     block's transactions in block order;
   - the coinbase outputs take this space by the FIFO rule.
2. A P2MR Inscription in a fee therefore lands in a coinbase output and belongs to the miner. Coinbase
   outputs are spendable only after 1,000 confirmations (`src/consensus/consensus.h:19`).
3. If the coinbase claims less than subsidy plus fees (allowed by consensus,
   `src/validation.cpp:2942-2946`), the unclaimed tail is **lost**. A P2MR Inscription in it becomes
   `lost`, permanently. The subsidy is the one of PINS-2 §5.1 for the height of the block. It is not
   derived from the coinbase, because a miner that claims less would shift every fee bit.
4. AuxPoW (merged-mined) blocks follow the same rule: only the Qbit block's own coinbase counts.

## 7. Burns and special outputs

| Output type (restricted-output mode, `src/consensus/restricted_outputs.h:18-45`) | Effect on a P2MR Inscription it receives |
|---|---|
| P2MR (`OP_2 <32 bytes>`) | normal ownership |
| `OP_RETURN` | `burned`, permanently; it MUST be displayed as burned |
| PayToAnchor (`51024e73`) | normal FIFO, but anyone can spend the output; wallets MUST warn and SHOULD refuse |
| Reserved witness version 3 to 16 (PINS-1 F15; mainnet and testnet4 from height 0) | normal FIFO, owner `script:<hex>` (PINS-2 §4.4); anyone can spend the output, and the default relay policy does not relay a transaction that creates one, so only a miner can place one; wallets MUST warn and SHOULD refuse |

A deliberate burn SHOULD send the inscribed bit to an `OP_RETURN` output whose value is at least the
offset + 1 of the bit inside it.

## 8. Wallet requirements

1. **Coin control.** A wallet that holds P2MR Inscriptions MUST NOT spend an inscribed output as fee
   input, consolidation input or change input. It MUST spend it only in an explicit transfer or sale.
2. **Unaware wallets.** A wallet that classifies every plain P2MR output as asset-free and offers
   consolidation of the largest outputs can spend an inscribed output as an ordinary coin. Unless a
   wallet consults a PINS indexer, holders SHOULD keep P2MR Inscriptions in a dedicated address that is never used
   for ordinary payments, and marketplaces MUST tell buyers so.
3. **Display.** Wallets and explorers SHOULD show the P2MR Inscription ID, number and bitpoint, and SHOULD
   mark `reinscription`, `opaque`, `burned`, `lost` and `unbound` states.
4. **Safe send.** Before signing a transfer, a wallet SHOULD verify with an indexer that the inscribed
   bit lands in the intended output, and that no other P2MR Inscription in the same inputs is moved by
   accident.

## 9. Edge cases (all MUST be handled)

| Case | Result |
|---|---|
| Inscribed output split into two outputs | bit follows FIFO to one of them |
| Two inscribed inputs merged into one output | both P2MR Inscriptions in that output, at different offsets |
| P2MR Inscription reveal with pointer into change | P2MR Inscription lands in the change output |
| Reveal with all value to fee | P2MR Inscription in the coinbase |
| Reveal whose input has zero value and no later value | `unbound` |
| Inscribed output spent in the same block as created | processed in block order; no special case |
| Reorg removes the transfer | location rolls back (PINS-2 §4.3) |
| Output sent to PayToAnchor | normal FIFO; wallet warning |
| Output sent to a reserved witness version 3 to 16 output | normal FIFO; wallet warning |

## 10. Test vectors

All five are in `vectors/ownership.json`: a short synthetic chain on mainnet rules (subsidy 21,000,000,000 bits), the exact blocks the rules engine receives, the table of P2MR Inscriptions after the last block, and the state hash (PINS-2 §4.4) after every block. A test applies the blocks and compares the table and the hashes.

| Vector | Content | Result |
|---|---|---|
| TV3-1 | Simple transfer, input 0 → output 0 | A reveal puts the P2MR Inscription at output 0, offset 0. The next transaction spends it as input 0 and pays output 0: it is at output 0, offset 0 of that transaction, owned by the new script |
| TV3-2 | Split and merge with offsets | X at offset 0 and Y at offset 10,000 share an output. A split gives each its own output. A merge that lists Y's output first gives Y offset 0 and X offset 10,000 (input order decides). An uneven split of 15,000 into 4,000 and 11,000 puts X at output 1, offset 6,000 |
| TV3-3 | P2MR Inscription into fee, into coinbase output 1, lost tail | A reveal with all its value as fee, with a coinbase of two outputs, lands at coinbase output 1, offset 0. A bit that is fee after 5,000 bits, behind another transaction's fee of 3,000, lands at coinbase output 1, offset 0 when output 0 holds the subsidy and 8,000 bits. A coinbase that claims only the subsidy leaves the fee bit `lost` |
| TV3-4 | Burn to `OP_RETURN` | A P2MR Inscription revealed onto an `OP_RETURN` output is `burned`. One moved there later is `burned` too |
| TV3-5 | Unbound reveal | A reveal whose only input has zero value, and one whose input starts at the total input value, are numbered and `unbound` |

## 11. Copyright

This document is placed in the public domain under CC0-1.0.
