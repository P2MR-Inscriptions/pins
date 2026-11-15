// SPDX-License-Identifier: Apache-2.0

/**
 * Optional `offset` and `limit` for the list endpoints of the read-only API. One rule for all of them, so a
 * client written for one list works on the others (see docs/indexer/API.md).
 */

/** The largest `limit` any list endpoint accepts. */
export const MAX_PAGE_LIMIT = 1000;

/** `/pieces` pages by default, as it always has. The other lists return every row unless the caller sets a limit. */
export const DEFAULT_PIECES_LIMIT = 100;

/** `limit` is `null` when the caller set none: the whole list. */
export type PageRequest = { offset: number; limit: number | null };

/** A whole number written in digits only. `1e1`, `0x10`, ` 5`, `-1` and `1.5` are not. */
function wholeNumber(text: string): number | null {
  if (!/^\d{1,15}$/.test(text)) return null;
  return Number(text);
}

/**
 * Read `offset` (default 0) and `limit` from a query string. `fallback` is the limit when none is given:
 * a number for a list that pages by default, `null` for one that returns every row. Returns `null` for a
 * value that is not a whole number, a negative offset, or a limit outside 1 to `MAX_PAGE_LIMIT`.
 */
export function pageRequest(params: URLSearchParams, fallback: number | null): PageRequest | null {
  const offsetText = params.get("offset");
  const limitText = params.get("limit");
  const offset = offsetText === null ? 0 : wholeNumber(offsetText);
  const limit = limitText === null ? fallback : wholeNumber(limitText);
  if (offset === null) return null;
  if (limit !== null && (limit < 1 || limit > MAX_PAGE_LIMIT)) return null;
  if (limit === null && limitText !== null) return null;
  return { offset, limit };
}

/** The rows of one page, and the size of the whole list. */
export function slicePage<T>(rows: readonly T[], page: PageRequest): { total: number; offset: number; limit: number | null; shown: T[] } {
  const end = page.limit === null ? rows.length : page.offset + page.limit;
  return { total: rows.length, offset: page.offset, limit: page.limit, shown: rows.slice(page.offset, end) };
}

export const PAGE_ERROR = `offset must be a whole number from 0 and limit a whole number from 1 to ${MAX_PAGE_LIMIT}`;
