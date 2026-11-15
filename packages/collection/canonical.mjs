// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical P2MR Inscription bytes derived from the collection zip passed by the caller.
 * The zip is read only. Nothing in this module writes the source images or metadata files.
 *
 * PNG: lossless. Ancillary chunks, including bKGD, are not copied. The encoder keeps
 * 8-bit RGBA unless a shorter encoding decodes to the same pixels. Compression is
 * Node zlib.deflateSync level 9 (windowBits 15, memLevel 8, default strategy).
 * Each scanline uses the PNG filter (None, Sub, Up, Average, Paeth) with the lowest
 * sum of absolute byte values; ties keep the lower filter type.
 *
 * CBOR: RFC 8949 preferred serialization (shortest argument, definite lengths).
 * Map keys are emitted in insertion order, which this module fixes as:
 * meta, then name, attributes, and each attribute as trait_type then value.
 * The source `file` field is omitted. The one-element JSON array is not encoded.
 *
 * collection.json is inscribed as JSON, not CBOR. The canonical bytes are compact
 * UTF-8 JSON (JSON.stringify, no extra space), source key order, with
 * largeImageFormat removed, and a single trailing newline.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { leafFromDigests, merkleRoot as merkleRootOf } from "../protocol/merkle.mjs";

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, sum]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilter(data, height, rowBytes, bpp) {
  const raw = Buffer.alloc(height * rowBytes);
  let src = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = data[src];
    src += 1;
    const row = raw.subarray(y * rowBytes, (y + 1) * rowBytes);
    const prev = y > 0 ? raw.subarray((y - 1) * rowBytes, y * rowBytes) : null;
    for (let i = 0; i < rowBytes; i += 1) {
      const x = data[src];
      src += 1;
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      let value = x;
      if (filter === 1) value = (x + a) & 255;
      else if (filter === 2) value = (x + b) & 255;
      else if (filter === 3) value = (x + Math.floor((a + b) / 2)) & 255;
      else if (filter === 4) value = (x + paeth(a, b, c)) & 255;
      else if (filter !== 0) throw new Error(`Unsupported PNG filter ${filter}.`);
      row[i] = value;
    }
  }
  return raw;
}

function filterScanlines(rows, bpp) {
  const size = rows.reduce((sum, row) => sum + 1 + row.length, 0);
  const filtered = Buffer.alloc(size);
  let offset = 0;
  for (let y = 0; y < rows.length; y += 1) {
    const row = rows[y];
    const prev = y > 0 ? rows[y - 1] : null;
    let best = null;
    let bestScore = Infinity;
    let bestType = 0;
    for (let filter = 0; filter <= 4; filter += 1) {
      const out = Buffer.alloc(row.length);
      let score = 0;
      for (let i = 0; i < row.length; i += 1) {
        const x = row[i];
        const a = i >= bpp ? row[i - bpp] : 0;
        const b = prev ? prev[i] : 0;
        const c = prev && i >= bpp ? prev[i - bpp] : 0;
        let value = x;
        if (filter === 1) value = (x - a) & 255;
        else if (filter === 2) value = (x - b) & 255;
        else if (filter === 3) value = (x - Math.floor((a + b) / 2)) & 255;
        else if (filter === 4) value = (x - paeth(a, b, c)) & 255;
        out[i] = value;
        score += value < 128 ? value : 256 - value;
      }
      if (score < bestScore) {
        bestScore = score;
        best = out;
        bestType = filter;
      }
    }
    filtered[offset] = bestType;
    offset += 1;
    best.copy(filtered, offset);
    offset += best.length;
  }
  return deflateSync(filtered, { level: 9 });
}

