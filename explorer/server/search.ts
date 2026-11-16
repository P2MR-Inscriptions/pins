// SPDX-License-Identifier: Apache-2.0
/**
 * What the search box accepts. `classifyQuery` turns the text into the page it names, or null.
 *
 * The text comes from `?q=` and is not trusted. A query longer than `MAX_QUERY_LENGTH` characters (after
 * trimming) is not a search: the longest thing the box accepts is an address of 125 characters. Each pattern
 * below is anchored and has no two quantifiers that can match the same character in a row, so matching takes
 * time in proportion to the length of the text, whatever the text is.
 */

/** The longest query, in characters, that is looked at. Longer text gets the same answer as any text that is not found. */
export const MAX_QUERY_LENGTH = 128;

export const ID = /^[0-9a-f]{64}i\d+$/;
export const HEX64 = /^[0-9a-f]{64}$/;
export const ADDRESS = /^(qb|tq|qbrt)1[0-9a-z]{6,120}$/;

// The block of a query: `block 5`, `block #5`. Optional space, then an optional `#` with its optional space:
// `\s*(?:#\s*)?` is `\s*#?\s*` with the two runs of space no longer adjacent, so no space can be matched in two ways.
const BLOCK = /^block\s*(?:#\s*)?(\d+)$/i;

// The number of a P2MR Inscription, the global number that counts every one from 0: digits, or digit groups with
// a comma (`10,001`). It may follow a name (`no.`, `n°`, `inscription`, `pins`, `p2mr inscription`) and a `#`.
// A collection's own item numbers are not searched: this explorer is not tied to one collection.
const NUMBER = /^(?:(?:no\.?|n°|inscription|pins|p2mr\s+inscription)\s*)?(?:#\s*)?(\d{1,3}(?:,\d{3})+|\d+)$/i;

export function classifyQuery(q: string): { type: string; path: string } | null {
  const s = q.trim();
  if (!s || s.length > MAX_QUERY_LENGTH) return null;
  const lower = s.toLowerCase();
  if (ID.test(lower)) return { type: "inscription", path: `/inscription/${lower}` };
  if (HEX64.test(lower)) return { type: "transaction", path: `/tx/${lower}` };
  if (ADDRESS.test(lower)) return { type: "address", path: `/address/${lower}` };
  const block = BLOCK.exec(s);
  if (block) return { type: "block", path: `/block/${Number(block[1])}` };
  const numbered = NUMBER.exec(s);
  if (numbered) {
    const number = Number(numbered[1].replaceAll(",", ""));
    if (Number.isSafeInteger(number)) return { type: "inscription number", path: `/number/${number}` };
  }
  return null;
}
