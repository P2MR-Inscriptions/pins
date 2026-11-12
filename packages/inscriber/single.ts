// SPDX-License-Identifier: Apache-2.0

/**
 * Input of a single inscription for the command line: the body file, its content type, and optional metadata.
 * `plan`, `sign` and `preflight` all read the files through this module, so the three agree on the bytes.
 */
import { readFileSync } from "node:fs";
import type { SingleContent } from "./plan.ts";

/** One content type is a short ASCII MIME type (PINS-1 §4). */
export const MAX_CONTENT_TYPE_LENGTH = 255;

/** Flags of a collection mint. A single inscription has none of them. */
const COLLECTION_FLAGS = ["collection", "zip", "assignment", "sale", "holder", "root"] as const;
/** Flags that only a single inscription takes. */
const SINGLE_ONLY_FLAGS = ["body", "content-type", "metadata"] as const;

export function assertContentType(value: string): string {
  if (value.length === 0) throw new Error("the content type is empty");
  if (value.length > MAX_CONTENT_TYPE_LENGTH) throw new Error(`the content type is longer than ${MAX_CONTENT_TYPE_LENGTH} characters`);
  if (!/^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/.test(value) || !value.includes("/")) {
    throw new Error("the content type must be an ASCII MIME type such as image/png or text/plain;charset=utf-8");
  }
  return value;
}

/** `--single` takes the three single-only flags and refuses every collection flag. Without it, the single-only flags are refused. */
export function assertSingleFlags(command: string, flag: Record<string, string | boolean>): boolean {
  const single = flag.single === true;
  if (flag.single !== undefined && !single) throw new Error("--single takes no value");
  if (!single) {
    for (const name of SINGLE_ONLY_FLAGS) {
      if (flag[name] !== undefined) throw new Error(`--${name} is for a single inscription: add --single`);
    }
    return false;
  }
  if (command !== "plan" && command !== "sign" && command !== "preflight") {
    throw new Error(`--single applies to plan, sign and preflight, not ${command}. A single inscription has no assignment or reserve`);
  }
  for (const name of COLLECTION_FLAGS) {
    if (flag[name] !== undefined) throw new Error(`--${name} belongs to a collection and cannot be used with --single`);
  }
  return true;
}

/** Read the body, content type and optional metadata. The body is inscribed exactly as given. */
export async function readSingleContent(flag: Record<string, string | boolean>): Promise<SingleContent> {
  const bodyPath = flag.body;
  if (typeof bodyPath !== "string" || bodyPath.length === 0) throw new Error("missing --body");
  const typeValue = flag["content-type"];
  if (typeof typeValue !== "string" || typeValue.length === 0) throw new Error("missing --content-type");
  const body = new Uint8Array(readFileSync(bodyPath));
  if (body.length === 0) throw new Error("the body file is empty");
  const contentType = assertContentType(typeValue);
  let metadata: Uint8Array | undefined;
  if (flag.metadata !== undefined) {
    if (typeof flag.metadata !== "string" || flag.metadata.length === 0) throw new Error("--metadata needs a file");
    const specifier = "../collection/canonical.mjs";
    const canonical = await import(specifier) as { canonicalMetadataCbor: (parsed: unknown) => Uint8Array };
    metadata = new Uint8Array(canonical.canonicalMetadataCbor(JSON.parse(readFileSync(flag.metadata, "utf8"))));
  }
  return { single: { body, contentType, ...(metadata ? { metadata } : {}) } };
}
