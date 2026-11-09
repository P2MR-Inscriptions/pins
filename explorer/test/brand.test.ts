
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const sha = (file: string) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

test("the rendered PINS mark is the transparent official foreground", () => {
  const official = readFileSync("public/brand/pins-avatar-official.svg", "utf8");
  const mark = readFileSync("public/pins-avatar.svg", "utf8");
  const html = readFileSync("public/index.html", "utf8");

  const officialPng = official.match(/data:image\/png;base64,([^"]+)/);
  const markPng = mark.match(/data:image\/png;base64,([^"]+)/);

  assert.ok(officialPng);
  assert.ok(markPng);

  const officialBytes = Buffer.from(officialPng[1], "base64");
  const markBytes = Buffer.from(markPng[1], "base64");

  assert.equal(officialBytes[25], 2);
  assert.equal(markBytes[25], 6);

  assert.notEqual(official, mark);

  assert.equal(
    sha("public/brand/pins-avatar-official.svg"),
    "5be13e5eedc7debf60454e0f9b04d2caae92520b2961013eedd928015b2c8310",
  );
  assert.equal(
    sha("public/pins-avatar.svg"),
    "9fd884f2b3889aac94081c90c2062597c59a0d567995a0c59c694fcff0f9f4a9",
  );

  assert.equal(html.includes("pins-avatar-official.svg"), false);
  assert.match(html, /src="\/pins-avatar\.svg"/);
});

test("the Qbit wordmark is the unmodified official file", () => {
  const logo = readFileSync("public/qbit-logo-full.svg");
  const html = readFileSync("public/index.html", "utf8");
  const css = readFileSync("public/style.css", "utf8");
  assert.equal(createHash("sha256").update(logo).digest("hex"), "28978ec61a6f72fc55d18cf180a80fe357eecc3d4d617686f8f09d13f86e2de7");
  assert.equal(logo.includes(Buffer.from("<rect")), false);
  assert.match(html, /src="\/qbit-logo-full\.svg"[^>]*width="92" height="40"/);
  assert.match(css, /aspect-ratio: 736 \/ 320/);
  assert.match(css, /\.logo \{[^}]*background: transparent/);
  assert.match(css, /\.qbit-block img \{[^}]*background: transparent/);
});
