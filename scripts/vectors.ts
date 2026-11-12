// SPDX-License-Identifier: Apache-2.0

/**
 * Builds the test vectors in docs/specs/vectors/ with the code of this repository.
 *   node --experimental-strip-types scripts/vectors.ts          prints nothing, checks the files
 *   node --experimental-strip-types scripts/vectors.ts --write  rewrites the files
 * `packages/protocol/vectors.test.ts` recomputes every file and fails on a difference.
 * Every value is built from public, synthetic inputs, except the genesis of the public example
 * collection, which is read from the chain.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalMetadataCbor, encodeCbor } from "../packages/collection/canonical.mjs";
import { decodeCbor } from "../packages/indexer/cbor.ts";
import { collectionView } from "../packages/indexer/collection.ts";
import { Indexer, type Inscription } from "../packages/indexer/pins.ts";
import { buildEnvelope, concatBytes, contentTypeField, metadataField, parseEnvelopes, pointerField, pushBytes, revealLeaf, MARKER, OP_ENDIF, OP_FALSE, OP_IF } from "../packages/inscriber/script.ts";
import { encodeGenesisField } from "../packages/inscriber/preflight.ts";
import { leafHash, leafListRoot, merkleLevels, merkleProof, merkleRoot, verifyMerkleProof } from "../packages/protocol/merkle.mjs";
import { RESERVE_TEST_SEED, reserveRank, saleOrder, saleSeed, selectReserve } from "../packages/protocol/reserve.mjs";

export const VECTOR_DIR = join(dirname(fileURLToPath(import.meta.url)), "../docs/specs/vectors");

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const sha256 = (bytes: Uint8Array): Buffer => createHash("sha256").update(bytes).digest();
const fromHex = (value: string): Buffer => Buffer.from(value, "hex");

type Json = Record<string, unknown>;

function leafVectors(): Json {
  const ok = (name: string, number: number, body: Uint8Array, metadata: Uint8Array) => ({
    name,
    number,
    body_hex: hex(body),
    metadata_hex: hex(metadata),
    body_sha256: hex(sha256(body)),
    metadata_sha256: hex(sha256(metadata)),
    preimage_hex: hex(concatBytes([u32(number), sha256(body), sha256(metadata)])),
    leaf: hex(leafHash(number, body, metadata)),
  });
  const metadata = canonicalMetadataCbor({ meta: { name: "Item#1", attributes: [{ trait_type: "Tone", value: "0" }] } });
  const rejected = (name: string, number: number) => {
    let refused = false;
    try {
      leafHash(number, new Uint8Array(), new Uint8Array());
    } catch {
      refused = true;
    }
    if (!refused) throw new Error(`leaf of number ${number} was not refused`);
    return { name, number, body_hex: "", metadata_hex: "", error: true };
  };
  return {
    description: "Leaf of one item, PINS-5 §5.1: SHA256(u32be(number) || SHA256(body) || SHA256(metadata)). The body and the metadata are the exact inscribed bytes. A number outside 0 to 4294967295 has no leaf.",
    spec: "PINS-5 §5.1",
    cases: [
      ok("one-byte body, empty metadata", 1, Uint8Array.of(0x42), new Uint8Array()),
      ok("empty body, empty metadata", 1, new Uint8Array(), new Uint8Array()),
      ok("text body, canonical metadata of one item", 1, text("body one"), metadata),
      ok("number 0", 0, text("body zero"), metadata),
      ok("number 7", 7, text("body seven"), metadata),
      ok("largest number", 4294967295, text("body"), metadata),
      rejected("number below 0", -1),
      rejected("number above the largest", 4294967296),
    ],
  };
}

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value, 0);
  return out;
}

/** Synthetic leaves: SHA-256 of the ASCII text "leaf <index>". Any 32-byte values would do. */
function syntheticLeaves(count: number): Buffer[] {
  return Array.from({ length: count }, (_, index) => sha256(text(`leaf ${index}`)));
}

