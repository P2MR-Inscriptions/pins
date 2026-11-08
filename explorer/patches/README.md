# Indexer patches

Setup applies five patches, in this order, to public PINS commit `3e014f4ff156a35eea4b8613e37116fd124aa719`. The credential patch edits `scripts/indexer-run.ts` after the genesis patch has added the lines it replaces. Checking it against the clean pin fails at that file. Setup applies one patch at a time and skips a patch whose changes are already present. It does not reset the tree and it does not read `.env` or `data/`. Redirects are refused with `-q` first and `--max-redirs 0`. `0003` and `0004` are not part of a fresh setup. `0004-curl-max-redirs.patch` is only for a vendor that already applied `0003`. The public repository is not modified.

1. `0001-indexer-genesis-flag.patch` adds `--genesis <inscription id>`. Without it, the indexer selects the first valid collection genesis in chain order. The id comes from the operator's manifest. It is not a protocol default.
2. `0002-rpc-credentials-off-argv.patch` stops the indexer from reading `--rpc-user` and `--rpc-password`, and stops `curl` from receiving `-u user:password`. Curl reads the user from its stdin config (`--config -`). `npm --silent` only hides npm's log line. It is not the control that keeps the password off the command line.
3. `0005-output-identity.patch` records an output created and spent in the same block once, at that block's height. A height `-1` placeholder with the same value is promoted inside the block transaction. A different value, a second creator, or an outpoint already stored at another height rolls the block back. It does not use `INSERT OR IGNORE` for those rows.
4. `0006-parser-bounds.patch` rejects an oversized or truncated CBOR length before allocation, and an unsigned PUSHDATA4 length that does not fit. It does not change the indexer pin. Root fixes are not applied to this pin unless this patch is.
5. `0007-genesis-auth.patch` reads genesis parameters only from field 5 and checks the leaf list against the Merkle root. It keeps the `--genesis` id check from `0001`. It applies after `0001`.

The preimage used by `test/patches.test.ts` is the unmodified public files in `test/fixtures/pins-unpatched/`.
