// SPDX-License-Identifier: Apache-2.0

/**
 * Envelope sizes for the zip passed by the caller. The zip is read locally.
 * This module does not connect to a node and does not write the source files.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { itemEnvelope, type RevealItem } from "../packages/inscriber/reveal.ts";
import { leafHash } from "../packages/protocol/merkle.mjs";

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
  collectionJson: Uint8Array;
  leafList: Uint8Array;
  pngBytes: number;
  cborBytes: number;
  batches: Batch[];
};

/** What the collection declares about its own size. Nothing here has a default. */
export type MintShape = {
  /** Number of items. Ids 1 through `supply` are read from the zip. */
  supply: number;
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

/**
 * Splits the items into reveals of `size` items, in order. The last reveal holds the rest.
 * The size is the collection's own choice, kept under the reveal weight limit by `plan`.
 */
export function groupsOf(items: RevealItem[], size: number): Batch[] {
  if (!Number.isInteger(size) || size < 1) throw new Error("the batch size must be a positive integer");
  const groups: Batch[] = [];
  for (let start = 0; start < items.length; start += size) {
    const slice = items.slice(start, start + size);
    const envelopeSum = slice.reduce((sum, item, index) => sum + itemEnvelope(item, index).length, 0);
    groups.push({ start, count: slice.length, weight: revealWeight(34 + envelopeSum, slice.length) });
  }
  return groups;
}

/** Real canonical bodies. Envelope lengths use the index inside each reveal. */
export async function loadCanonical(zipPath: string, shape: MintShape): Promise<CanonicalBatch> {
  const staging = mkdtempSync(join(tmpdir(), "pins-canonical-"));
  try {
    execFileSync("unzip", ["-q", "-o", zipPath, "-d", staging], { stdio: "pipe" });
    return await loadCanonicalDir(findLayout(staging), shape);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** The same, from a folder that has images/, json/, and collection.json. */
export async function loadCanonicalDir(layout: string, shape: MintShape): Promise<CanonicalBatch> {
  const { supply } = shape;
  if (!Number.isInteger(supply) || supply < 1) throw new Error("the supply must be a positive integer");
  const { decodePng, encodeCanonicalPng, canonicalMetadataCbor, canonicalCollectionJson } = await canonicalModule();
  const collectionJson = canonicalCollectionJson(readFileSync(join(layout, "collection.json")));
  for (const [folder, extension] of [["images", "png"], ["json", "json"]] as const) {
    if (existsSync(join(layout, folder, `${supply + 1}.${extension}`))) {
      throw new Error(`the zip has more items than the supply of ${supply}: ${folder}/${supply + 1}.${extension} exists`);
    }
  }
  const items: RevealItem[] = [];
  const leaves: Buffer[] = [];
  let pngBytes = 0;
  let cborBytes = 0;
  for (let id = 1; id <= supply; id += 1) {
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
  return {
    items,
    collectionJson: new Uint8Array(collectionJson),
    leafList: new Uint8Array(Buffer.concat(leaves)),
    pngBytes,
    cborBytes,
    batches: packItems(items),
  };
}