function rootVectors(): Json {
  const counts = [1, 2, 3, 4, 5, 6, 7, 8, 9, 16, 17];
  const cases = counts.map((count) => {
    const leaves = syntheticLeaves(count);
    return {
      name: `${count} leaves`,
      leaves: leaves.map(hex),
      root: merkleRoot(leaves),
      levels: merkleLevels(leaves).map((level) => level.map(hex)),
    };
  });
  const three = syntheticLeaves(3);
  const four = [...three, three[2]];
  if (merkleRoot(three) !== merkleRoot(four)) throw new Error("the duplicated last node must keep the root");
  return {
    description: "Root of a list of 32-byte leaves, PINS-5 §5.1: parent = SHA256(left || right), a level with an odd number of nodes duplicates its last node, and the root of one leaf is that leaf. `levels` lists every level from the leaves up. An odd level is shown with its duplicate. The leaves are SHA-256 of the text `leaf <index>`.",
    spec: "PINS-5 §5.1",
    cases,
    equal_roots: [
      {
        name: "three leaves and four leaves whose last two are equal fold to one root",
        left: three.map(hex),
        right: four.map(hex),
        root: merkleRoot(three),
        note: "The tree alone cannot tell them apart. The genesis fixes the supply, and every leaf commits to its own number, so a position at or after the supply is refused (see merkle-proof.json).",
      },
    ],
    empty: { leaves: [], error: true },
  };
}

function proofVectors(): Json {
  const valid: Json[] = [];
  for (const count of [1, 2, 3, 4, 5, 7, 9]) {
    const leaves = syntheticLeaves(count);
    const root = merkleRoot(leaves);
    for (let index = 0; index < count; index += 1) {
      const path = merkleProof(leaves, index);
      if (!verifyMerkleProof(leaves[index], index, count, path, root)) throw new Error("a built proof does not verify");
      valid.push({ count, index, leaf: hex(leaves[index]), path, root, valid: true });
    }
  }
  const leaves = syntheticLeaves(5);
  const root = merkleRoot(leaves);
  const path = merkleProof(leaves, 2);
  const flip = (value: string): string => (value.startsWith("0") ? "1" : "0") + value.slice(1);
  const refused = (name: string, input: { leaf: string; index: number; count: number; path: string[]; root: string }) => {
    if (verifyMerkleProof(fromHex(input.leaf), input.index, input.count, input.path, input.root)) throw new Error(`${name} was accepted`);
    return { name, ...input, valid: false };
  };
  const three = syntheticLeaves(3);
  const threeRoot = merkleRoot(three);
  const padded = merkleProof(three, 2);
  if (!verifyMerkleProof(three[2], 3, 4, padded, threeRoot)) throw new Error("the duplicated last node must verify in a tree of four");
  valid.push({ name: "the proof of the third of three leaves also proves the fourth of four leaves whose last two are equal", count: 4, index: 3, leaf: hex(three[2]), path: padded, root: threeRoot, valid: true });
  return {
    description: "Proofs of a leaf at a position in a tree of `count` leaves. `path` lists the sibling hashes from the leaf up, as hex. A verifier takes the leaf, the position, the count, the path and the root. It refuses a position at or after the count, and a path whose length is not the depth of that tree (ceil(log2(count)) levels, none for one leaf).",
    spec: "PINS-5 §5.1",
    valid,
    invalid: [
      refused("wrong root", { leaf: hex(leaves[2]), index: 2, count: 5, path, root: flip(root) }),
      refused("leaf changed", { leaf: flip(hex(leaves[2])), index: 2, count: 5, path, root }),
      refused("a sibling changed", { leaf: hex(leaves[2]), index: 2, count: 5, path: [flip(path[0]), ...path.slice(1)], root }),
      refused("position changed to its neighbour", { leaf: hex(leaves[2]), index: 3, count: 5, path, root }),
      refused("path too short", { leaf: hex(leaves[2]), index: 2, count: 5, path: path.slice(0, -1), root }),
      refused("path too long", { leaf: hex(leaves[2]), index: 2, count: 5, path: [...path, path[0]], root }),
      refused("position equal to the count", { leaf: hex(leaves[4]), index: 5, count: 5, path: merkleProof(leaves, 4), root }),
      refused("negative position", { leaf: hex(leaves[0]), index: -1, count: 5, path: merkleProof(leaves, 0), root }),
      refused("count of zero", { leaf: hex(leaves[0]), index: 0, count: 0, path: [], root: hex(leaves[0]) }),
      refused("one leaf with a path", { leaf: hex(leaves[0]), index: 0, count: 1, path: [hex(leaves[0])], root: merkleRoot([leaves[0]]) }),
      refused("duplicated last node of three leaves, claimed as a fourth item", { leaf: hex(three[2]), index: 3, count: 3, path: [hex(three[2]), merkleProof(three, 2)[1]], root: threeRoot }),
    ],
  };
}

