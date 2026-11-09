// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

test("page assets stay on this origin except the Qbit link", () => {
  const html = readFileSync("public/index.html", "utf8");
  const css = readFileSync("public/style.css", "utf8");
  const js = readFileSync("public/app.js", "utf8");
  assert.deepEqual(html.match(/https?:\/\/[^"'\s)]+/g), ["https://qbit.org"]);
  assert.equal(/https?:/.test(css), false);
  assert.deepEqual(js.match(/https?:\/\/[^"'\s)]+/g), ["http://www.w3.org/2000/svg"]);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /PINS Explorer/);
  assert.match(html, /href="#\/inscriptions">Latest P2MR Inscriptions</);
  assert.match(html, /id="nav-collection">FLATBITS collection</);
  assert.match(html, /class="top-cluster"/);
  assert.match(html, /How it works/);
  assert.ok(html.indexOf("Latest P2MR Inscriptions") < html.indexOf("FLATBITS collection"));
  assert.ok(html.indexOf("FLATBITS collection") < html.indexOf("How it works"));
  assert.ok(html.indexOf("How it works?") < html.indexOf(">What is Qbit?<"));
  assert.match(html, /class="icon-sun"/);
  assert.match(html, /class="icon-moon"/);
  assert.match(html, /aria-label="Switch to light mode"/);
  assert.match(html, /src="\/theme.js"/);
  assert.equal(sha("public/pins-avatar.svg"), "9fd884f2b3889aac94081c90c2062597c59a0d567995a0c59c694fcff0f9f4a9");
  assert.equal(sha("public/brand/pins-avatar-official.svg"), "5be13e5eedc7debf60454e0f9b04d2caae92520b2961013eedd928015b2c8310");
  assert.equal(sha("public/qbit-logo-full.svg"), "28978ec61a6f72fc55d18cf180a80fe357eecc3d4d617686f8f09d13f86e2de7");
  const fontBytes = statSync("public/fonts/chakra-petch-latin-400-normal.woff2").size + statSync("public/fonts/chakra-petch-latin-500-normal.woff2").size;
  assert.ok(fontBytes > 0 && fontBytes < 25000);
  assert.equal(html.includes("partnership"), false);
  assert.equal(html.includes("not a Qbit project"), false);
  assert.equal(html.includes(">Built on Qbit<"), false);
  assert.match(html, /class="qbit-note">Built on</);
  assert.match(html, /class="qbit-note">PINS is an independent protocol\.</);
  assert.ok(html.indexOf(">Built on<") < html.indexOf("qbit-logo-full.svg"));
  assert.ok(html.indexOf("qbit-logo-full.svg") < html.indexOf(">PINS is an independent protocol.<"));
  assert.match(html, /class="qbit-group"/);
  assert.match(html, /class="qbit-block"/);
  console.log(JSON.stringify({
    html: statSync("public/index.html").size,
    css: statSync("public/style.css").size,
    js: statSync("public/app.js").size,
    theme: statSync("public/theme.js").size,
    pinsLogo: statSync("public/pins-avatar.svg").size,
    qbitLogo: statSync("public/qbit-logo-full.svg").size,
    fonts: fontBytes,
  }));
});

test("image mats are the pre-redesign backing and the sale palette remains", () => {
  const css = readFileSync("public/style.css", "utf8");
  assert.match(css, /--mat: #110e0c/);
  assert.match(css, /html:not\(\.dark\)[\s\S]*--mat: #e7e1d6/);
  assert.equal(css.includes("#e6efea"), false);
  assert.match(css, /\.px \{[^}]*background: var\(--mat\)/);
  assert.equal(css.includes("#202a26"), false);
  assert.equal(css.includes("Outfit"), false);
  assert.equal(css.includes("Space Grotesk"), false);
  assert.match(css, /Chakra Petch/);
  assert.equal(css.includes("background: var(--art)"), false);
  assert.match(css, /justify-content: center/);
  assert.match(css, /details\.manifest \{ margin: 1\.25rem 0 1\.5rem/);
  assert.match(css, /white-space: nowrap/);
  assert.equal(css.includes("content-visibility"), false);
  for (const color of ["#110e0c", "#1ab453", "#f6f1e8", "#e07b14"]) assert.equal(css.includes(color), true, color);
});

test("warmup retries do not rebuild the page and home paints once", () => {
  const src = readFileSync("public/app.js", "utf8");
  const home = src.slice(src.indexOf("async function home"), src.indexOf("async function inscriptionsPage"));
  assert.equal((home.match(/refreshStatus/g) ?? []).length, 1);
  assert.ok(home.indexOf("refreshStatus") < home.indexOf("page.show"));
  assert.equal(home.includes("Holders"), false);
  assert.equal(home.includes("authenticPieces"), false);
  assert.equal(home.includes("/collection/sample"), false);
  assert.equal(home.includes("heroCard"), false);
  assert.match(src, /LATEST P2MR INSCRIPTION/);
  assert.match(home, /HOME_SIDE/);
  assert.match(home, /class: "home-side"/);
  assert.match(home, /class: "home-links"/);
  assert.match(home, /Browse all P2MR Inscriptions →/);
  assert.match(home, /Open the \$\{brand\.collectionNav\} collection →/);
  assert.equal(/page\.get\([`'"]\/collection/.test(home), false);
  assert.match(src, /data-warmup/);
  assert.match(src, /Reading the index\. This can take a few minutes\./);
  assert.match(src, /aria-busy/);
  assert.match(readFileSync("public/style.css", "utf8"), /border-top-color: #1ab552/);
  assert.equal(readFileSync("public/style.css", "utf8").includes("border-top-color: var(--primary)"), false);
  assert.equal(src.includes("refreshes by itself"), false);
  assert.match(src, /setTimeout\(\(\) => \{ runPage\(fn, args, serial, false\); \}, 1500\)/);
  assert.match(home, /It is read-only\. It does not sign, broadcast, or keep a wallet\./);
  assert.equal(home.includes("chainLine"), false);
  assert.equal(home.includes("More recent"), false);
  assert.equal(src.includes("Manifest fields are labelled separately."), false);
  assert.match(src, /not chain data/);
  assert.match(src, /const PAGE_SIZE = 104;/);
  assert.match(src, /const HOME_FETCH = HOME_SIDE \+ 1;/);
  assert.match(src, /const PAGE_SIZE = 104;/);
  assert.match(src, /const SHEET_COLS = 13;/);
  assert.equal(src.includes("detail-close"), false);
  assert.equal(src.includes("window.close"), false);
  assert.match(src, /stroke: "currentColor"/);
  assert.match(home, /READ FROM YOUR OWN NODE/);
  assert.ok(home.indexOf("home-intro") < home.indexOf("home-board"));
  assert.match(readFileSync("public/style.css", "utf8"), /width: min\(100%, 80rem\)/);
  assert.match(readFileSync("public/style.css", "utf8"), /a\.back \{[^}]*color: #1ab552/);
  assert.match(readFileSync("public/style.css", "utf8"), /font-weight: 700/);
  assert.match(readFileSync("public/style.css", "utf8"), /chakra-petch-latin-700-normal\.woff2/);
  const introRule = readFileSync("public/style.css", "utf8").match(/\.home-intro \{[^}]*\}/)?.[0] ?? "";
  assert.equal(introRule.includes("flex: 1 0 auto"), false);
  assert.match(readFileSync("public/style.css", "utf8"), /grid-template-columns: 1fr auto 1fr/);
  assert.match(readFileSync("public/style.css", "utf8"), /\.qbit-group \{ grid-column: 2; grid-row: 1;/);
  assert.match(readFileSync("public/index.html", "utf8"), /id="state-line"/);
  assert.match(src, /function stateControl/);
  assert.match(readFileSync("public/style.css", "utf8"), /html:not\(\.dark\) \.guide h1, html:not\(\.dark\) \.guide h2 \{ color: #0c6b32; \}/);
  assert.match(src, /i\.authenticity === "confirmed" && i\.snapshotStale !== true/);
  assert.match(src, /i\.chain === "confirmed" && i\.snapshotStale !== true/);
  assert.match(src, /chainBadge, showBadge \? authNote/);
  assert.match(src, /backHash\(lastListHash/);
  assert.equal((src.match(/setInterval\(/g) ?? []).length, 1);
  assert.equal(src.includes("themeButton.textContent"), false);
});
