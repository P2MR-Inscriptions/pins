<!-- SPDX-License-Identifier: CC0-1.0 -->
# PINS-1: Core Inscription

| Field | Value |
|---|---|
| Standard | PINS-1 |
| Title | Core Inscription |
| Status | Draft. Regtest measurements are recorded. Vectors still marked TODO-regtest are open. |
| Type | Protocol, normative |
| License | CC0-1.0 |
| Requires | none |
| Required by | PINS-2, PINS-3, PINS-4, PINS-5, PINS-6 |
| Protocol marker | `pins` (`0x70 0x69 0x6e 0x73`), final (collision check: `collision-check.md`) |

> P2MR Inscriptions is an independent, open protocol. It is not affiliated with, endorsed by, or
> an official proposal of the Qbit project or Qbit-Org. "Qbit", "QBT" and "P2MR" are used only to
> name the network and its native output type.

## 1. Abstract

PINS-1 defines how arbitrary content (images, text, JSON, media) is written into a Qbit
transaction so that every conforming indexer recognizes the same inscriptions, assigns them the
same identifiers and numbers, and binds each one to the same initial bit. Content is carried in an
unexecuted branch (an "envelope") of a revealed P2MR leaf script with leaf version `0xc0`.

## 2. Conventions

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY and
OPTIONAL are to be interpreted as described in RFC 2119 and RFC 8174 when, and only when, they
appear in all capitals.

- **bit**: the smallest unit of QBT (1 QBT = 100,000,000 bits).
- **byte strings** are written in hex; multi-byte integers are little-endian unless stated.
- **push**: any opcode `0x00`–`0x4e` (data push) together with the bytes it pushes, plus
  `OP_1NEGATE` (`0x4f`, pushes `[0x81]`) and `OP_1`–`OP_16` (`0x51`–`0x60`, push `[n]`).
- **leaf script**: the second-to-last P2MR witness item after the optional annex is removed, as
  defined in Qbit `doc/consensus/p2mr-v1.md` §3.
- **TODO-regtest**: a value or vector that MUST be produced on a private, local regtest node before
  this document leaves Draft status.

### 2.1 Sources verified

All normative Qbit facts below were checked against `Qbit-Org/qbit` at:

- release `v1.0.0` (`7ebcddb622d6e639041f005a189b048ec2a221fe`);
- branch `1.x.x` head `b27130a7b913de6516cd172a952cb70776f00d0c` (2026-11-03), which includes PR
  #263 (P2MR runtime stack-byte policy) and PR #265.

Line numbers refer to `1.x.x`; `v1.0.0` numbers are given where they differ.

## 3. Qbit facts this standard relies on

| # | Fact | Source |
|---|---|---|
| F1 | P2MR output: native witness v2, 32-byte program, `OP_2 <32-byte root>`; script path only, no key path | `doc/consensus/p2mr-v1.md` §2, §5 |
| F2 | Active leaf version is `0xc0` only; control block `1 + 32*m` bytes, bit 0 set; `0xc2..0xfe` are reserved (consensus-valid, not executed, non-standard); `0xfe` is named "extension-envelope" | `p2mr-v1.md` §4; `src/script/script.h:90-171` (`v1.0.0`: `:85-165`) |
| F3 | Leaf hash `TaggedHash("P2MRLeaf", leaf_version \|\| CompactSize(len) \|\| script)`; branch hash `TaggedHash("P2MRBranch", min(a,b) \|\| max(a,b))` | `p2mr-v1.md` §5 |
| F4 | Each data push is limited to 520 bytes, checked for every push, executed or not | `src/script/interpreter.cpp:545` (`v1.0.0`: `:535`); `src/script/script.h:28` |
| F5 | Pushes inside a non-executed branch are not placed on the stack | `src/script/interpreter.cpp:589` (`v1.0.0`: `:566`) |
| F6 | P2MR has no 10,000-byte script-size limit and no 201-opcode limit | `p2mr-v1.md` §8, §10 |
| F7 | Policy limits on the initial stack (16 KiB per item, 128 KiB total) exclude the leaf script and the control block | `src/policy/policy.cpp:354-385`; `src/script/script.h:46-49` |
| F8 | Policy: the main stack plus the alt stack MUST NOT exceed 1 MiB after any opcode (`1.x.x` only; not in `v1.0.0`) | `src/script/script.h:56`; `src/script/interpreter.cpp:1413-1416`; `src/policy/policy.h:137` |
| F9 | Signatures: SLH-DSA-SHA2-128s-bounded30, 32-byte public key, 3,680-byte signature plus an optional nonzero hash-type byte; `OP_CHECKSIGPQC` = `0xb3` | `p2mr-v1.md` §7, §9 |
| F10 | `WITNESS_SCALE_FACTOR = 1` (no witness discount); block weight 2,000,000 | `src/consensus/consensus.h:15,22` |
| F11 | Standard transaction weight 400,000 | `src/policy/policy.h:37` |
| F12 | Ancestor and descendant size limits 404 kvB, count limits 25 | `src/policy/policy.h:75-81` |
| F13 | Minimum relay fee 250 bits/kvB; dust relay fee 750 bits/kvB | `src/policy/policy.h:71,73` |
| F14 | P2MR dust threshold = ceil((43 + 3,763) × 750 / 1000) = 2,855 bits | `src/policy/policy.cpp:34-75`; `src/script/p2mr_sizing.h:15-41`; `src/policy/feerate.cpp:20-27` (rounds up) |
| F15 | Restricted-output mode (consensus): every output MUST be P2MR v2/32, `OP_RETURN`, or PayToAnchor | `src/consensus/restricted_outputs.h:18-45`; `src/kernel/chainparams.cpp:159` |
| F16 | Annexes are non-standard | `src/policy/policy.cpp:360-363` |
| F17 | OP_SUCCESS opcodes cause immediate success and are non-standard | `p2mr-v1.md` §8; `src/script/interpreter.cpp:2168-2194` |
| F18 | Qbit Core contains no inscription detection or filtering code | grep of `src/` at both revisions |

