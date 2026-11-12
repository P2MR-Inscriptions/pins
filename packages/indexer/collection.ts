// SPDX-License-Identifier: Apache-2.0

/**
 * Collection view over a PINS indexer. Authenticity is PINS-5 §9.
 * The sale stays closed until a wallet can complete a pre-signed offer.
 * An online sale key is not read and not required.
 */
import { createHash } from "node:crypto";
import { LAUNCH_PRICE_SCHEMA, priceBody } from "../inscriber/price.ts";
import { parsePrice, type PriceRecord } from "../inscriber/preflight.ts";
import { CONFIRMATIONS_FINAL } from "../protocol/index.mjs";
import { leafHash, leafListRoot } from "../protocol/merkle.mjs";
import { decodeCbor } from "./cbor.ts";
import { MAX_PAGE_LIMIT } from "./paging.ts";
import type { Indexer, Inscription } from "./pins.ts";

/** Field 5 schema texts of the records the indexer reads, defined once (PINS-5 §6, §8.5 and §7). The collection and price schemas are settings of the indexer. */
export const LEAFLIST_SCHEMA = "pins-leaflist/1";
export const SALE_REVEAL_SCHEMA = "pins-sale-reveal/1";
export const CLOSE_SCHEMA = "pins-close/1";

type ReserveModule = {
  selectReserve: (
    pieces: { id: number; attributes: { trait_type: string; value: string }[] }[],
    seed: Buffer,
    options?: { groups?: { trait_type: string; value: string; count: number }[]; extra?: number },
  ) => { reserve: number[]; sale: number[] };
  saleOrder: (ids: number[], mixedSeed: Buffer) => number[];
  saleSeed: (secret: Buffer, blockHash: Buffer) => Buffer;
};

async function reserveModule(): Promise<ReserveModule> {
  const specifier = "../protocol/reserve.mjs";
  return (await import(specifier)) as ReserveModule;
}

/**
 * The earliest valid price inscription wins. A later one, even from the same issuer, is ignored.
 * Invalid field 5, the wrong genesis id, or any other signer is skipped.
 * `priceSchema` is the launch text unless the indexer was started with a rehearsal schema.
 */
export function firstValidPrice(
  items: readonly Inscription[],
  genesisId: string,
  issuer: string,
  priceSchema: string = LAUNCH_PRICE_SCHEMA,
): { id: string; price: PriceRecord } | null {
  const body = priceBody(priceSchema);
  const ordered = items
    .filter((item) => item.leafIssuer === issuer && !item.flags.includes("reinscription") && !item.flags.includes("opaque"))
    .sort((left, right) => left.createdHeight - right.createdHeight || left.createdIndex - right.createdIndex || left.n - right.n);
  for (const item of ordered) {
    if (!item.metadata) continue;
    let decoded: unknown;
    try {
      decoded = decodeCbor(item.metadata);
    } catch {
      continue;
    }
    if (item.contentType !== "text/plain" || !sameBytes(item.body, body)) continue;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) continue;
    const record = decoded as Record<string, unknown>;
    if (record.schema !== priceSchema || record.genesis !== genesisId) continue;
    try {
      return { id: item.id, price: parsePrice(record) };
    } catch {
      continue;
    }
  }
  return null;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

const PRICE_KEYS = ["price_bits", "price_sources", "price_time"] as const;

function carriesPrice(record: Record<string, unknown> | null | undefined): boolean {
  return Boolean(record && PRICE_KEYS.some((key) => record[key] !== undefined));
}

function readReserve(value: unknown): ReserveDecl {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("genesis reserve must be an object");
  const record = value as { groups?: unknown; extra?: unknown };
  if (!Array.isArray(record.groups) || typeof record.extra !== "number") throw new Error("genesis reserve must declare groups and extra");
  const groups = record.groups.map((group) => {
    if (!group || typeof group !== "object") throw new Error("genesis reserve group is not an object");
    const row = group as { trait_type?: unknown; value?: unknown; count?: unknown };
    if (typeof row.trait_type !== "string" || typeof row.value !== "string" || typeof row.count !== "number") {
      throw new Error("genesis reserve group must have trait_type, value, and count");
    }
    return { trait_type: row.trait_type, value: row.value, count: row.count };
  });
  return { groups, extra: record.extra };
}

