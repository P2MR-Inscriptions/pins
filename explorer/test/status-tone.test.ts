// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { indexedStatus, nodeStatus } from "../public/status-tone.js";

test("connected RPC is not treated as a current index", () => {
  const indexed = indexedStatus({ ready: false, preview: true, stale: false, loading: true, indexedHeight: 10, nodeHeight: 12 });
  const node = nodeStatus({ enabled: true, reachable: true });
  assert.deepEqual(node, { kind: "ok", text: "connected" });
  assert.equal(indexed.kind, "warn");
  assert.match(indexed.text, /syncing/);
  assert.notEqual(indexed.kind, "ok");
});

test("green current requires a ready snapshot at the indexer tip", () => {
  assert.deepEqual(indexedStatus({ ready: true, stale: false, loading: false, indexedHeight: 20, nodeHeight: 20 }), { kind: "ok", text: "20 · current" });
  assert.equal(indexedStatus({ ready: true, stale: false, loading: false, indexedHeight: 18, nodeHeight: 20 }).kind, "warn");
  assert.match(indexedStatus({ ready: true, stale: true, indexedHeight: 20, nodeHeight: 20 }).text, /stale/);
  assert.equal(indexedStatus({ ready: true, indexedHeight: 20 }).kind, "neutral");
  assert.equal(indexedStatus({}).text, "unknown");
});

test("node connection has its own disconnected and off states", () => {
  assert.deepEqual(nodeStatus({ enabled: true, reachable: false }), { kind: "bad", text: "disconnected" });
  assert.deepEqual(nodeStatus({ enabled: false }), { kind: "neutral", text: "off" });
  assert.deepEqual(nodeStatus({}), { kind: "neutral", text: "unknown" });
});
