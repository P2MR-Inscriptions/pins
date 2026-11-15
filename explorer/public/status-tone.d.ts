// SPDX-License-Identifier: Apache-2.0

export function indexedStatus(input: {
  ready?: boolean;
  preview?: boolean;
  stale?: boolean;
  loading?: boolean;
  indexedHeight?: number;
  nodeHeight?: number;
}): { kind: "ok" | "warn" | "bad" | "neutral"; text: string };
export function nodeStatus(input: { enabled?: boolean; reachable?: boolean }): { kind: "ok" | "warn" | "bad" | "neutral"; text: string };