export function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error("Not a PNG.");
  let offset = 8;
  let ihdr = null;
  const idat = [];
  let palette = null;
  let transparency = null;
  let ended = false;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > buf.length) throw new Error("Truncated PNG chunk.");
    const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buf.subarray(offset + 8, offset + 8 + length);
    const found = buf.readUInt32BE(offset + 8 + length);
    const expect = crc32(buf.subarray(offset + 4, offset + 8 + length)) >>> 0;
    if (found !== expect) throw new Error(`Bad CRC for ${type}.`);
    if (type === "IHDR") ihdr = Buffer.from(data);
    else if (type === "IDAT") idat.push(Buffer.from(data));
    else if (type === "PLTE") palette = Buffer.from(data);
    else if (type === "tRNS") transparency = Buffer.from(data);
    else if (type === "IEND") {
      ended = true;
      break;
    }
    offset = end;
  }
  if (!ended || !ihdr || ihdr.length !== 13) throw new Error("PNG is missing IHDR or IEND.");
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  if (ihdr[10] !== 0 || ihdr[11] !== 0 || ihdr[12] !== 0) throw new Error("Unsupported PNG compression or interlace.");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`Unsupported PNG color type ${colorType}.`);
  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8));
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
  const inflated = inflateSync(Buffer.concat(idat));
  if (inflated.length !== height * (rowBytes + 1)) throw new Error("PNG scanlines have the wrong size.");
  const raw = unfilter(inflated, height, rowBytes, bpp);
  return {
    width,
    height,
    bitDepth,
    colorType,
    rgba: toRgba(raw, width, height, colorType, bitDepth, palette, transparency),
  };
}

function toRgba(raw, width, height, colorType, bitDepth, palette, transparency) {
  const rgba = Buffer.alloc(width * height * 4);
  if (colorType === 6 && bitDepth === 8) {
    raw.copy(rgba);
    return rgba;
  }
  if (colorType === 2 && bitDepth === 8) {
    for (let i = 0, o = 0; i < raw.length; i += 3, o += 4) {
      rgba[o] = raw[i];
      rgba[o + 1] = raw[i + 1];
      rgba[o + 2] = raw[i + 2];
      rgba[o + 3] = 255;
    }
    return rgba;
  }
  if (colorType === 3 && palette) {
    const indices = unpackIndices(raw, width, height, bitDepth);
    for (let i = 0; i < indices.length; i += 1) {
      const index = indices[i];
      const p = index * 3;
      if (p + 2 >= palette.length) throw new Error("Palette index is out of range.");
      rgba[i * 4] = palette[p];
      rgba[i * 4 + 1] = palette[p + 1];
      rgba[i * 4 + 2] = palette[p + 2];
      rgba[i * 4 + 3] = transparency && index < transparency.length ? transparency[index] : 255;
    }
    return rgba;
  }
  throw new Error(`Cannot expand PNG color type ${colorType} bit depth ${bitDepth}.`);
}

function unpackIndices(raw, width, height, bitDepth) {
  const indices = new Array(width * height);
  const rowBytes = Math.ceil((width * bitDepth) / 8);
  let n = 0;
  for (let y = 0; y < height; y += 1) {
    const row = raw.subarray(y * rowBytes, (y + 1) * rowBytes);
    let acc = 0;
    let bits = 0;
    let o = 0;
    for (let x = 0; x < width; x += 1) {
      if (bits < bitDepth) {
        acc = (acc << 8) | row[o];
        o += 1;
        bits += 8;
      }
      bits -= bitDepth;
      indices[n] = (acc >> bits) & ((1 << bitDepth) - 1);
      n += 1;
    }
  }
  return indices;
}

