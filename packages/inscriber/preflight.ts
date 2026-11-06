// SPDX-License-Identifier: Apache-2.0

/**
 * Mainnet preflight. Every row must pass before broadcast.
 * This module does not open a socket. The CLI supplies the node answers.
 */
import { createHash } from "node:crypto";
import { addressToScriptPubKey } from "@qbit-oss/protocol";
import { decodeCbor } from "../indexer/cbor.ts";
import { readCompactSize } from "./compact.ts";
import { parseEnvelopes } from "./script.ts";
import { parseMarker } from "./marker.ts";
import { rpcChainName, type MintNetwork } from "./network.ts";
import type { MintPlan } from "./plan.ts";
import { LAUNCH_PRICE_SCHEMA } from "./price.ts";

export { LAUNCH_COLLECTION_SCHEMA, LAUNCH_PRICE_SCHEMA, PRICE_BODY, priceBody, priceSchemaFor } from "./price.ts";

export type Check = { name: string; pass: boolean; detail: string };

/** Above the 250 bits/kvB minimum relay. Not a consensus rule. */
export const MIN_FEE_RATE = 1;
/** Above the 10 bit/vB planning example. A larger number is treated as a typo. */
export const MAX_FEE_RATE = 200;
/** Standard transaction weight. WITNESS_SCALE_FACTOR is 1, so this is bytes. */
export const STANDARD_TX_BYTES = 400_000;
/**
 * Descendant size limit recorded on regtest (PINS-5 §6.1):
 * `too-long-mempool-chain ... [limit: 404000]`.
 */
export const DESCENDANT_LIMIT_BYTES = 404_000;

export type NodeInfo = {
  chain: string;
  blocks: number;
  headers: number;
  initialblockdownload: boolean;
  subversion: string;
};

export type PriceRecord = {
  price_bits: number;
  price_sources: string[];
  price_time: string;
};

const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export function formatReport(checks: Check[]): string {
  const lines = checks.map((check) => `${check.pass ? "PASS" : "FAIL"}  ${check.name}  ${check.detail}`);
  const failed = checks.filter((check) => !check.pass).length;
  lines.push(failed === 0 ? `${checks.length} PASS` : `${failed} FAIL`);
  return `${lines.join("\n")}\n`;
}

export function reportOk(checks: Check[]): boolean {
  return checks.every((check) => check.pass);
}

export function nodeChecks(info: NodeInfo, network: MintNetwork): Check[] {
  const expected = rpcChainName(network);
  const synced = info.blocks > 0 && info.blocks === info.headers && info.initialblockdownload === false;
  const versionOk = /\/qbit:1\.\d+\.\d+\//.test(info.subversion);
  return [
    {
      name: "node chain",
      pass: info.chain === expected,
      detail: `chain ${info.chain}, expected ${expected}`,
    },
    {
      name: "node synced",
      pass: synced,
      detail: `blocks ${info.blocks}, headers ${info.headers}, initialblockdownload ${info.initialblockdownload}`,
    },
    {
      name: "node version",
      pass: versionOk,
      detail: info.subversion || "missing subversion",
    },
  ];
}

export function rootCheck(root: string, expected: string): Check {
  return {
    name: "merkle root",
    pass: root === expected,
    detail: root === expected ? root : `${root} is not the collection root`,
  };
}

export function quotaChecks(
  reserveIds: number[],
  pieces: { id: number; attributes: { trait_type: string; value: string }[] }[],
  groups: { trait_type: string; value: string; count: number }[],
  extraCount: number,
): Check[] {
  const unique = new Set(reserveIds);
  const expected = groups.reduce((sum, group) => sum + group.count, 0) + extraCount;
  const supply = pieces.reduce((max, piece) => Math.max(max, piece.id), expected);
  const countOk = unique.size === expected && reserveIds.length === expected && reserveIds.every((id) => Number.isInteger(id) && id >= 1 && id <= supply);
  const byId = new Map(pieces.map((piece) => [piece.id, piece]));
  const reserved = [];
  for (const id of reserveIds) {
    const piece = byId.get(id);
    if (piece) reserved.push(piece);
  }
  const used = new Set<number>();
  const short: string[] = [];
  for (const group of groups) {
    const eligible = reserved.filter((piece) => !used.has(piece.id) && piece.attributes.some((row) => row.trait_type === group.trait_type && row.value === group.value));
    if (eligible.length < group.count) short.push(`${group.trait_type}=${group.value} needs ${group.count}, found ${eligible.length}`);
    for (const piece of eligible.slice(0, group.count)) used.add(piece.id);
  }
  const extra = reserved.filter((piece) => !used.has(piece.id)).length;
  const quotasOk = short.length === 0 && extra === extraCount && reserved.length === expected;
  return [
    {
      name: "reserve count",
      pass: countOk && unique.size === expected,
      detail: countOk && unique.size === expected ? `${expected} ids` : `${unique.size} distinct ids in a list of ${reserveIds.length}`,
    },
    {
      name: "reserve quotas",
      pass: quotasOk,
      detail: quotasOk ? `${groups.length} groups then ${extraCount} extra` : (short.join("; ") || `extra ${extra}, expected ${extraCount}`),
    },
  ];
}

