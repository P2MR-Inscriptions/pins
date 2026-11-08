// In-app return targets. A hash is internal only. External history is never used.
import { brand } from "./brand.js";

const DETAIL = /^#\/inscription\/[0-9a-f]{64}i\d+$/;
const TRANSIENT = new RegExp(`^#\\/(?:number|${brand.piecePath})\\/\\d+$`);

export function normalizeHash(hash) {
  if (!hash || hash === "#") return "#/";
  return hash.startsWith("#") ? hash : `#${hash}`;
}

export function isDetailHash(hash) {
  return DETAIL.test(normalizeHash(hash));
}

/** Number and piece routes replace themselves with an inscription. They are not a place to return to. */
export function isTransientHash(hash) {
  return TRANSIENT.test(normalizeHash(hash));
}

/** Any explorer page that is not an inscription detail. */
export function isListHash(hash) {
  const value = normalizeHash(hash);
  if (isDetailHash(value)) return false;
  return value === "#/" || value.startsWith("#/");
}

export function fallbackListHash() {
  return "#/inscriptions";
}

export function backHash(lastListHash, here) {
  const current = normalizeHash(here);
  const previous = lastListHash ? normalizeHash(lastListHash) : "";
  if (previous && previous !== current && isListHash(previous) && !isTransientHash(previous)) return previous;
  return fallbackListHash();
}

export function backLabel(hash) {
  const value = normalizeHash(hash);
  if (value === "#/") return "Back to home";
  if (value.startsWith("#/collection")) return "Back to collection";
  if (value.startsWith("#/address/")) return "Back to address";
  if (value.startsWith("#/inscriptions")) return "Back to Latest P2MR Inscriptions";
  if (value.startsWith("#/how-it-works")) return "Back to How it works";
  return "Back to Latest P2MR Inscriptions";
}
