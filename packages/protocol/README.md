<!-- SPDX-License-Identifier: Apache-2.0 -->

# Protocol core

Shared constants for P2MR Inscriptions. The specification is [docs/specs](../../docs/specs/README.md). The marker is `pins`. Collection names, roots, and reserve quotas are not constants in this package.

`PROTOCOL_TAG` in `index.mjs` is `pins`, the 4-byte marker from PINS-1. `PROTOCOL_NAME` is `P2MR Inscriptions`. `reserve.mjs` selects a creator reserve from the groups in a collection profile and a caller-supplied seed. It does not create a launch secret and it does not name a collection. Nothing in this package may place the marker, a collection name, or any envelope into witness bytes.

This package does not ship an older witness builder. Do not add one here.
