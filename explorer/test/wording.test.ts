// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/** Visible copy only. Paths and code identifiers are removed before the check. */
function strayInscription(text: string): string | null {
  const visible = text
    .replace(/\$\{[^}]*\}/g, " ")
    .replace(/[#/][A-Za-z0-9_$.{}?-]*/g, " ")
    .replaceAll("LATEST P2MR INSCRIPTION", " ")
    .replaceAll("P2MR Inscriptions", " ")
    .replaceAll("P2MR Inscription", " ");
  const found = visible.match(/\binscriptions?\b/i);
  return found ? found[0] : null;
}

function stringsIn(source: string): string[] {
  return [...source.matchAll(/`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g)].map((match) => match[0].slice(1, -1));
}

test("visible nouns are PINS or P2MR Inscription / P2MR Inscriptions", () => {
  const files = ["public/index.html", "public/app.js", "public/guide.js", "public/history.js", "public/brand.js"];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const text of stringsIn(source)) {
      const stray = strayInscription(text);
      assert.equal(stray, null, `${file}: ${text}`);
    }
  }
  const html = readFileSync("public/index.html", "utf8");
  const shown = ["public/index.html", "public/app.js", "public/guide.js", "public/qbit-page.js", "public/history.js", "public/brand.js", "server/api.ts"]
    .map((file) => readFileSync(file, "utf8")).join("\n");
  for (const banned of [
    "not a Qbit project",
    "not affiliated",
    "The official site states",
    "The official page says",
    "The official wallet page",
    "describes itself",
    "Qbit project's",
  ]) assert.equal(shown.includes(banned), false, banned);
  assert.match(shown, /PINS is an independent protocol\./);
  const qbit = readFileSync("public/qbit-page.js", "utf8");
  for (const banned of ["outside token allocation", "outside allocation", "does not issue", "does not trade", "Shor's", "quantum-secure from inception"]) {
    assert.equal(qbit.includes(banned), false, banned);
  }
  assert.match(qbit, /210,000,000 QBT/);
  assert.match(qbit, /100,000,000 bits/);
  assert.match(qbit, /3,680 bytes/);
  assert.match(qbit, /SLH-DSA-SHA2-128s-bounded30/);
  assert.match(qbit, /There is no premine\./);
  assert.match(qbit, /first-in-first-out/);
  assert.match(qbit, /leaf version 0xc0/);
  const guide = readFileSync("public/guide.js", "utf8");
  assert.match(guide, /connect-src to none/);
  assert.match(guide, /2,048 bytes/);
  assert.equal(guide.includes("or a wallet"), false);
  assert.match(html, />Latest P2MR Inscriptions</);
  assert.match(readFileSync("public/app.js", "utf8"), /1 P2MR Inscription/);
  assert.match(readFileSync("public/app.js", "utf8"), /P2MR Inscriptions/);
  assert.match(readFileSync("public/guide.js", "utf8"), /1 P2MR Inscription/);
});