function leafListVectors(): Json {
  const body = (count: number) => Buffer.concat(syntheticLeaves(count));
  const valid = (count: number) => ({ name: `${count} leaves`, body_hex: hex(body(count)), root: leafListRoot(body(count)) });
  const refused = (name: string, bytes: Uint8Array) => {
    if (leafListRoot(bytes) !== null) throw new Error(`${name} was accepted`);
    return { name, body_hex: hex(bytes), root: null };
  };
  return {
    description: "Root of a leaf list body, PINS-5 §6: the 32-byte leaves back to back, folded as in PINS-5 §5.1. A body that is empty or whose length is not a multiple of 32 has no root. The leaves are SHA-256 of the text `leaf <index>`.",
    spec: "PINS-5 §6",
    cases: [
      valid(1), valid(2), valid(3), valid(5), valid(8),
      refused("empty body", new Uint8Array()),
      refused("31 bytes", body(1).subarray(0, 31)),
      refused("33 bytes", Buffer.concat([body(1), Buffer.alloc(1)])),
      refused("two leaves and one byte", Buffer.concat([body(2), Buffer.alloc(1)])),
    ],
  };
}

function cborVectors(): Json {
  const bytes = (value: unknown): unknown => {
    if (value instanceof Uint8Array) return { bytes: hex(value) };
    if (Array.isArray(value)) return value.map(bytes);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, bytes(entry)]));
    return value;
  };
  const accept = (name: string, data: string) => ({ name, hex: data, value: bytes(decodeCbor(fromHex(data))) });
  const reject = (name: string, data: string) => {
    try {
      decodeCbor(fromHex(data));
    } catch {
      return { name, hex: data, error: true };
    }
    throw new Error(`${name} was accepted`);
  };
  const nest = (depth: number) => "81".repeat(depth) + "00";
  return {
    description: "Reader of field 5, PINS-4 §2.1: definite lengths, shortest integer arguments, text map keys, valid UTF-8, no tags, no floats, no undefined, a depth limit of 32, no bytes after the value. A repeated map key is not an error: the last value replaces the earlier one. `value` is the JSON of the decoded value, with a byte string as {\"bytes\": hex}.",
    spec: "PINS-4 §2.1",
    accept: [
      accept("unsigned 0", "00"),
      accept("unsigned 23", "17"),
      accept("unsigned 24, one-byte argument", "1818"),
      accept("unsigned 255", "18ff"),
      accept("unsigned 256, two-byte argument", "190100"),
      accept("unsigned 65536, four-byte argument", "1a00010000"),
      accept("unsigned 4294967296, eight-byte argument", "1b0000000100000000"),
      accept("negative -1", "20"),
      accept("empty text", "60"),
      accept("text", "6568656c6c6f"),
      accept("text with a multi-byte character", "62c3a9"),
      accept("empty byte string", "40"),
      accept("byte string", "43010203"),
      accept("empty array", "80"),
      accept("array of two", "820102"),
      accept("empty map", "a0"),
      accept("map with a text key", "a1616101"),
      accept("false, true, null", "83f4f5f6"),
      accept("nested map and array", "81a1616b01"),
      accept("repeated key, the last value wins", "a2616101616102"),
      accept("depth 32", nest(32)),
    ],
    reject: [
      reject("empty input", ""),
      reject("trailing byte", "0000"),
      reject("truncated one-byte argument", "18"),
      reject("truncated text", "6268"),
      reject("declared length longer than the data", "a1"),
      reject("one-byte argument for a value below 24", "1817"),
      reject("two-byte argument for a value below 256", "1900ff"),
      reject("four-byte argument for a value below 65536", "1a0000ffff"),
      reject("eight-byte argument for a value below 4294967296", "1b00000000ffffffff"),
      reject("indefinite array", "9fff"),
      reject("indefinite text", "7fff"),
      reject("tag", "c000"),
      reject("half-precision float", "f90000"),
      reject("double-precision float", "fb0000000000000000"),
      reject("undefined", "f7"),
      reject("simple value 16", "f0"),
      reject("one-byte simple value", "f814"),
      reject("integer key", "a10101"),
      reject("byte string key", "a1410101"),
      reject("invalid UTF-8 in text", "61ff"),
      reject("reserved additional information 28", "1c"),
      reject("depth 33", nest(33)),
    ],
  };
}

