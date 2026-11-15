// SPDX-License-Identifier: Apache-2.0

/**
 * The three records the issuer writes to close a collection and its sale (PINS-5 sections 7 and 8.5):
 *
 * - `pins-unsold-address/1`: `{ schema, root, address }`, the commitment to the address that receives the unsold items.
 * - `pins-sale-reveal/1`: `{ schema, root, sale_secret }`, the public mark that the sale is closed.
 * - `pins-close/1`: `{ schema, root, count }`, the closing of the collection.
 *
 * Each record is one P2MR Inscription signed by the issuer key. Its field 5 is a CBOR map of exactly three
 * keys in the order above, with the root and the secret as 32-byte byte strings. The body is the schema text and
 * the content type is `text/plain`; the indexer sets no condition on either. The encoders here write the same
 * bytes the reference indexer reads in `packages/indexer/collection.ts`.
 */
import { createHash } from "node:crypto";
import { addressToScriptPubKey } from "@qbit-oss/protocol";
import { decodeCbor } from "../indexer/cbor.ts";
import type { MintNetwork } from "./network.ts";
import type { SingleInscription } from "./plan.ts";

export const UNSOLD_ADDRESS_SCHEMA = "pins-unsold-address/1";
export const SALE_REVEAL_SCHEMA = "pins-sale-reveal/1";
export const CLOSE_SCHEMA = "pins-close/1";

export const RECORD_KINDS = ["unsold-address", "sale-reveal", "close"] as const;
export type RecordKind = typeof RECORD_KINDS[number];

/** The content type of every record. The indexer does not read it. */
export const RECORD_CONTENT_TYPE = "text/plain";

const SCHEMA_OF: Record<RecordKind, string> = {
  "unsold-address": UNSOLD_ADDRESS_SCHEMA,
  "sale-reveal": SALE_REVEAL_SCHEMA,
  close: CLOSE_SCHEMA,
};

/** The three keys of a record, in order. */
const KEYS_OF: Record<RecordKind, string> = {
  "unsold-address": "schema,root,address",
  "sale-reveal": "schema,root,sale_secret",
  close: "schema,root,count",
};

export type RecordInput =
  | { kind: "unsold-address"; root: string; address: string; network: MintNetwork }
  | { kind: "sale-reveal"; root: string; saleSecret: Uint8Array }
  | { kind: "close"; root: string; count: number };

/** A record read back from field 5. The secret is kept as bytes. */
export type ParsedRecord =
  | { kind: "unsold-address"; root: string; address: string }
  | { kind: "sale-reveal"; root: string; saleSecret: Uint8Array }
  | { kind: "close"; root: string; count: number };

export function isRecordKind(value: unknown): value is RecordKind {
  return typeof value === "string" && (RECORD_KINDS as readonly string[]).includes(value);
}

export function schemaOf(kind: RecordKind): string {
  return SCHEMA_OF[kind];
}

/** The body of a record P2MR Inscription: its schema, as short text. It is never the secret. */
export function recordBody(kind: RecordKind): Uint8Array {
  return new Uint8Array(Buffer.from(SCHEMA_OF[kind], "utf8"));
}

function head(major: number, value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("a CBOR length or count must be a non-negative whole number");
  if (value < 24) return Buffer.from([major << 5 | value]);
  if (value < 0x100) return Buffer.from([major << 5 | 24, value]);
  if (value < 0x10000) return Buffer.from([major << 5 | 25, value >> 8, value & 0xff]);
  if (value < 0x100000000) {
    const out = Buffer.alloc(5);
    out[0] = major << 5 | 26;
    out.writeUInt32BE(value, 1);
    return out;
  }
  const out = Buffer.alloc(9);
  out[0] = major << 5 | 27;
  out.writeBigUInt64BE(BigInt(value), 1);
  return out;
}

function textItem(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([head(3, bytes.length), bytes]);
}

function byteItem(value: Uint8Array): Buffer {
  return Buffer.concat([head(2, value.length), value]);
}

function hex32(value: string, what: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${what} must be 64 lowercase hex characters`);
  return Buffer.from(value, "hex");
}

/** The script of a witness-v2 P2MR address of `network` (PINS-5 section 8.5), or an error. */
export function unsoldAddressScript(address: string, network: MintNetwork): Uint8Array {
  const script = addressToScriptPubKey(address, network);
  if (script.length !== 34 || script[0] !== 0x52 || script[1] !== 0x20) throw new Error("the unsold address must be a witness-v2 P2MR address");
  return script;
}

/** Field 5 of a record: the CBOR map of its three keys, with byte strings for the root and the secret. */
export function recordField(input: RecordInput): Uint8Array {
  const root = hex32(input.root, "the root");
  const third = ((): Buffer => {
    if (input.kind === "unsold-address") {
      // The writer uses the lowercase form `p2mrAddressFromPubkey` writes, so a commitment has one spelling.
      if (input.address !== input.address.toLowerCase()) throw new Error("the unsold address must be written in lowercase");
      unsoldAddressScript(input.address, input.network);
      return Buffer.concat([textItem("address"), textItem(input.address)]);
    }
    if (input.kind === "sale-reveal") {
      if (input.saleSecret.length !== 32) throw new Error("the sale secret must be 32 bytes");
      return Buffer.concat([textItem("sale_secret"), byteItem(input.saleSecret)]);
    }
    if (!Number.isSafeInteger(input.count) || input.count < 1) throw new Error("the count must be a positive whole number");
    return Buffer.concat([textItem("count"), head(0, input.count)]);
  })();
  return new Uint8Array(Buffer.concat([
    Buffer.from([0xa3]),
    textItem("schema"), textItem(SCHEMA_OF[input.kind]),
    textItem("root"), byteItem(root),
    third,
  ]));
}

/** The P2MR Inscription of a record: the schema as the body, `text/plain`, and the record as field 5. */
export function recordInscription(input: RecordInput): SingleInscription {
  return { body: recordBody(input.kind), contentType: RECORD_CONTENT_TYPE, metadata: recordField(input) };
}

/**
 * A record read from field 5, by the rule of the reference indexer: a map of exactly the three keys of one
 * schema in order, a 32-byte root, and the typed third value. It does not compare the root with a genesis.
 * Null when `field5` is not such a record.
 */
export function parseRecord(field5: Uint8Array): ParsedRecord | null {
  let value: unknown;
  try {
    value = decodeCbor(field5);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Uint8Array) return null;
  const map = value as Record<string, unknown>;
  const keys = Object.keys(map).join(",");
  const kind = RECORD_KINDS.find((candidate) => KEYS_OF[candidate] === keys && map.schema === SCHEMA_OF[candidate]);
  if (!kind || !(map.root instanceof Uint8Array) || map.root.length !== 32) return null;
  const root = Buffer.from(map.root).toString("hex");
  if (kind === "unsold-address") return typeof map.address === "string" ? { kind, root, address: map.address } : null;
  if (kind === "sale-reveal") return map.sale_secret instanceof Uint8Array && map.sale_secret.length === 32 ? { kind, root, saleSecret: new Uint8Array(map.sale_secret) } : null;
  return typeof map.count === "number" && Number.isSafeInteger(map.count) && map.count >= 1 ? { kind, root, count: map.count } : null;
}

/** The input that writes `parsed` again, so a plan's leaf can be compared with the leaf of its own record. */
export function recordInputOf(parsed: ParsedRecord, network: MintNetwork): RecordInput {
  if (parsed.kind === "unsold-address") return { ...parsed, network };
  return parsed;
}

export function saleCommitmentOf(saleSecret: Uint8Array): string {
  return createHash("sha256").update(saleSecret).digest("hex");
}
