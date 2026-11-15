<!-- SPDX-License-Identifier: Apache-2.0 -->

# Governance

PINS is a community project. It belongs to the people who use it and maintain it, and it does not depend on any one of them. This page says who decides what, and how that changes.

## What is governed

| Part | Where | Who may change it, and how |
|---|---|---|
| The protocol rules | [docs/specs](docs/specs/README.md), CC0-1.0 | Through the [standards process](docs/STANDARDS-PROCESS.md). A rule change is a new version of the standard, and it can never change a result that is already on mainnet |
| The reference tools | `packages/`, `scripts/`, `explorer/`, Apache-2.0 | A pull request that a maintainer approves and that passes every required check ([CONTRIBUTING.md](CONTRIBUTING.md)) |
| The documents | everything else in the repository | The same pull request path |
| The release of the tools | the version in `package.json` and the changelogs | A maintainer, after the checks pass on `main` |

## Maintainers

A maintainer is a person with write access to the repository. Maintainers review and merge pull requests, run the replay of the standards process, handle private reports ([SECURITY.md](SECURITY.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)), and keep the repository settings. A maintainer acts for the project and not for an employer or a collection.

- **Decisions are made in public**, in an issue or a pull request, with the reasons written down. A private report is the one exception, and its outcome is published as an advisory or a changelog entry when it affects users.
- **Review.** A change is reviewed by a maintainer other than its author whenever another maintainer is active. It merges only when every required check is green ([branch protection](CONTRIBUTING.md#branch-protection)). A change to a rule also passes the proofs of the standards process, which do not depend on who reviews it.
- **Disagreement is settled by the rules of the standards**, not by seniority. A proposal that keeps every result on mainnet, comes with a specification text, vectors and a replay, and has no unanswered objection is accepted. An objection that names a result that would change, or a vector that fails, is decisive.
- **No deadlines.** Maintainers acknowledge and respond as soon as they can, and a proposal waits for as long as a careful review takes.

## Becoming a maintainer

Anyone who has contributed over time can be proposed in a public issue, by themselves or by another person. The existing maintainers agree in that issue, and one of them grants the access. A maintainer who stops taking part, or who asks to step down, is removed from the list of people with access, and the repository keeps working: the checks, the vectors and the replay do not depend on anyone.

When no maintainer is active, anyone may fork the repository. The specifications are CC0-1.0 and the code is Apache-2.0, so a fork may continue the work. A fork that keeps the marker `pins` keeps every rule and every result of [the standards](docs/specs/README.md). A fork that wants other rules uses its own marker (PINS-1 §5.5).

## What no one can change

The marker `pins`, the envelope layout, the leaf preimage, the Merkle folding, the reserve and sale-order domain bytes, and the results of the mainnet replay of [Flatbits](docs/examples/flatbits.md) are fixed. They are the protocol, and an indexer on mainnet depends on them. A change that touches them is a new protocol with a new marker, and it is not a change to this one.

## Where to talk

Questions, proposals and bugs go to [GitHub issues](https://github.com/P2MR-Inscriptions/pins/issues). A proposal for a rule uses the *Spec proposal* template. A vulnerability, or conduct that breaks the [code of conduct](CODE_OF_CONDUCT.md), goes through GitHub private vulnerability reporting, as [SECURITY.md](SECURITY.md) describes.

PINS is independent. It is not an official project of Qbit or Qbit-Org, and nothing in this repository speaks for them.
