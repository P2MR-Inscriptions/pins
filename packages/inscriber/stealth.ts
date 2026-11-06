// SPDX-License-Identifier: Apache-2.0

/**
 * Testnet4 refuses a plan whose raw bytes contain a launch token.
 * The words are stored as hex so a published protocol tree does not spell them.
 * Rehearsal checks and broadcast both use this list.
 */
type RawPlan = {
  fanout?: { raw?: string };
  reveals?: { raw?: string; leaf?: string }[];
};

const FORBIDDEN_HEX = [
  "666c6174626974",
  "666c617462697473",
  "666c6174",
  "70696e73",
  "646f7a6e6f74",
  "676974687562",
  "37303736383630386132316465633138663631316136343365643166353139613139646634613065636133356336356136323538386433383364636166376232",
];

/** Decoded at runtime. The source text of this file does not contain the words. */
export const FORBIDDEN = FORBIDDEN_HEX.map((hex) => Buffer.from(hex, "hex").toString("utf8"));

export function forbiddenIn(bytes: Uint8Array): string[] {
  const text = Buffer.from(bytes).toString("latin1").toLowerCase();
  return FORBIDDEN.filter((word) => text.includes(word));
}

export function rawFromPlan(plan: RawPlan): Uint8Array {
  const parts = [plan.fanout?.raw ?? "", ...(plan.reveals ?? []).flatMap((reveal) => [reveal.raw ?? "", reveal.leaf ?? ""])];
  return Buffer.concat(parts.filter((part) => part.length > 0).map((part) => Buffer.from(part, "hex")));
}
