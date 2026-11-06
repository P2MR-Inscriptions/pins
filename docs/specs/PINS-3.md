<!-- SPDX-License-Identifier: CC0-1.0 -->
# PINS-3: Transfer and Ownership

| Field | Value |
|---|---|
| Standard | PINS-3 |
| Title | Transfer and Ownership |
| Status | Draft. Regtest measurements are recorded. Vectors still marked TODO-regtest are open. |
| Type | Protocol, normative |
| License | CC0-1.0 |
| Requires | PINS-1 |

> Independent protocol, not affiliated with Qbit or Qbit-Org. Conventions and verified Qbit
> revisions: PINS-1 §2.

## 1. Abstract

Every inscription is bound to exactly one bit, the **inscribed bit**. Ownership follows that bit
through ordinary Qbit transactions by a first-in-first-out (FIFO) rule. The owner is whoever controls
the output that currently holds the bit. This binding and the FIFO rule are mandatory for every
conforming indexer and wallet. No bit-number index is required (PINS-2 Part B is optional).

## 2. Definitions

- **Bitpoint**: `<txid>:<vout>:<offset>`, the position of one bit inside one output, `offset` being
  counted in bits from the start of the output's value (`0 ≤ offset < value`).
- **Location** of an inscription: the bitpoint of its inscribed bit, or one of the terminal states
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
3. If `x ≥ I` (possible only when input `i` and every later input have zero value), the inscription
   is `unbound`: it is numbered but has no location and no owner, forever.
4. Otherwise the inscribed bit is the bit at offset `x`, placed by the FIFO rule (section 3). If
   `x ≥ O`, the bit goes to the fee (section 6).

Several inscriptions MAY be bound to the same bit. The second and later ones carry the
`reinscription` flag (PINS-1 §7.2). They move together.

## 5. Transfers

1. An inscription moves only when the output holding it is spent. The FIFO rule (section 3) gives its
   new bitpoint.
2. A transfer that should deliver an inscription to a recipient MUST place the inscribed bit inside
   the recipient's output. The simple form: spend the inscribed output as input 0 with the inscribed
   bit at offset 0, and make output 0 the recipient's output with a value of at least 1 bit more
   than the offset (in practice: the postage, default 10,000 bits).
3. The postage value of an output is not part of the inscription; it travels with it and belongs
   to the owner.
4. Every output MUST be at or above the dust threshold (2,855 bits for P2MR,
   `src/policy/policy.cpp:34-75`) to be relayed.

## 6. Fees and the coinbase

1. A bit that becomes fee is placed in the coinbase transaction of the block that confirms the
   transaction:
   - the coinbase input space is: the subsidy range of the block first, then the fee ranges of the
     block's transactions in block order;
   - the coinbase outputs take this space by the FIFO rule.
2. An inscription in a fee therefore lands in a coinbase output and belongs to the miner. Coinbase
   outputs are spendable only after 1,000 confirmations (`src/consensus/consensus.h:19`).
3. If the coinbase claims less than subsidy plus fees (allowed by consensus,
   `src/validation.cpp:2942-2946`), the unclaimed tail is **lost**. An inscription in it becomes
   `lost`, permanently.
4. AuxPoW (merged-mined) blocks follow the same rule: only the Qbit block's own coinbase counts.

## 7. Burns and special outputs

| Output type (restricted-output mode, `src/consensus/restricted_outputs.h:18-45`) | Effect on an inscription it receives |
|---|---|
| P2MR (`OP_2 <32 bytes>`) | normal ownership |
| `OP_RETURN` | `burned`, permanently; it MUST be displayed as burned |
| PayToAnchor (`51024e73`) | normal FIFO, but anyone can spend the output; wallets MUST warn and SHOULD refuse |

A deliberate burn SHOULD send the inscribed bit to an `OP_RETURN` output whose value is at least the
offset + 1 of the bit inside it.

## 8. Wallet requirements

1. **Coin control.** A wallet that holds inscriptions MUST NOT spend an inscribed output as fee
   input, consolidation input or change input. It MUST spend it only in an explicit transfer or sale.
2. **Unaware wallets.** Qbit Wallet `v1.0.7` classifies every plain P2MR output as asset-free
   (`packages/wallet-background/src/utils/qbit-api.ts:2684-2702`, "qbit defines no protected-asset
   layer today") and offers consolidation of the largest outputs. Until it consults a PINS indexer,
   holders SHOULD keep inscriptions in a dedicated address that is never used for ordinary payments,
   and marketplaces MUST tell buyers so.
3. **Display.** Wallets and explorers SHOULD show the inscription ID, number and bitpoint, and SHOULD
   mark `reinscription`, `opaque`, `burned`, `lost` and `unbound` states.
4. **Safe send.** Before signing a transfer, a wallet SHOULD verify with an indexer that the inscribed
   bit lands in the intended output, and that no other inscription in the same inputs is moved by
   accident.

## 9. Edge cases (all MUST be handled)

| Case | Result |
|---|---|
| Inscribed output split into two outputs | bit follows FIFO to one of them |
| Two inscribed inputs merged into one output | both inscriptions in that output, at different offsets |
| Inscription reveal with pointer into change | inscription lands in the change output |
| Reveal with all value to fee | inscription in the coinbase |
| Reveal whose input has zero value and no later value | `unbound` |
| Inscribed output spent in the same block as created | processed in block order; no special case |
| Reorg removes the transfer | location rolls back (PINS-2 §4.3) |
| Output sent to PayToAnchor | normal FIFO; wallet warning |

## 10. Test vectors

| Vector | Content | Status |
|---|---|---|
| TV3-1 | Simple transfer, input 0 → output 0 | TODO-regtest |
| TV3-2 | Split and merge with offsets | TODO-regtest |
| TV3-3 | Inscription into fee, into coinbase output 1, lost tail | TODO-regtest |
| TV3-4 | Burn to `OP_RETURN` | TODO-regtest |
| TV3-5 | Unbound reveal | TODO-regtest |

## 11. Copyright

This document is placed in the public domain under CC0-1.0.
