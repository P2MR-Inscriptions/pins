<!-- SPDX-License-Identifier: CC0-1.0 -->
# PINS-4: Metadata

| Field | Value |
|---|---|
| Standard | PINS-4 |
| Title | Metadata |
| Status | Draft. The canonical PNG and CBOR rules below are the format. A collection's images are not part of this document. |
| Type | Data format, normative |
| License | CC0-1.0 |
| Requires | PINS-1 |

> Independent protocol, not affiliated with Qbit or Qbit-Org. Conventions: PINS-1 §2.

## 1. Abstract

PINS-4 defines the content of the `metadata` field (tag 5, PINS-1 §5.2): one CBOR data item that
describes the inscription. The body stays the content itself (for example the PNG); attributes live
next to it, in the same envelope, and are immutable like the rest of the inscription.

## 2. Encoding

1. The value of field 5 (all its chunks concatenated, PINS-1 §5.3) MUST be exactly one CBOR data item
   (RFC 8949), with no trailing bytes.
2. Writers MUST use RFC 8949 preferred serialization (§4.1): shortest integer and length arguments,
   definite lengths only, no duplicate map keys.
3. Map keys MUST appear in the order fixed by the schema that defines the map (section 3 and PINS-5).
   This is a schema-defined order, not the byte-sorted order of RFC 8949 §4.2.1. Readers MUST NOT
   re-encode metadata before hashing: every hash in PINS is computed over the exact inscribed bytes.
4. Allowed CBOR types: unsigned and negative integers, byte strings, UTF-8 text strings, arrays,
   maps, `true`, `false`, `null`. Floats, tags and undefined MUST NOT be used.
5. A field 5 value that is not well-formed CBOR is ignored by readers; the inscription stays valid.

### 2.1 Reader rules

A reader MUST decode field 5 with the rules below. Whether an inscription is a genesis, a leaf list, an
item or a price record depends on them, so every reader MUST apply them in the same way. A value that
breaks any rule is handled as in rule 5 above: it is ignored and the inscription stays valid.

1. The value is exactly one data item. Bytes after it, or an item that is cut short, are an error.
2. The additional information values 28, 29 and 30 are an error, and so is 31, which stands for an
   indefinite length or the break code. Every length is definite.
3. For major types 0 to 6, the argument MUST use the shortest form. An argument below 24 in a 1-byte
   form, one up to `0xff` in a 2-byte form, one up to `0xffff` in a 4-byte form, and one up to
   `0xffffffff` in an 8-byte form are an error. This covers integers and the lengths of strings,
   arrays and maps.
4. Major types 0 (unsigned integer), 1 (negative integer), 2 (byte string), 3 (text string), 4 (array)
   and 5 (map) are accepted. Major type 6 (a tag) is an error. Of major type 7 only `false` (`0xf4`),
   `true` (`0xf5`) and `null` (`0xf6`) are accepted. `undefined`, every other simple value and every
   half, single or double float are an error.
5. Integers are read up to 64 bits, from `-2^64` to `2^64 - 1`. A rule that needs a safe integer, such
   as `supply` or `first` in PINS-5 §3, rejects a value above `2^53 - 1`.
6. A text string MUST be valid UTF-8, and a map key MUST be a text string. Anything else is an error.
   A leading U+FEFF is a character of the string and is not removed.
7. The depth of the top-level item is 0, and each array element, map key and map value is one deeper
   than its container. An item at a depth above 32 is an error. An item inside 32 arrays or maps is
   still accepted. One inside 33 is not.
8. A repeated map key is not an error. The last value replaces the earlier one, and the key keeps the
   position of its first occurrence. The reader does not check key order. The rules that use a map check
   it (PINS-5 §3 for the genesis, PINS-5 §6 for the leaf list). Writers MUST NOT repeat a key (§2).
   Every text key is an ordinary key, including `__proto__`.

## 3. Item schema (`pins-item/1`)

A map with one key:

```
{
  "meta": {
    "name": text,                       # e.g. "Item#1234"
    "attributes": [                     # zero or more
      { "trait_type": text, "value": text },
      ...
    ]
  }
}
```

- Key order is exactly: `meta`; inside it `name`, then `attributes`; inside each attribute
  `trait_type`, then `value`.
- Attribute order is the order of the source metadata file and is part of the hashed bytes.
- The item carries no reference to its collection and no separate index field. Collection membership
  and the item number are established by PINS-5 (issuer key, name prefix and Merkle leaf), which also
  avoids any circular dependency between items and the genesis inscription.
- Unknown keys MUST be ignored by readers. Keys starting with `x-` are reserved for private use.

## 4. Worked mapping