function addressOk(address: string, network: MintNetwork): string | null {
  try {
    addressToScriptPubKey(address, network);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "invalid address";
  }
}

export function addressChecks(network: MintNetwork, creator: string, sale: string, change: string, funding: string): Check[] {
  const rows: [string, string][] = [
    ["creator address", creator],
    ["sale address", sale],
    ["change address", change],
    ["funding address", funding],
  ];
  const checks = rows.map(([name, address]) => {
    const problem = addressOk(address, network);
    return { name, pass: problem === null, detail: problem ?? address };
  });
  // Revenue is a fifth wallet. Buyer payments go there. It is not a mint-plan
  // address, so it is not one of these four. Do not pass it as any of them.
  const distinct = new Set([creator, sale, change, funding]).size === 4;
  checks.push({
    name: "addresses distinct",
    pass: distinct,
    detail: distinct ? "creator, sale, change, and funding differ" : "two of creator, sale, change, and funding are the same",
  });
  return checks;
}

export function bitsFromQbt(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) throw new Error("node value is not a QBT amount");
  return BigInt(Math.round(value * 100_000_000));
}

export function fundingChecks(input: {
  found: boolean;
  confirmations: number;
  valueBits: bigint | null;
  scriptHex: string | null;
  fileValueBits: bigint;
  requiredBits: bigint;
  expectedScriptHex: string;
}): Check[] {
  const scriptOk = input.found && input.scriptHex === input.expectedScriptHex;
  const valueOk = input.found && input.valueBits !== null && input.valueBits === input.fileValueBits && input.valueBits >= input.requiredBits;
  return [
    {
      name: "funding utxo",
      pass: input.found && scriptOk,
      detail: !input.found ? "not found" : scriptOk ? "output script matches the plan" : "output script does not match the plan",
    },
    {
      name: "funding confirmations",
      pass: input.found && input.confirmations >= 6,
      detail: input.found ? `${input.confirmations} confirmations` : "not found",
    },
    {
      name: "funding value",
      pass: valueOk,
      detail: input.valueBits === null
        ? "no value"
        : `${input.valueBits} bits on chain, file ${input.fileValueBits}, plan spends ${input.requiredBits}`,
    },
  ];
}

export function requiredBits(plan: MintPlan): bigint {
  return plan.reveals.reduce((sum, reveal) => sum + BigInt(reveal.commitValue), 0n) + BigInt(plan.fanout.fee);
}

export function feeRateCheck(rate: number): Check {
  const pass = Number.isInteger(rate) && rate >= MIN_FEE_RATE && rate <= MAX_FEE_RATE;
  return {
    name: "fee rate",
    pass,
    detail: pass ? `${rate} bit/vB` : `${rate} is outside ${MIN_FEE_RATE}..${MAX_FEE_RATE} bit/vB`,
  };
}

export function weightChecks(plan: Pick<MintPlan, "fanout" | "reveals">): Check[] {
  const fanoutBytes = plan.fanout.raw.length / 2;
  const heavy = plan.reveals.filter((reveal) => reveal.weight > STANDARD_TX_BYTES);
  const chained = plan.reveals.filter((reveal) => fanoutBytes + reveal.weight > DESCENDANT_LIMIT_BYTES);
  return [
    {
      name: "reveal weight",
      pass: heavy.length === 0 && plan.reveals.length > 0,
      detail: heavy.length === 0 ? `${plan.reveals.length} reveals at or under ${STANDARD_TX_BYTES} bytes` : heavy.map((reveal) => `${reveal.name} ${reveal.weight}`).join(", "),
    },
    {
      name: "descendant limit",
      pass: chained.length === 0 && Number.isInteger(fanoutBytes),
      detail: chained.length === 0
        ? `fan-out ${fanoutBytes} bytes plus each reveal is at or under ${DESCENDANT_LIMIT_BYTES}`
        : chained.map((reveal) => `${reveal.name} ${fanoutBytes + reveal.weight}`).join(", "),
    },
  ];
}