export type CollectionProfile = {
  name: string;
  namePrefix: string;
  supply: number;
  first: number;
  itemType: string;
  root: string;
  reserveGroups: { trait_type: string; value: string; count: number }[];
  reserveExtra: number;
  reserveCount: number;
};

function matchesProfile(genesis: Genesis, profile: CollectionProfile | null | undefined): boolean {
  // A profile with no reserve groups is one with no sale. It configures no reserve.
  if (!profile || profile.reserveGroups.length === 0) return false;
  return genesis.name === profile.name
    && genesis.supply === profile.supply
    && genesis.first === profile.first
    && genesis.namePrefix === profile.namePrefix
    && genesis.itemType === profile.itemType
    && genesis.root === profile.root;
}

export type PieceStatus = "reserve" | "sale" | "unassigned";

export type CollectionView = {
  status: "absent" | "present";
  sale: "waiting_for_wallet";
  saleNote: string;
  genesisId?: string;
  name?: string;
  supply?: number;
  first?: number;
  namePrefix?: string;
  root?: string;
  issuer?: string;
  itemType?: string;
  leafListId?: string;
  /** The closing inscription of PINS-5 §7. Items inscribed after it are not authentic. */
  closingId?: string;
  seedRevealed?: boolean;
  reserveMode?: "configured" | "declared" | "none";
  reserveVerified?: boolean | null;
  /** Set when reserve selection throws or the selected count is not the declared count. */
  reserveReason?: string;
  /** `pending` until the block at genesis height + 6 is indexed and has 6 confirmations. `failed` when reserve selection throws. */
  orderStatus?: "none" | "pending" | "ready" | "failed";
  orderPendingReason?: string;
  orderBlockHeight?: number;
  /** Display hash of that block. The mix uses the reversed internal bytes. */
  orderBlockHash?: string;
  order?: number[] | null;
  orderVerified?: boolean | null;
  /**
   * `none` when the genesis declares no sale: no price inscription is read. Otherwise `pending` until the
   * first valid price inscription by the genesis issuer, then `ready`. Later ones are ignored.
   */
  priceStatus?: "none" | "pending" | "ready";
  priceId?: string;
  priceBits?: number;
  priceSources?: string[];
  priceTime?: string;
  pieces?: PieceView[];
};

/**
 * Location as JSON. A `Uint8Array` script becomes `{"0":82,"1":32,…}` under
 * `JSON.stringify`. Callers that leave the indexer see lowercase hex instead.
 */
export type PublicLocation =
  | { state: "located"; txid: string; vout: number; offset: string; script: string }
  | { state: "unbound" }
  | { state: "burned" }
  | { state: "lost" };

/** Hex script and decimal offset. `null` when the piece has no inscription yet. */
export function publicLocation(location: Inscription["location"] | null): PublicLocation | null {
  if (!location) return null;
  if (location.state !== "located") return { state: location.state };
  return {
    state: "located",
    txid: location.txid,
    vout: location.vout,
    offset: location.offset.toString(),
    script: Buffer.from(location.script).toString("hex"),
  };
}

export type PieceView = {
  number: number;
  inscriptionId: string | null;
  authentic: boolean;
  reason: string;
  status: PieceStatus;
  location: PublicLocation | null;
  ownerAddress: string;
  /** Output script that holds the piece, lowercase hex. Empty when there is no owner. */
  ownerScript: string;
  confirmations: number;
  final: boolean;
};

type ReserveDecl = { groups: { trait_type: string; value: string; count: number }[]; extra: number };

type Genesis = {
  inscription: Inscription;
  name: string;
  supply: number;
  first: number;
  namePrefix: string;
  root: string;
  issuer: string;
  itemType: string;
  saleCommitment: string;
  reserve?: ReserveDecl;
};

export type ChainCursor = {
  tipHeight: number;
  /** Display block hash, or null when that height is not in the index. */
  blockHash: (height: number) => string | null;
};

/** PINS-5 §8.2: internal header hash, not the reversed display hex. */
export function internalBlockHash(displayHex: string): Buffer {
  const raw = Buffer.from(displayHex, "hex");
  if (raw.length !== 32) throw new Error("block hash must be 32 bytes");
  return Buffer.from(raw).reverse();
}

const SALE_NOTE = "The sale waits until Qbit Wallet can complete a pre-signed SIGHASH 0x83 offer. No online sale key is used.";

