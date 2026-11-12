// SPDX-License-Identifier: Apache-2.0

// PINS explorer front end. Plain ES module, no dependencies and no remote scripts.
// API text is untrusted: it is inserted only with textContent / createTextNode.
import { brand } from "./brand.js";
import { mediaKind, normalizeType, PREVIEW_BYTES } from "./content-view.js";
import { guideSections, pinsSource } from "./guide.js";
import { qbitLinks, qbitSections } from "./qbit-page.js";
import { backHash, isDetailHash, isTransientHash } from "./history.js";
import { indexedStatus, nodeStatus } from "./status-tone.js";

const view = document.getElementById("view");
const SAFE_ID = /^[0-9a-f]{64}i\d+$/;
const PAGE_SIZE = 104;
const HOME_SIDE = 14;
const HOME_FETCH = HOME_SIDE + 1;
const SHEET_COLS = 13;
const listScroll = new Map();
let lastListHash = null;
let hereHash = "";
let restoreScroll = null;
let status = null;
let routeSerial = 0;
let pageSignal = null;
let pageAbort = new AbortController();
let retryTimer = 0;
let statusTask = null;

// document.createElement("svg") is an HTML element and does not paint.
// Arrows and status marks have to be created in the SVG namespace.
const SVG_NS = "http://www.w3.org/2000/svg";
const SVG_TAGS = new Set(["svg", "path", "circle", "g", "line", "polyline", "polygon", "rect"]);
const h = (tag, attrs, ...kids) => {
  const svg = SVG_TAGS.has(tag);
  const el = svg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class" && !svg) el.className = v;
    else if (k.startsWith("on") && !svg) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
};

async function request(path, signal) {
  const res = await fetch(`/api${path}`, signal ? { signal } : {});
  let body = null;
  try { body = await res.json(); } catch { /* handled below */ }
  if (!res.ok) throw Object.assign(new Error(body?.error || `HTTP ${res.status}`), { status: res.status });
  return body;
}

function openPage() {
  const serial = routeSerial;
  const signal = pageSignal;
  return {
    live: () => serial === routeSerial && !signal.aborted,
    show: (...nodes) => { if (serial === routeSerial) render(...nodes); },
    get: (path) => request(path, signal),
  };
}

