// SPDX-License-Identifier: Apache-2.0

/**
 * The collection Merkle tree of PINS-5 §5.1. One implementation, used by the inscriber, the
 * indexer, the collection builder and the vectors.
 *
 *   leaf   = SHA256( u32be(number) || SHA256(body) || SHA256(metadata) )   68-byte preimage
 *   parent = SHA256( left || right )                                        64-byte preimage
 *
 * A level with an odd number of nodes duplicates its last node. The root of one leaf is that
 * leaf. Leaves are positional: the caller passes them in ascending item number.
 */
import { createHash } from "node:crypto";

/** @param {Uint8Array} bytes @returns {Buffer} */
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest();
}

/**
 * The leaf of an item, from the SHA-256 digests of its body and of its metadata.
 * @param {number} number
 * @param {Uint8Array} bodySha256 32 bytes
 * @param {Uint8Array} metadataSha256 32 bytes
 * @returns {Buffer}
 */
export function leafFromDigests(number, bodySha256, metadataSha256) {
  const preimage = Buffer.alloc(68);
  preimage.writeUInt32BE(number, 0);
  Buffer.from(bodySha256).copy(preimage, 4);
  Buffer.from(metadataSha256).copy(preimage, 36);
  return sha256(preimage);
}

/**
 * The leaf of an item: the exact inscribed body and the exact inscribed field 5 bytes.
 * @param {number} number
 * @param {Uint8Array} body
 * @param {Uint8Array} metadata
 * @returns {Buffer}
 */
export function leafHash(number, body, metadata) {
  return leafFromDigests(number, sha256(body), sha256(metadata));
}

/**
 * The levels of the tree, from the leaves up to the root. Each odd level is already padded with
 * its duplicated last node, except the top one.
 * @param {Uint8Array[]} leaves
 * @returns {Uint8Array[][]}
 */
export function merkleLevels(leaves) {
  /** @type {Uint8Array[]} */
  let level = leaves.map((leaf) => Uint8Array.from(leaf));
  if (!level.length) throw new Error("empty merkle tree");
  const levels = [];
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    levels.push(level);
    /** @type {Uint8Array[]} */
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(createHash("sha256").update(level[i]).update(level[i + 1]).digest());
    }
    level = next;
  }
  levels.push(level);
  return levels;
}

/**
 * The root, as lowercase hex.
 * @param {Uint8Array[]} leaves
 * @returns {string}
 */
export function merkleRoot(leaves) {
  const levels = merkleLevels(leaves);
  return Buffer.from(levels[levels.length - 1][0]).toString("hex");
}

/**
 * The root of a leaf list body (PINS-5 §6): 32-byte leaves back to back. `null` when the body is
 * empty or its length is not a multiple of 32.
 * @param {Uint8Array} body
 * @returns {string | null}
 */
export function leafListRoot(body) {
  if (body.length === 0 || body.length % 32 !== 0) return null;
  /** @type {Uint8Array[]} */
  const leaves = [];
  for (let offset = 0; offset < body.length; offset += 32) leaves.push(body.subarray(offset, offset + 32));
  return merkleRoot(leaves);
}

/**
 * The sibling hashes from the leaf at `index` up to the root, as hex, bottom first.
 * @param {Uint8Array[]} leaves
 * @param {number} index
 * @returns {string[]}
 */
export function merkleProof(leaves, index) {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) throw new Error("leaf index is outside the tree");
  const levels = merkleLevels(leaves);
  const path = [];
  let position = index;
  for (let depth = 0; depth < levels.length - 1; depth += 1) {
    path.push(Buffer.from(levels[depth][position ^ 1]).toString("hex"));
    position >>= 1;
  }
  return path;
}

/**
 * Checks that `leaf` is the leaf at position `index` of a tree of `count` leaves with root `root`.
 * The position must be inside the tree, and the path must have exactly the depth of that tree: a
 * proof for a position at or after `count` is refused, even when it folds to the root.
 * @param {Uint8Array} leaf 32 bytes
 * @param {number} index
 * @param {number} count
 * @param {string[]} path sibling hashes as hex, bottom first
 * @param {string} root lowercase hex
 * @returns {boolean}
 */
export function verifyMerkleProof(leaf, index, count, path, root) {
  if (!Number.isInteger(count) || count < 1) return false;
  if (!Number.isInteger(index) || index < 0 || index >= count) return false;
  let depth = 0;
  for (let width = count; width > 1; width = Math.ceil(width / 2)) depth += 1;
  if (path.length !== depth) return false;
  let node = Buffer.from(leaf);
  if (node.length !== 32) return false;
  let position = index;
  for (const sibling of path) {
    if (!/^[0-9a-f]{64}$/.test(sibling)) return false;
    const other = Buffer.from(sibling, "hex");
    node = position % 2 === 0
      ? createHash("sha256").update(node).update(other).digest()
      : createHash("sha256").update(other).update(node).digest();
    position >>= 1;
  }
  return node.toString("hex") === root;
}
