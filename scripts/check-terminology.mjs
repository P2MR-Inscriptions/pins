// SPDX-License-Identifier: Apache-2.0

/**
 * Terminology check. In text a person reads, the word "inscription" is always "P2MR Inscription"
 * (an `ord` port exists on Qbit, so the bare word is ambiguous). This script finds every other
 * occurrence in the repository and says why it is allowed, or fails.
 *
 *   node scripts/check-terminology.mjs            summary by category, exit 1 if anything is unclassified
 *   node scripts/check-terminology.mjs --list     every allowed occurrence, by category
 *
 * Allowed: a code identifier, an API path, a JSON key, a protocol field or flag name, a file name,
 * a test file, a code span or code block, text inside a source string that is one token, the SQL of
 * the store, a released or dated history entry, and a name or URL (`P2MR-Inscriptions`).
 * Nothing else: a sentence in a document, a comment, a message, a label.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_DIRS = new Set(["node_modules", ".git"]);
const SKIP_FILES = /(^|\/)package-lock\.json$|\.(png|woff2?|ttf|ico|svg|zip)$/;
const WORD = /inscriptions?/gi;

/** Files whose every line is a record of the past: not rewritten. [file, first line that is history] */
function historyStart(file, lines) {
  const find = (re) => lines.findIndex((line) => re.test(line));
  if (file === "CHANGELOG.md") return find(/^## 1\.0\.0/);
  if (file === "explorer/CHANGELOG.md") return find(/^## 1\.0\.1/);
  if (file === "docs/specs/CHANGELOG.md") return find(/^## 2026-11-06/);
  if (file.startsWith("docs/releases/")) return 0;
  return -1;
}

/** Literal search queries and a quoted post, recorded as they were typed; the changelog quotes the old names of outputs it renames. */
const LITERAL_FILES = new Set(["docs/specs/collision-check.md", "CHANGELOG.md"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (!SKIP_FILES.test(path)) out.push(path);
  }
  return out;
}

/** Split JavaScript or TypeScript source into code, comment, string and regex segments. */
function segments(src) {
  const out = [];
  const n = src.length;
  let last = "";
  const REGEX_PREV = "(,=:[!&|?{};+-*%<>~^";
  const push = (kind, text) => out.push({ kind, text });
  function template(start) {
    let buf = "";
    let j = start;
    while (j < n) {
      const c = src[j];
      if (c === "\\") { buf += src.slice(j, j + 2); j += 2; continue; }
      if (c === "`") { push("string", buf); push("code", "`"); return j + 1; }
      if (c === "$" && src[j + 1] === "{") { push("string", buf); buf = ""; push("code", "${"); j = code(j + 2, true); continue; }
      buf += c; j += 1;
    }
    push("string", buf);
    return j;
  }
  function code(start, inTemplate) {
    let j = start;
    let depth = 0;
    let buf = "";
    const flush = () => { if (buf) { push("code", buf); buf = ""; } };
    while (j < n) {
      const c = src[j];
      if (inTemplate && c === "}" && depth === 0) { flush(); push("code", "}"); return j + 1; }
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      if (c === "/" && src[j + 1] === "/") { flush(); const e = src.indexOf("\n", j); const end = e < 0 ? n : e; push("comment", src.slice(j, end)); j = end; continue; }
      if (c === "/" && src[j + 1] === "*") { flush(); const e = src.indexOf("*/", j + 2); const end = e < 0 ? n : e + 2; push("comment", src.slice(j, end)); j = end; continue; }
      if (c === "'" || c === '"') {
        flush(); let k = j + 1;
        while (k < n && src[k] !== c) k += src[k] === "\\" ? 2 : 1;
        push("code", c); push("string", src.slice(j + 1, k)); push("code", c); j = k + 1; last = c; continue;
      }
      if (c === "`") { flush(); push("code", "`"); j = template(j + 1); last = "`"; continue; }
      if (c === "/" && (last === "" || REGEX_PREV.includes(last) || /(return|typeof)\s*$/.test(src.slice(Math.max(0, j - 8), j)))) {
        flush(); let k = j + 1; let cls = false;
        while (k < n) {
          const d = src[k];
          if (d === "\\") { k += 2; continue; }
          if (d === "[") cls = true; else if (d === "]") cls = false; else if ((d === "/" && !cls) || d === "\n") break;
          k += 1;
        }
        push("regex", src.slice(j, k + 1)); j = k + 1; last = ")"; continue;
      }
      buf += c;
      if (!/\s/.test(c)) last = c;
      j += 1;
    }
    flush();
    return j;
  }
  code(0, false);
  return out;
}

/** Why an occurrence in prose (a comment, a string, a document) is fine, or null when it is not. */
function proseReason(text, index, spanText) {
  const word = text.slice(index).match(/^inscriptions?/i)[0];
  const before = text.slice(0, index);
  const after = text.slice(index + word.length);
  if (/P2MR $/i.test(before) && /^(Inscriptions?|INSCRIPTIONS?)$/.test(word)) return "ok";
  const ticks = (before.match(/`/g) ?? []).length;
  if (ticks % 2 === 1 && after.includes("`")) return "code span (identifier, path, flag, key, literal)";
  const token = (before.match(/[\w./@:#{}$-]*$/)?.[0] ?? "") + word + (after.match(/^[\w./@:{}$-]*/)?.[0] ?? "");
  if (/p2mr-?inscriptions?/i.test(token)) return "name or URL (P2MR-Inscriptions)";
  if (/\//.test(token.slice(0, token.toLowerCase().indexOf("inscription")))) return "API path or route";
  if (/[\w_]$/.test(before) || /^[\w_]/.test(after)) return "code identifier (part of a longer name)";
  if (/^[\s]*[:=]/.test(after) || /[.]$/.test(before) && /^[\s]*[[(=,;:.)\]}]/.test(after)) return "property or key";
  if (spanText !== undefined && !/\s/.test(spanText)) return "one-token string or code span";
  return null;
}

/** Occurrences of the bare word in text that is not code, with the reason they are allowed. */
function proseOccurrences(text) {
  const hits = [];
  for (const m of text.matchAll(WORD)) hits.push(m.index);
  return hits;
}

export function scan(root = resolve(dirname(fileURLToPath(import.meta.url)), "..")) {
  const results = [];
  for (const path of walk(root)) {
    const file = relative(root, path);
    let content;
    try { content = readFileSync(path, "utf8"); } catch { continue; }
    if (content.includes("\u0000")) continue;
    const lines = content.split("\n");
    const record = (lineNo, category, text) => results.push({ file, line: lineNo, category, text: text.trim().slice(0, 160) });
    const isTest = /\.test\.(ts|mjs|js)$/.test(file) || file.startsWith("explorer/test/");
    const historyAt = historyStart(file, lines);
    const isCode = /\.(ts|mjs|js)$/.test(file);
    const isMarkdown = /\.(md|txt|yml|yaml|html|json)$|(^|\/)NOTICE$/.test(file);
    if (isCode && !isTest) {
      // Offsets to line numbers.
      const lineStarts = [0];
      for (let k = 0; k < content.length; k += 1) if (content[k] === "\n") lineStarts.push(k + 1);
      const lineOf = (offset) => { let lo = 0; let hi = lineStarts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1; } return lo + 1; };
      let offset = 0;
      for (const seg of segments(content)) {
        const base = offset;
        offset += seg.text.length;
        for (const index of proseOccurrences(seg.text)) {
          const lineNo = lineOf(base + index);
          const text = lines[lineNo - 1];
          if (seg.kind === "code") { record(lineNo, "code identifier", text); continue; }
          if (seg.kind === "regex") { record(lineNo, "search pattern (accepts what a user types)", text); continue; }
          const reason = proseReason(seg.text, index, seg.kind === "string" ? seg.text : undefined);
          if (reason === "ok") continue;
          if (reason) { record(lineNo, reason, text); continue; }
          if (file === "packages/indexer/store.ts" && /\b(TABLE|FROM|INTO)\s+inscriptions\b|DELETE FROM inscriptions/i.test(seg.text)) { record(lineNo, "SQL table name (stored schema)", text); continue; }
          if (file === "scripts/check-terminology.mjs") { record(lineNo, "this script's own statement of the rule", text); continue; }
          if (file === "explorer/server/search.ts") { record(lineNo, "search result type (API value)", text); continue; }
          record(lineNo, "UNCLASSIFIED", text);
        }
      }
      continue;
    }
    if (!isCode && !isMarkdown && !isTest) continue;
    let fenced = false;
    lines.forEach((line, k) => {
      if (/^\s*```/.test(line)) { fenced = !fenced; if (!isTest) return; }
      if (!WORD.test(line)) { WORD.lastIndex = 0; return; }
      WORD.lastIndex = 0;
      const lineNo = k + 1;
      if (isTest) { record(lineNo, "test file (names, fixtures, expectations)", line); return; }
      if (historyAt >= 0 && k >= historyAt) { record(lineNo, "released or dated history entry (not rewritten)", line); return; }
      if (fenced) { record(lineNo, "code block (paths, JSON, SQL, commands)", line); return; }
      // Remove code spans from the line, then look at what is left.
      const spans = [...line.matchAll(/`[^`]*`/g)];
      let rest = line;
      for (const span of spans) {
        if (WORD.test(span[0])) {
          WORD.lastIndex = 0;
          const inner = span[0].slice(1, -1);
          const stripped = inner.replace(/P2MR Inscriptions?/gi, "");
          const bare = (stripped.match(WORD) ?? []).length > 0;
          WORD.lastIndex = 0;
          if (!bare) { /* only P2MR Inscription inside */ }
          else if (/^inscription #\d+$/.test(inner)) record(k + 1, "search pattern (accepts what a user types)", line);
          else if (LITERAL_FILES.has(file) || !/\s/.test(inner)) record(k + 1, "code span (identifier, path, flag, key, literal)", line);
          else record(k + 1, "UNCLASSIFIED", line);
        }
        WORD.lastIndex = 0;
        rest = rest.replace(span[0], " ".repeat(span[0].length));
      }
      rest = rest.replace(/\]\([^)]*\)/g, (m) => " ".repeat(m.length));
      const urls = [...rest.matchAll(/https?:\/\/\S+/g)];
      for (const u of urls) rest = rest.replace(u[0], " ".repeat(u[0].length));
      for (const index of proseOccurrences(rest)) {
        const reason = proseReason(rest, index, undefined);
        if (reason === "ok") continue;
        if (reason) { record(lineNo, reason, line); continue; }
        if (/^\s*[\w-]+:\s*(\/|http)/.test(line)) { record(lineNo, "name or URL (P2MR-Inscriptions)", line); continue; }
        record(lineNo, "UNCLASSIFIED", line);
      }
      WORD.lastIndex = 0;
    });
  }
  // A span that was recorded gets one row per line; drop exact repeats.
  const seen = new Set();
  return results.filter((r) => { const key = `${r.file}:${r.line}:${r.category}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rows = scan();
  const byCategory = new Map();
  for (const row of rows) byCategory.set(row.category, [...(byCategory.get(row.category) ?? []), row]);
  const list = process.argv.includes("--list");
  for (const [category, items] of [...byCategory].sort((a, b) => b[1].length - a[1].length)) {
    const files = new Set(items.map((item) => item.file));
    process.stdout.write(`${String(items.length).padStart(5)}  ${category}  (${files.size} files)\n`);
    if (list || category === "UNCLASSIFIED") for (const item of items) process.stdout.write(`        ${item.file}:${item.line}: ${item.text}\n`);
  }
  const bad = byCategory.get("UNCLASSIFIED")?.length ?? 0;
  process.stdout.write(bad === 0 ? "OK: every bare occurrence is allowed.\n" : `FAIL: ${bad} unclassified occurrence(s).\n`);
  process.exit(bad === 0 ? 0 : 1);
}