## 4. Envelope

### 4.1 Wire format

An envelope is the following sequence of script instructions inside a leaf script:

```
OP_FALSE                      0x00
OP_IF                         0x63
<marker>                      push of exactly the 4 bytes 70 69 6e 73 ("pins")
<tag_1> <value_1>             zero or more field pairs (section 5)
...
[ OP_0 <body_1> <body_2> ... ]   optional: body separator (empty push) and body pushes
OP_ENDIF                      0x68
```

Rules:

1. The envelope starts at an `OP_FALSE` instruction that is the single byte `0x00`, immediately
   followed by the single byte `0x63` (`OP_IF`).
2. The next instruction MUST be a push (of any push opcode) whose data equals `70696e73`.
   Otherwise the sequence is not a PINS envelope.
3. Every instruction after the marker and before the matching `OP_ENDIF` MUST be a push. The first
   non-push instruction ends the scan of that candidate: if it is `OP_ENDIF` (`0x68`), the envelope
   is complete; if it is any other opcode, the candidate is not an envelope.
4. If the script ends before `OP_ENDIF`, the candidate is not an envelope.
5. Pushes before the body separator are read as alternating `tag`, `value` items. The body
   separator is the first push of zero bytes that occupies a tag position. Every push after it,
   up to `OP_ENDIF`, is a body push.
6. If, before the separator (or before `OP_ENDIF` when there is no separator), the number of
   pushes after the marker is odd, the final tag has no value. The envelope is still an
   inscription and gets the `incomplete_field` flag (section 7.2); the dangling tag is ignored.

### 4.2 Location of envelopes

A conforming indexer MUST look for envelopes only in:

- a transaction input that spends a P2MR v2/32 output (F1), in a confirmed block;
- whose witness, after removal of an optional annex (an item starting with `0x50` when at least two
  items exist, per `p2mr-v1.md` §3), has at least two items;
- whose control block leaf version (`control[0] & 0xfe`) equals `0xc0`;
- inside the leaf script (the second-to-last item after annex removal).

Envelopes in a reserved leaf version, in initial stack items, in the annex, in a coinbase, in an
`OP_RETURN` output or in any non-P2MR input are NOT inscriptions.

### 4.3 Scanning

The indexer decodes the leaf script into instructions from the start. If the script cannot be
fully decoded (a truncated push), the input yields no inscriptions. Otherwise, the indexer walks
the instruction list; at each index `j` where a candidate begins (rule 4.1.1 and 4.1.2), it parses
the candidate. A complete envelope ending at index `e` is recorded and scanning resumes at `e + 1`;
a failed candidate resumes scanning at `j + 1`. Any number of envelopes MAY appear in one leaf
script, before or after executed code.

Inscriptions are recognized regardless of whether the leaf script also contains other code,
including OP_SUCCESS opcodes: consensus has already decided the spend is valid.

### 4.4 Why this location

