<!-- SPDX-License-Identifier: Apache-2.0 -->

# Assets

Logos and images used by the documents. None of them is read by the protocol, the indexer or the inscriber.

| File | What it is |
|---|---|
| `pins-social-preview.png` | The banner at the top of the repository README. |
| `pins-avatar.svg` | The PINS mark. It is a raster PNG embedded in an SVG wrapper (about 690 KB), so it does not scale like a vector. The plate is `#0b120d`, so the green mark stays readable on a light page and on a dark page. |
| `pins-avatar.png` | A raster file of the same mark, kept for uploading as a profile picture. No page reads it. |
| `qbit-favicon.png` | The Qbit favicon, copied unmodified from https://qbit.org/favicon.png. No page reads it. |

The Qbit marks belong to the Qbit project. They are not covered by this repository's licence, and their use here does not mean that the Qbit project endorses PINS (see the README).

## Files the explorer shares

Each of these files exists once.

- `qbit-logo-full.svg` is not in this folder. The Qbit wordmark is `explorer/public/qbit-logo-full.svg` (SHA-256 `28978ec61a6f72fc55d18cf180a80fe357eecc3d4d617686f8f09d13f86e2de7`), copied unmodified from https://qbit.org/logo-full.svg. The explorer serves it and the README shows it.
- `pins-avatar.svg` here is the unmodified official mark (SHA-256 `ed312c3f294b29fd2f202c2eacb4ca470e89a60538172360831c32557978c864`). The explorer tests read it from this folder and check its bytes.
- `explorer/public/pins-avatar.svg` is not a copy. It is the version the explorer page serves. `explorer/public/brand/PROVENANCE.txt` records how it was made from the official mark.

A change to the mark is a change to these files and to the checksums in the explorer tests.
