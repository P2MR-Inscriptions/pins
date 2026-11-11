import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { guideSections } from "../public/guide.js";

const text = guideSections.map((section) => JSON.stringify(section)).join("\n");

test("How it works is a menu route with a section for each topic", () => {
  const html = readFileSync("public/index.html", "utf8");
  const app = readFileSync("public/app.js", "utf8");
  const css = readFileSync("public/style.css", "utf8");
  assert.match(html, /id="nav-guide" href="#\/how-it-works"|href="#\/how-it-works" id="nav-guide"/);
  assert.match(app, /#\/how-it-works/);
  assert.match(app, /fn === guidePage/);
  assert.match(css, /\.top nav \{ flex-wrap: wrap;/);
  assert.match(css, /\.guide-toc \{ display: flex; flex-wrap: wrap;/);
  const ids = guideSections.map((section) => section.id);
  assert.deepEqual(ids, [
    "prerequisites", "configuration", "fresh-setup", "update", "two-processes",
    "snapshot", "read-only", "status", "authenticity", "troubleshooting",
  ]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 10);
  for (const id of ids) {
    assert.match(app, new RegExp(`guide-\\$\\{section\\.id\\}|guide-\\$\\{slug\\}`));
    assert.match(app, new RegExp(`#/how-it-works/\\$\\{section\\.id\\}`));
  }
  assert.match(app, /function scrollGuideHeading/);
  assert.match(app, /headerOffset\(\)/);
  assert.equal(app.includes("scrollIntoView"), false);
  assert.match(css, /\.guide h2 \{[^}]*scroll-margin-top: var\(--header-offset, 5\.5rem\)/);
});

test("the guide matches the local scripts and does not leak a setup shortcut", () => {
  assert.match(text, /22\.12/);
  assert.match(text, /older than 23/);
  assert.match(text, /git/);
  assert.match(text, /curl/);
  assert.match(text, /witness scripts/);
  assert.equal(text.includes("not pruned"), false);
  assert.equal(text.includes("input index"), false);
  assert.match(text, /witness pruned/);
  assert.match(text, /QBIT_CONF/);
  assert.match(text, /Do not change qbit\.conf/);
  assert.match(text, /npm run setup/);
  assert.match(text, /Do not run npm run setup on a patched install/);
  assert.match(text, /npm run indexer/);
  assert.match(text, /npm start/);
  assert.match(text, /127\.0\.0\.1:8787/);
  assert.match(text, /127\.0\.0\.1:8080/);
  assert.match(text, /getblockcount, getblockhash, getblockheader, and getrawtransaction/);
  assert.match(text, /authentic set to true/);
  assert.match(text, /node -v/);
  assert.equal(/https?:\/\/(?!127\.0\.0\.1)/.test(text), false);
  for (const banned of ["/home/", "/Users/", "/agent", "npm install -g", "npm install flatbits", "rpcpassword=", "password:", "edit qbit.conf", "add to qbit.conf"]) {
    assert.equal(text.includes(banned), false, banned);
  }
});
