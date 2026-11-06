// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { piecePage, traitsFromMetadata, type PieceView } from "./collection.ts";

function piece(number: number): PieceView {
  return {
    number,
    inscriptionId: null,
    authentic: false,
    reason: "no authentic inscription",
    status: "unassigned",
    location: null,
    ownerAddress: "",
    ownerScript: "",
    confirmations: 0,
    final: false,
  };
}

test("piece pages stay inside the requested window", () => {
  const pieces = [piece(1), piece(2), piece(3)];
  assert.equal(piecePage(pieces, -1, 1), null);
  assert.equal(piecePage(pieces, 0, 0), null);
  assert.equal(piecePage(pieces, 0, 101), null);
  const page = piecePage(pieces, 1, 1);
  assert.equal(page?.total, 3);
  assert.deepEqual(page?.pieces.map((item) => item.number), [2]);
  const authentic = [piece(1), { ...piece(2), authentic: true }, piece(3)];
  const only = piecePage(authentic, 0, 10, true);
  assert.equal(only?.total, 1);
  assert.equal(only?.pieces[0]?.number, 2);
});

test("traits come from field 5 and bad metadata is empty", () => {
  assert.deepEqual(traitsFromMetadata(undefined), []);
  assert.deepEqual(traitsFromMetadata(Uint8Array.of(0xff)), []);
});
