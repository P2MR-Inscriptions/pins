<!-- SPDX-License-Identifier: Apache-2.0 -->

# Assets

Logos and images used by the documents. None of them is read by the protocol, the indexer or the inscriber.

| File | What it is |
|---|---|
| `pins-social-preview.png` | The banner at the top of the repository README. |
| `pins-avatar.svg` | The PINS mark. It is a raster PNG embedded in an SVG wrapper (about 690 KB), so it does not scale like a vector. The plate is `#0b120d`, so the green mark stays readable on a light page and on a dark page. |
| `pins-avatar.png` | A raster file of the same mark. |
| `qbit-logo-full.svg` | The Qbit wordmark. It is the Qbit project's file, copied unmodified from https://qbit.org/logo-full.svg, and it is used in the README to say which network PINS is built on. |
| `qbit-favicon.png` | The Qbit favicon, copied unmodified from https://qbit.org/favicon.png. |

The Qbit marks belong to the Qbit project. They are not covered by this repository's licence, and their use here does not mean that the Qbit project endorses PINS (see the README).

## Copies in the explorer

Some files exist twice on purpose. Do not merge them or point one at the other.

- `explorer/public/brand/pins-avatar-official.svg` is a byte-for-byte copy of `pins-avatar.svg` here (SHA-256 `ed312c3f294b29fd2f202c2eacb4ca470e89a60538172360831c32557978c864`). The explorer keeps it as the unmodified reference of the official mark, and its tests check the bytes.
- `explorer/public/qbit-logo-full.svg` is a byte-for-byte copy of `qbit-logo-full.svg` here (SHA-256 `28978ec61a6f72fc55d18cf180a80fe357eecc3d4d617686f8f09d13f86e2de7`). The explorer is a separate package that serves its own files, so it does not read this folder.
- `explorer/public/pins-avatar.svg` is not a copy. It is the version the explorer page serves. `explorer/public/brand/PROVENANCE.txt` records how it was made from the official mark.

A change to the mark is a change to all of these files and to the checksums in the explorer tests.