function metadataVectors(): Json {
  const accept = (name: string, value: unknown) => ({ name, input: value, cbor_hex: hex(canonicalMetadataCbor(value)) });
  const reject = (name: string, value: unknown) => {
    try {
      canonicalMetadataCbor(value);
    } catch {
      return { name, input: value, error: true };
    }
    throw new Error(`${name} was accepted`);
  };
  return {
    description: "Canonical metadata of an item, PINS-4 §2: the JSON record `{ meta: { name, attributes } }`, with an optional `file` key that is not encoded, becomes definite-length CBOR with the keys in this order: meta, name, attributes, and trait_type then value for each attribute. The input is the JSON.",
    spec: "PINS-4 §2",
    accept: [
      accept("name and no attribute", { meta: { name: "Item#1", attributes: [] } }),
      accept("one attribute", { meta: { name: "Item#2", attributes: [{ trait_type: "Tone", value: "0" }] } }),
      accept("two attributes", { meta: { name: "Item#3", attributes: [{ trait_type: "Tone", value: "1" }, { trait_type: "Shape", value: "round" }] } }),
      accept("a file key is dropped", { file: "3.png", meta: { name: "Item#3", attributes: [] } }),
      accept("the record in a one-element array", [{ meta: { name: "Item#4", attributes: [] } }]),
    ],
    reject: [
      reject("meta keys out of order", { meta: { attributes: [], name: "Item#1" } }),
      reject("an unknown key beside meta", { meta: { name: "Item#1", attributes: [] }, extra: 1 }),
      reject("attribute keys out of order", { meta: { name: "Item#1", attributes: [{ value: "0", trait_type: "Tone" }] } }),
      reject("a numeric attribute value", { meta: { name: "Item#1", attributes: [{ trait_type: "Tone", value: 0 }] } }),
      reject("no meta", { file: "1.png" }),
    ],
  };
}

const ISSUER = "ab".repeat(32);
const ROOT = "cd".repeat(32);
const COMMITMENT = "ee".repeat(32);

function inscription(partial: Partial<Inscription> & { id: string }): Inscription {
  return {
    txid: "11".repeat(32), n: 0, number: 0, location: { state: "unbound" }, flags: [], contentType: "application/json",
    body: new Uint8Array(), bodySha256: "", metadata: null, fields: [], createdHeight: 1, createdIndex: 0, locationHeight: 1,
    leafIssuer: ISSUER, ownerScript: "", ownerAddress: "", ...partial,
  };
}

async function present(field: Uint8Array, over: Partial<Inscription> = {}): Promise<boolean> {
  const indexer = new Indexer();
  indexer.inscriptions.set("g", inscription({ id: "g", metadata: field, ...over }));
  const view = await collectionView(indexer, { tipHeight: 20, blockHash: () => null });
  return view.status === "present";
}

const baseGenesis = {
  schema: "pins-collection/1", name: "Example", supply: 3, first: 1, name_prefix: "Item#", root: ROOT, issuer: ISSUER,
  item_type: "image/png", sale_commitment: COMMITMENT,
};