The canonical bytes are produced by `packages/collection/canonical.mjs` (function
`canonicalMetadataCbor`) from the zip the operator passes in.

- the source JSON is a one-element array `[ { "file": …, "meta": { "name", "attributes" } } ]`; the
  array wrapper is not encoded and the `file` field is omitted;
- `name` is the collection's name prefix plus the decimal item number, with no leading zeros;
- attribute order is the order of the source metadata and is part of the hashed bytes;
- trait types and values are text and come from that source. This document does not fix a trait list.

Example shape, not a collection: `{"meta": {"name": "Item#1", "attributes": [{"trait_type": "Example", "value": "…"}]}}`.

## 5. Content rules for image items

- `content_type` MUST be `image/png`. The body MUST be the canonical PNG defined below.

### 5.1 Canonical PNG

The source image is 24×24, color type 6, bit depth 8. Decode it to row-major 8-bit RGBA
(R, G, B, A). Ancillary chunks, including `bKGD`, are not applied. The canonical file MUST decode
back to those same RGBA bytes.

Every candidate is one PNG: the 8-byte signature, `IHDR`, the chunks named below, one `IDAT`,
`IEND`. No ancillary chunk is written. `IHDR` is width, height, bit depth, color type, compression
method 0, filter method 0, interlace 0. Each chunk uses the PNG CRC-32 of its type and data.

`IDAT` is one zlib stream, not raw deflate: zlib wrapper (`CMF`/`FLG` and Adler-32), deflate level 9,
window size 15, memory level 8, default strategy. Those are the parameters of
`zlib.deflateSync(scanlines, { level: 9 })` in Node.js (windowBits 15, memLevel 8, strategy 0).

Scanlines are filtered before deflate. For each row, try filter types 0 (None), 1 (Sub), 2 (Up),
3 (Average) and 4 (Paeth), using the unfiltered bytes of the row above. `a` is the byte `bpp` places
to the left, or 0. `b` is the byte above, or 0. `c` is the byte above-left, or 0. Average uses
`floor((a + b) / 2)`. Paeth uses `p = a + b - c` and picks `a`, then `b`, then `c`, by the smallest
absolute distance, ties in that order. `bpp` is 4 for RGBA, 3 for RGB, and 1 for indexed rows
(packed bytes). The score of a filtered row is the sum, over its bytes, of `byte` when `byte < 128`
and `256 - byte` otherwise. The lowest score wins. A tie keeps the lower filter type.

Candidates, built in this order:

1. 8-bit RGBA, color type 6. This candidate always exists.
2. 8-bit RGB, color type 2, only when every alpha byte is 255. Alpha is then implicit 255.
3. Indexed color, color type 3, at bit depths 1, then 2, then 4, then 8. Palette entries are the
   distinct `(R, G, B, A)` colors in first-seen order, left to right, top to bottom. A depth is
   skipped when the color count is above `2^depth` or above 256. `PLTE` holds the RGB triples in
   that order and is not padded. If any alpha is not 255, `tRNS` follows `PLTE` with one alpha byte
   per palette entry (not a shortened prefix). If every alpha is 255, `tRNS` is omitted. Index bytes
   are packed most-significant bit first, and the unused low bits of a row are 0.

A candidate is kept only when it decodes to the same RGBA bytes. Among those, the shortest file
wins. A later candidate replaces the current file only when it is strictly shorter, so an equal
length keeps the earlier candidate. RGBA is the starting file.

The reference encoder is `encodeCanonicalPng` in `packages/collection/canonical.mjs`. The manifest
hashes are the check that an independent encoder matched these rules.
- `content_encoding` MUST NOT be used.
- Review renders are not part of the inscribed item and MUST NOT be inscribed.
- Renderers SHOULD display the image scaled by an integer factor with nearest-neighbour sampling
  (CSS `image-rendering: pixelated`).

## 6. Collection documents

`collection.json` is inscribed as its own body with `content_type` `application/json`, in its
canonical form: compact UTF-8 JSON, source key order, `largeImageFormat` removed, one trailing
newline. PINS data about the collection
(Merkle root, issuer key, sale parameters) goes in the genesis field 5 as a `pins-collection/1` map
(PINS-5 §3), never inside `collection.json`.

## 7. Test vectors

| Vector | Content | Status |
|---|---|---|
| TV4-1 | Canonical CBOR of one item, hashed as PINS-5 §5.1 | TODO-spec |
| TV4-2 | Canonical PNG of one item, hashed as PINS-5 §5.1 | TODO-spec |
| TV4-3 | Re-encoded metadata (keys reordered) fails the PINS-5 leaf check | TODO-regtest |

## 8. Copyright

This document is placed in the public domain under CC0-1.0.