const pieceTitle = (piece) => {
  if (!piece || typeof piece !== "object") return "P2MR Inscription";
  const base = String(piece.namePrefix || piece.collectionName || brand.pieceWord).replace(/[\s#]+$/, "");
  const n = Number(piece.number);
  return Number.isFinite(n) ? `${base} #${n.toLocaleString("en-US")}` : base;
};
const fmt = (n) => {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString("en-US") : "unknown";
};
const short = (s, n = 10) => (s && s.length > n * 2 + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s || "");
const bytes = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return "unknown";
  return v < 1024 ? `${v} B` : `${(v / 1024).toFixed(1)} kB`;
};
const clip = (value, max) => {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const link = (href, text, cls) => h("a", { href, class: cls }, text);
const addrLink = (a) => (a ? link(`#/address/${encodeURIComponent(a)}`, a, "mono") : h("span", { class: "muted" }, "none (burned, lost, or unbound)"));
const txLink = (t) => link(`#/tx/${t}`, t, "mono");
const verified = (text = "Snapshot") => h("span", { class: "badge ok", title: "From the indexer snapshot. This explorer does not recompute ownership or the collection check." }, text);
const manifestBadge = () => h("span", { class: "badge warn", title: "From the manifest file supplied with this explorer, not from the chain." }, "Manifest");

function facts(rows) {
  const dl = h("dl", { class: "facts" });
  for (const [k, v] of rows.filter(Boolean)) if (v !== undefined && v !== null && v !== false) dl.append(h("dt", null, k), h("dd", null, v));
  return dl;
}

function pager(total, offset, limit, go) {
  const pages = Math.max(1, Math.ceil(total / limit));
  const page = Math.floor(offset / limit) + 1;
  const input = h("input", { type: "number", min: 1, max: pages, value: page, "aria-label": "Page number" });
  return h("div", { class: "pager" },
    h("div", { class: "pager-group" },
      h("button", { disabled: page <= 1, onclick: () => go((page - 2) * limit) }, "Previous"),
      h("span", { class: "muted" }, `Page ${fmt(page)} of ${fmt(pages)}`)),
    h("div", { class: "pager-group" },
      input,
      h("button", { onclick: () => go((Math.min(pages, Math.max(1, Number(input.value) || 1)) - 1) * limit) }, "Go"),
      h("button", { disabled: page >= pages, onclick: () => go(page * limit) }, "Next")));
}

function pxLength(raw, fallback) {
  const text = String(raw || "").trim();
  if (text.endsWith("rem")) return parseFloat(text) * parseFloat(getComputedStyle(document.documentElement).fontSize);
  const value = parseFloat(text);
  return Number.isFinite(value) ? value : fallback;
}

function cardMetrics() {
  const style = getComputedStyle(document.documentElement);
  return {
    cell: pxLength(style.getPropertyValue("--cell"), 96),
    gap: pxLength(style.getPropertyValue("--gap"), 8),
  };
}

function fitSheet(board) {
  const { cell, gap } = cardMetrics();
  const box = getComputedStyle(view);
  const max = Math.max(0, view.clientWidth - parseFloat(box.paddingLeft) - parseFloat(box.paddingRight));
  const fit = Math.max(1, Math.floor((max + gap) / (cell + gap)));
  const cols = Math.min(SHEET_COLS, fit);
  board.style.width = `${cols * cell + Math.max(0, cols - 1) * gap}px`;
  board.style.setProperty("--cols", String(cols));
}

function picture(src, alt, index, extra) {
  // The size hint comes from the manifest (status.artSize). Without one, the image has no hint and the style sizes it.
  const art = status?.artSize;
  return h("img", {
    class: extra || "px",
    src, alt,
    width: art?.width, height: art?.height,
    decoding: "async",
    loading: index < 10 ? "eager" : "lazy",
    fetchpriority: index < 4 ? "high" : "auto",
  });
}

const liveMedia = new Set();
let fullReturn = null;

function stopOne(el) {
  if (!el) return;
  el.dataset.stopping = "1";
  liveMedia.delete(el);
  try {
    if (el.tagName === "IFRAME") el.src = "about:blank";
    else {
      el.pause?.();
      el.removeAttribute("src");
      el.load?.();
    }
  } catch { /* already gone */ }
}

function releaseMedia() {
  for (const el of [...liveMedia]) stopOne(el);
  document.querySelectorAll(".viewer.is-enlarged").forEach((node) => clearEnlarge(node));
  document.querySelectorAll(".viewer-spacer").forEach((node) => node.remove());
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

function typeLabel(item) {
  if (item?.contentRole === "leaf-list") return "Leaf list";
  return clip(normalizeType(item?.contentType) || "No content type", 48);
}

function fallbackFrame(item, extra, message) {
  return h("div", { class: `tile${extra ? ` ${extra}` : ""}` },
    h("span", { class: "frame-note" }, typeLabel(item)),
    h("span", { class: "frame-note" }, message || "Preview unavailable"));
}

function imageFrame(item, index, extra) {
  if (item.bodyLength === 0) return fallbackFrame(item, extra, "No content bytes");
  const img = picture(`/api/content/${item.id}`, `P2MR Inscription ${fmt(item.number)}`, index, extra ? `px ${extra}` : "px");
  img.addEventListener("error", () => {
    if (img.isConnected) img.replaceWith(fallbackFrame(item, extra, "Preview unavailable"));
  });
  return img;
}

function textFrame(item, extra) {
  const box = h("div", { class: `tile preview${extra ? ` ${extra}` : ""}` });
  const pre = h("pre", { class: "frame-text" }, item.bodyLength === 0 ? "No content bytes" : "Text");
  box.append(pre);
  if (item.bodyLength === 0 || !SAFE_ID.test(item.id)) return box;
  fetch(`/api/content/${item.id}?preview=1`).then(async (res) => {
    if (!box.isConnected) return;
    if (!res.ok) { pre.textContent = "Preview unavailable"; return; }
    const text = await res.text();
    if (!box.isConnected) return;
    pre.textContent = text.slice(0, PREVIEW_BYTES);
  }).catch(() => {
    if (box.isConnected) pre.textContent = "Preview unavailable";
  });
  return box;
}

function playIcon() {
  return h("svg", { viewBox: "0 0 24 24", width: "18", height: "18", "aria-hidden": "true", focusable: "false" },
    h("path", { d: "M8 5v14l11-7z", fill: "currentColor" }));
}
function stopIcon() {
  return h("svg", { viewBox: "0 0 24 24", width: "18", height: "18", "aria-hidden": "true", focusable: "false" },
    h("path", { d: "M6 6h12v12H6z", fill: "currentColor" }));
}
function fullIcon(exit) {
  const d = exit ? "M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" : "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5";
  return h("svg", { viewBox: "0 0 24 24", width: "18", height: "18", "aria-hidden": "true", focusable: "false" },
    h("path", { d, fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" }));
}

function gatedFrame(item, kind, extra) {
  if (item.bodyLength === 0) return fallbackFrame(item, extra, "No content bytes");
  const box = h("div", { class: `tile media${extra ? ` ${extra}` : ""}` });
  const label = kind === "audio" ? "Play audio" : kind === "video" ? "Play video" : "Open page";
  const play = h("button", { type: "button", class: "frame-play", "aria-label": label, title: label }, playIcon());
  play.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    startMedia(box, item, kind);
  });
  box.append(play);
  return box;
}

function startMedia(box, item, kind) {
  const url = `/api/content/${item.id}`;
  const el = kind === "html"
    ? h("iframe", { sandbox: "allow-scripts", referrerpolicy: "no-referrer", title: "Inscribed page", src: `${url}?frame=1` })
    : kind === "audio"
      ? h("audio", { controls: true, preload: "none", src: url })
      : h("video", { controls: true, preload: "none", playsinline: true, src: url });
  liveMedia.add(el);
  const fail = () => {
    if (el.dataset.stopping === "1" || !box.isConnected) return;
    stopOne(el);
    box.replaceWith(fallbackFrame(item, box.classList.contains("art") ? "art" : "", "Preview unavailable"));
  };
  el.addEventListener("error", fail);
  const stop = h("button", { type: "button", class: "frame-stop", "aria-label": "Stop", title: "Stop" }, stopIcon());
  stop.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    stopOne(el);
    if (box.isConnected) box.replaceWith(gatedFrame(item, kind, box.classList.contains("art") ? "art" : ""));
  });
  box.replaceChildren(el, stop);
  if (kind !== "html") {
    const started = el.play?.();
    if (started?.catch) started.catch(() => {});
  }
}

function contentFrame(item, index, extra) {
  try {
    if (!item || !SAFE_ID.test(item.id || "")) return fallbackFrame(item, extra, "Preview unavailable");
    const kind = mediaKind(item.contentType);
    if (kind === "image" || kind === "svg") return imageFrame(item, index, extra);
    if (kind === "text") return textFrame(item, extra);
    if (kind === "audio" || kind === "video" || kind === "html") return gatedFrame(item, kind, extra);
    return fallbackFrame(item, extra, "Preview unavailable");
  } catch {
    return h("div", { class: `tile${extra ? ` ${extra}` : ""}` }, "Preview unavailable");
  }
}

function cell(item, index) {
  try {
    const id = item && typeof item.id === "string" ? item.id : "";
    const label = item && item.collectionPiece != null && Number.isFinite(Number(item.collectionPiece))
      ? `#${fmt(item.collectionPiece)}`
      : `No. ${fmt(item?.number)}`;
    const frame = contentFrame(item, index);
    if (!SAFE_ID.test(id)) return h("div", { class: "cell" }, frame, h("span", { class: "cap" }, label));
    return h("a", { class: "cell", href: `#/inscription/${id}`, title: id }, frame, h("span", { class: "cap" }, label));
  } catch {
    return h("div", { class: "cell" }, h("div", { class: "tile" }, "Preview unavailable"), h("span", { class: "cap" }, "P2MR Inscription"));
  }
}

function syncFullButton(viewer) {
  const button = viewer.querySelector(".full-toggle");
  if (!button) return;
  const on = document.fullscreenElement === viewer || viewer.classList.contains("is-enlarged");
  const label = on ? "Exit full screen" : "Full screen";
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
  button.setAttribute("aria-pressed", on ? "true" : "false");
  button.replaceChildren(fullIcon(on));
}

function clearEnlarge(viewer) {
  viewer.classList.remove("is-enlarged");
  const spacer = viewer.previousElementSibling;
  if (spacer?.classList?.contains("viewer-spacer")) spacer.remove();
  syncFullButton(viewer);
}

async function toggleFull(viewer, button) {
  const on = document.fullscreenElement === viewer || viewer.classList.contains("is-enlarged");
  if (on) {
    if (document.fullscreenElement === viewer) {
      try { await document.exitFullscreen(); } catch { /* already closed */ }
    }
    clearEnlarge(viewer);
    const back = fullReturn && fullReturn.isConnected ? fullReturn : button;
    back?.focus?.();
    return;
  }
  fullReturn = button;
  if (document.fullscreenEnabled && viewer.requestFullscreen) {
    try {
      await viewer.requestFullscreen();
      syncFullButton(viewer);
      return;
    } catch { /* denied or unavailable; use the in-page frame */ }
  }
  const spacer = h("div", { class: "viewer-spacer" });
  spacer.style.height = `${viewer.offsetHeight}px`;
  viewer.before(spacer);
  viewer.classList.add("is-enlarged");
  syncFullButton(viewer);
  button.focus();
}

function detailViewer(item) {
  const viewer = h("div", { class: "viewer" });
  viewer.append(contentFrame(item, 0, "art"));
  const button = h("button", { type: "button", class: "full-toggle", "aria-label": "Full screen", title: "Full screen", "aria-pressed": "false" }, fullIcon(false));
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void toggleFull(viewer, button);
  });
  viewer.append(button);
  return viewer;
}

const errorBox = (e) => h("div", { class: "err", role: "alert" },
  h("strong", null, e.status === 404 ? "Not found" : "Something went wrong"),
  h("p", null, e.message),
  e.status === 503 ? h("p", null, "Check that the indexer is running and that INDEXER_URL points to it. The default port is 8787. It does not answer until the first catch-up finishes.") : null);

const WARMUP = "Reading the index. This can take a few minutes.";
function paint(nodes, scroll) {
  view.replaceChildren(...nodes.flat().filter((node) => node != null && node !== false));
  if (!scroll) return;
  const restore = restoreScroll;
  restoreScroll = null;
  if (restore != null) {
    requestAnimationFrame(() => window.scrollTo(0, restore));
    return;
  }
  view.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}