| Option | Decision | Reason |
|---|---|---|
| Unexecuted branch in the `0xc0` leaf script | Chosen | Standard; committed by the P2MR root, so no third party can alter it; never placed on the stack (F5), so the 1 MiB policy (F8) and the 16 KiB / 128 KiB initial-stack limits (F7) do not apply to the data |
| Initial stack items dropped by `OP_DROP` | Rejected | Capped at 128 KiB per input (F7); counted against the 1 MiB stack policy (F8) |
| Annex | Rejected | Non-standard (F16) |
| Reserved leaf versions `0xc2..0xfe` | Rejected | Non-standard and reserved for Qbit's own upgrades (F2) |
| `OP_RETURN` | Rejected | Not bound to a bit; separate data-carrier policy |
| OP_SUCCESS constructions | Rejected | Non-standard (F17) |

## 5. Fields

### 5.1 Tag encoding

A tag is the byte string pushed in a tag position. `OP_1`–`OP_16` and `OP_1NEGATE` are accepted
and read as the one-byte strings they push. A tag of exactly one byte is compared against the table
below. The parity of a tag is the parity of its first byte (its least significant byte). Even tags
are **critical**; odd tags are **informational**.

### 5.2 Field table

PINS reuses the field numbers of the Ordinals protocol (prior art, 2023) wherever the meaning is the
same, so existing parsers and renderers can be reused. Only the fields below are defined by PINS-1.

| Tag | Name | Parity | Value | Chunked | Defined in |
|---|---|---|---|---|---|
| 0 (empty push) | body separator | n/a | none | n/a | PINS-1 |
| 1 | `content_type` | odd | ASCII MIME type, e.g. `image/png` | no | PINS-1 |
| 2 | `pointer` | even | unsigned integer, little-endian, trailing `0x00` bytes MAY be omitted; at most 8 bytes | no | PINS-1, PINS-3 |
| 5 | `metadata` | odd | CBOR data item (RFC 8949) | yes | PINS-4 |
| 7 | `metaprotocol` | odd | UTF-8 string | no | PINS-1 |
| 9 | `content_encoding` | odd | ASCII, `br` or `gzip` (HTTP `Content-Encoding`) | no | PINS-1 |
| 11 | `delegate` | odd | binary inscription ID (section 6.1) | no | PINS-1 |

Reserved with their Ordinals meaning, NOT defined by PINS-1 and treated as unknown fields
(section 5.4) until a later PINS standard defines them: 3 (`parent`), 13, 15 (`note`, no-op),
17 (`properties`), 19 (`property_encoding`), 66 (`unbound`), 255 (`nop`). Future PINS standards
MUST NOT assign a different meaning to any of these numbers.

### 5.3 Chunked and repeated fields

- A **chunked** field MAY appear several times; its value is the concatenation of all its values in
  envelope order. Writers MUST split values longer than 520 bytes (F4) into chunks of 520 bytes,
  except the last.
- A **non-chunked** field that appears more than once: the first value is used and the inscription
  gets the `duplicate_field` flag.

### 5.4 Unknown fields

- Unknown **odd** tags MUST be ignored.
- An unknown **even** tag makes the inscription **opaque**: it is still recognized, identified,
  numbered and tracked (PINS-2, PINS-3), but its content and fields MUST NOT be interpreted or
  rendered, because the writer signalled a rule this reader does not know.

### 5.5 Frozen location rule

In PINS-1 the only field that affects where an inscription lands is `pointer`. A future field that
changes initial location, numbering or ownership MUST NOT be introduced as a new tag. It requires a
new protocol marker, so that every indexer version keeps agreeing on numbers and owners.

## 6. Identity

### 6.1 Inscription ID

The ID of an inscription is `<txid>i<n>`:

- `txid` is the reveal transaction ID, lowercase hex, displayed in the usual reversed byte order;
- `n` is the zero-based index of the envelope among all PINS envelopes of that transaction,
  counted by input order, then by position inside the leaf script.

The **binary** form (used by `delegate` and PINS-4/5 references) is the 32-byte txid in internal
byte order followed by `n` as a 4-byte little-endian integer with trailing `0x00` bytes removed
(so `n = 0` is exactly 32 bytes).

### 6.2 Inscription number

Inscription numbers are defined in PINS-2. They start at 0 and never go negative.

## 7. Validity

### 7.1 Not an inscription

A byte sequence is not an inscription, gets no ID and no number, when any of these holds:

- the location rules of section 4.2 are not met;
- the marker push data is not exactly `70696e73`;
- a non-push instruction other than `OP_ENDIF` appears inside the candidate;
- `OP_ENDIF` is missing;
- the leaf script cannot be fully decoded;
- the containing block is below the activation height (PINS-2).

### 7.2 Inscription flags

Every other envelope is an inscription. These flags are informational and NEVER change its ID,
number or initial location, except `bad_pointer` as stated:

| Flag | Condition | Effect |
|---|---|---|
| `opaque` | an unknown even tag is present | content not interpreted |
| `duplicate_field` | a non-chunked field repeats | first value used |
| `incomplete_field` | dangling tag without value | dangling tag ignored |
| `bad_pointer` | pointer is longer than 8 bytes, or its value ≥ total output value of the reveal | pointer ignored, default location used (PINS-3) |
| `reinscription` | the initial bit already carries an inscription | allowed; PINS-5 excludes it from collection authenticity |
| `unbound` | no bit exists for the initial location (PINS-3) | numbered, no owner |
| `no_body` | no body separator | content is empty |

There are no "cursed" inscriptions and no negative numbers in PINS.

## 8. Content

- The **body** is the concatenation of all body pushes, in order.
- `content_type` tells readers how to interpret the body. Absent, readers SHOULD treat the content
  as `application/octet-stream`.
- When `content_encoding` is present, the body is encoded; readers decode it before use. PINS-5
  collection items MUST NOT use `content_encoding`.
- Delegation: when `delegate` names an existing inscription, readers SHOULD serve the delegate's
  content and content type instead of this inscription's body. Delegation chains and loops are
  resolved by reading only one level: the delegate's own `delegate` field is ignored.

## 9. Reveal construction (writer rules)

### 9.1 Reveal leaf (normative shape for PINS-aware tools)

```
<pubkey:32> OP_CHECKSIGPQC        20 <32 bytes> b3
<envelope_0>                      00 63 04 70696e73 ... 68
<envelope_1> ...                  (batching, section 9.4)
```

Witness: `[signature (3,680 or 3,681 bytes), leaf_script, control_block]`.

Execution: `OP_CHECKSIGPQC` consumes the signature and leaves `[0x01]`; each `OP_FALSE OP_IF`
pops the empty item and skips to its `OP_ENDIF`. The final stack is `[0x01]`, satisfying CLEANSTACK
(`src/script/interpreter.cpp:2210-2211`). The peak stack holds about 3.7 KB, far below the 1 MiB
policy (F8). Binding the leaf to a key prevents third parties from front-running the reveal.

### 9.2 Writer requirements

Writers:

1. MUST use leaf version `0xc0` and MUST NOT include an annex.
2. MUST use minimal push opcodes for every push (indexers MUST still accept non-minimal pushes
   inside envelopes; see TODO-regtest Q7 in the README).
3. MUST encode the marker as `04 70696e73` and tags as `01 <tag>` (one-byte direct push).
4. MUST split the body and chunked fields into pushes of 520 bytes, except the last (F4).
5. MUST NOT include any OP_SUCCESS opcode (F17) anywhere in the leaf script.
6. MUST keep every output at or above the dust threshold (F14) and inside restricted-output mode
   (F15).
7. SHOULD run the signed reveal through `testmempoolaccept` on a node of the current release
   before broadcast.

### 9.3 Commit and reveal

1. Build leaf `L1` (section 9.1) and a **recovery leaf** `L2 = <recovery_pubkey:32> OP_CHECKSIGPQC`.
2. The commit output is the P2MR output whose root is
   `TaggedHash("P2MRBranch", min(h1, h2) || max(h1, h2))`, with `h1`, `h2` the leaf hashes (F3).
3. **Commit transaction:** fund that output with the sum of all postage values plus the reveal fee.
   On chain it is indistinguishable from any other P2MR output.
4. **Reveal transaction:** spend the commit output through `L1` with control block
   `c1 || h2` (33 bytes). Outputs: one postage output per inscription (default 10,000 bits, at least
   the dust threshold of 2,855 bits, F14), then optional change.
5. **Abort:** spend the commit output through `L2` (control block `c1 || h1`). Nothing is revealed.

`L2` SHOULD use a key different from `L1`. The recovery key MUST be kept offline like the
issuer key (PINS-5).

### 9.4 Batching

One PQC signature (3,683 bytes with its push) is larger than a 24×24 PNG. Writers SHOULD place many
envelopes under one signature. In a batch:

- envelope `k` (0-based) SHOULD carry `pointer = k × postage` (omitted for `k = 0`), so that each
  inscription lands on the first bit of its own output `k`;
- outputs `0..N-1` carry `postage` each; change, if any, comes after them.

### 9.5 Size and weight

`WITNESS_SCALE_FACTOR = 1` (F10), so weight = virtual size = serialized bytes.