function pngBytes(width, height, bitDepth, colorType, idat, extra = []) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  return Buffer.concat([PNG_SIG, chunk("IHDR", ihdr), ...extra, chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

function rowsFrom(raw, width, channels) {
  const stride = width * channels;
  const rows = [];
  for (let y = 0; y < raw.length; y += stride) rows.push(raw.subarray(y, y + stride));
  return rows;
}

function encodeRgba(rgba, width, height) {
  return pngBytes(width, height, 8, 6, filterScanlines(rowsFrom(rgba, width, 4), 4));
}

function encodeRgb(rgba, width, height) {
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) {
    if (rgba[i + 3] !== 255) return null;
    rgb[o] = rgba[i];
    rgb[o + 1] = rgba[i + 1];
    rgb[o + 2] = rgba[i + 2];
  }
  return pngBytes(width, height, 8, 2, filterScanlines(rowsFrom(rgb, width, 3), 3));
}

function packRow(indices, bitDepth) {
  const rowBytes = Math.ceil((indices.length * bitDepth) / 8);
  const out = Buffer.alloc(rowBytes);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const value of indices) {
    acc = (acc << bitDepth) | value;
    bits += bitDepth;
    if (bits === 8) {
      out[o] = acc;
      o += 1;
      acc = 0;
      bits = 0;
    }
  }
  if (bits) out[o] = acc << (8 - bits);
  return out;
}

function encodeIndexed(rgba, width, height, bitDepth) {
  const colors = [];
  const indexOf = new Map();
  const indices = new Array(width * height);
  for (let i = 0, pixel = 0; i < rgba.length; i += 4, pixel += 1) {
    const key = `${rgba[i]},${rgba[i + 1]},${rgba[i + 2]},${rgba[i + 3]}`;
    let index = indexOf.get(key);
    if (index === undefined) {
      if (colors.length === 256) return null;
      index = colors.length;
      indexOf.set(key, index);
      colors.push([rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]);
    }
    indices[pixel] = index;
  }
  const maxIndex = (1 << bitDepth) - 1;
  if (colors.length > maxIndex + 1) return null;
  const rows = [];
  for (let y = 0; y < height; y += 1) rows.push(packRow(indices.slice(y * width, (y + 1) * width), bitDepth));
  const plte = Buffer.alloc(colors.length * 3);
  const alpha = Buffer.alloc(colors.length);
  let opaque = true;
  for (let i = 0; i < colors.length; i += 1) {
    plte[i * 3] = colors[i][0];
    plte[i * 3 + 1] = colors[i][1];
    plte[i * 3 + 2] = colors[i][2];
    alpha[i] = colors[i][3];
    if (colors[i][3] !== 255) opaque = false;
  }
  const extra = [chunk("PLTE", plte)];
  if (!opaque) extra.push(chunk("tRNS", alpha));
  return pngBytes(width, height, bitDepth, 3, filterScanlines(rows, 1), extra);
}

function pixelsMatch(png, rgba) {
  const decoded = decodePng(png);
  return decoded.rgba.equals(rgba);
}

export function encodeCanonicalPng(rgba, width, height) {
  const rgbaPng = encodeRgba(rgba, width, height);
  if (!pixelsMatch(rgbaPng, rgba)) throw new Error("RGBA re-encode changed pixels.");
  let best = rgbaPng;
  const candidates = [encodeRgb(rgba, width, height)];
  for (const depth of [1, 2, 4, 8]) candidates.push(encodeIndexed(rgba, width, height, depth));
  for (const candidate of candidates) {
    if (!candidate || candidate.length >= best.length) continue;
    if (!pixelsMatch(candidate, rgba)) continue;
    best = candidate;
  }
  return { bytes: best, colorType: best[25], bitDepth: best[24] };
}

export function pngChunkTypes(buf) {
  const types = [];
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
    types.push(type);
    offset += 12 + length;
    if (type === "IEND") break;
  }
  return types;
}

function cborHead(major, length) {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  if (length < 65536) {
    const bytes = Buffer.alloc(3);
    bytes[0] = (major << 5) | 25;
    bytes.writeUInt16BE(length, 1);
    return bytes;
  }
  if (length <= 0xffffffff) {
    const bytes = Buffer.alloc(5);
    bytes[0] = (major << 5) | 26;
    bytes.writeUInt32BE(length, 1);
    return bytes;
  }
  throw new Error("CBOR length does not fit in 32 bits.");
}