function render(...nodes) {
  view.dataset.ready = "1";
  view.setAttribute("aria-busy", "false");
  paint(nodes, true);
  concealPinsGithub();
}
function startup(message) {
  return h("div", { class: "startup", role: "status", "aria-live": "polite", "aria-busy": "true", "data-warmup": "1" },
    h("span", { class: "spinner", "aria-hidden": "true" }),
    h("p", null, message));
}
function showStartup(message) {
  const note = view.querySelector("[data-warmup] p");
  if (note) {
    if (note.textContent !== message) note.textContent = message;
    return;
  }
  if (view.dataset.ready === "1") return;
  view.setAttribute("aria-busy", "true");
  paint([startup(message)], false);
}

const query = (s) => Object.fromEntries(new URLSearchParams(s || ""));
const go = (path) => { location.hash = path; };

function slicePage(items, offset) {
  const start = Math.max(0, offset);
  return { shown: items.slice(start, start + PAGE_SIZE), total: items.length, offset: start };
}

/* ---------- pages ---------- */

function countedInscriptions(n) {
  return Number(n) === 1 ? "1 P2MR Inscription" : `${fmt(n)} P2MR Inscriptions`;
}

function homeHero(item) {
  const label = item.collectionPiece != null ? `#${fmt(item.collectionPiece)}` : `No. ${fmt(item.number)}`;
  const href = item && SAFE_ID.test(item.id || "") ? `#/inscription/${item.id}` : "#/inscriptions";
  return h("article", { class: "home-hero" },
    h("h2", null, "LATEST P2MR INSCRIPTION"),
    h("a", { class: "hero-art", href }, contentFrame(item, 0)),
    h("span", { class: "cap" }, label));
}

async function home() {
  const page = openPage();
  const latest = await page.get(`/inscriptions?limit=${HOME_FETCH}`);
  if (!page.live()) return;
  await refreshStatus(true);
  if (!page.live()) return;
  const items = latest.inscriptions;
  const hero = items[0];
  const side = hero ? items.slice(1).filter((item) => item.id !== hero.id).slice(0, HOME_SIDE) : [];
  const intro = h("section", { class: "home-intro" },
      h("h2", null, "READ FROM YOUR OWN NODE"),
    h("p", null, "This explorer shows PINS recorded by the indexer on this computer.", h("br"), "It is read-only. It does not sign, broadcast, or keep a wallet."));
  const board = hero ? h("div", { class: "home-board" },
    h("div", { class: "home-stage" },
      homeHero(hero),
      side.length ? h("div", { class: "home-side" }, side.map((item, index) => cell(item, index + 1))) : null),
    h("div", { class: "home-links" },
      link("#/inscriptions", "Browse all P2MR Inscriptions →"),
      link("#/collection", "Open the collection →"))) : null;
  page.show(
    h("div", { class: "home-gap home-gap-top", "aria-hidden": "true" }),
    intro,
    board ? h("div", { class: "home-gap home-gap-mid", "aria-hidden": "true" }) : null,
    board || h("p", { class: "muted" }, "No P2MR Inscriptions in this snapshot yet."));
  fitHomeGaps();
}

function reserveFooter() {
  const foot = document.querySelector(".site-foot");
  if (!foot) return;
  document.documentElement.style.setProperty("--foot-space", `${foot.offsetHeight}px`);
}

function fitHomeGaps() {
  const topEl = document.querySelector(".home-gap-top");
  const midEl = document.querySelector(".home-gap-mid");
  const intro = document.querySelector(".home-intro");
  const board = document.querySelector(".home-board");
  const header = document.querySelector(".top");
  const foot = document.querySelector(".site-foot");
  const banner = document.getElementById("banner");
  reserveFooter();
  if (!topEl || !intro || !header || !foot) return;
  const narrow = window.innerWidth < 640;
  const wantTop = narrow ? 32 : 160;
  const wantMid = narrow ? 20 : 80;
  const minTop = narrow ? 12 : 16;
  const minMid = narrow ? 8 : 12;
  const bannerH = banner && !banner.hidden ? banner.offsetHeight : 0;
  const padTop = parseFloat(getComputedStyle(view).paddingTop) || 0;
  const padBottom = parseFloat(getComputedStyle(view).paddingBottom) || 0;
  let gapTop = Math.max(0, wantTop - padTop);
  let gapMid = midEl ? wantMid : 0;
  const chrome = header.offsetHeight + bannerH + padTop + padBottom + foot.offsetHeight;
  const blocks = intro.offsetHeight + (board ? board.offsetHeight : 0);
  let overflow = gapTop + gapMid + blocks + chrome - window.innerHeight;
  const shrink = (px) => {
    const cutTop = Math.min(px, Math.max(0, gapTop - minTop));
    gapTop -= cutTop;
    px -= cutTop;
    const cutMid = Math.min(px, Math.max(0, gapMid - minMid));
    gapMid -= cutMid;
  };
  if (overflow > 0) shrink(overflow);
  const apply = () => {
    topEl.style.height = `${Math.round(gapTop)}px`;
    if (midEl) midEl.style.height = `${Math.round(gapMid)}px`;
  };
  apply();
  const extra = document.documentElement.scrollHeight - window.innerHeight;
  if (extra > 0) {
    shrink(extra);
    apply();
  }
  const title = intro.querySelector("h2");
  const half = Math.round(gapTop / 2);
  if (title) {
    title.dataset.gapShift = String(half);
    title.style.top = `${-half - 10}px`;
  }
  placePinsGithub();
  // Phones only. The upward title shift leaves a hole above the two intro lines.
  // Move that title down and the copy up. Tablet and desktop keep the shift above.
  const para = intro.querySelector("p");
  if (window.innerWidth < 768 && title && para) {
    title.style.top = `${Math.round((-half - 10) / 2)}px`;
    para.style.marginTop = "0.2rem";
  } else if (para) {
    para.style.marginTop = "";
  }
  balanceFeatureGaps();
}

function balanceFeatureGaps() {
  const hero = document.querySelector(".home-hero");
  if (!hero) return;
  hero.style.top = "";
  if (window.innerWidth >= 1280) return;
  const para = document.querySelector(".home-intro p");
  const heading = hero.querySelector("h2");
  const cap = hero.querySelector(".cap");
  const side = document.querySelector(".home-side");
  if (!para || !heading || !cap || !side) return;
  const range = document.createRange();
  range.selectNodeContents(para);
  const lines = [...range.getClientRects()].filter((rect) => rect.width > 2);
  const textBottom = lines.length ? lines[lines.length - 1].bottom : para.getBoundingClientRect().bottom;
  const above = heading.getBoundingClientRect().top - textBottom;
  const below = side.getBoundingClientRect().top - cap.getBoundingClientRect().bottom;
  const shift = Math.round((above - below) / 2);
  if (shift > 0) hero.style.top = `${-shift}px`;
}

function ensurePinsGithub() {
  let link = document.getElementById("pins-github");
  if (link) return link;
  link = h("a", {
    id: "pins-github",
    class: "pins-github",
    href: pinsSource.href,
    target: "_blank",
    rel: "noopener noreferrer",
  }, h("img", { src: "/github-mark.svg", alt: "", width: "20", height: "20" }), pinsSource.label);
  document.body.append(link);
  return link;
}

function concealPinsGithub() {
  const link = document.getElementById("pins-github");
  if (!link) return;
  link.classList.remove("is-placed");
}

function textRect(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const rect = range.getBoundingClientRect();
  return rect.width > 1 && rect.height > 1 ? rect : el.getBoundingClientRect();
}

function overlaps(link, el) {
  const a = link.getBoundingClientRect();
  const b = textRect(el);
  return a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
}

function pinGithub(link, parent, top, horizontal) {
  parent.append(link);
  link.style.top = `${Math.round(top)}px`;
  link.style.left = horizontal.left ?? "auto";
  link.style.right = horizontal.right ?? "auto";
  link.style.transform = horizontal.transform ?? "none";
  link.classList.add("is-placed");
}