| Quantity | Value | Status |
|---|---|---|
| Standard reveal weight limit | 400,000 serialized bytes (F11). Weight equals size | verified |
| Fixed reveal overhead, 1 input, depth-1 control block, change output, 625 postage outputs, leaf script of at least 65,536 bytes | 3,855 bytes | measured, regtest, 2026-11-04 |
| Push overhead per 520-byte chunk | 3 bytes (`4d 0802`) | computed |
| Largest standard reveal | 400,000 serialized bytes. A 393,800-byte body measured 400,004 and was rejected `tx-size` | measured, regtest, 2026-11-04 |
| Peak stack of a reveal | 3,712 bytes (3,680-byte signature + 32-byte pubkey). The envelope is not counted | measured, regtest, 2026-11-04 |
| Per-item bytes in a batch | envelope bytes + 43 (output) | computed |
| Items per standard reveal | `floor((400,000 − overhead) / per_item_bytes)` | computed |

#### 9.5.1 Worked estimate (canonical data, 5,044,093 bytes of payload)

Averages per item from the canonical manifest: PNG body 249.5 bytes, CBOR metadata 254.9 bytes.

| Envelope part | Bytes |
|---|---|
| `OP_FALSE OP_IF` + marker push | 7 |
| `content_type` `image/png` (tag + push) | 12 |
| `pointer` (tag + up to 3-byte value) | ≤ 6 |
| `metadata` (tag + push header ≤ 3 + 254.9) | ≤ 259.9 |
| `OP_0` separator | 1 |
| body (push header ≤ 3 + 249.5) | ≤ 252.5 |
| `OP_ENDIF` | 1 |
| **Envelope** | **≤ 539.4** |
| Output (8 value + 1 length + 34 script) | 43 |
| **Per item** | **≤ 582.4** |

| Result | Value |
|---|---|
| Items per reveal at the 400,000 limit | a greedy in-order pack is 15 reveals (up to 723 of the lighter items) |
| Recommended | 16 reveals of 625 items. Measured weight 345,083 to 372,817 bytes |
| Item reveals in total | 5,844,107 bytes |
| Genesis + leaf list (one reveal, 320,000-byte list) | 326,064 bytes, mined |
| Fan-out that funds those 17 commit outputs | 4,548 bytes in the regtest run (17 outputs plus change) |
| **Those 18 transactions** | **6,174,719 bytes** |
| Fee at 1 / 5 / 10 bits/vB | 0.06174719 / 0.30873595 / 0.61747190 QBT |
| Postage locked in item outputs (10,000 × 10,000 bits) | 1 QBT (not a fee; it moves with the items) |
| Block weight limit 2,000,000 | 5 reveals per block in the regtest run, so 4 blocks for the 17 reveals, plus the fan-out's block |

Exact per-item sizes differ; the batch builder MUST sum real sizes and stay
under the limit. A reveal of the first 625 canonical items, weight 345,083, and one of 625 one-byte
bodies, weight 48,167, were both mined. Neither was rejected for sigops.

The commit and reveal chained unconfirmed MUST stay within the 404 kvB ancestor and descendant
limits (F12). The funding plan that stays inside that limit is PINS-5 §6.1. A second large reveal
that shares an unconfirmed ancestor is rejected
`too-long-mempool-chain, exceeds descendant size limit ... [limit: 404000]`.

## 10. Security considerations

- **Front-running.** Without the key check in `L1`, anyone seeing the reveal in the mempool could
  copy the envelope into their own transaction. The `<pubkey> OP_CHECKSIGPQC` prefix prevents
  this.
- **Signature usage.** SLH-DSA bounded30 keys are usage-limited (2^30 signatures, F9). Keys used by
  PINS tools MUST track their signature count.
- **Policy drift.** Qbit tightened P2MR policy in `1.x.x` (F8). Tools SHOULD be tested against the
  current release branch, not only the last tag.
- **Data availability.** See PINS-2 (witness pruning).

## 11. Test vectors

| Vector | Content | Status |
|---|---|---|
| TV1-1 | Minimal envelope: `content_type` `text/plain;charset=utf-8`, body `hello` | TODO-regtest |
| TV1-2 | 24×24 PNG with CBOR metadata (field 5) | TODO-regtest |
| TV1-3 | Batch of 3 envelopes with pointers 0, 10,000, 20,000 | TODO-regtest |
| TV1-4 | Body of exactly 520, 521 and 1,040 bytes (chunk boundaries) | TODO-regtest |
| TV1-5 | Invalid: wrong marker, missing `OP_ENDIF`, non-push inside, reserved leaf version | TODO-regtest |
| TV1-6 | Flags: unknown even tag, duplicate `content_type`, dangling tag, bad pointer | TODO-regtest |
| TV1-7 | Recovery-leaf abort spend | TODO-regtest |

## 12. Copyright

This document is placed in the public domain under CC0-1.0.