async function genesisVectors(): Promise<Json> {
  const accept = async (name: string, map: Record<string, unknown>, over: Partial<Inscription> = {}) => {
    const field = encodeCbor(map);
    if (!(await present(field, over))) throw new Error(`${name} was refused`);
    return { name, field5_hex: hex(field), content_type: over.contentType ?? "application/json", reveal_key: over.leafIssuer ?? ISSUER, genesis: true };
  };
  const reject = async (name: string, map: Record<string, unknown>, over: Partial<Inscription> = {}) => {
    const field = encodeCbor(map);
    if (await present(field, over)) throw new Error(`${name} was accepted`);
    return { name, field5_hex: hex(field), content_type: over.contentType ?? "application/json", reveal_key: over.leafIssuer ?? ISSUER, genesis: false };
  };
  const without = (key: string) => Object.fromEntries(Object.entries(baseGenesis).filter(([name]) => name !== key));
  const encoded = async (input: Parameters<typeof encodeGenesisField>[0]) => hex(await encodeGenesisField(input));
  const toInput = { schema: "pins-collection/1", name: "Example", supply: 3, first: 1, namePrefix: "Item#", itemType: "image/png", root: ROOT, issuer: ISSUER };
  const reserve = { groups: [{ trait_type: "Tone", value: "0", count: 1 }], extra: 1 };
  return {
    description: "Genesis of a collection, PINS-5 §3. Field 5 is a CBOR map with these keys in this order: schema, name, supply, first, name_prefix, root, issuer, item_type, then sale_commitment when the collection declares a sale, then reserve when it declares one. `genesis` says whether the reference indexer takes the P2MR Inscription as the genesis of a collection. The issuer text must equal the key that signs the reveal (`reveal_key`). The content type must be `application/json`.",
    spec: "PINS-5 §3",
    encode: [
      { name: "with a sale", input: { ...toInput, saleCommitment: COMMITMENT }, field5_hex: await encoded({ ...toInput, saleCommitment: COMMITMENT }) },
      { name: "no sale", input: toInput, field5_hex: await encoded(toInput) },
    ],
    cases: [
      await accept("with a sale", baseGenesis),
      await accept("no sale, eight keys", without("sale_commitment")),
      await accept("with a sale and a declared reserve", { ...baseGenesis, reserve }),
      await accept("first item number 0", { ...baseGenesis, first: 0 }),
      await reject("another schema", { ...baseGenesis, schema: "pins-collection/2" }),
      await reject("name and supply swapped", { schema: baseGenesis.schema, supply: 3, name: "Example", first: 1, name_prefix: "Item#", root: ROOT, issuer: ISSUER, item_type: "image/png", sale_commitment: COMMITMENT }),
      await reject("an extra key", { ...baseGenesis, extra: 1 }),
      await reject("a price key", { ...baseGenesis, price_bits: 1 }),
      await reject("reserve not last", { ...without("sale_commitment"), reserve, sale_commitment: COMMITMENT }),
      await reject("missing name_prefix", without("name_prefix")),
      await reject("empty name", { ...baseGenesis, name: "" }),
      await reject("supply 0", { ...baseGenesis, supply: 0 }),
      await reject("supply as text", { ...baseGenesis, supply: "3" }),
      await reject("root of 63 characters", { ...baseGenesis, root: ROOT.slice(1) }),
      await reject("root in upper case", { ...baseGenesis, root: ROOT.toUpperCase().replace(/[0-9]/g, "C") }),
      await reject("sale_commitment of 63 characters", { ...baseGenesis, sale_commitment: COMMITMENT.slice(1) }),
      await reject("empty item_type", { ...baseGenesis, item_type: "" }),
      await reject("issuer text that is not the reveal key", baseGenesis, { leafIssuer: "12".repeat(32) }),
      await reject("content type that is not JSON", baseGenesis, { contentType: "text/plain" }),
    ],
  };
}

/** The genesis field 5 of the public example collection, as read from the chain. */
function realGenesis(): Promise<Json> {
  const values = {
    schema: "pins-collection/1", name: "Flatbits", supply: 10000, first: 1, namePrefix: "Flatbit#",
    root: "70768608a21dec18f611a643ed1f519a19df4a0eca35c65a62588d383dcaf7b2",
    issuer: "569bdca31b68cab9cf1580abd42829ef042d43e3641d85361f6ad5e4db2799db", itemType: "image/png",
    saleCommitment: "7e4a8a5a4782633d851e3de7cf06f096e6e6802ac68e34a9cfd816e624bcc8b6",
  };
  const onChain = "a966736368656d617170696e732d636f6c6c656374696f6e2f31646e616d6568466c61746269747366737570706c79192710656669727374016b6e616d655f70726566697868466c61746269742364726f6f7478403730373638363038613231646563313866363131613634336564316635313961313964663461306563613335633635613632353838643338336463616637623266697373756572784035363962646361333162363863616239636631353830616264343238323965663034326434336533363431643835333631663661643565346462323739396462696974656d5f7479706569696d6167652f706e676f73616c655f636f6d6d69746d656e74784037653461386135613437383236333364383531653364653763663036663039366536653638303261633638653334613963666438313665363234626363386236";
  return encodeGenesisField(values).then((encoded) => {
    if (hex(encoded) !== onChain) throw new Error("the public example genesis does not re-encode to its on-chain bytes");
    return {
      description: "The genesis of the public example collection, read from Qbit mainnet. This is public chain data, kept here as a real check of the encoder. It carries no art and no private value.",
      spec: "PINS-5 §3",
      network: "mainnet",
      genesis_id: "15d6f9c48865b579f7d1144e4d2d71d905c6fe04458bebc814052a3e39a07784i0",
      leaf_list_id: "15d6f9c48865b579f7d1144e4d2d71d905c6fe04458bebc814052a3e39a07784i1",
      block_height: 161948,
      field5_hex: onChain,
      values,
    };
  });
}

