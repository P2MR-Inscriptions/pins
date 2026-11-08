import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const plate = '<rect width="1024" height="1024" fill="#0b120d"/>';

test("the rendered PINS mark is the official foreground with the plate removed", () => {
  const official = readFileSync("public/brand/pins-avatar-official.svg", "utf8");
  const mark = readFileSync("public/pins-avatar.svg", "utf8");
  const html = readFileSync("public/index.html", "utf8");
  assert.equal(official.includes(plate), true);
  assert.equal(mark.includes(plate), false);
  assert.equal(mark.includes("#0b120d"), false);
  const expected = official.replace(plate, "").replace(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">',
    '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">',
  );
  assert.equal(mark, expected);
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
