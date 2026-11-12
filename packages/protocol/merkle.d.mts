// SPDX-License-Identifier: Apache-2.0
// Types of merkle.mjs, for the packages that read it without allowJs.
export function leafFromDigests(number: number, bodySha256: Uint8Array, metadataSha256: Uint8Array): Buffer;
export function leafHash(number: number, body: Uint8Array, metadata: Uint8Array): Buffer;
export function merkleLevels(leaves: Uint8Array[]): Uint8Array[][];
export function merkleRoot(leaves: Uint8Array[]): string;
export function leafListRoot(body: Uint8Array): string | null;
export function merkleProof(leaves: Uint8Array[], index: number): string[];
export function verifyMerkleProof(leaf: Uint8Array, index: number, count: number, path: string[], root: string): boolean;