function envelopeVectors(): Json {
  const pubkey = Buffer.alloc(32, 2);
  const field = (item: { tag: number; value: Uint8Array }) => ({ tag: item.tag, value_hex: hex(item.value) });
  const parsed = (script: Uint8Array) => parseEnvelopes(script).map((envelope) => ({
    fields: envelope.fields.map(field),
    body_hex: hex(envelope.body),
    flags: envelope.flags,
  }));
  const ok = (name: string, script: Uint8Array) => ({ name, script_hex: hex(script), envelopes: parsed(script) });
  const raw = (pushes: Uint8Array[], close = true) => concatBytes([
    pushBytes(pubkey),
    Uint8Array.of(0xb3, OP_FALSE, OP_IF), pushBytes(MARKER), ...pushes.map((push) => pushBytes(push)), close ? Uint8Array.of(OP_ENDIF) : new Uint8Array(),
  ]);
  const pattern = (length: number): Uint8Array => Uint8Array.from({ length }, (_, index) => index % 251);
  const meta = canonicalMetadataCbor({ meta: { name: "Item#1", attributes: [{ trait_type: "Tone", value: "0" }] } });
  const one = (fields: { tag: number; value: Uint8Array }[], body: Uint8Array) => revealLeaf(pubkey, [buildEnvelope(fields, body)]);
  const empty = new Uint8Array();
  // The writer and the specification agree: the tag of a chunked field repeats with each chunk of 520 bytes.
  const longMetadata = (length: number): Uint8Array => {
    const value = pattern(length);
    const pieces: Uint8Array[] = [];
    for (let offset = 0; offset < length; offset += 520) pieces.push(Uint8Array.of(5), value.subarray(offset, offset + 520));
    const byHand = raw([Uint8Array.of(1), text("application/octet-stream"), ...pieces, empty, text("x")]);
    const byWriter = one([contentTypeField("application/octet-stream"), metadataField(value)], text("x"));
    if (hex(byHand) !== hex(byWriter)) throw new Error(`the writer does not repeat the tag of a ${length}-byte field 5`);
    return byWriter;
  };
  const cases = [
    ok("text body with a content type", one([contentTypeField("text/plain;charset=utf-8")], text("hello"))),
    ok("an item: content type, metadata, body", one([contentTypeField("image/png"), metadataField(meta)], pattern(40))),
    ok("body of 520 bytes, one push", one([contentTypeField("application/octet-stream")], pattern(520))),
    ok("body of 521 bytes, two pushes", one([contentTypeField("application/octet-stream")], pattern(521))),
    ok("body of 1040 bytes, two full pushes", one([contentTypeField("application/octet-stream")], pattern(1040))),
    ok("metadata of 600 bytes, field 5 repeated with a chunk of 520 and a chunk of 80", longMetadata(600)),
    ok("metadata of 1040 bytes, field 5 repeated with two chunks of 520", longMetadata(1040)),
    ok("metadata of 1041 bytes, field 5 repeated with chunks of 520, 520 and 1", longMetadata(1041)),
    ok("three envelopes with pointers 0, 10000, 20000", revealLeaf(pubkey, [0n, 10000n, 20000n].map((pointer, index) => buildEnvelope([contentTypeField("text/plain"), pointerField(pointer)], text(`item ${index}`))))),
    ok("a leaf with no envelope", revealLeaf(pubkey, [])),
    ok("wrong marker", concatBytes([pushBytes(pubkey), Uint8Array.of(0xb3, OP_FALSE, OP_IF), pushBytes(text("pinx")), pushBytes(empty), pushBytes(text("x")), Uint8Array.of(OP_ENDIF)])),
    ok("missing OP_ENDIF", raw([Uint8Array.of(1), text("text/plain"), empty, text("x")], false)),
    ok("a non-push opcode inside", concatBytes([pushBytes(pubkey), Uint8Array.of(0xb3, OP_FALSE, OP_IF), pushBytes(MARKER), Uint8Array.of(0x76), pushBytes(empty), pushBytes(text("x")), Uint8Array.of(OP_ENDIF)])),
    ok("a truncated push", concatBytes([raw([empty, text("x")]), Uint8Array.of(0x05, 0x01)])),
    ok("no body separator", raw([Uint8Array.of(1), text("text/plain")])),
    ok("a tag with no value", raw([Uint8Array.of(1), text("text/plain"), Uint8Array.of(3)])),
    ok("a repeated content type", raw([Uint8Array.of(1), text("text/plain"), Uint8Array.of(1), text("text/html"), empty, text("x")])),
    ok("an unknown even tag", raw([Uint8Array.of(4), text("v"), empty, text("x")])),
    ok("an unknown odd tag is kept", raw([Uint8Array.of(7), text("v"), empty, text("x")])),
    ok("an empty value before the separator", raw([Uint8Array.of(1), empty, Uint8Array.of(5), Uint8Array.of(0xaa), empty, Uint8Array.of(0x42)])),
  ];
  return {
    description: "Envelopes in a reveal leaf script, PINS-1 §4. `script_hex` is the whole leaf script: a 32-byte public key, OP_CHECKSIGPQC, then the envelopes. `envelopes` is what the reference reader finds, in order: the fields (tag and value, with the pieces of field 5 joined), the body (its pieces joined) and the flags. An empty list means the script holds no envelope. The marker is `pins`. The public key is 32 bytes of 0x02.",
    spec: "PINS-1 §4",
    marker_hex: hex(MARKER),
    cases,
  };
}

