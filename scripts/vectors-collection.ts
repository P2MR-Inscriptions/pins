// SPDX-License-Identifier: Apache-2.0

/**
 * Vectors for the collection rules that need a whole collection: the authenticity of items
 * (PINS-5 §9) and the canonical PNG (PINS-4 §5).
 */
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { canonicalMetadataCbor, decodePng, encodeCanonicalPng, encodeCbor } from "../packages/collection/canonical.mjs";
import { collectionView } from "../packages/indexer/collection.ts";
import { Indexer, bodyFacts, type Inscription } from "../packages/indexer/pins.ts";
import { leafHash, leafListRoot } from "../packages/protocol/merkle.mjs";

type Json = Record<string, unknown>;

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const ISSUER = "ab".repeat(32);
const OTHER = "cd".repeat(32);

const metadataOf = (number: number): Uint8Array =>
  canonicalMetadataCbor({ meta: { name: `Item#${number}`, attributes: [{ trait_type: "Tone", value: String(number) }] } });
const bodyOf = (number: number): Uint8Array => text(`body of item ${number}`);

const genesisTx = "aa".repeat(32);
const idOf = (label: string): string => `${createHash("sha256").update(label).digest("hex")}i0`;

type Spec = { label: string; height: number; index?: number; issuer?: string; contentType?: string; body: Uint8Array; metadata: Uint8Array | null; txid?: string; n?: number };

function inscription(spec: Spec, number: number): Inscription {
  return {
    id: idOf(spec.label), txid: spec.txid ?? idOf(spec.label).slice(0, 64), n: spec.n ?? 0, number,
    location: { state: "unbound" }, flags: [], contentType: spec.contentType ?? "image/png",
    ...bodyFacts(spec.body), metadata: spec.metadata, fields: [],
    createdHeight: spec.height, createdIndex: spec.index ?? 0, locationHeight: spec.height,
    leafIssuer: spec.issuer ?? ISSUER, ownerScript: "", ownerAddress: "",
  };
}

const leafList = Buffer.concat([1, 2, 3].map((number) => leafHash(number, bodyOf(number), metadataOf(number))));
const ROOT = leafListRoot(leafList) as string;

const genesis: Spec = {
  label: "genesis", height: 10, index: 1, contentType: "application/json", txid: genesisTx, body: new Uint8Array(),
  metadata: encodeCbor({ schema: "pins-collection/1", name: "Example", supply: 3, first: 1, name_prefix: "Item#", root: ROOT, issuer: ISSUER, item_type: "image/png" }),
};
const list: Spec = { label: "leaf list", height: 10, index: 1, n: 1, contentType: "application/octet-stream", txid: genesisTx, body: leafList, metadata: null };
const item = (number: number, height: number, extra: Partial<Spec> = {}): Spec => ({
  label: `item ${number} at ${height}${extra.issuer ? " by another key" : ""}${extra.label ?? ""}`, height, body: bodyOf(number), metadata: metadataOf(number), ...extra,
});
/** `{ schema: "pins-close/1", root: <32 bytes>, count: 3 }` as CBOR; the root is a byte string, which the shared text encoder does not write. */
function closingField(): Uint8Array {
  return Buffer.concat([
    Buffer.from([0xa3]), encodeCbor("schema"), encodeCbor("pins-close/1"),
    encodeCbor("root"), Buffer.from([0x58, 0x20]), Buffer.from(ROOT, "hex"),
    encodeCbor("count"), encodeCbor(3),
  ]);
}

const closing: Spec = {
  label: "closing", height: 13, contentType: "application/json", body: new Uint8Array(),
  metadata: closingField(),
};

async function view(specs: Spec[]): Promise<{ pieces: { number: number; authentic: boolean; inscription: string | null }[]; closing: string | null }> {
  const indexer = new Indexer("mainnet");
  specs.forEach((spec, index) => indexer.inscriptions.set(idOf(spec.label), inscription(spec, index)));
  const result = await collectionView(indexer, { tipHeight: 30, blockHash: () => null });
  if (result.status !== "present") throw new Error("the collection was not found");
  return {
    pieces: (result.pieces ?? []).map((piece) => ({ number: piece.number, authentic: piece.authentic, inscription: piece.inscriptionId ? piece.inscriptionId : null })),
    closing: result.closingId ?? null,
  };
}

