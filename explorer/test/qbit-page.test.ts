// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { qbitLinks } from "../public/qbit-page.js";

const allowed = new Set([
  "https://qbit.org",
  "https://qbit.org/architecture",
  "https://qbit.org/consensus",
  "https://qbit.org/p2mr",
  "https://qbit.org/whitepaper",
  "https://qbit.org/wallet",
  "https://qbit.org/pool/setup",
  "https://qbit.org/ecosystem",
  "https://mempool.qbit.org",
]);

test("the Qbit page links only to checked official pages", () => {
  const page = readFileSync("public/qbit-page.js", "utf8");
  const app = readFileSync("public/app.js", "utf8");
  assert.match(app, /rel: "noopener noreferrer"/);
  assert.match(app, /target: "_blank"/);
  for (const link of qbitLinks) {
    assert.equal(allowed.has(link.href), true, link.href);
    assert.equal(page.includes(link.href), true);
  }
  assert.equal(app.includes("https://"), false);
  const guide = readFileSync("public/guide.js", "utf8");
  assert.match(guide, /href: "https:\/\/github\.com\/P2MR-Inscriptions\/pins"/);
  assert.match(guide, /label: "PINS on GitHub"/);
  assert.match(app, /pinsSource\.href/);
  assert.match(app, /github-mark\.svg/);
  assert.equal(app.includes('h("h1", null, "Qbit")'), false);
  assert.match(app, /class: "guide qbit-page"/);
  assert.match(readFileSync("public/style.css", "utf8"), /#q \{ width: 520px; min-width: 520px;/);
  assert.match(readFileSync("public/style.css", "utf8"), /transform: scale\(0\.8\)/);
  assert.match(readFileSync("public/github-mark.svg", "utf8"), /fill="#141210"/);
  assert.equal(readFileSync("public/github-mark.svg", "utf8").includes("currentColor"), false);
  assert.match(readFileSync("public/style.css", "utf8"), /\.pins-github \{[^}]*color: var\(--fg\)/);
  assert.match(readFileSync("public/style.css", "utf8"), /html\.dark \.pins-github \{ background: #f6f1e8; color: var\(--bg\); \}/);
  assert.match(app, /h\("br"\), "It is read-only\./);
  assert.match(app, /h\("br"\), "This page does not read the indexer/);
  assert.equal(app.includes("placeGithubGuide"), false);
  assert.equal(app.includes("not a Qbit project"), false);
  assert.equal(page.includes("not a Qbit project"), false);
  assert.equal(page.includes("not affiliated"), false);
  assert.match(page, /PINS is an independent protocol\./);
  assert.match(app, /createElementNS/);
  assert.match(readFileSync("public/index.html", "utf8"), /PINS is an independent protocol\./);
  assert.match(readFileSync("public/qbit-page.js", "utf8"), /href: "https:\/\/qbit\.org\/wallet"/);
  assert.match(readFileSync("public/qbit-page.js", "utf8"), /Get Qbit Wallet/);
  assert.match(readFileSync("public/style.css", "utf8"), /\.site-foot \{[^}]*position: fixed/);
  assert.match(readFileSync("public/style.css", "utf8"), /\.pager \{[^}]*justify-content: center/);
  assert.match(readFileSync("public/style.css", "utf8"), /\.guide \{[^}]*font-size: 1rem/);
  assert.match(app, /Previous P2MR Inscription/);
  assert.match(app, /Next P2MR Inscription/);
  assert.match(app, /-half - 10/);
  assert.match(app, /dataset\.gapShift/);
  const render = app.slice(app.indexOf("function render"), app.indexOf("function startup"));
  assert.equal(render.includes("placePinsGithub"), false);
  assert.match(readFileSync("public/index.html", "utf8"), />What is Qbit\?</);
});
