// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync("public/app.js", "utf8");

test("thumbnail captions outside the collection view are the global number, Pins #N", () => {
  // Captions of the home page and of the latest list.
  const cell = app.slice(app.indexOf("function cell("), app.indexOf("function cell(") + 700);
  const hero = app.slice(app.indexOf("function homeHero("), app.indexOf("function homeHero(") + 300);
  assert.match(cell, /pinsLabel\(/);
  assert.match(hero, /inscriptionLabel\(/);
  for (const block of [cell, hero]) assert.equal(block.includes("collectionPiece"), false);
  assert.equal(app.includes("`No. "), false);
});

test("a collection item is named from the genesis name prefix, and the menu from the collection name", () => {
  assert.match(app, /itemBase = \(prefix, name\) =>/);
  assert.match(app, /`\$\{record\.name\} Collection`/);
  assert.match(app, /placeholder: `\$\{itemName\(\)\} #/);
});