type Want = (number: number) => string | null;
async function authCase(name: string, description: string, specs: Spec[], want: Want, wantClosing = false): Promise<Json> {
  const result = await view(specs);
  for (const piece of result.pieces) {
    const expected = want(piece.number);
    const label = expected === null ? null : idOf(expected);
    if (piece.inscription !== label || piece.authentic !== (label !== null)) {
      throw new Error(`${name}: piece ${piece.number} is ${piece.inscription ?? "empty"}, expected ${expected ?? "empty"}`);
    }
  }
  if ((result.closing !== null) !== wantClosing) throw new Error(`${name}: closing mismatch`);
  return {
    name,
    description,
    genesis_field5_hex: hex(genesis.metadata as Uint8Array),
    leaf_list_hex: hex(leafList),
    items: specs.map((spec, index) => ({
      label: spec.label,
      id: idOf(spec.label),
      order: index,
      created_height: spec.height,
      created_index: spec.index ?? 0,
      reveal_key: spec.issuer ?? ISSUER,
      content_type: spec.contentType ?? "image/png",
      body_hex: hex(spec.body),
      field5_hex: spec.metadata ? hex(spec.metadata) : null,
    })),
    expected_pieces: result.pieces.map((piece) => ({ number: piece.number, authentic: piece.authentic, item: piece.inscription ? specs.find((spec) => idOf(spec.label) === piece.inscription)?.label ?? null : null })),
    closing: wantClosing ? "closing" : null,
  };
}

export async function authenticityVectors(): Promise<Json> {
  const real = [item(1, 11), item(2, 12), item(3, 14)];
  const reordered = encodeCbor({ meta: { attributes: [{ trait_type: "Tone", value: "2" }], name: "Item#2" } });
  const reorderedTrait = encodeCbor({ meta: { name: "Item#2", attributes: [{ value: "2", trait_type: "Tone" }] } });
  const itemSet = [1, 2, 3].map((number) => ({
    number,
    body_hex: hex(bodyOf(number)),
    metadata_hex: hex(metadataOf(number)),
    leaf: hex(leafHash(number, bodyOf(number), metadataOf(number))),
  }));
  return {
    item_set_root: {
      name: "TV5-2 root of an item set",
      description: "The three items of the cases below, numbers 1 to 3. The root is the PINS-5 §5.1 fold of their leaves in number order, and `leaf_list_hex` is the leaves back to back, the body of the leaf list (PINS-5 §6).",
      items: itemSet,
      leaf_list_hex: hex(leafList),
      root: ROOT,
    },
    description: "Authenticity of items, PINS-5 §9. A collection of three items (numbers 1 to 3, name prefix `Item#`, content type `image/png`) is built from a genesis, a leaf list and the listed P2MR Inscriptions, in the order given. `expected_pieces` is what the reference indexer reports for each number. A piece is authentic when a P2MR Inscription of the issuer key, after the genesis and before any closing, with the right content type and name, has a leaf equal to the leaf list entry. Only the first one that qualifies for a number counts.",
    spec: "PINS-5 §9",
    cases: [
      await authCase("TV5-3 forged copy signed by another key", "Another key inscribes a byte-for-byte copy of item 2 first. It is not an item: its reveal key is not the issuer. The issuer's own item 2 afterwards still takes the piece.", [genesis, list, item(1, 11), item(2, 11, { issuer: OTHER }), item(2, 12), item(3, 14)], (n) => (n === 2 ? "item 2 at 12" : `item ${n} at ${n === 1 ? 11 : 14}`)),
      await authCase("TV5-3 forged copy by the issuer with another body", "The issuer key signs an item 2 whose body is not the one in the leaf list. The leaf differs, so piece 2 stays empty.", [genesis, list, item(1, 11), item(2, 12, { body: text("another body"), label: " with another body" }), item(3, 14)], (n) => (n === 2 ? null : `item ${n} at ${n === 1 ? 11 : 14}`)),
      await authCase("TV5-4 item inscribed after closing", "Items 1 and 2 are inscribed, then the issuer closes the collection, then item 3 is inscribed. Item 3 is not authentic because it comes after the closing P2MR Inscription.", [genesis, list, item(1, 11), item(2, 12), closing, item(3, 14)], (n) => (n === 3 ? null : `item ${n} at ${n === 1 ? 11 : 12}`), true),
      await authCase("TV5-4 control, no closing", "The same P2MR Inscriptions without the closing: item 3 is authentic.", [genesis, list, item(1, 11), item(2, 12), item(3, 14)], (n) => `item ${n} at ${n === 1 ? 11 : n === 2 ? 12 : 14}`),
      await authCase("TV4-3 metadata keys reordered", "Item 2 carries valid CBOR in which `attributes` comes before `name`. The bytes differ from the canonical encoding, so the leaf differs and piece 2 stays empty.", [genesis, list, item(1, 11), item(2, 12, { metadata: reordered, label: " reordered" }), item(3, 14)], (n) => (n === 2 ? null : `item ${n} at ${n === 1 ? 11 : 14}`)),
      await authCase("TV4-3 attribute keys reordered", "Item 2 carries valid CBOR in which `value` comes before `trait_type`. Same result.", [genesis, list, item(1, 11), item(2, 12, { metadata: reorderedTrait, label: " reordered trait" }), item(3, 14)], (n) => (n === 2 ? null : `item ${n} at ${n === 1 ? 11 : 14}`)),
      await authCase("TV4-3 control, canonical metadata", "The same item 2 with canonical metadata is authentic.", real.length ? [genesis, list, ...real] : [], (n) => `item ${n} at ${n === 1 ? 11 : n === 2 ? 12 : 14}`),
    ],
  };
}

