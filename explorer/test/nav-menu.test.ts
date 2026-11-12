// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the menu button is width-based and stays out of the desktop row", () => {
  const html = readFileSync("public/index.html", "utf8");
  const css = readFileSync("public/style.css", "utf8");
  const app = readFileSync("public/app.js", "utf8");
  assert.match(html, /id="nav-toggle"/);
  assert.match(html, /aria-controls="explorer-nav"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /id="explorer-nav"/);
  assert.ok(html.indexOf("Latest P2MR Inscriptions") < html.indexOf('id="nav-collection">Collection<'));
  assert.ok(html.indexOf("How it works?") < html.indexOf(">What is Qbit?<"));
  assert.match(css, /#nav-toggle \{ display: none; \}/);
  assert.match(css, /@media \(max-width: 79\.999rem\)/);
  assert.equal(css.includes("navigator.userAgent"), false);
  assert.equal(app.includes("navigator.userAgent"), false);
  assert.match(app, /function closeMenu/);
  assert.match(app, /aria-expanded/);
  assert.match(app, /window\.innerWidth >= 1280/);
  assert.match(app, /Close menu/);
  const small = css.slice(css.indexOf("@media (max-width: 79.999rem)"));
  assert.match(small, /\.home-hero h2 \{[^}]*white-space: nowrap/);
  assert.match(small, /\.home-hero \{[^}]*align-items: center/);
  assert.match(small, /#foot \{ order: 3; justify-content: center; \}/);
  assert.match(small, /\.state-full \{[^}]*text-align: center/);
});
