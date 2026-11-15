<!-- SPDX-License-Identifier: Apache-2.0 -->

# How to propose a change to the standards

PINS-1 to PINS-6 ([docs/specs](specs/README.md), CC0-1.0) are in use on Qbit mainnet. Indexers, marketplaces and collections depend on them, so a change is made in one way only, and it is proved before it is accepted. Anyone can follow this page. It needs no permission from the people who wrote the first version.

## What kind of change is it

| Kind | Example | What it needs | Version |
|---|---|---|---|
| **Wording** | A typo, a clearer sentence, a better example. The meaning of no MUST or SHOULD changes | A pull request. An entry in [docs/specs/CHANGELOG.md](specs/CHANGELOG.md) that says "wording only" | Patch: 1.0.0 becomes 1.0.1 |
| **Compatible rule** | A new standard. A new optional field with an odd tag. A new record schema that is read next to the old one. A rule that says what to do where the standard was silent | A [proposal](#the-steps), the [proofs](#the-proofs), a new version of the standard | Minor: 1.0.0 becomes 1.1.0 |
| **Incompatible rule** | Anything that would change the number, the location, the owner or the authenticity of a P2MR Inscription that exists, or the `stateHash` of a block | Not possible with the marker `pins`. It is a different protocol: it needs its own marker and its own standards (PINS-1 §5.5) | none: a new protocol |

If you are not sure which kind a change is, it is the stricter one until the proofs show otherwise.

## The rule that cannot be broken

**A change never changes a result that is already on mainnet.** For the public example, [Flatbits](examples/flatbits.md), a replay of mainnet to block 171,486 must keep giving:

- `stateHash` `2d8255401cc9bace5eeba394b83eb38865ec6713b8d2a8578009b77b76424112`, and the two earlier tips of the example page unchanged,
- 10,002 P2MR Inscriptions, 10,000 of them authentic items of the collection.

The first line is the proof for every P2MR Inscription on the chain up to that block, not only for Flatbits: the state hash covers the number, the id, the body hash, the content type, the location, the owner, the height and the flags of every one of them (PINS-2 §4.4). A rule that is correct in the abstract and changes that digest is rejected. The frozen parts, in addition, are listed in [CONTRIBUTING.md](../CONTRIBUTING.md#what-not-to-change): the marker, the envelope layout, the leaf preimage, the Merkle folding and the two domain bytes.

A new rule therefore reads a field or a record that no existing P2MR Inscription carries, or adds a view without changing an existing one. A rule that needs an existing P2MR Inscription to be read differently is the incompatible kind.

## The steps

1. **Open a proposal.** Use the *Spec proposal* issue template. Say which standard and section, what is wrong or missing, the exact rule you propose, and what it does to results that exist. A proposal is public and anyone may comment.
2. **Settle the text.** The discussion ends when the rule is written in the language of the standard (MUST, SHOULD, MAY, with the case each one covers) and nobody has an unanswered objection that names a result that would change or a vector that would fail. There is no deadline: the discussion lasts as long as it needs.
3. **Open the pull request** with everything in [the proofs](#the-proofs) and link the proposal. One proposal, one pull request.
4. **Review.** A maintainer other than the author reviews it when another maintainer is active, the checks are green, and the replay result is in the pull request ([GOVERNANCE.md](../GOVERNANCE.md)).
5. **Merge.** The change is in `main` and in the changelog. A tool that implements the new rule says so in its own changelog.

## The proofs

A pull request that changes a rule contains all of these.

1. **The text.** The standard says the new rule in normative words. The version line of the standard and the version table of [docs/specs/README.md](specs/README.md) carry the new version. [docs/specs/CHANGELOG.md](specs/CHANGELOG.md) has an entry for it. `STANDARDS` in `packages/protocol/index.mjs` lists the new version (a test compares it with the index, and `/status` of the indexer reports it).
2. **The vectors.** New cases in the generators (`scripts/vectors.ts`, `scripts/vectors-chain.ts`, `scripts/vectors-collection.ts`) show the new rule, so that another implementation can check itself against it ([docs/specs/vectors](specs/vectors/README.md)). Every existing vector file is unchanged. Run them in check mode, which rewrites nothing:

   ```text
   node --experimental-strip-types scripts/vectors.ts
   node --experimental-strip-types scripts/vectors-collection.ts
   ```

   `--write` regenerates the files and is for adding new cases. A pull request in which an old vector changes is a pull request that breaks a result.
3. **The reference implementation.** The code of `packages/` applies the rule, with tests. The files that decide the `stateHash` are listed in [CONTRIBUTING.md](../CONTRIBUTING.md#changing-the-indexing-path).
4. **The checks of CI,** run by you before you push:

   ```text
   npm ci
   npm run lint
   npm run typecheck
   npm test
   npm run check:terminology
   ```
5. **The replay.** Run the reference indexer over mainnet on your own node (`-txindex`, not pruned), from the activation height, and read the digest of block 171,486 from the store:

   ```text
   npm run indexer:serve -- --db replay.sqlite --rpc http://127.0.0.1:RPC_PORT/ --rpc-datadir YOUR_NODE_DATADIR --network mainnet --confirm-network mainnet --activation 161948 --genesis 15d6f9c48865b579f7d1144e4d2d71d905c6fe04458bebc814052a3e39a07784i0
   ```

   When the indexer has caught up (`/status` shows the tip), stop it and read the digest:

   ```text
   node --no-warnings -e 'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync("replay.sqlite", { readOnly: true }); console.log(db.prepare("SELECT state_hash FROM blocks WHERE height = 171486").get().state_hash)'
   ```

   It prints `2d8255401cc9bace5eeba394b83eb38865ec6713b8d2a8578009b77b76424112`. `/collection` of the same run shows `status` `present`, `supply` 10000 and `authentic` 10000 ([Verify the example](examples/flatbits.md#verify-the-example)). Put the result in the pull request.
6. **The effect on other implementations.** The pull request says what an independent indexer must change, and how it can tell that it did (a vector, a field of `/status`).

A change to the wording only needs the CI checks and a changelog entry. It needs no replay unless it touches a file of the indexing path.

## After the change

- The old version of a standard stays readable in the git history and in the tag of its release. A reader names the version of the standard it implements, and `/status` of an indexer lists it.
- A change that adds a rule is announced in the changelog of the standards and in the changelog of the repository.
- Anyone who disagrees with a decision can build on the old version: the specifications are CC0-1.0 and the code is Apache-2.0 ([GOVERNANCE.md](../GOVERNANCE.md#becoming-a-maintainer)).
