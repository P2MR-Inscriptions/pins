// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical state hash, PINS-2 §4.4. Two indexers that saw the same blocks produce the
 * same hex digest. The preimage is one line for the tip block, then one line per P2MR Inscription,
 * sorted by number, joined by LF with no trailing LF. The content type is the raw bytes of the
 * first field 1 value, with LF written as `%0a` and `%` as `%25`, so a value that holds a space or
 * a line break cannot move a field or start a line.
 */
import { createHash } from "node:crypto";
import { contentTypeBytes, type Indexer, type Inscription } from "./pins.ts";

/** The content type bytes of `contentTypeBytes` (the first field 1 value, unaltered), with LF and `%` escaped (PINS-2 §4.4). Empty when the field is absent. */
function escapedContentType(item: Inscription): Buffer {
  const out: number[] = [];
  for (const byte of contentTypeBytes(item)) {
    if (byte === 0x0a) out.push(0x25, 0x30, 0x61);
    else if (byte === 0x25) out.push(0x25, 0x32, 0x35);
    else out.push(byte);
  }
  return Buffer.from(out);
}

export function stateHash(indexer: Indexer, block: { height: number; hash: string }): string {
  const lines: Buffer[] = [Buffer.from(`block ${block.height} ${block.hash}`)];
  const items = [...indexer.inscriptions.values()].sort((left, right) => left.number - right.number);
  for (const item of items) {
    const place = item.location.state === "located"
      ? `${item.location.txid}:${item.location.vout}:${item.location.offset}`
      : item.location.state;
    lines.push(Buffer.concat([
      Buffer.from(`${item.number} ${item.id} ${item.bodySha256} `),
      escapedContentType(item),
      Buffer.from(` ${place} ${item.ownerAddress} ${item.locationHeight} ${[...item.flags].sort().join(",")}`),
    ]));
  }
  const hash = createHash("sha256");
  lines.forEach((line, index) => {
    if (index > 0) hash.update("\n");
    hash.update(line);
  });
  return hash.digest("hex");
}
