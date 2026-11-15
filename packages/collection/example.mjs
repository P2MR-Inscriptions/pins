// SPDX-License-Identifier: Apache-2.0

/**
 * A made-up collection for trying the tools, with no art or name of any real collection.
 * `exampleCollection` returns the files of the zip layout (`images/N.png`, `json/N.json`, `collection.json`),
 * the Merkle root, the collection profiles (with a sale and with none) and a price file. `zipOf` packs files into
 * a zip. Everything is deterministic: the same arguments give the same bytes and the same root.
 * Nothing here talks to a node, and nothing here is a default of the protocol.
 */
import { crc32, deflateRawSync } from "node:zlib";
import { leafHash, merkleRoot } from "../protocol/merkle.mjs";
import { canonicalMetadataCbor, encodeCanonicalPng } from "./canonical.mjs";

const SIDE = 16;
const TONES = [
  [231, 111, 81],
  [244, 162, 97],
  [42, 157, 143],
  [38, 70, 83],
];

/** A 16 by 16 picture: a flat background of the item's tone, and a square whose size follows the item number. */
function pixels(id) {
  const tone = TONES[id % TONES.length];
  const half = 2 + (id % 5);
  const rgba = Buffer.alloc(SIDE * SIDE * 4);
  for (let y = 0; y < SIDE; y += 1) {
    for (let x = 0; x < SIDE; x += 1) {
      const inside = Math.abs(x - 7.5) <= half && Math.abs(y - 7.5) <= half;
      const offset = (y * SIDE + x) * 4;
      rgba[offset] = inside ? 255 - tone[0] : tone[0];
      rgba[offset + 1] = inside ? 255 - tone[1] : tone[1];
      rgba[offset + 2] = inside ? 255 - tone[2] : tone[2];
      rgba[offset + 3] = 255;
    }
  }
  return rgba;
}

/**
 * @param {{ supply?: number, batchSize?: number }} [options]
 *   `supply` is the number of items (at least 8, so the sample reserve fits), `batchSize` the items in each reveal.
 */
export function exampleCollection({ supply = 12, batchSize = 4 } = {}) {
  if (!Number.isInteger(supply) || supply < 8) throw new Error("the example needs a supply of 8 or more");
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("the batch size must be a positive whole number");
  /** @type {Map<string, Buffer>} */
  const files = new Map();
  const leaves = [];
  for (let id = 1; id <= supply; id += 1) {
    const png = Buffer.from(encodeCanonicalPng(pixels(id), SIDE, SIDE).bytes);
    const record = [{ meta: { name: `Dot #${id}`, attributes: [{ trait_type: "Tone", value: String(id % TONES.length) }, { trait_type: "Size", value: String(id % 5) }] } }];
    files.set(`images/${id}.png`, png);
    files.set(`json/${id}.json`, Buffer.from(`${JSON.stringify(record)}\n`));
    leaves.push(leafHash(id, png, Buffer.from(canonicalMetadataCbor(record))));
  }
  files.set("collection.json", Buffer.from(`${JSON.stringify({ name: "Example Dots", description: "A made-up collection for trying the PINS tools. It is not a real collection." })}\n`));
  const root = merkleRoot(leaves);
  const common = { name: "Example Dots", namePrefix: "Dot #", supply, first: 1, schema: "pins-collection/1", itemType: "image/png", root, batchSize };
  return {
    files,
    root,
    /** A collection with a sale commitment: two reserved items, the rest for sale. */
    profileSale: { ...common, reserveGroups: [{ trait_type: "Tone", value: "0", count: 1 }], reserveExtra: 1 },
    /** A collection with no sale commitment. */
    profileNoSale: { ...common, sale: false },
    /** The file `price --price` reads. The numbers are for a rehearsal only. */
    price: {
      price_bits: 50_000,
      price_sources: ["rehearsal: the issuer chose 50000 bits"],
      price_time: "2026-01-01T00:00:00Z",
    },
  };
}

function dos(date) {
  return { time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1), day: ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate() };
}

/**
 * A zip of the given files (a Map of path to bytes), deflated, with a fixed time stamp so the bytes repeat.
 * Paths must be plain relative paths with `/`. It does not write 64-bit zips: a collection is far below 4 GiB.
 */
export function zipOf(files) {
  const stamp = dos(new Date(Date.UTC(2026, 0, 1)));
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, bytes] of files) {
    if (name.startsWith("/") || name.includes("..") || name.includes("\\")) throw new Error(`not a plain relative path: ${name}`);
    const packed = deflateRawSync(bytes, { level: 9 });
    const path = Buffer.from(name);
    const crc = crc32(bytes) >>> 0;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(8, 8);
    head.writeUInt16LE(stamp.time, 10);
    head.writeUInt16LE(stamp.day, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(bytes.length, 22);
    head.writeUInt16LE(path.length, 26);
    local.push(head, path, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(stamp.time, 12);
    entry.writeUInt16LE(stamp.day, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(path.length, 28);
    entry.writeUInt32LE(0o100644 * 65536, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, path);
    offset += head.length + path.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