function placePinsGithub() {
  const link = ensurePinsGithub();
  link.classList.remove("is-placed");
  const hash = location.hash || "#/";
  const onHome = hash === "#/" || hash === "#";
  if (!onHome || !document.querySelector(".home-intro")) return;
  if (!placeGithubHome(link)) placeGithubTheme(link);
}

function placeGithubHome(link) {
  const intro = document.querySelector(".home-intro");
  const title = intro?.querySelector("h2");
  const para = intro?.querySelector("p");
  if (!intro || !title || !para || title.dataset.gapShift == null) return false;
  const half = Number(title.dataset.gapShift);
  const titleH = title.offsetHeight;
  const paraMargin = parseFloat(getComputedStyle(para).marginTop) || 0;
  const gap = half + paraMargin;
  if (gap < link.offsetHeight + 8) return false;
  const top = titleH - half + (gap - link.offsetHeight) / 2;
  pinGithub(link, intro, top, { left: "50%", transform: "translateX(-50%)" });
  if (overlaps(link, title) || overlaps(link, para)) {
    link.classList.remove("is-placed");
    return false;
  }
  return true;
}

function placeGithubTheme(link) {
  const header = document.querySelector(".top");
  const theme = document.getElementById("theme");
  if (!header || !theme) return false;
  const hr = header.getBoundingClientRect();
  const tr = theme.getBoundingClientRect();
  const top = tr.top - hr.top + Math.max(0, (tr.height - link.offsetHeight) / 2);
  const left = tr.right - hr.left + 10;
  if (left < 0 || left + link.offsetWidth > hr.width - 8) return false;
  pinGithub(link, header, top, { left: `${Math.round(left)}px` });
  const blocked = [...header.querySelectorAll("a, button, input")].some((el) => el !== link && !link.contains(el) && overlaps(link, el));
  if (blocked) link.classList.remove("is-placed");
  return link.classList.contains("is-placed");
}

function headerOffset() {
  const header = document.querySelector(".top");
  return (header ? header.offsetHeight : 0) + 12;
}

function syncHeaderOffset() {
  document.documentElement.style.setProperty("--header-offset", `${headerOffset()}px`);
}

let guideAnchor = null;

function scrollGuideHeading(heading) {
  guideAnchor = heading || null;
  if (!heading?.isConnected) return;
  syncHeaderOffset();
  heading.focus({ preventScroll: true });
  const top = heading.getBoundingClientRect().top + window.scrollY - headerOffset();
  window.scrollTo(0, Math.max(0, Math.round(top)));
}

async function inscriptionsPage(q) {
  const page = openPage();
  const offset = Number(query(q).offset) || 0;
  const data = await page.get(`/inscriptions?offset=${offset}&limit=${PAGE_SIZE}`);
  if (!page.live()) return;
  const to = (o) => go(`/inscriptions?offset=${o}`);
  page.show(h("h1", null, "P2MR Inscriptions"), h("p", { class: "lede" }, `${countedInscriptions(data.total)}, newest first.`),
    h("div", { class: "grid" }, data.inscriptions.map(cell)), pager(data.total, offset, PAGE_SIZE, to));
}

async function collectionPage(q) {
  const page = openPage();
  const params = query(q);
  const offset = Number(params.offset) || 0, only = params.verified === "1";
  const col = await page.get("/collection");
  if (!page.live()) return;
  const list = col.piecesComplete
    ? await page.get(`/collection/pieces?offset=${offset}&limit=${PAGE_SIZE}${only ? "&authentic=1" : ""}`)
    : { pieces: [], total: 0 };
  if (!page.live()) return;
  if (col.onchain.status === "pending") {
    page.show(h("h1", { class: "collection-title" }, brand.collectionNav), h("p", { class: "lede" }, "The collection record is still loading. Piece totals are not shown yet."));
    return;
  }
  if (col.onchain.status !== "present") {
    page.show(h("h1", null, "Collection"), h("div", { class: "err" }, h("strong", null, "No collection in this snapshot yet"),
      h("p", null, "The indexer has not recorded a valid collection genesis. If it is still syncing, wait until it reaches the tip, then reload this page.")));
    return;
  }
  const c = col.onchain;
  const to = (o, v = only) => go(`/collection?offset=${o}${v ? "&verified=1" : ""}`);
  const jump = h("input", { type: "number", min: c.first, max: c.first + c.supply - 1, placeholder: `${brand.pieceWord} #${c.first}–${c.first + c.supply - 1}`, "aria-label": "Piece number" });
  const mismatch = col.checks.some((k) => k.match === false);
  const summary = col.piecesComplete
    ? `${fmt(col.authenticPieces)} of ${fmt(c.supply)} pieces are authentic in this indexer snapshot.`
    : "Piece totals stay hidden until the collection check finishes.";
  const genesis = h("div", { class: "section genesis" }, h("h3", null, "Collection genesis ", verified()),
    facts([["Genesis P2MR Inscription", link(`#/inscription/${c.genesisId}`, c.genesisId, "mono")], ["Merkle root", h("span", { class: "mono" }, c.root)], ["Issuer key", h("span", { class: "mono" }, c.issuer)], ["Item type", c.itemType]]));
  page.show(
    h("h1", { class: "collection-title" }, c.name),
    h("p", { class: "lede" }, summary),
    genesis,
    h("details", { class: "manifest", open: mismatch },
      h("summary", null, `Manifest check: ${col.checks.filter((k) => k.match === true).length} of ${col.checks.length} fields match the chain `, mismatch ? h("span", { class: "badge bad" }, "differs from chain") : manifestBadge()),
      h("p", { class: "muted" }, "The manifest is a config file supplied with this explorer, not chain data. It is shown beside the indexed values so the two stay distinct."),
      table(["Field", "Manifest", "On-chain", ""], col.checks.map((k) => [k.field, h("span", { class: "mono" }, String(k.manifest)), h("span", { class: "mono" }, k.onchain === null ? "not found" : String(k.onchain)),
        k.match === true ? h("span", { class: "badge ok" }, "match") : k.match === false ? h("span", { class: "badge bad" }, "differs") : h("span", { class: "badge warn" }, "unknown")]))),
    col.piecesComplete ? h("div", { class: "bar" },
      h("form", { class: "bar", onsubmit: (e) => { e.preventDefault(); if (jump.value) go(`/${brand.piecePath}/${Number(jump.value)}`); } }, jump, h("button", { type: "submit" }, "Open piece")),
      h("label", { class: "bar" }, h("input", { type: "checkbox", checked: only, onchange: (e) => to(0, e.target.checked) }), "Authentic pieces only")) : h("p", { class: "muted" }, "The piece list is still loading."),
    col.piecesComplete ? (() => {
      const sheet = h("div", { class: "sheet" },
        h("div", { class: "grid" }, list.pieces.map((p, index) => {
          if (!p.inscriptionId) return h("a", { class: "cell", href: `#/${brand.piecePath}/${p.number}` }, h("div", { class: "tile empty" }, "not inscribed"), h("span", { class: "cap" }, `#${fmt(p.number)}`));
          const img = picture(`/api/content/${p.inscriptionId}`, `${c.name} ${p.number}`, index);
          img.addEventListener("error", () => { if (img.isConnected) img.replaceWith(h("div", { class: "tile" }, "Preview unavailable")); });
          return h("a", { class: "cell", href: `#/inscription/${p.inscriptionId}`, title: p.inscriptionId }, img, h("span", { class: "cap" }, `#${fmt(p.number)}`));
        })),
        pager(list.total, offset, PAGE_SIZE, to));
      fitSheet(sheet);
      return sheet;
    })() : null);
}