export function encodeCbor(value) {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) throw new Error("CBOR encoder accepts unsigned integers only.");
    return cborHead(0, value);
  }
  if (typeof value === "string") {
    const text = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, text.length), text]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([cborHead(4, value.length), ...value.map((entry) => encodeCbor(entry))]);
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    return Buffer.concat([
      cborHead(5, keys.length),
      ...keys.flatMap((key) => [encodeCbor(key), encodeCbor(value[key])]),
    ]);
  }
  throw new Error("Unsupported CBOR value.");
}

export function canonicalMetadataCbor(parsed) {
  const record = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Metadata record is not an object.");
  for (const key of Object.keys(record)) {
    if (key !== "file" && key !== "meta") throw new Error(`Unexpected metadata key ${key}.`);
  }
  const meta = record.meta;
  if (!meta || typeof meta !== "object") throw new Error("Metadata has no meta object.");
  if (Object.keys(meta).join(",") !== "name,attributes") throw new Error("Metadata meta keys are not name, attributes.");
  if (typeof meta.name !== "string" || !Array.isArray(meta.attributes)) throw new Error("Metadata meta is incomplete.");
  const attributes = meta.attributes.map((row) => {
    if (!row || Object.keys(row).join(",") !== "trait_type,value") throw new Error("Attribute keys are not trait_type, value.");
    if (typeof row.trait_type !== "string" || typeof row.value !== "string") throw new Error("Attribute values must be strings.");
    return { trait_type: row.trait_type, value: row.value };
  });
  return encodeCbor({ meta: { name: meta.name, attributes } });
}