function reserveVectors(): Json {
  const secret = Buffer.alloc(32, 0x11);
  const blockHash = Buffer.alloc(32, 0x22);
  const mixed = saleSeed(secret, blockHash);
  const ids = [1, 2, 3, 4, 5];
  const pieces = Array.from({ length: 10 }, (_, index) => ({ id: index + 1, attributes: [{ trait_type: "Tone", value: String(index % 2) }] }));
  const selected = selectReserve(pieces, RESERVE_TEST_SEED, { groups: [{ trait_type: "Tone", value: "0", count: 2 }], extra: 1 });
  return {
    description: "Reserve ranking, reserve selection and sale order, PINS-5 §8. The seeds are test values, not the secret of any collection. `rank` is SHA256(seed || 0x01 || u32be(n)).",
    spec: "PINS-5 §8",
    seed_ascii: RESERVE_TEST_SEED.toString("ascii"),
    ranks: [1, 2, 3].map((n) => ({ n, rank: hex(reserveRank(RESERVE_TEST_SEED, n)) })),
    selection: {
      pieces: pieces.map((piece) => ({ id: piece.id, attributes: piece.attributes })),
      groups: [{ trait_type: "Tone", value: "0", count: 2 }],
      extra: 1,
      reserve: [...selected.reserve].sort((a, b) => a - b),
      group_ids: selected.byGroup[0].ids,
      extra_ids: selected.extra,
      sale: selected.sale,
    },
    sale_order: {
      secret_hex: hex(secret),
      block_hash_hex: hex(blockHash),
      mixed_seed_hex: hex(mixed),
      ids,
      order: saleOrder(ids, mixed),
    },
  };
}

export async function buildVectors(): Promise<Record<string, string>> {
  const files: Record<string, Json> = {
    "merkle-leaf.json": leafVectors(),
    "merkle-root.json": rootVectors(),
    "merkle-proof.json": proofVectors(),
    "leaf-list.json": leafListVectors(),
    "cbor.json": cborVectors(),
    "metadata.json": metadataVectors(),
    "genesis.json": await genesisVectors(),
    "genesis-example.json": await realGenesis(),
    "envelope.json": envelopeVectors(),
    "reserve.json": reserveVectors(),
  };
  return Object.fromEntries(Object.entries(files).map(([name, value]) => [name, `${JSON.stringify(value, null, 2)}\n`]));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = await buildVectors();
  if (process.argv.includes("--write")) {
    mkdirSync(VECTOR_DIR, { recursive: true });
    for (const [name, content] of Object.entries(files)) writeFileSync(join(VECTOR_DIR, name), content);
    process.stdout.write(`wrote ${Object.keys(files).length} files\n`);
  } else {
    for (const [name, content] of Object.entries(files)) {
      if (!existsSync(join(VECTOR_DIR, name)) || readFileSync(join(VECTOR_DIR, name), "utf8") !== content) throw new Error(`${name} differs`);
    }
  }
}
