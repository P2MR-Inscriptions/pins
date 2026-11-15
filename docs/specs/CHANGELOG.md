<!-- SPDX-License-Identifier: CC0-1.0 -->
# Specification changelog

## 1.0.0

PINS-1 to PINS-6 are version 1.0.0. They describe what the reference indexer does, and what was measured on regtest and on mainnet, against Qbit Core v1.0.1 (`0439a7e5`). The marker is `pins`. The mainnet `ACTIVATION_HEIGHT` is 161948 (blocks 0 to 161,947 hold no `pins` envelope, `collision-check.md`). The documents stay CC0-1.0.

PINS-5 §8.5 states the `pins-unsold-address/1` commitment in full: the issuer key signs it (its reveal leaf starts with `<K_iss> OP_CHECKSIGPQC`, and §2 lists it among the reveals of `K_iss`), its field 5 has exactly the keys `schema`, `root` and `address`, `root` is the root of the genesis and `address` is a witness-v2 P2MR address of the network of the collection, the first valid commitment in chain order counts and later ones are ignored, and "before close" means confirmed before the sale reveal in chain order. The reference indexer does not read this record, and none of its rules changes.