function table(head, rows) {
  return h("div", { class: "table-scroll" }, h("table", null, h("thead", null, h("tr", null, head.map((x) => h("th", null, x)))), h("tbody", null, rows.map((r) => h("tr", null, r.map((c) => h("td", null, c)))))));
}

async function piecePage(n) {
  const page = openPage();
  const piece = await page.get(`/collection/pieces/${n}`);
  if (!page.live()) return;
  if (piece.inscriptionId) { location.replace(`#/inscription/${piece.inscriptionId}`); return; }
  page.show(h("h1", null, `${brand.pieceWord} #${n}`), h("div", { class: "err" }, h("strong", null, "No authentic P2MR Inscription for this number"),
    h("p", null, "Nothing in this snapshot passes the collection check for this piece. It may not be inscribed yet.")), h("p", null, link("#/collection", "Back to the collection")));
}

async function numberPage(n) {
  const page = openPage();
  const item = await page.get(`/number/${n}`);
  if (!page.live()) return;
  location.replace(`#/inscription/${item.id}`);
}

function locationText(loc) {
  if (!loc || typeof loc !== "object") return "unknown";
  if (loc.state !== "located") return typeof loc.state === "string" ? loc.state : "unknown";
  if (typeof loc.txid !== "string") return "unknown";
  return [link(`#/tx/${loc.txid}`, `${loc.txid}:${loc.vout}`, "mono"), h("span", { class: "muted" }, ` bit offset ${loc.offset}`)];
}

async function inscriptionPage(id) {
  const page = openPage();
  const i = await page.get(`/inscription/${id}`);
  if (!page.live()) return;
  const viewer = detailViewer(i);
  const showBadge = i.authenticity === "confirmed" && i.snapshotStale !== true;
  const onChain = i.chain === "confirmed" && i.snapshotStale !== true;
  const finalNote = i.piece && i.piece.final === false && Number.isInteger(i.piece.confirmations)
    ? ` Collection record has ${fmt(i.piece.confirmations)} confirmations and is not marked final.`
    : "";
  const chainTitle = `Indexer snapshot includes this P2MR Inscription in block ${fmt(i.createdHeight)}. Not a finality claim.${finalNote}`;
  const chainBadge = onChain
    ? h("p", { class: "chain-badge" }, h("a", { href: `#/block/${i.createdHeight}`, title: chainTitle }, "On-chain"))
    : null;
  const chainNote = onChain ? null
    : i.chain === "stale" || i.snapshotStale
      ? h("p", { class: "auth-note" }, "On-chain is hidden. This snapshot may not match the indexer tip.")
      : i.chain === "mock"
        ? h("p", { class: "auth-note" }, "Mock data. On-chain is not confirmed.")
        : h("p", { class: "auth-note" }, "On-chain is not confirmed.");
  const authNote = i.snapshotStale
    ? h("p", { class: "auth-note" }, "Authentic is hidden. A newer indexer read was not applied.")
      : i.authenticity === "confirmed"
      ? h("p", { class: "auth-badge" }, h("strong", { title: "Indexer collection check for this P2MR Inscription, current snapshot." }, "Authentic"))
      : i.authenticity === "rejected"
        ? h("p", { class: "auth-note" }, "Collection check: not authentic.")
        : h("p", { class: "auth-note" }, "Collection check: not confirmed.");
  const lede = i.snapshotStale
    ? "A P2MR Inscription (PINS). The snapshot is stale."
    : showBadge
      ? (i.piece?.final ? "Authentic in this snapshot, and the indexer marks it final." : "Authentic in this snapshot. The indexer does not mark it final yet.")
      : i.authenticity === "rejected"
        ? `Not authentic${i.piece?.reason ? `: ${i.piece.reason}` : "."}`
        : "A P2MR Inscription (PINS).";
  const backTo = backHash(lastListHash, location.hash || "#/");
  const backArrow = h("svg", { class: "back-arrow", viewBox: "0 0 24 24", width: "20", height: "20", "aria-hidden": "true", focusable: "false" },
    h("path", { d: "M15 5 8 12l7 7", fill: "none", stroke: "currentColor", "stroke-width": "2.6", "stroke-linecap": "round", "stroke-linejoin": "round" }));
  const hopArrow = (direction) => h("svg", { viewBox: "0 0 24 24", width: "22", height: "22", "aria-hidden": "true", focusable: "false" },
    h("path", { d: direction === "prev" ? "M15 5 8 12l7 7" : "M9 5l7 7-7 7", fill: "none", stroke: "currentColor", "stroke-width": "2.6", "stroke-linecap": "round", "stroke-linejoin": "round" }));
  const hop = (target, label, direction) => target?.id
    ? h("a", { class: "insc-hop", href: `#/inscription/${target.id}`, "aria-label": label }, hopArrow(direction))
    : h("button", { type: "button", class: "insc-hop", disabled: true, "aria-label": label }, hopArrow(direction));
  const name = i.metadata?.decoded?.meta?.name;
  const attrs = Array.isArray(i.piece?.attributes) && i.piece.attributes.length ? i.piece.attributes : i.metadata?.decoded?.meta?.attributes;
  const traitRows = Array.isArray(attrs) ? attrs.filter((row) => row && typeof row === "object").slice(0, 40).map((row) => [clip(row.trait_type, 80), clip(row.value, 80)]) : [];
  let decodedText = "";
  if (i.metadata?.decoded !== undefined) {
    try { decodedText = JSON.stringify(i.metadata.decoded, null, 2); } catch { decodedText = ""; }
    if (decodedText.length > 8000) decodedText = `${decodedText.slice(0, 8000)}\n…`;
  }
  const rawHex = typeof i.metadata?.rawHex === "string" ? i.metadata.rawHex.slice(0, 8000) : "";
  const fields = Array.isArray(i.fields) ? i.fields : [];
  const flags = Array.isArray(i.flags) ? i.flags.filter((flag) => typeof flag === "string") : [];
  const tx = typeof i.txid === "string" && /^[0-9a-f]{64}$/.test(i.txid) ? txLink(i.txid) : "none";
  const heading = i.piece ? pieceTitle(i.piece) : (typeof name === "string" && name.trim() ? clip(name, 160) : `P2MR Inscription ${fmt(i.number)}`);
  const ext = status?.externalExplorer;
  page.show(
    h("div", { class: "detail" },
      h("div", { class: "detail-actions" },
        h("a", { class: "back", id: "detail-back", href: backTo }, backArrow, "Back"),
        h("div", { class: "insc-nav" },
          hop(i.neighbors?.prev, "Previous P2MR Inscription", "prev"),
          hop(i.neighbors?.next, "Next P2MR Inscription", "next"))),
      h("div", { class: "art-wrap" }, viewer, h("div", { class: "badge-row" }, chainBadge, showBadge ? authNote : null)),
      h("div", { class: "detail-copy" },
      h("h1", null, heading),
      h("p", { class: "lede" }, lede),
      chainNote,
      showBadge ? null : authNote,
      h("div", { class: "legend" }, verified(), "Names and attributes below are field 5 from the indexer snapshot."))),
    h("div", { class: "section" }, h("h3", null, "P2MR Inscription ", verified()),
      facts([
        ["P2MR Inscription ID", h("span", { class: "mono" }, i.id)], ["P2MR Inscription number", fmt(i.number)],
        ["Transaction", tx], ["Content type", clip(typeof i.contentType === "string" && i.contentType ? i.contentType : "none", 80)], ["Size", bytes(i.bodyLength)],
        ["Content SHA-256", h("span", { class: "mono" }, i.bodySha256)],
        ["Created in block", link(`#/block/${i.createdHeight}`, fmt(i.createdHeight))],
        ["Current owner", addrLink(i.ownerAddress)], ["Location", locationText(i.location)],
        ["Last moved in block", link(`#/block/${i.locationHeight}`, fmt(i.locationHeight))],
        ["Flags", flags.length ? clip(flags.join(", "), 200) : "none"], ["Reveal key", h("span", { class: "mono" }, clip(i.leafIssuer || "none", 80))],
        ["Raw content", [link(`/api/content/${i.id}`, "view"), " · ", link(`/api/content/${i.id}?download=1`, "download bytes")]],
        ext ? ["Node explorer", link(`${ext}/tx/${i.txid}`, "open transaction")] : null])),
    i.piece ? h("div", { class: "section" }, h("h3", null, "Collection ", verified()),
      facts([["Collection", link("#/collection", i.piece.collectionName ?? "collection")], ["Piece", `#${fmt(i.piece.number)}`],
        ["Confirmations", `${fmt(i.piece.confirmations)}${i.piece.final ? " (final)" : " (not final yet)"}`],
        ["Genesis", link(`#/inscription/${i.piece.genesisId}`, short(i.piece.genesisId, 12), "mono")]])) : null,
    h("div", { class: "section" }, h("h3", null, "Metadata ", verified("Field 5")),
      i.metadata ? [
        i.metadata.error ? h("div", { class: "err" }, "Field 5 could not be decoded.") : null,
        i.metadata.truncated ? h("p", { class: "muted" }, "Field 5 is longer than this page shows.") : null,
        traitRows.length ? table(["Trait", "Value"], traitRows) : null,
        h("details", null, h("summary", null, "Decoded CBOR and raw bytes"),
          decodedText ? h("pre", null, decodedText) : null,
          rawHex ? h("pre", null, rawHex) : null)
      ] : h("p", { class: "muted" }, "This P2MR Inscription carries no metadata field."),
      h("details", null, h("summary", null, "All envelope fields"), table(["Tag", "Value (hex)"], fields.slice(0, 80).map((f) => [String(f?.tag ?? ""), h("span", { class: "mono" }, short(typeof f?.value === "string" ? f.value : "", 40))])))));
  document.getElementById("detail-back")?.focus({ preventScroll: true });
}

