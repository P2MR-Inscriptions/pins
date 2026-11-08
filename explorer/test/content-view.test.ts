import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mediaKind, normalizeType } from "../public/content-view.js";

test("content kinds stay inside the supported set", () => {
  const cases: [unknown, string][] = [
    ["image/png", "image"],
    ["image/jpeg; charset=binary", "image"],
    ["IMAGE/GIF", "image"],
    ["image/webp", "image"],
    ["image/svg+xml", "svg"],
    ["text/plain", "text"],
    ["application/json", "text"],
    ["text/html", "html"],
    ["text/html;charset=utf-8", "html"],
    ["text/javascript", "other"],
    ["application/javascript", "other"],
    ["application/pdf", "other"],
    ["application/octet-stream", "other"],
    ["audio/mpeg", "audio"],
    ["audio/wav", "audio"],
    ["audio/ogg", "audio"],
    ["audio/webm", "audio"],
    ["video/mp4", "video"],
    ["video/webm", "video"],
    ["video/ogg", "video"],
    ["image/png\r\nX", "other"],
    ["", "other"],
    [null, "other"],
    [12, "other"],
  ];
  for (const [raw, kind] of cases) assert.equal(mediaKind(raw), kind, String(raw));
  assert.equal(normalizeType(" Text/Plain ; charset=utf-8 "), "text/plain");
});

test("the page does not give an inscribed page the parent origin or fullscreen", () => {
  const app = readFileSync("public/app.js", "utf8");
  const css = readFileSync("public/style.css", "utf8");
  const guide = readFileSync("public/guide.js", "utf8");
  assert.match(app, /sandbox: "allow-scripts"/);
  for (const token of ["allow-same-origin", "allow-fullscreen", "allow-popups", "allow-forms", "allow-top-navigation", "allow-downloads"]) {
    assert.equal(app.includes(token), false, token);
  }
  assert.match(app, /preload: "none"/);
  assert.equal(app.includes("autoplay"), false);
  assert.match(app, /function releaseMedia/);
  assert.match(app, /class: "full-toggle"/);
  assert.match(app, /requestFullscreen/);
  assert.match(app, /Exit full screen/);
  assert.match(css, /\.viewer:fullscreen/);
  assert.match(css, /object-fit: contain/);
  assert.match(guide, /sandbox is allow-scripts/);
  assert.match(guide, /connect-src to none/);
  assert.match(guide, /cannot fetch this explorer or the indexer/);
  assert.equal(guide.includes("or a wallet"), false);
  assert.equal(app.includes("innerHTML"), false);
});