// ---------------------------------------------------------------- TV4-2: the canonical PNG

const PALETTE: [number, number, number, number][] = [[0, 0, 0, 255], [220, 40, 40, 255], [40, 180, 80, 255], [250, 250, 250, 255]];

/** The IDAT data of a PNG, inflated, as the scanlines with their filter bytes. */
function filteredScanlines(png: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 8;
  let colorType = -1;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    if (type === "IHDR") colorType = png[offset + 8 + 9];
    if (type === "IDAT") parts.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  void colorType;
  return inflateSync(Buffer.concat(parts));
}

export function pngVectors(): Json {
  const width = 24;
  const height = 24;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = PALETTE[((x >> 2) + (y >> 2)) % 4];
      rgba.set([r, g, b, a], (y * width + x) * 4);
    }
  }
  const encoded = encodeCanonicalPng(rgba, width, height);
  const bytes = Buffer.from(encoded.bytes);
  const decoded = decodePng(bytes);
  if (!Buffer.from(decoded.rgba).equals(rgba)) throw new Error("TV4-2: the canonical PNG does not decode to the pixels");
  const ihdr = bytes.subarray(16, 29);
  const chunkTypes: string[] = [];
  for (let offset = 8; offset < bytes.length; offset += 12 + bytes.readUInt32BE(offset)) chunkTypes.push(bytes.toString("latin1", offset + 4, offset + 8));
  const scanlines = filteredScanlines(bytes);
  const metadata = metadataOf(1);
  return {
    description: "TV4-2: the canonical PNG of one item, PINS-4 §5, hashed as PINS-5 §5.1. The pixels are a 24 by 24 pattern of four opaque colours in 4 by 4 blocks (palette in `palette`, colour index of pixel (x, y) is ((x >> 2) + (y >> 2)) mod 4). The encoder picks the shortest candidate, so the result is an indexed PNG. `scanlines_sha256` is the SHA-256 of the inflated IDAT data (one filter byte and the packed indices per row): it depends only on the rules of PINS-4 §5 and must match for every conforming encoder. `png_sha256` and `leaf` also depend on the deflate stream (Node zlib level 9, windowBits 15, memLevel 8): a conforming encoder that deflates differently produces another file for the same pixels and must be compared by `scanlines_sha256`, not by `png_sha256`.",
    spec: "PINS-4 §5",
    width,
    height,
    palette: PALETTE,
    rgba_sha256: sha256(rgba),
    ihdr_hex: hex(ihdr),
    chunk_types: chunkTypes,
    scanlines_sha256: sha256(scanlines),
    png_hex: hex(bytes),
    png_sha256: sha256(bytes),
    metadata_hex: hex(metadata),
    leaf: hex(leafHash(1, bytes, metadata)),
  };
}