async function addressPage(addr, q) {
  const page = openPage();
  const offset = Number(query(q).offset) || 0;
  const a = await page.get(`/address/${encodeURIComponent(addr)}?offset=${offset}&limit=${PAGE_SIZE}`);
  if (!page.live()) return;
  const to = (o) => go(`/address/${addr}?offset=${o}`);
  page.show(
    h("h1", null, "Address"), h("p", { class: "mono" }, a.address),
    h("div", { class: "legend" }, verified(), "Each P2MR Inscription is bound to one bit. The indexer follows that bit first-in-first-out (PINS-3). This page shows the stored snapshot and does not recompute it."),
    facts([["PINS held", fmt(a.total)], ["From the collection", fmt(a.collectionPieces)], ["Outputs holding PINS", fmt(a.outputs.length)]]),
    a.total === 0 ? h("p", { class: "muted" }, "This address holds no PINS in the current index.") : h("div", { class: "grid" }, a.inscriptions.map(cell)),
    a.total > PAGE_SIZE ? pager(a.total, offset, PAGE_SIZE, to) : null,
    a.outputs.length ? h("div", { class: "section" }, h("h3", null, "Outputs ", verified()),
      table(["Output (txid:vout)", "PINS"], a.outputs.slice(0, PAGE_SIZE).map((o) => [link(`#/tx/${o.outpoint.split(":")[0]}`, o.outpoint, "mono"), String(o.count)])),
      a.outputs.length > PAGE_SIZE ? h("p", { class: "muted" }, `Showing ${PAGE_SIZE} of ${fmt(a.outputs.length)} outputs.`) : null) : null);
}

async function txPage(txid, q) {
  const page = openPage();
  const t = await page.get(`/tx/${txid}`);
  if (!page.live()) return;
  const offset = Number(query(q).offset) || 0;
  const created = slicePage(t.created, offset);
  const holding = slicePage(t.holding, 0);
  const list = (part) => part.shown.length ? h("div", { class: "grid" }, part.shown.map(cell)) : h("p", { class: "muted" }, "None.");
  const ext = status?.externalExplorer;
  const to = (o) => go(`/tx/${txid}?offset=${o}`);
  page.show(h("h1", null, "Transaction"), h("p", { class: "mono" }, txid),
    ext ? h("p", null, link(`${ext}/tx/${txid}`, "Open in the node explorer")) : null,
    t.node ? h("div", { class: "section" }, h("h3", null, "From your node ", verified("Node RPC")),
      facts([["Confirmations", t.node.confirmations !== undefined ? fmt(t.node.confirmations) : null], ["Block", t.node.blockhash ? h("span", { class: "mono" }, t.node.blockhash) : null],
        ["Size", t.node.size !== undefined ? `${fmt(t.node.size)} B` : null], ["Outputs", t.node.vout ? String(t.node.vout.length) : null]])) :
      t.nodeError ? h("p", { class: "muted" }, `Node details unavailable: ${t.nodeError}`) : null,
    h("div", { class: "section" }, h("h3", null, "P2MR Inscriptions created here ", verified()), list(created), created.total > PAGE_SIZE ? pager(created.total, created.offset, PAGE_SIZE, to) : null),
    h("div", { class: "section" }, h("h3", null, "P2MR Inscriptions currently in this transaction's outputs ", verified()), list(holding),
      holding.total > PAGE_SIZE ? h("p", { class: "muted" }, `Showing ${PAGE_SIZE} of ${fmt(holding.total)} held here.`) : null),
    h("p", { class: "muted" }, "The indexer lists transactions that created PINS or that currently hold PINS."));
}

async function blockPage(param, q) {
  const page = openPage();
  const b = await page.get(`/block/${param}`);
  if (!page.live()) return;
  const offset = Number(query(q).offset) || 0;
  const created = slicePage(b.created, offset);
  const to = (o) => go(`/block/${param}?offset=${o}`);
  page.show(h("h1", null, `Block ${fmt(b.height)}`), b.hash ? h("p", { class: "mono" }, b.hash) : null,
    b.header ? facts([["Confirmations", b.header.confirmations !== undefined ? fmt(b.header.confirmations) : null], ["Transactions", b.header.nTx !== undefined ? fmt(b.header.nTx) : null],
      ["Time", b.header.time ? new Date(b.header.time * 1000).toLocaleString() : null],
      ["Previous", b.height > 0 ? link(`#/block/${b.height - 1}`, fmt(b.height - 1)) : null], ["Next", b.header.nextblockhash ? link(`#/block/${b.height + 1}`, fmt(b.height + 1)) : null]]) :
      h("p", { class: "muted" }, b.nodeError ? `Block details unavailable: ${b.nodeError}` : "Block details need node RPC. See .env.example. The P2MR Inscriptions below come from the indexer."),
    h("div", { class: "section" }, h("h3", null, "P2MR Inscriptions created in this block ", verified()),
      created.shown.length ? h("div", { class: "grid" }, created.shown.map(cell)) : h("p", { class: "muted" }, "None."),
      created.total > PAGE_SIZE ? pager(created.total, created.offset, PAGE_SIZE, to) : null));
}

/* ---------- router, search, status ---------- */

function prose(text) {
  const lines = String(text).split("\n");
  const kids = [];
  lines.forEach((line, index) => {
    if (index) kids.push(h("br"));
    if (line) kids.push(line);
  });
  return kids;
}

