// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical state hash. Two indexers that saw the same blocks produce the
 * same hex digest. The preimage is one line per inscription, sorted by number.
 */
import { createHash } from "node:crypto";
import type { Indexer } from "./pins.ts";

export function stateHash(indexer: Indexer, block: { height: number; hash: string }): string {
  const lines = [`block ${block.height} ${block.hash}`];
  const items = [...indexer.inscriptions.values()].sort((left, right) => left.number - right.number);
  for (const item of items) {
    const place = item.location.state === "located"
      ? `${item.location.txid}:${item.location.vout}:${item.location.offset}`
      : item.location.state;
    lines.push([
      item.number,
      item.id,
      item.bodySha256,
      item.contentType,
      place,
      item.ownerAddress,
      item.locationHeight,
      [...item.flags].sort().join(","),
    ].join(" "));
  }
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}