function skip(raw: Uint8Array, offset: number, length: number): number {
  const next = offset + length;
  if (next > raw.length) throw new Error("transaction is truncated");
  return next;
}

/** Version, inputs, outputs, and locktime. Witness stacks are removed. */
export function nonWitnessSerialization(raw: Uint8Array): Uint8Array {
  if (raw.length < 10) throw new Error("transaction is truncated");
  let offset = 4;
  const witness = raw[4] === 0 && raw[5] === 1;
  if (witness) offset = 6;
  const bodyStart = offset;
  const inputs = readCompactSize(raw, offset);
  offset = inputs.next;
  for (let i = 0; i < inputs.value; i += 1) {
    offset = skip(raw, offset, 36);
    const script = readCompactSize(raw, offset);
    offset = skip(raw, script.next, script.value + 4);
  }
  const outputs = readCompactSize(raw, offset);
  offset = outputs.next;
  for (let i = 0; i < outputs.value; i += 1) {
    offset = skip(raw, offset, 8);
    const script = readCompactSize(raw, offset);
    offset = skip(raw, script.next, script.value);
  }
  const body = raw.subarray(bodyStart, offset);
  if (witness) {
    for (let i = 0; i < inputs.value; i += 1) {
      const count = readCompactSize(raw, offset);
      offset = count.next;
      for (let j = 0; j < count.value; j += 1) {
        const item = readCompactSize(raw, offset);
        offset = skip(raw, item.next, item.value);
      }
    }
  }
  offset = skip(raw, offset, 4);
  if (offset !== raw.length) throw new Error("transaction length does not match");
  const out = new Uint8Array(4 + body.length + 4);
  out.set(raw.subarray(0, 4), 0);
  out.set(body, 4);
  out.set(raw.subarray(raw.length - 4), 4 + body.length);
  return out;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false;
  return true;
}

export function signedBodyChecks(unsigned: MintPlan, signed: MintPlan): Check[] {
  const problems: string[] = [];
  if (unsigned.signed !== false) problems.push("unsigned file is marked signed");
  if (signed.signed !== true) problems.push("signed file is not marked signed");
  const keys = ["version", "network", "feeRate", "issuerPublic", "recoveryPublic", "creator", "sale", "change", "marker", "root"] as const;
  for (const key of keys) {
    if (unsigned[key] !== signed[key]) problems.push(key);
  }
  if (unsigned.reveals.length !== signed.reveals.length) problems.push("reveal count");
  const revealKeys = ["name", "txid", "weight", "fee", "commitValue", "commitAddress", "leaf", "control", "spentScript"] as const;
  const count = Math.min(unsigned.reveals.length, signed.reveals.length);
  for (let i = 0; i < count; i += 1) {
    for (const key of revealKeys) {
      if (unsigned.reveals[i][key] !== signed.reveals[i][key]) problems.push(`reveal ${i} ${key}`);
    }
    if (JSON.stringify(unsigned.reveals[i].outputs) !== JSON.stringify(signed.reveals[i].outputs)) problems.push(`reveal ${i} outputs`);
    try {
      const left = nonWitnessSerialization(Buffer.from(unsigned.reveals[i].raw, "hex"));
      const right = nonWitnessSerialization(Buffer.from(signed.reveals[i].raw, "hex"));
      if (!sameBytes(left, right)) problems.push(`reveal ${i} raw`);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : `reveal ${i} raw`);
    }
  }
  const fanKeys = ["txid", "fee", "spentValue", "spentScript", "leaf", "control"] as const;
  for (const key of fanKeys) {
    if (unsigned.fanout[key] !== signed.fanout[key]) problems.push(`fan-out ${key}`);
  }
  try {
    const left = nonWitnessSerialization(Buffer.from(unsigned.fanout.raw, "hex"));
    const right = nonWitnessSerialization(Buffer.from(signed.fanout.raw, "hex"));
    if (!sameBytes(left, right)) problems.push("fan-out raw");
  } catch (error) {
    problems.push(error instanceof Error ? error.message : "fan-out raw");
  }
  return [{
    name: "signed body",
    pass: problems.length === 0,
    detail: problems.length === 0 ? "matches the unsigned plan except witnesses" : problems.join(", "),
  }];
}

