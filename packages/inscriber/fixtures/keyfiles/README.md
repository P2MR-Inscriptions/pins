Throwaway keyfiles for the keyfile tests. They hold keys made only for these tests, with the passphrase
`pins-test-fixture-passphrase`. They guard nothing and must never be used for a real collection.

- `v1.0.0.keyfile.json` was written by the keyfile code of the v1.0.0 release.
- `main-with-sale.keyfile.json` and `main-no-sale.keyfile.json` were written by the code before the recovery draw became independent
  (the second one with `keygen --no-sale`).
- All three use the same fixed 128-byte draw, so the issuer and recovery public keys are the same in each (`expected.json`).