export function canonicalCollectionJson(source) {
  const parsed = JSON.parse(source.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("collection.json is not an object.");
  delete parsed.largeImageFormat;
  return Buffer.from(`${JSON.stringify(parsed)}\n`);
}

function merkleRoot(items) {
  if (!items.length) throw new Error("Empty edition.");
  return merkleRootOf(items.map((item) => leafFromDigests(item.id, Buffer.from(item.canonicalImageSha256, "hex"), Buffer.from(item.canonicalMetadataSha256, "hex"))));
}

/**
 * What a collection zip may hold. The numbers are far above a real collection (a 10,000 item zip has about 20,000
 * entries and 16 MB) and far below what could fill a disk. A caller may pass its own.
 */
export const DEFAULT_ZIP_LIMITS = Object.freeze({
  maxEntries: 200_000,
  maxTotalBytes: 2 ** 30,
  maxEntryBytes: 2 ** 26,
});

const ZIPINFO_LINE = /^([-dlcbps?])[-rwxsStT]{9}\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s(.*)$/;

/**
 * The entries of a zip, read with the system `unzip` (Info-ZIP, `unzip -Z`). It must be on the PATH.
 * Nothing is extracted. Each entry is `{ kind, size, name }` and `kind` is the first character of its Unix mode:
 * `-` file, `d` directory, `l` symbolic link, anything else a special file.
 */
export function listZip(zip) {
  let text;
  try {
    text = execFileSync("unzip", ["-Z", zip], { encoding: "utf8", maxBuffer: 64 * 2 ** 20, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (error && error.code === "ENOENT") throw new Error("The `unzip` program (Info-ZIP) is required and was not found on the PATH.", { cause: error });
    throw new Error(`unzip could not read ${basename(zip)}: ${String(error && error.message).split("\n")[0]}`, { cause: error });
  }
  const declared = /number of entries: (\d+)/.exec(text);
  const entries = [];
  for (const line of text.split("\n")) {
    const match = ZIPINFO_LINE.exec(line);
    if (match) entries.push({ kind: match[1], size: Number(match[2]), name: match[3] });
  }
  if (!declared || Number(declared[1]) !== entries.length) throw new Error("The zip listing could not be read in full. Refusing the zip.");
  return entries;
}

function hasControlCharacter(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** Refuse a zip entry that could land outside the folder, replace another entry, or is not a plain file or folder. */
export function checkZipEntries(entries, limits = DEFAULT_ZIP_LIMITS) {
  if (entries.length > limits.maxEntries) throw new Error(`Refusing the zip: ${entries.length} entries, the limit is ${limits.maxEntries}.`);
  const seen = new Set();
  let total = 0;
  for (const { kind, size, name } of entries) {
    const shown = JSON.stringify(name.slice(0, 80));
    if (name.length === 0 || name.startsWith("/") || name.includes("\\") || /^[A-Za-z]:/.test(name) || hasControlCharacter(name)) throw new Error(`Refusing zip entry ${shown}.`);
    if (name.split("/").includes("..")) throw new Error(`Refusing zip entry ${shown}.`);
    if (kind !== "-" && kind !== "d") throw new Error(`Refusing zip entry ${shown}: it is a link or a special file.`);
    if (seen.has(name)) throw new Error(`Refusing the zip: ${shown} appears twice.`);
    seen.add(name);
    if (size > limits.maxEntryBytes) throw new Error(`Refusing zip entry ${shown}: ${size} bytes, the limit is ${limits.maxEntryBytes}.`);
    total += size;
    if (total > limits.maxTotalBytes) throw new Error(`Refusing the zip: more than ${limits.maxTotalBytes} bytes in all.`);
  }
}

/** After extraction: only plain files and folders, and no more bytes than the limit. */
function checkExtracted(root, limits) {
  let total = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        total += lstatSync(path).size;
        if (total > limits.maxTotalBytes) throw new Error(`Refusing the zip: it extracts to more than ${limits.maxTotalBytes} bytes.`);
      } else throw new Error(`Refusing the zip: ${JSON.stringify(entry.name)} extracted as a link or a special file.`);
    }
  };
  walk(root);
}

/**
 * Extract `zip` into the new, empty folder `dest`. The entries are checked before anything is written (see
 * `checkZipEntries`), `unzip` is told never to overwrite (`-n`), and the result is checked once more.
 * It needs the system `unzip` (Info-ZIP) on the PATH. The zip itself is only read.
 */
export function extractZip(zip, dest, limits = DEFAULT_ZIP_LIMITS) {
  if (readdirSync(dest).length > 0) throw new Error("The extraction folder must be empty.");
  checkZipEntries(listZip(zip), limits);
  try {
    execFileSync("unzip", ["-q", "-n", zip, "-d", dest], { stdio: "pipe" });
  } catch (error) {
    throw new Error(`unzip could not extract ${basename(zip)}: ${String(error && error.message).split("\n")[0]}`, { cause: error });
  }
  checkExtracted(dest, limits);
}

function findLayout(root) {
  const candidates = [root];
  for (const name of readdirSync(root, { withFileTypes: true })) {
    if (name.isDirectory() && !name.name.startsWith(".")) candidates.push(join(root, name.name));
  }
  const hits = candidates.filter(
    (dir) => existsSync(join(dir, "images")) && existsSync(join(dir, "json")) && existsSync(join(dir, "collection.json")),
  );
  if (hits.length !== 1) throw new Error("The zip must contain images/, json/, and collection.json.");
  return hits[0];
}

/**
 * `edition` is the number of items and `artwork` is the source image shape the collection declares
 * ({ width, height, colorType, bitDepth }), or `null` to accept any. Neither has a default.
 */
export function buildCanonicalSet({ zipPath, edition, artwork } = {}) {
  if (!zipPath) throw new Error("zipPath is required.");
  if (!Number.isInteger(edition) || edition < 1) throw new Error("edition is required: the number of items, a positive integer.");
  if (artwork === undefined) throw new Error("artwork is required: the source image shape { width, height, colorType, bitDepth }, or null to accept any.");
  const sourceBefore = readFileSync(zipPath);
  const sourceZipSha256 = sha256(sourceBefore);
  const staging = mkdtempSync(join(tmpdir(), "pins-canonical-"));
  try {
    extractZip(zipPath, staging);
    const layout = findLayout(staging);
    const collection = canonicalCollectionJson(readFileSync(join(layout, "collection.json")));
    const items = [];
    let canonicalPngBytes = 0;
    let canonicalCborBytes = 0;
    let mismatched = 0;
    let backgroundStripped = 0;
    const formats = {};
    for (let id = 1; id <= edition; id += 1) {
      const sourceImage = readFileSync(join(layout, "images", `${id}.png`));
      const sourceMeta = readFileSync(join(layout, "json", `${id}.json`));
      const decoded = decodePng(sourceImage);
      if (artwork) {
        if (
          decoded.width !== artwork.width ||
          decoded.height !== artwork.height ||
          decoded.colorType !== artwork.colorType ||
          decoded.bitDepth !== artwork.bitDepth
        ) {
          throw new Error(`#${id} is not ${artwork.width}×${artwork.height} color ${artwork.colorType} bit depth ${artwork.bitDepth}.`);
        }
      }
      if (pngChunkTypes(sourceImage).includes("bKGD")) backgroundStripped += 1;
      const canonicalImage = encodeCanonicalPng(decoded.rgba, decoded.width, decoded.height);
      if (!decodePng(canonicalImage.bytes).rgba.equals(decoded.rgba)) {
        mismatched += 1;
        throw new Error(`#${id} canonical PNG pixels differ.`);
      }
      const canonicalMeta = canonicalMetadataCbor(JSON.parse(sourceMeta.toString("utf8")));
      const format = `${canonicalImage.colorType}/${canonicalImage.bitDepth}`;
      formats[format] = (formats[format] || 0) + 1;
      canonicalPngBytes += canonicalImage.bytes.length;
      canonicalCborBytes += canonicalMeta.length;
      items.push({
        id,
        sourceImageSha256: sha256(sourceImage),
        canonicalImageSha256: sha256(canonicalImage.bytes),
        sourceMetadataSha256: sha256(sourceMeta),
        canonicalMetadataSha256: sha256(canonicalMeta),
      });
    }
    const manifest = {
      edition,
      sourceZip: basename(zipPath),
      sourceZipSha256,
      sourceZipUnmodified: true,
      node: process.version,
      pixelIdentity: { checked: edition, mismatched, backgroundChunksStripped: backgroundStripped, formats },
      png: {
        encoding:
          "Lossless re-encode. bKGD and every other ancillary chunk are omitted. " +
          "8-bit RGBA is kept unless a shorter RGB or indexed encoding decodes to the same pixels. " +
          "zlib deflateSync level 9. Scanline filter is the minimum absolute-byte score, lowest type on a tie.",
      },
      cbor: {
        encoding:
          "Definite-length CBOR. Unsigned integers use the shortest form. " +
          "Map key order is meta, name, attributes, trait_type, value. The file field is omitted.",
      },
      collectionJson: {
        encoding:
          "Compact JSON, UTF-8, one trailing newline, source key order, largeImageFormat removed. Inscribed as JSON.",
        sha256: sha256(collection),
        bytes: collection.length,
      },
      totals: {
        canonicalPngBytes,
        canonicalCborBytes,
        collectionJsonBytes: collection.length,
        grandTotal: canonicalPngBytes + canonicalCborBytes,
      },
      leaf: {
        status: "final",
        construction:
          "leaf = SHA-256(uint32be(number) || canonical PNG SHA-256 || canonical CBOR SHA-256). " +
          "The two digests are raw 32-byte values. The tree pairs leaves in ascending number order. " +
          "An odd trailing node is duplicated. Each parent is SHA-256(left || right). This is not a consensus rule.",
      },
      merkleRoot: merkleRoot(items),
      items,
    };
    if (!readFileSync(zipPath).equals(sourceBefore)) throw new Error("The source zip changed.");
    return manifest;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
