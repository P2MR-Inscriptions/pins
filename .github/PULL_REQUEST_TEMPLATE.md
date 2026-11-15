<!-- SPDX-License-Identifier: Apache-2.0 -->

## Summary

<!-- What changed, and which PINS document or package it touches. -->

## Protocol bytes

<!-- Confirm the marker, envelope, leaf preimage, Merkle folding, and reserve and sale domain bytes are unchanged. If they are not, stop and open a discussion first. -->

- [ ] No change to P2MR Inscription bytes or to the hash rules

## Checks

- [ ] `npm ci`, `npm run build`, `npm run lint`, `npm run typecheck`, `npm test` and `npm run check:terminology` pass, on Node.js 22 and on Node.js 24
- [ ] In `explorer/`: `npm ci --ignore-scripts`, `npm run typecheck` and `npm test` pass (when the change touches the explorer or the indexer API)
- [ ] `CHANGELOG.md` (or `explorer/CHANGELOG.md`, `docs/specs/CHANGELOG.md`) says what changed
- [ ] Test vectors: regenerated with `node --experimental-strip-types scripts/vectors.ts --write` only for an edit that changes no rule, and the diff of `docs/specs/vectors/` is explained below
- [ ] A change to a specification changes wording only, or says why it does not
- [ ] A change to the indexing path (`packages/indexer`, `packages/protocol`, `packages/collection/canonical.mjs`): the mainnet replay of `docs/examples/flatbits.md` gives the same `stateHash`

## Notes

<!-- Link an issue if there is one. Do not paste keys, seeds, or RPC passwords. -->
