// SPDX-License-Identifier: Apache-2.0

/**
 * Envelope sizes for the zip passed by the caller. The zip is read locally.
 * This module does not connect to a node and does not write the source files.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { itemEnvelope, type RevealItem } from "../packages/inscriber/reveal.ts";

type CanonicalModule = {
  decodePng: (buf: Uint8Array) => { rgba: Uint8Array; width: number; height: number };
  encodeCanonicalPng: (rgba: Uint8Array, width: number, height: number) => { bytes: Uint8Array };
  canonicalMetadataCbor: (parsed: unknown) => Uint8Array;
  canonicalCollectionJson: (source: Uint8Array) => Uint8Array;
};

async function canonicalModule(): Promise<CanonicalModule> {
  const specifier = "../packages/collection/canonical.mjs";
  return (await import(specifier)) as CanonicalModule;
}
import { revealWeight, STANDARD_WEIGHT, type Batch } from "../packages/inscriber/weight.ts";

export type CanonicalBatch = {
  items: RevealItem[];
  envelopeLengths: number[];
  collectionJson: Uint8Array;
  leafList: Uint8Array;
  pngBytes: number;
  cborBytes: number;
  batches: Batch[];
  groupsOf625: Batch[];
  first625Weight: number;
  maxEnvelope: number;
  maxGroupWeight: number;
};

function findLayout(root: string): string {
  const candidates = [root, ...readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name))];
  const hits = candidates.filter((dir) => existsSync(join(dir, "images")) && existsSync(join(dir, "json")) && existsSync(join(dir, "collection.json")));
  if (hits.length !== 1) throw new Error("The zip must contain images/, json/, and collection.json.");
  return hits[0];
}

function packItems(items: RevealItem[]): Batch[] {
  const batches: Batch[] = [];
  let start = 0;
  while (start < items.length) {
    let count = 0;
    let envelopeSum = 0;
    while (start + count < items.length) {
      const length = itemEnvelope(items[start + count], count).length;
      if (count > 0 && revealWeight(34 + envelopeSum + length, count + 1) > STANDARD_WEIGHT) break;
      envelopeSum += length;
      count += 1;
    }
    batches.push({ start, count, weight: revealWeight(34 + envelopeSum, count) });
    start += count;
  }
  return batches;
}

function leafHash(id: number, png: Uint8Array, cbor: Uint8Array): Buffer {
  const preimage = Buffer.alloc(68);
  preimage.writeUInt32BE(id, 0);
  createHash("sha256").update(png).digest().copy(preimage, 4);
  createHash("sha256").update(cbor).digest().copy(preimage, 36);
  return createHash("sha256").update(preimage).digest();
}

/** Real canonical bodies. Envelope lengths use the index inside each reveal. */
export async function loadCanonical(zipPath: string): Promise<CanonicalBatch> {
  const { decodePng, encodeCanonicalPng, canonicalMetadataCbor, canonicalCollectionJson } = await canonicalModule();
  const staging = mkdtempSync(join(tmpdir(), "pins-canonical-"));
  try {
    execFileSync("unzip", ["-q", "-o", zipPath, "-d", staging], { stdio: "pipe" });
    const layout = findLayout(staging);
    const collectionJson = canonicalCollectionJson(readFileSync(join(layout, "collection.json")));
    const items: RevealItem[] = [];
    const leaves: Buffer[] = [];
    let pngBytes = 0;
    let cborBytes = 0;
    for (let id = 1; id <= 10_000; id += 1) {
      const decoded = decodePng(readFileSync(join(layout, "images", `${id}.png`)));
      const image = encodeCanonicalPng(decoded.rgba, decoded.width, decoded.height);
      const metadata = canonicalMetadataCbor(JSON.parse(readFileSync(join(layout, "json", `${id}.json`), "utf8")));
      const body = new Uint8Array(image.bytes);
      const meta = new Uint8Array(metadata);
      pngBytes += body.length;
      cborBytes += meta.length;
      leaves.push(leafHash(id, body, meta));
      items.push({ body, contentType: "image/png", metadata: meta });
    }
    const batches = packItems(items);
    const groupsOf625: Batch[] = [];
    let maxEnvelope = 0;
    for (let start = 0; start < items.length; start += 625) {
      const slice = items.slice(start, start + 625);
      const envelopeSum = slice.reduce((sum, item, index) => {
        const length = itemEnvelope(item, index).length;
        if (length > maxEnvelope) maxEnvelope = length;
        return sum + length;
      }, 0);
      groupsOf625.push({ start, count: slice.length, weight: revealWeight(34 + envelopeSum, slice.length) });
    }
    const envelopeLengths = items.slice(0, 625).map((item, index) => itemEnvelope(item, index).length);
    return {
      items,
      envelopeLengths,
      collectionJson: new Uint8Array(collectionJson),
      leafList: new Uint8Array(Buffer.concat(leaves)),
      pngBytes,
      cborBytes,
      batches,
      groupsOf625,
      first625Weight: groupsOf625[0].weight,
      maxEnvelope,
      maxGroupWeight: Math.max(...groupsOf625.map((group) => group.weight)),
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
