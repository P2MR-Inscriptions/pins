<!-- SPDX-License-Identifier: Apache-2.0 -->

Throwaway keyfiles for the keyfile tests. They hold keys made only for these tests, with the passphrase
`pins-test-fixture-passphrase`. They guard nothing and must never be used for a real collection.

- `recovery-derived.keyfile.json`, `main-with-sale.keyfile.json` and `main-no-sale.keyfile.json` are keyfiles at `n` = 16384 (2^14), the lowest cost `openKeyfile` accepts. In each, the recovery key is derived from the issuer draw, not drawn on its own. The first two have a sale secret; the third was made with `keygen --no-sale` and has none.
- All three use the same fixed 128-byte draw, so the issuer and recovery public keys are the same in each (`expected.json`).
