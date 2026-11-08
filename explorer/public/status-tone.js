// Footer tones. Green is only a fact the payload supports.
// A connected node is not treated as a fully synced index.

function knownHeight(value) {
  return Number.isInteger(value) && value >= 0;
}

export function indexedStatus({ ready, preview, stale, loading, indexedHeight, nodeHeight }) {
  const height = knownHeight(indexedHeight) ? indexedHeight : null;
  const node = knownHeight(nodeHeight) ? nodeHeight : null;
  if (stale) return { kind: "warn", text: height == null ? "stale" : `${height} · stale` };
  if (loading || (preview && !ready)) return { kind: "warn", text: height == null ? "syncing" : `${height} · syncing` };
  if (ready && height != null && node != null && height === node) return { kind: "ok", text: `${height} · current` };
  if (ready && height != null && node != null && height < node) return { kind: "warn", text: `${height} · behind` };
  if (height != null) return { kind: "neutral", text: String(height) };
  return { kind: "neutral", text: "unknown" };
}

export function nodeStatus({ enabled, reachable }) {
  if (enabled !== true && enabled !== false) return { kind: "neutral", text: "unknown" };
  if (!enabled) return { kind: "neutral", text: "off" };
  if (reachable === true) return { kind: "ok", text: "connected" };
  if (reachable === false) return { kind: "bad", text: "disconnected" };
  return { kind: "neutral", text: "unknown" };
}