export function parsePrice(value: unknown): PriceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("--price file must be an object");
  const record = value as { price_bits?: unknown; price_sources?: unknown; price_time?: unknown };
  if (!Number.isInteger(record.price_bits) || Number(record.price_bits) <= 0) throw new Error("price_bits must be a positive integer");
  if (!Array.isArray(record.price_sources) || record.price_sources.length === 0 || record.price_sources.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error("price_sources must be a non-empty list of text");
  }
  if (typeof record.price_time !== "string" || !UTC_TIME.test(record.price_time)) throw new Error("price_time must be UTC YYYY-MM-DDTHH:MM:SSZ");
  return {
    price_bits: Number(record.price_bits),
    price_sources: record.price_sources as string[],
    price_time: record.price_time,
  };
}

export type GenesisProfile = {
  schema: string;
  name: string;
  supply: number;
  first: number;
  namePrefix: string;
  itemType: string;
  root: string;
};

export async function encodeGenesisField(input: GenesisProfile & {
  issuer: string;
  saleCommitment: string;
}): Promise<Uint8Array> {
  const specifier = "../collection/canonical.mjs";
  const canonical = await import(specifier) as { encodeCbor: (value: unknown) => Uint8Array };
  return canonical.encodeCbor({
    schema: input.schema,
    name: input.name,
    supply: input.supply,
    first: input.first,
    name_prefix: input.namePrefix,
    root: input.root,
    issuer: input.issuer,
    item_type: input.itemType,
    sale_commitment: input.saleCommitment,
  });
}

/**
 * Field 5 of a price inscription. `schema` defaults to the launch text.
 * A rehearsal passes the derived stand-in (`p/1` for collection schema `c/1`).
 * Key order is the order in PINS-6 §5.1.
 */
export async function encodePriceField(input: { genesis: string; price: PriceRecord; schema?: string }): Promise<Uint8Array> {
  const schema = input.schema ?? LAUNCH_PRICE_SCHEMA;
  const specifier = "../collection/canonical.mjs";
  const canonical = await import(specifier) as { encodeCbor: (value: unknown) => Uint8Array };
  return canonical.encodeCbor({
    schema,
    genesis: input.genesis,
    price_bits: input.price.price_bits,
    price_sources: input.price.price_sources,
    price_time: input.price.price_time,
  });
}

export type ReserveGroup = { trait_type: string; value: string; count: number };

type ReserveSpec = { groups: ReserveGroup[]; extra: number };

/**
 * The groups the indexer will pass to selectReserve for this genesis.
 * A declared reserve wins. Otherwise the configured profile is what a matching
 * genesis uses. This is the same choice as collection.ts.
 */
export function indexerGroups(
  field: Record<string, unknown> | null,
  profile: { reserveGroups: ReserveGroup[]; reserveExtra: number } | null,
): { groups: ReserveGroup[]; extra: number; source: "declared" | "profile" } | { error: string } {
  if (field && Object.prototype.hasOwnProperty.call(field, "reserve")) {
    const declared = readDeclaredReserve(field.reserve);
    if (!declared) return { error: "genesis reserve must declare groups and extra" };
    return { ...declared, source: "declared" };
  }
  if (profile) return { groups: profile.reserveGroups, extra: profile.reserveExtra, source: "profile" };
  return { error: "genesis declares no reserve and no collection profile was given" };
}

function readDeclaredReserve(value: unknown): ReserveSpec | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { groups?: unknown; extra?: unknown };
  if (!Array.isArray(record.groups) || !Number.isInteger(record.extra)) return null;
  const groups: ReserveGroup[] = [];
  for (const group of record.groups) {
    if (!group || typeof group !== "object" || Array.isArray(group)) return null;
    const row = group as { trait_type?: unknown; value?: unknown; count?: unknown };
    if (typeof row.trait_type !== "string" || typeof row.value !== "string" || !Number.isInteger(row.count)) return null;
    groups.push({ trait_type: row.trait_type, value: row.value, count: Number(row.count) });
  }
  return { groups, extra: Number(record.extra) };
}

function sameIds(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort((x, y) => x - y);
  const b = [...right].sort((x, y) => x - y);
  return a.every((id, index) => id === b[index]);
}