function sha256(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

const HEX32 = /^[0-9a-f]{64}$/;
/** The keys every genesis has, in order. `sale_commitment` and then `reserve` may follow, each optional. */
const GENESIS_KEYS = ["schema", "name", "supply", "first", "name_prefix", "root", "issuer", "item_type"];
const GENESIS_KEYS_WITH_SALE = [...GENESIS_KEYS, "sale_commitment"];

function chainOrder(left: Inscription, right: Inscription): number {
  return left.createdHeight - right.createdHeight || left.createdIndex - right.createdIndex || left.n - right.n;
}

/**
 * Genesis parameters come only from field 5. A JSON body, earlier or not, is not a source.
 * The eight base keys come first, in order. `sale_commitment` is optional, and so is `reserve`,
 * which comes last. A genesis without `sale_commitment` declares no sale. The issuer text must
 * be the reveal key.
 */
function genesisOf(indexer: Indexer): Genesis | null {
  const found = [...indexer.inscriptions.values()]
    .filter((item) => item.contentType === "application/json")
    .sort(chainOrder);
  for (const item of found) {
    if (indexer.genesisId && item.id !== indexer.genesisId) continue;
    if (item.flags.includes("reinscription") || item.flags.includes("opaque") || !item.metadata) continue;
    let field: Record<string, unknown>;
    try {
      const decoded = decodeCbor(item.metadata);
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) continue;
      field = decoded as Record<string, unknown>;
    } catch {
      continue;
    }
    if (field.schema !== indexer.collectionSchema || carriesPrice(field)) continue;
    const keys = Object.keys(field);
    const withoutReserve = keys.filter((key) => key !== "reserve").join(",");
    const declaresSale = withoutReserve === GENESIS_KEYS_WITH_SALE.join(",");
    if (!declaresSale && withoutReserve !== GENESIS_KEYS.join(",")) continue;
    if (field.reserve !== undefined && keys[keys.length - 1] !== "reserve") continue;
    const { name, supply, first, root, issuer } = field;
    const namePrefix = field.name_prefix;
    const itemType = field.item_type;
    if (typeof name !== "string" || name.length === 0) continue;
    if (typeof supply !== "number" || !Number.isSafeInteger(supply) || supply < 1 || !Number.isSafeInteger(supply * 32)) continue;
    if (typeof first !== "number" || !Number.isSafeInteger(first) || first < 0) continue;
    if (typeof namePrefix !== "string" || typeof itemType !== "string" || itemType.length === 0) continue;
    if (typeof root !== "string" || !HEX32.test(root)) continue;
    if (typeof issuer !== "string" || !HEX32.test(issuer) || issuer !== item.leafIssuer) continue;
    let saleCommitment = "";
    if (declaresSale) {
      if (typeof field.sale_commitment !== "string" || !HEX32.test(field.sale_commitment)) continue;
      saleCommitment = field.sale_commitment;
    }
    let reserve: ReserveDecl | undefined;
    if (field.reserve !== undefined) {
      try {
        reserve = readReserve(field.reserve);
      } catch {
        continue;
      }
    }
    return {
      inscription: item,
      name,
      supply,
      first,
      namePrefix,
      root,
      issuer,
      itemType,
      saleCommitment,
      reserve,
    };
  }
  return null;
}

/**
 * The v1.0.0 inscriber writes the leaf list with no field 5. A list is accepted when
 * it shares the genesis transaction and issuer, has `supply * 32` bytes, and those
 * leaves fold to `root`. Field 5, when present, must be `pins-leaflist/1` with that
 * root as 32 bytes. A wrong field 5 drops that candidate.
 */
function leafListOf(indexer: Indexer, genesis: Genesis): Inscription | undefined {
  const want = genesis.supply * 32;
  const candidates = [...indexer.inscriptions.values()]
    .filter((item) => item.txid === genesis.inscription.txid
      && item !== genesis.inscription
      && item.contentType === "application/octet-stream"
      && item.body.length === want
      && item.leafIssuer === genesis.issuer
      && !item.flags.includes("reinscription")
      && !item.flags.includes("opaque"))
    .sort(chainOrder);
  for (const item of candidates) {
    if (item.metadata) {
      let decoded: Record<string, unknown>;
      try {
        const value = decodeCbor(item.metadata);
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        decoded = value as Record<string, unknown>;
      } catch {
        continue;
      }
      if (Object.keys(decoded).join(",") !== "schema,root" || decoded.schema !== LEAFLIST_SCHEMA) continue;
      const root = decoded.root;
      if (!(root instanceof Uint8Array) || root.length !== 32 || Buffer.from(root).toString("hex") !== genesis.root) continue;
    }
    if (leafListRoot(item.body) !== genesis.root) continue;
    return item;
  }
  return undefined;
}

