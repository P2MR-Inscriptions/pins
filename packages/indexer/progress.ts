// SPDX-License-Identifier: Apache-2.0
/**
 * A throttled first-sync progress line, for example
 * `sync 168000/176956 (95%) 12.4 blocks/s, ETA 12m`.
 * The percent is the share of this catch-up, from `start` to `tip`, not from height 0.
 */

export const PROGRESS_INTERVAL_MS = 5_000;

/** Format a remaining time as `12s`, `12m`, or `1h 12m`. */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "unknown";
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

export function formatSyncLine(height: number, tip: number, blocksPerSecond: number, etaSeconds: number, start = 0): string {
  const span = tip - start;
  const pct = span <= 0 ? 100 : Math.max(0, Math.min(100, Math.round((100 * (height - start)) / span)));
  const rate = Number.isFinite(blocksPerSecond) ? Math.max(0, blocksPerSecond) : 0;
  return `sync ${height}/${tip} (${pct}%) ${rate.toFixed(1)} blocks/s, ETA ${formatEta(etaSeconds)}`;
}
