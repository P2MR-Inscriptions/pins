// SPDX-License-Identifier: Apache-2.0

/**
 * The reference indexer lives in this directory.
 * Importing this file does not open a socket and does not listen.
 * `follow.ts` talks to a local regtest node when called.
 * `api.ts` listens only when `startApi` is called.
 */
export const STATUS = "reference";
export const ENTRY = "./pins.ts";