/** Field 5 of an inscription that is not a reinscription or opaque, as a map. Other values are not records of the collection. */
function recordOf(item: Inscription): Record<string, unknown> | null {
  if (!item.metadata || item.flags.includes("reinscription") || item.flags.includes("opaque")) return null;
  try {
    const decoded = decodeCbor(item.metadata);
    return isRecord(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/** The issuer's inscriptions after the genesis whose field 5 is a map of three keys (`0xa3`), in chain order. */
function recordCandidates(indexer: Indexer, genesis: Genesis): Inscription[] {
  return [...indexer.inscriptions.values()]
    .filter((item) => item.metadata?.[0] === 0xa3 && item.leafIssuer === genesis.issuer && after(genesis, item))
    .sort(chainOrder);
}

function bytes32(value: unknown): Buffer | null {
  return value instanceof Uint8Array && value.length === 32 ? Buffer.from(value) : null;
}

/**
 * PINS-5 §8.5: the sale reveal is signed by the issuer key, comes after the genesis, and has
 * field 5 `{ schema: "pins-sale-reveal/1", root, sale_secret }` with `root` the genesis root
 * and `SHA256(sale_secret)` equal to `sale_commitment`. The first one in chain order counts.
 */
function saleRevealOf(indexer: Indexer, genesis: Genesis): { inscription: Inscription; secret: Buffer } | null {
  if (!genesis.saleCommitment) return null;
  for (const item of recordCandidates(indexer, genesis)) {
    const record = recordOf(item);
    if (!record || Object.keys(record).join(",") !== "schema,root,sale_secret" || record.schema !== SALE_REVEAL_SCHEMA) continue;
    const root = bytes32(record.root);
    const secret = bytes32(record.sale_secret);
    if (!root || root.toString("hex") !== genesis.root || !secret || sha256(secret).toString("hex") !== genesis.saleCommitment) continue;
    return { inscription: item, secret };
  }
  return null;
}

/**
 * PINS-5 §7: the closing inscription is signed by the issuer key, comes after the genesis, and
 * has field 5 `{ schema: "pins-close/1", root, count }` with `root` the genesis root and `count`
 * the supply. The first one in chain order counts. No inscription after it is an item.
 */
function closingOf(indexer: Indexer, genesis: Genesis): Inscription | null {
  for (const item of recordCandidates(indexer, genesis)) {
    const record = recordOf(item);
    if (!record || Object.keys(record).join(",") !== "schema,root,count" || record.schema !== CLOSE_SCHEMA) continue;
    const root = bytes32(record.root);
    if (!root || root.toString("hex") !== genesis.root || record.count !== genesis.supply) continue;
    return item;
  }
  return null;
}

function after(genesis: Genesis, item: Inscription): boolean {
  if (item.createdHeight !== genesis.inscription.createdHeight) return item.createdHeight > genesis.inscription.createdHeight;
  if (item.createdIndex !== genesis.inscription.createdIndex) return item.createdIndex > genesis.inscription.createdIndex;
  return item.n > genesis.inscription.n;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTrait(value: unknown): value is { trait_type: string; value: string } {
  return isRecord(value) && typeof value.trait_type === "string" && typeof value.value === "string";
}

/**
 * Field 5 can come from any inscription, so each value is checked before it is used.
 * PINS-5 §9 rule 4 needs a text `meta.name`, and PINS-4 §3 gives attributes as text pairs.
 * An inscription without them is not an item of the collection and affects no other one.
 */
function metaOf(item: Inscription): { name?: string; attributes?: { trait_type: string; value: string }[] } | null {
  if (!item.metadata) return null;
  let decoded: unknown;
  try {
    decoded = decodeCbor(item.metadata);
  } catch {
    return null;
  }
  const meta = isRecord(decoded) ? decoded.meta : undefined;
  if (!isRecord(meta)) return null;
  return {
    name: typeof meta.name === "string" ? meta.name : undefined,
    attributes: Array.isArray(meta.attributes) && meta.attributes.every(isTrait) ? meta.attributes : undefined,
  };
}

export async function collectionView(indexer: Indexer, cursor: ChainCursor, profile?: CollectionProfile | null): Promise<CollectionView> {
  const base = { sale: "waiting_for_wallet" as const, saleNote: SALE_NOTE };
  const genesis = genesisOf(indexer);
  if (!genesis) return { status: "absent", ...base };
  const leafList = leafListOf(indexer, genesis);
  const seed = saleRevealOf(indexer, genesis);
  const closing = closingOf(indexer, genesis);
  const claimed = new Map<number, Inscription>();
  const candidates = [...indexer.inscriptions.values()]
    .filter((item) => item !== genesis.inscription && item !== leafList && item.leafIssuer === genesis.issuer && after(genesis, item))
    .filter((item) => !closing || chainOrder(item, closing) < 0)
    .sort((left, right) => left.createdHeight - right.createdHeight || left.createdIndex - right.createdIndex || left.n - right.n);
  for (const item of candidates) {
    const meta = metaOf(item);
    if (!meta?.name?.startsWith(genesis.namePrefix)) continue;
    const number = Number(meta.name.slice(genesis.namePrefix.length));
    if (!Number.isInteger(number) || claimed.has(number)) continue;
    if (!authentic(genesis, leafList?.body, item, number)) continue;
    claimed.set(number, item);
  }
  const pieces: PieceView[] = [];
  for (let number = genesis.first; number < genesis.first + genesis.supply; number += 1) {
    const match = claimed.get(number) ?? null;
    const confirmations = match ? Math.max(0, cursor.tipHeight - match.locationHeight + 1) : 0;
    pieces.push({
      number,
      inscriptionId: match?.id ?? null,
      authentic: Boolean(match),
      reason: match ? "ok" : "no authentic inscription",
      status: "unassigned",
      location: publicLocation(match?.location ?? null),
      ownerAddress: match?.ownerAddress ?? "",
      ownerScript: match?.ownerScript ?? "",
      confirmations,
      final: confirmations >= CONFIRMATIONS_FINAL,
    });
  }
  const reserveMode = genesis.reserve ? "declared" as const : matchesProfile(genesis, profile) ? "configured" as const : "none" as const;
  let reserveVerified: boolean | null = null;
  let reserveReason: string | undefined;
  let order: number[] | null = null;
  let orderVerified: boolean | null = null;
  let orderStatus: "none" | "pending" | "ready" | "failed" = genesis.saleCommitment ? "pending" : "none";
  let orderPendingReason: string | undefined = genesis.saleCommitment ? "sale secret is not revealed" : "genesis declares no sale";
  // PINS-5 §8.2: H_seed is the height of the genesis block plus 6. Finality is separate.
  const orderBlockHeight = genesis.inscription.createdHeight + 6;
  const orderBlockHash = cursor.blockHash(orderBlockHeight) ?? undefined;
  let saleIds: number[] | null;
  if (!genesis.saleCommitment) {
    saleIds = null;
  } else if (!seed) {
    saleIds = null;
  } else if (reserveMode === "none") {
    saleIds = pieces.map((piece) => piece.number);
    reserveVerified = null;
  } else {
    const reserve = await reserveModule();
    const traits = pieces.flatMap((piece) => {
      const item = piece.inscriptionId ? indexer.get(piece.inscriptionId) : undefined;
      const meta = item ? metaOf(item) : null;
      if (!meta?.attributes) return [];
      return [{ id: piece.number, attributes: meta.attributes }];
    });
    // A short quota used to throw out of /collection (HTTP 500). The genesis is
    // still valid. Report the failure on the view and keep serving pieces.
    const groups = reserveMode === "declared" && genesis.reserve
      ? { groups: genesis.reserve.groups, extra: genesis.reserve.extra }
      : { groups: profile!.reserveGroups, extra: profile!.reserveExtra };
    try {
      const selected = reserve.selectReserve(traits, seed.secret, groups);
      const expectedCount = reserveMode === "configured"
        ? profile!.reserveCount
        : genesis.reserve!.groups.reduce((sum, group) => sum + group.count, 0) + genesis.reserve!.extra;
      reserveVerified = selected.reserve.length === expectedCount;
      if (!reserveVerified) reserveReason = `reserve selection returned ${selected.reserve.length} ids, expected ${expectedCount}`;
      saleIds = selected.sale;
      const reserved = new Set(selected.reserve);
      for (const piece of pieces) piece.status = reserved.has(piece.number) ? "reserve" : "sale";
    } catch (error) {
      reserveVerified = false;
      reserveReason = error instanceof Error ? error.message : "reserve selection failed";
      orderStatus = "failed";
      orderVerified = false;
      orderPendingReason = reserveReason;
      saleIds = null;
    }
  }
  if (genesis.saleCommitment && seed && saleIds) {
    if (!orderBlockHash) {
      orderPendingReason = `block ${orderBlockHeight} (genesis height + 6) is not indexed`;
    } else if (cursor.tipHeight - orderBlockHeight + 1 < CONFIRMATIONS_FINAL) {
      orderPendingReason = `block ${orderBlockHeight} is indexed but not final`;
    } else {
      const reserve = await reserveModule();
      const mixed = reserve.saleSeed(seed.secret, internalBlockHash(orderBlockHash));
      order = reserve.saleOrder(saleIds, mixed);
      orderVerified = true;
      orderStatus = "ready";
      orderPendingReason = undefined;
      if (reserveMode === "none") for (const piece of pieces) piece.status = "sale";
    }
  }
  // A price opens a sale. A genesis that declares none has nothing to open, so none is read.
  const price = genesis.saleCommitment
    ? firstValidPrice(
      [...indexer.inscriptions.values()].filter((item) => after(genesis, item)),
      genesis.inscription.id,
      genesis.issuer,
      indexer.priceSchema,
    )
    : null;
  return {
    status: "present",
    ...base,
    genesisId: genesis.inscription.id,
    priceStatus: !genesis.saleCommitment ? "none" : price ? "ready" : "pending",
    priceId: price?.id,
    priceBits: price?.price.price_bits,
    priceSources: price?.price.price_sources,
    priceTime: price?.price.price_time,
    name: genesis.name,
    supply: genesis.supply,
    first: genesis.first,
    namePrefix: genesis.namePrefix,
    root: genesis.root,
    issuer: genesis.issuer,
    itemType: genesis.itemType,
    leafListId: leafList?.id,
    closingId: closing?.id,
    seedRevealed: Boolean(seed),
    reserveMode,
    reserveVerified,
    reserveReason,
    orderStatus,
    orderPendingReason,
    orderBlockHeight,
    orderBlockHash,
    order,
    orderVerified,
    pieces,
  };
}

function authentic(genesis: Genesis, leafList: Uint8Array | undefined, item: Inscription, number: number): boolean {
  if (item.leafIssuer !== genesis.issuer) return false;
  if (item.contentType !== genesis.itemType) return false;
  if (item.flags.includes("reinscription") || item.flags.includes("opaque")) return false;
  const meta = metaOf(item);
  if (!meta || meta.name !== `${genesis.namePrefix}${number}`) return false;
  if (!item.metadata || !leafList) return false;
  const leaf = leafHash(number, item.body, item.metadata);
  const offset = (number - genesis.first) * 32;
  if (offset < 0 || offset + 32 > leafList.length) return false;
  return Buffer.from(leafList.subarray(offset, offset + 32)).equals(leaf);
}

export function pieceByNumber(view: CollectionView, number: number): PieceView | null {
  return view.pieces?.find((piece) => piece.number === number) ?? null;
}

/** One page of pieces for a gallery. `limit` is capped (`MAX_PAGE_LIMIT`) so a client cannot ask for the whole supply at once. */
export function piecePage(pieces: PieceView[], offset: number, limit: number, authenticOnly = false): { total: number; offset: number; limit: number; pieces: PieceView[] } | null {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) return null;
  const source = authenticOnly ? pieces.filter((piece) => piece.authentic) : pieces;
  return { total: source.length, offset, limit, pieces: source.slice(offset, offset + limit) };
}

export function traitsFromMetadata(metadata: Uint8Array | undefined): { trait_type: string; value: string }[] {
  if (!metadata) return [];
  try {
    const decoded = decodeCbor(metadata) as { meta?: { attributes?: { trait_type: string; value: string }[] } };
    const rows = decoded.meta?.attributes ?? [];
    return rows.filter((row) => typeof row?.trait_type === "string" && typeof row?.value === "string");
  } catch {
    return [];
  }
}
