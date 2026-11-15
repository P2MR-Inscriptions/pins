// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { P2MR_LEAF_VERSION_V1, p2mrLeafHash } from "@qbit-oss/protocol";
import { MARKER, buildEnvelope, contentTypeField, parseEnvelopes, pushBytes } from "./script.ts";
import { commitTree, itemsLeaf, recoveryFor } from "./reveal.ts";

test("the marker push is the four bytes pins", () => {
  assert.equal(Buffer.from(MARKER).toString("utf8"), "pins");
  const envelope = buildEnvelope([contentTypeField("image/png")], Uint8Array.of(1, 2, 3));
  assert.equal(envelope[0], 0x00);
  assert.equal(envelope[1], 0x63);
  assert.equal(envelope.at(-1), 0x68);
  const parsed = parseEnvelopes(envelope);
  assert.equal(parsed.length, 1);
  assert.deepEqual([...parsed[0].body], [1, 2, 3]);
});

test("a non-minimal push is still recognized", () => {
  const fat = pushBytes(MARKER, false);
  assert.equal(fat[0], 0x4c);
  const parsed = parseEnvelopes(buildEnvelope([], Uint8Array.of(9), false));
  assert.equal(parsed.length, 1);
  assert.deepEqual([...parsed[0].body], [9]);
});

test("the commit root binds the reveal leaf and the empty recovery leaf", () => {
  const pubkey = new Uint8Array(32).fill(4);
  const reveal = itemsLeaf(pubkey, [{ body: Uint8Array.of(1), contentType: "text/plain" }]);
  const tree = commitTree(reveal, recoveryFor(pubkey));
  assert.equal(tree.revealControl[0], P2MR_LEAF_VERSION_V1 | 1);
  assert.equal(tree.revealControl.length, 33);
  assert.equal(Buffer.from(p2mrLeafHash(P2MR_LEAF_VERSION_V1, reveal)).equals(Buffer.from(tree.revealLeafHash)), true);
  assert.equal(tree.root.length, 32);
});
