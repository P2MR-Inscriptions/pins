// SPDX-License-Identifier: Apache-2.0
/**
 * What the search box accepts. `classifyQuery` turns the text into the page it names, or null.
 *
 * The text comes from `?q=` and is not trusted. A query longer than `MAX_QUERY_LENGTH` characters (after
 * trimming) is not a search: the longest thing the box accepts is an address of 125 characters. Each pattern
 * below is anchored and has no two quantifiers that can match the same character in a row, so matching takes
 * time in proportion to the length of the text, whatever the text is.
 */
import { profile } from "./profile.ts";

/** The longest query, in characters, that is looked at. Longer text gets the same answer as any text that is not found. */
export const MAX_QUERY_LENGTH = 128;

export const ID = /^[0-9a-f]{64}i\d+$/;
export const HEX64 = /^[0-9a-f]{64}$/;
export const ADDRESS = /^(qb|tq|qbrt)1[0-9a-z]{6,120}$/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const WORDS = profile.pieceWords.map(escapeRegExp).join("|");

// A word, then optional space, then `#`, then optional space and the number. The word may be left out.
const PIECE_HASH = new RegExp(`^(?:${WORDS})?\\s*#\\s*(\\d+)$`, "i");
// A word and at least one space, then the number.
const PIECE_SPACE = new RegExp(`^(?:${WORDS})\\s+(\\d+)$`, "i");
// Optional space, then an optional `#` with its optional space: `\s*(?:#\s*)?` is `\s*#?\s*` with the
// two runs of space no longer adjacent, so no space can be matched in two ways.
const BLOCK = /^block\s*(?:#\s*)?(\d+)$/i;
const NUMBERED = /^(?:no\.?|n°|inscription)\s*(?:#\s*)?(\d+)$/i;
const PLAIN = /^\d+$/;

export function classifyQuery(q: string): { type: string; path: string } | null {
  const s = q.trim();
  if (!s || s.length > MAX_QUERY_LENGTH) return null;
  const lower = s.toLowerCase();
  if (ID.test(lower)) return { type: "inscription", path: `/inscription/${lower}` };
  if (HEX64.test(lower)) return { type: "transaction", path: `/tx/${lower}` };
  if (ADDRESS.test(lower)) return { type: "address", path: `/address/${lower}` };
  const piece = PIECE_HASH.exec(s) ?? PIECE_SPACE.exec(s);
  if (piece) return { type: "collection piece", path: `/${profile.piecePath}/${Number(piece[1])}` };
  const block = BLOCK.exec(s);
  if (block) return { type: "block", path: `/block/${Number(block[1])}` };
  const numbered = NUMBERED.exec(s);
  if (numbered) return { type: "inscription number", path: `/number/${Number(numbered[1])}` };
  if (PLAIN.test(s)) return { type: "inscription number", path: `/number/${Number(s)}` };
  return null;
}
