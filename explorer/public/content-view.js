// SPDX-License-Identifier: Apache-2.0

// How a P2MR Inscription body may be shown. The server uses the same rules.
// Unknown types stay downloadable. Nothing here fetches or executes content.

export const PREVIEW_BYTES = 2048;

const TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const RASTER = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT = new Set(["text/plain", "application/json"]);
const AUDIO = new Set(["audio/mpeg", "audio/wav", "audio/wave", "audio/x-wav", "audio/ogg", "audio/webm"]);
const VIDEO = new Set(["video/mp4", "video/webm", "video/ogg"]);

/** MIME type without parameters. Empty when the value is not a single type token. */
export function normalizeType(raw) {
  if (typeof raw !== "string") return "";
  const base = raw.split(";")[0].trim().toLowerCase();
  return TYPE_RE.test(base) ? base : "";
}

/** image and svg paint in an img. text is plain. audio, video, and html start only after a click. */
export function mediaKind(raw) {
  const type = normalizeType(raw);
  if (RASTER.has(type)) return "image";
  if (type === "image/svg+xml") return "svg";
  if (TEXT.has(type)) return "text";
  if (AUDIO.has(type)) return "audio";
  if (VIDEO.has(type)) return "video";
  if (type === "text/html") return "html";
  return "other";
}
