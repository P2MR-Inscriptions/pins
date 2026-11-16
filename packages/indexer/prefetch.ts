// SPDX-License-Identifier: Apache-2.0

export const DEFAULT_PREFETCH = 8;
export const MIN_PREFETCH = 1;
export const MAX_PREFETCH = 32;

/**
 * The prefetch window: how many blocks to fetch ahead. Default 8. Allowed
 * range 1 to 32. An empty value uses the default.
 */
export function parsePrefetch(raw: string | undefined, fallback = DEFAULT_PREFETCH): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_PREFETCH || value > MAX_PREFETCH) {
    throw new Error(`--prefetch must be an integer from ${MIN_PREFETCH} to ${MAX_PREFETCH}`);
  }
  return value;
}
