// SPDX-License-Identifier: Apache-2.0

/**
 * Envelope marker. The launch marker is the 4 bytes `pins`.
 * A rehearsal may use another 4 bytes. Mainnet refuses anything else.
 */
import type { MintNetwork } from "./network.ts";

export const PINS_MARKER = new Uint8Array([0x70, 0x69, 0x6e, 0x73]);

export function markerHex(marker: Uint8Array): string {
  return Buffer.from(marker).toString("hex");
}

export function isPinsMarker(marker: Uint8Array): boolean {
  return marker.length === PINS_MARKER.length && marker.every((byte, index) => byte === PINS_MARKER[index]);
}

/**
 * The rehearsal marker is a secret that must not land in a terminal log.
 * The launch marker `pins` is public, so it stays visible. `--show-marker` prints either one.
 */
export function formatMarkerLine(marker: string, show: boolean): string {
  if (show || marker === markerHex(PINS_MARKER)) return `marker ${marker}`;
  return "marker hidden";
}

/** `pins`, or exactly 8 hex characters. */
export function parseMarker(value: string | undefined): Uint8Array {
  if (value === undefined || value === "pins") return PINS_MARKER;
  if (!/^[0-9a-fA-F]{8}$/.test(value)) throw new Error("marker must be pins or exactly 4 bytes of hex");
  return Uint8Array.from(Buffer.from(value, "hex"));
}

export function assertMarkerForNetwork(marker: Uint8Array, network: MintNetwork): void {
  if (network === "mainnet" && !isPinsMarker(marker)) {
    throw new Error("mainnet refuses a marker other than pins");
  }
}