/**
 * Re-run the selection the indexer will run, before any mint broadcast.
 * The seed is the one whose SHA-256 is sale_commitment. The groups are the
 * ones the indexer will use (declared on the genesis, otherwise the profile).
 * The assigned reserve must be that selection, and the sale list must be the
 * other piece ids. A quota throw is a failed row, not an exception.
 */
export async function reserveReproductionChecks(input: {
  seed: Buffer;
  pieces: { id: number; attributes: { trait_type: string; value: string }[] }[];
  reserve: number[];
  sale: number[];
  field: Record<string, unknown> | null;
  profile: { reserveGroups: ReserveGroup[]; reserveExtra: number } | null;
}): Promise<Check[]> {
  const hash = createHash("sha256").update(input.seed).digest("hex");
  const commitment = input.field?.sale_commitment;
  const hashOk = typeof commitment === "string" && commitment === hash;
  const checks: Check[] = [{
    name: "seed hash",
    pass: hashOk,
    detail: hashOk ? hash : `seed hash ${hash} is not the genesis sale_commitment`,
  }];
  const groups = indexerGroups(input.field, input.profile);
  if ("error" in groups) {
    checks.push({ name: "reserve reproduction", pass: false, detail: groups.error });
    checks.push({ name: "sale complement", pass: false, detail: groups.error });
    return checks;
  }
  const specifier = "../protocol/reserve.mjs";
  const reserveModule = await import(specifier) as {
    selectReserve: (
      pieces: { id: number; attributes: { trait_type: string; value: string }[] }[],
      seed: Buffer,
      options: { groups: ReserveGroup[]; extra: number },
    ) => { reserve: number[]; sale: number[] };
  };
  try {
    const selected = reserveModule.selectReserve(input.pieces, input.seed, { groups: groups.groups, extra: groups.extra });
    const reserveOk = sameIds(selected.reserve, input.reserve);
    const pieceIds = input.pieces.map((piece) => piece.id);
    const complement = pieceIds.filter((id) => !new Set(selected.reserve).has(id));
    const saleOk = sameIds(selected.sale, input.sale) && sameIds(selected.sale, complement) && sameIds(input.sale, complement);
    checks.push({
      name: "reserve reproduction",
      pass: reserveOk,
      detail: reserveOk
        ? `${selected.reserve.length} ids match the ${groups.source} groups`
        : `selectReserve with the ${groups.source} groups does not reproduce the assigned reserve`,
    });
    checks.push({
      name: "sale complement",
      pass: saleOk,
      detail: saleOk ? `${selected.sale.length} sale ids are the pieces that were not reserved` : "sale ids are not the complement of the reserve",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "selectReserve failed";
    checks.push({ name: "reserve reproduction", pass: false, detail: message });
    checks.push({ name: "sale complement", pass: false, detail: message });
  }
  return checks;
}

export function genesisFieldFromLeaf(leafHex: string, markerHex: string): Record<string, unknown> | null {
  const marker = parseMarker(markerHex);
  const envelopes = parseEnvelopes(Buffer.from(leafHex, "hex"), marker);
  const field = envelopes[0]?.fields.find((item) => item.tag === 5);
  if (!field) return null;
  const decoded = decodeCbor(field.value);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
  return decoded as Record<string, unknown>;
}

export function genesisChecks(field: Record<string, unknown> | null, profile: GenesisProfile): Check[] {
  if (!field) {
    return [{ name: "genesis field 5", pass: false, detail: "missing" }];
  }
  const commitment = field.sale_commitment;
  const pricePresent = field.price_bits !== undefined || field.price_sources !== undefined || field.price_time !== undefined;
  return [
    {
      name: "genesis identity",
      pass: field.schema === profile.schema
        && field.name === profile.name
        && field.supply === profile.supply
        && field.first === profile.first
        && field.name_prefix === profile.namePrefix
        && field.item_type === profile.itemType
        && field.root === profile.root,
      detail: `schema ${String(field.schema)}, root ${String(field.root)}`,
    },
    {
      name: "sale commitment",
      pass: typeof commitment === "string" && /^[0-9a-f]{64}$/.test(commitment),
      detail: typeof commitment === "string" ? commitment : "missing",
    },
    {
      name: "genesis price",
      pass: !pricePresent,
      detail: pricePresent ? "a price field is present" : "absent",
    },
  ];
}