function guideBlock(block) {
  if (block.kind === "ul") return h("ul", null, block.items.map((item) => h("li", null, prose(item))));
  if (block.kind === "code") return h("pre", null, h("code", null, block.text));
  if (block.kind === "steps") {
    return h("ol", { class: "steps" }, block.items.map((step) => h("li", null,
      h("span", { class: "step-k" }, step.label),
      step.text ? h("p", null, prose(step.text)) : null,
      step.code ? h("pre", null, h("code", null, step.code)) : null)));
  }
  return h("p", null, prose(block.text));
}

function guidePage(slug) {
  const known = guideSections.some((section) => section.id === slug);
  restoreScroll = null;
  render(
    h("article", { class: "guide" },
      h("header", { class: "guide-head" },
        h("h1", null, "How it works"),
        h("p", { class: "lede" }, "How to run this explorer on this computer.", h("br"), "This page does not read the indexer, so it stays available during the first catch-up."),
        slug && !known ? h("p", { class: "err", role: "alert" }, "That section is not on this page.") : null,
        h("nav", { class: "guide-toc", "aria-label": "On this page" },
          guideSections.map((section) => h("a", { href: `#/how-it-works/${section.id}`, "aria-current": section.id === slug ? "location" : null }, section.title)))),
      guideSections.map((section) => h("section", { id: section.id, "aria-labelledby": `guide-${section.id}` },
        h("h2", { id: `guide-${section.id}`, tabindex: "-1" }, section.title),
        section.blocks.map(guideBlock)))),
  );
  scrollGuideHeading(known ? document.getElementById(`guide-${slug}`) : null);
  placePinsGithub();
}

