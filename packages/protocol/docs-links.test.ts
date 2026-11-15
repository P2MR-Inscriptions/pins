// SPDX-License-Identifier: Apache-2.0

/**
 * Every relative link of every Markdown file points at a file that exists, and when it names a
 * heading (`file.md#heading`) that heading exists, with the slug GitHub gives it. Links outside the
 * repository (`https:`, `mailto:`) are not fetched. Code blocks and code spans are not read.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SKIP = new Set(["node_modules", ".git"]);

function markdownFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...markdownFiles(path));
    else if (name.endsWith(".md")) found.push(path);
  }
  return found;
}

/** Lines of prose: fenced code is dropped. */
function prose(text: string): string[] {
  let fenced = false;
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) lines.push(line);
  }
  return lines;
}

/** GitHub's heading anchor: lower case, no punctuation except `-` and `_`, spaces to `-`, repeats numbered. */
function slugs(text: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const line of prose(text)) {
    const match = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const base = match[1]
      .replace(/`/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .trim()
      .replace(/\s/g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    out.add(count === 0 ? base : `${base}-${count}`);
  }
  return out;
}

test("every relative link in the Markdown files resolves, to a file and to a heading", () => {
  const files = markdownFiles(ROOT);
  assert.ok(files.length > 15, "the Markdown files were found");
  const cache = new Map<string, Set<string>>();
  const anchors = (path: string) => {
    if (!cache.has(path)) cache.set(path, slugs(readFileSync(path, "utf8")));
    return cache.get(path)!;
  };
  const broken: string[] = [];
  let checked = 0;
  for (const file of files) {
    for (const [index, line] of prose(readFileSync(file, "utf8")).entries()) {
      const bare = line.replace(/`[^`]*`/g, "");
      for (const match of bare.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const target = match[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        const [pathPart, anchor] = target.split("#");
        const destination = pathPart === "" ? file : resolve(dirname(file), decodeURIComponent(pathPart));
        checked += 1;
        const label = `${relative(ROOT, file)}:${index + 1} -> ${target}`;
        if (!existsSync(destination)) {
          broken.push(`${label} (no such file)`);
        } else if (anchor !== undefined && anchor !== "" && destination.endsWith(".md") && !anchors(destination).has(anchor.toLowerCase())) {
          broken.push(`${label} (no such heading)`);
        }
      }
    }
  }
  assert.ok(checked > 50, `links were checked (${checked})`);
  assert.deepEqual(broken, []);
});