const routes = [
  [/^#\/?$/, home], [/^#\/inscriptions(?:\?(.*))?$/, inscriptionsPage], [/^#\/collection(?:\?(.*))?$/, collectionPage],
  [/^#\/how-it-works(?:\/([a-z0-9-]+))?$/, guidePage],
  [/^#\/qbit(?:\/([a-z0-9-]+))?$/, qbitPage],
  [new RegExp(`^#\\/${brand.piecePath}\\/(\\d+)$`), piecePage], [/^#\/number\/(\d+)$/, numberPage], [/^#\/inscription\/([0-9a-f]{64}i\d+)$/, inscriptionPage],
  [/^#\/address\/([0-9a-z]+)(?:\?(.*))?$/, addressPage], [/^#\/tx\/([0-9a-f]{64})(?:\?(.*))?$/, txPage], [/^#\/block\/(\w+)(?:\?(.*))?$/, blockPage],
];

function closeMenu(restoreFocus) {
  const toggle = document.getElementById("nav-toggle");
  const open = document.documentElement.classList.contains("nav-open");
  document.documentElement.classList.remove("nav-open");
  if (!toggle) return;
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-label", "Open menu");
  if (restoreFocus && open) toggle.focus();
}

function toggleMenu() {
  const toggle = document.getElementById("nav-toggle");
  if (!toggle) return;
  const open = !document.documentElement.classList.contains("nav-open");
  document.documentElement.classList.toggle("nav-open", open);
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
}

function markNav() {
  closeMenu(false);
  const hash = location.hash || "#/";
  const collection = document.getElementById("nav-collection");
  const inscriptions = document.querySelector('nav a[href="#/inscriptions"]');
  const guide = document.getElementById("nav-guide");
  const qbit = document.getElementById("nav-qbit");
  const onCollection = hash.startsWith("#/collection") || hash.startsWith(`#/${brand.piecePath}/`);
  const onInscriptions = hash.startsWith("#/inscriptions") || hash.startsWith("#/inscription/") || hash.startsWith("#/number/");
  const onGuide = hash.startsWith("#/how-it-works");
  const onQbit = hash.startsWith("#/qbit");
  collection.toggleAttribute("aria-current", onCollection);
  if (onCollection) collection.setAttribute("aria-current", "page");
  inscriptions.toggleAttribute("aria-current", onInscriptions);
  if (onInscriptions) inscriptions.setAttribute("aria-current", "page");
  guide.toggleAttribute("aria-current", onGuide);
  if (onGuide) guide.setAttribute("aria-current", "page");
  if (qbit) {
    qbit.toggleAttribute("aria-current", onQbit);
    if (onQbit) qbit.setAttribute("aria-current", "page");
  }
}

function qbitPage(slug) {
  const known = qbitSections.some((section) => section.id === slug);
  restoreScroll = null;
  render(
    h("article", { class: "guide qbit-page" },
      h("header", { class: "guide-head" },
        h("img", { class: "qbit-page-logo", src: "/qbit-logo-full.svg", alt: "Qbit", width: "120", height: "52" }),
        h("p", { class: "lede" }, "The network this explorer reads.\nPINS is an independent protocol."),
        slug && !known ? h("p", { class: "err", role: "alert" }, "That section is not on this page.") : null,
        h("nav", { class: "guide-toc", "aria-label": "On this page" },
          qbitSections.map((section) => h("a", { href: `#/qbit/${section.id}`, "aria-current": section.id === slug ? "location" : null }, section.title)))),
      qbitSections.map((section) => h("section", { id: section.id, "aria-labelledby": `qbit-${section.id}` },
        h("h2", { id: `qbit-${section.id}`, tabindex: "-1" }, section.title),
        section.blocks.map((block) => block.kind === "cta"
          ? h("p", null, h("a", { class: "cta", href: block.href, target: "_blank", rel: "noopener noreferrer" }, block.label))
          : h("p", null, prose(block.text))))),
      h("nav", { class: "guide-toc", "aria-label": "Official Qbit pages" },
        qbitLinks.map((item) => h("a", { href: item.href, target: "_blank", rel: "noopener noreferrer" }, item.label)))));
  scrollGuideHeading(known ? document.getElementById(`qbit-${slug}`) : null);
}

function showWarmup() {
  showStartup(WARMUP);
}

async function runPage(fn, args, serial, first) {
  if (serial !== routeSerial) return;
  if (first) showStartup("Loading the index.");
  try {
    await fn(...args);
  } catch (e) {
    if (serial !== routeSerial || e?.name === "AbortError") return;
    if (e.status === 503 && /still loading/.test(e.message)) {
      showWarmup();
      retryTimer = setTimeout(() => { runPage(fn, args, serial, false); }, 1500);
      return;
    }
    if (serial === routeSerial) {
      view.setAttribute("aria-busy", "false");
      paint([errorBox(e)], false);
    }
  }
}

function leaveFor(next) {
  // Detail-to-detail hops and number/#N redirects must not replace the list the reader came from.
  if (hereHash && hereHash !== next && !isDetailHash(hereHash) && !isTransientHash(hereHash)) {
    listScroll.set(hereHash, window.scrollY);
    lastListHash = hereHash;
  }
  hereHash = next;
}

async function route() {
  releaseMedia();
  pageAbort.abort();
  pageAbort = new AbortController();
  pageSignal = pageAbort.signal;
  const serial = ++routeSerial;
  clearTimeout(retryTimer);
  markNav();
  const hash = location.hash || "#/";
  if (hereHash !== hash) leaveFor(hash);
  restoreScroll = !isDetailHash(hash) && listScroll.has(hash) ? listScroll.get(hash) : null;
  for (const [re, fn] of routes) {
    const m = re.exec(hash);
    if (!m) continue;
    if (fn === guidePage) {
      guidePage(m[1] || "");
      return;
    }
    if (fn === qbitPage) {
      qbitPage(m[1] || "");
      return;
    }
    await runPage(fn, m.slice(1), serial, true);
    return;
  }
  render(errorBox({ status: 404, message: "That page does not exist." }));
}

document.getElementById("search").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("q");
  if (!input.value.trim()) return;
  try {
    const found = await request(`/search?q=${encodeURIComponent(input.value)}`);
    input.value = "";
    go(found.path);
  } catch (err) {
    if (err?.name === "AbortError") return;
    render(errorBox(err));
  }
});

function tagIcon(kind) {
  const path = kind === "ok" ? "M5 12.5 9.2 17 19 7" : kind === "bad" ? "M7 7l10 10M17 7 7 17" : kind === "warn" ? "M12 7v6M12 17h.01" : "";
  if (!path) return null;
  return h("svg", { class: "tag-icon", viewBox: "0 0 24 24", width: "12", height: "12", "aria-hidden": "true", focusable: "false" },
    h("path", { d: path, fill: "none", stroke: "currentColor", "stroke-width": "2.4", "stroke-linecap": "round" }));
}

function statusTag(kind, label, value, title) {
  return h("span", { class: kind === "neutral" ? "tag" : `tag ${kind}`, title: title || "" },
    h("span", { class: "tag-k" }, label),
    h("span", { class: "tag-v" }, tagIcon(kind), value));
}

function stateControl(hash) {
  const line = document.getElementById("state-line");
  if (!line) return;
  line.replaceChildren(
    h("span", { class: "tag-k" }, "State"),
    h("span", { class: "mono state-full" }, hash || "none"));
}

function paintStatus(foot, body) {
  const ix = body?.indexer;
  if (!ix?.reachable) {
    stateControl("");
    foot.replaceChildren(statusTag("bad", "Indexer", ix?.error || "unreachable", "The explorer could not read the indexer. It does not answer until the first catch-up finishes."));
    return;
  }
  const snap = body.snapshot || {};
  const indexed = indexedStatus({
    ready: snap.ready, preview: snap.preview, stale: snap.stale, loading: snap.loading,
    indexedHeight: snap.height, nodeHeight: ix.height,
  });
  const node = nodeStatus({ enabled: body.rpc?.enabled, reachable: body.rpc?.reachable });
  const count = snap.preview || snap.ready ? fmt(snap.inscriptions) : "unknown";
  const hash = ix.stateHash || "";
  const nodeTitle = node.text === "connected"
    ? "RPC answered. That does not mean the index matches the tip, and it is not a collection check."
    : "RPC connection only. This is not a collection check.";
  const tags = [
    statusTag("neutral", "Network", ix.network || "unknown", "Chain name reported by the indexer."),
    statusTag(indexed.kind, "Indexed", indexed.text, "Snapshot height. Current means it matches the indexer tip. It is not a collection check."),
    statusTag("neutral", "Count", count, snap.preview || snap.ready ? `${countedInscriptions(snap.inscriptions)} in the snapshot. Not an authenticity total.` : "P2MR Inscriptions in the snapshot. Not an authenticity total."),
    statusTag(node.kind, "Node", node.text === "connected" && Number.isInteger(ix.height) && Number.isInteger(snap.height) && ix.height !== snap.height ? `connected · tip ${fmt(ix.height)}` : node.text, nodeTitle),
  ];
  stateControl(hash);
  foot.replaceChildren(...tags);
}

async function refreshStatus(force = false) {
  if (document.hidden && !force) return;
  if (statusTask) return statusTask;
  statusTask = (async () => {
    try {
      status = await request("/status");
      const banner = document.getElementById("banner");
      const stale = status.snapshot?.stale;
      banner.hidden = !status.indexer.mock && !stale;
      banner.textContent = status.indexer.mock
        ? "Mock indexer with synthetic data. Development only, nothing here is on-chain."
        : stale ? "Showing the last consistent indexer snapshot. A newer read was not applied." : "";
      paintStatus(document.getElementById("foot"), status);
      reserveFooter();
      if (document.querySelector(".home-gap-top")) fitHomeGaps();
    } catch (error) {
      if (error?.name === "AbortError") return;
      stateControl("");
      const foot = document.getElementById("foot");
      foot.replaceChildren(h("span", { class: "tag bad" }, h("span", { class: "tag-k" }, "Explorer"), h("span", { class: "tag-v" }, "unreachable")));
    }
  })().finally(() => { statusTask = null; });
  return statusTask;
}

window.addEventListener("hashchange", route);
window.addEventListener("resize", () => {
  if (window.innerWidth >= 1280) closeMenu(false);
  reserveFooter();
  syncHeaderOffset();
  if (document.querySelector(".home-gap-top")) fitHomeGaps();
  else placePinsGithub();
  if (guideAnchor?.isConnected) scrollGuideHeading(guideAnchor);
});
document.fonts?.ready.then(() => {
  reserveFooter();
  syncHeaderOffset();
  if (document.querySelector(".home-gap-top")) fitHomeGaps();
  else placePinsGithub();
  if (guideAnchor?.isConnected) scrollGuideHeading(guideAnchor);
});
document.addEventListener("fullscreenchange", () => {
  document.querySelectorAll(".viewer").forEach((viewer) => syncFullButton(viewer));
  if (!document.fullscreenElement) {
    const button = fullReturn && fullReturn.isConnected ? fullReturn : document.querySelector(".full-toggle");
    if (button && document.querySelector(".viewer")) button.focus();
  }
});
document.getElementById("nav-toggle")?.addEventListener("click", () => toggleMenu());
document.getElementById("explorer-nav")?.addEventListener("click", (event) => {
  if (event.target.closest("a")) closeMenu(false);
});
document.addEventListener("click", (event) => {
  if (!document.documentElement.classList.contains("nav-open")) return;
  if (event.target.closest("#explorer-nav, #nav-toggle")) return;
  closeMenu(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.altKey || event.ctrlKey || event.metaKey) return;
  if (document.documentElement.classList.contains("nav-open")) {
    event.preventDefault();
    closeMenu(true);
    return;
  }
  const enlarged = document.querySelector(".viewer.is-enlarged");
  if (enlarged || document.fullscreenElement?.classList?.contains("viewer")) {
    event.preventDefault();
    if (enlarged) clearEnlarge(enlarged);
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    const button = fullReturn && fullReturn.isConnected ? fullReturn : document.querySelector(".full-toggle");
    button?.focus();
    return;
  }
  const tag = event.target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (!isDetailHash(location.hash || "")) return;
  event.preventDefault();
  location.hash = backHash(lastListHash, location.hash || "#/");
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refreshStatus(true); });
reserveFooter();
await refreshStatus(true);
setInterval(() => { void refreshStatus(); }, 10000);
route();

const themeButton = document.getElementById("theme");
const themeColor = document.querySelector('meta[name="theme-color"]');
function applyTheme(t) {
  const dark = t !== "light";
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  if (themeColor) themeColor.setAttribute("content", dark ? "#110e0c" : "#f3f1ec");
  const action = dark ? "Switch to light mode" : "Switch to dark mode";
  themeButton.setAttribute("aria-label", action);
  themeButton.setAttribute("title", action);
}
let savedTheme = null;
try { savedTheme = localStorage.getItem("pins-theme"); } catch { /* storage unavailable */ }
applyTheme(savedTheme === "light" ? "light" : "dark");
themeButton.addEventListener("click", () => {
  const next = document.documentElement.classList.contains("dark") ? "light" : "dark";
  applyTheme(next);
  try { localStorage.setItem("pins-theme", next); } catch { /* ignore */ }
});

document.getElementById("q").placeholder = brand.searchPlaceholder;
