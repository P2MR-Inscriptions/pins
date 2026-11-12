// SPDX-License-Identifier: Apache-2.0

/**
 * Mint CLI. `broadcast` and `preflight` talk to a node through `--rpc`. `plan`, `sign`, `assign`,
 * `address`, `keygen` and `price` are offline and refuse a node URL where they would otherwise use it.
 * The default network is regtest. `plan`, `sign` and `preflight` take `--single` for one stand-alone
 * P2MR Inscription (a body file and its content type) instead of a collection.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { init } from "@qbit-oss/pqc";
import { decodeCbor } from "../indexer/cbor.ts";
import { httpRpc } from "../indexer/follow.ts";
import { fundingAddress } from "./address.ts";
import { assertMarkerForNetwork, formatMarkerLine, parseMarker } from "./marker.ts";
import { LAUNCH_COLLECTION_SCHEMA, LAUNCH_PRICE_SCHEMA, priceBody, priceSchemaFor } from "./price.ts";
import { broadcastPlan } from "./broadcast.ts";
import {
  addressChecks,
  bitsFromQbt,
  encodeGenesisField,
  encodePriceField,
  feeRateCheck,
  formatReport,
  fundingChecks,
  genesisChecks,
  genesisFieldFromLeaf,
  nodeChecks,
  type Check,
  parsePrice,
  pricePlanField,
  priceSigningChecks,
  quotaChecks,
  reserveReproductionChecks,
  reportOk,
  requiredBits,
  rootCheck,
  signedBodyChecks,
  singleChecks,
  weightChecks,
} from "./preflight.ts";
import { createKeyfile, openKeyfile, readPassphrase, writeKeyfile, zeroSecrets } from "./keyfile.ts";
import { assertBroadcastNetwork, parseNetwork } from "./network.ts";
import { buildPlan, buildSinglePlan, type MintPlan, type PlanContent } from "./plan.ts";
import { assertSingleFlags, readSingleContent } from "./single.ts";
import { signPlan } from "./sign.ts";
import { assertReserveSize, assertRoot, holderFlag, merkleRoot, leafPreimage } from "./verify.ts";
import { groupsOf, loadCanonical, type MintShape } from "../../scripts/canonical-batch.ts";

function flags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[name] = true;
    else {
      out[name] = next;
      i += 1;
    }
  }
  return out;
}

function text(flag: Record<string, string | boolean>, name: string): string {
  const value = flag[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing --${name}`);
  return value;
}

function summary(plan: MintPlan, showMarker = false): string {
  if (plan.single === true) return singleSummary(plan, showMarker);
  const fees = [BigInt(plan.fanout.fee), ...plan.reveals.map((reveal) => BigInt(reveal.fee))];
  const total = fees.reduce((sum, fee) => sum + fee, 0n);
  const lines = [
    `network ${plan.network}`,
    `fee rate ${plan.feeRate} bit/vB`,
    `merkle root ${plan.root}`,
    `fan-out ${plan.fanout.txid} fee ${plan.fanout.fee} bits`,
    ...plan.reveals.map((reveal) => `${reveal.name} weight ${reveal.weight} fee ${reveal.fee} bits`),
    `reveals ${plan.reveals.length} (genesis + ${plan.reveals.length - 1} batches)`,
    `total fee ${total} bits`,
    `postage 10000 bits on every item output`,
    `creator ${plan.creator}`,
    plan.noSale ? (plan.holder === undefined ? "no sale: every item goes to the creator" : `no sale: every item goes to the holder ${plan.holder}`) : `sale holding ${plan.sale}`,
    `change ${plan.change}`,
    formatMarkerLine(plan.marker, showMarker),
  ];
  return lines.join("\n");
}

/** The summary of a single P2MR Inscription: its id is the txid of the reveal and index 0. */
function singleSummary(plan: MintPlan, showMarker: boolean): string {
  const reveal = plan.reveals[0];
  const total = BigInt(plan.fanout.fee) + BigInt(reveal.fee);
  return [
    `network ${plan.network}`,
    `fee rate ${plan.feeRate} bit/vB`,
    "single P2MR Inscription (no collection, no genesis, no number)",
    `fan-out ${plan.fanout.txid} fee ${plan.fanout.fee} bits`,
    `${reveal.name} ${reveal.txid} weight ${reveal.weight} fee ${reveal.fee} bits`,
    `P2MR Inscription id ${reveal.txid}i0`,
    `total fee ${total} bits`,
    "postage 10000 bits on the P2MR Inscription output",
    `owner ${plan.creator}`,
    `change ${plan.change}`,
    formatMarkerLine(plan.marker, showMarker),
  ].join("\n");
}

type CollectionProfile = {
  name: string;
  namePrefix: string;
  supply: number;
  first: number;
  schema: string;
  itemType: string;
  root: string;
  /** False when the profile declares no sale. It then has no reserve. */
  sale: boolean;
  reserveGroups: { trait_type: string; value: string; count: number }[];
  reserveExtra: number;
  reserveCount: number;
  /** Items per reveal. An operator setting with no default; `plan` asks for it. */
  batchSize?: number;
};

/** What the loader needs from the profile: how many items the zip holds. The inscriber numbers items from 1. */
function shapeOf(profile: CollectionProfile | null): MintShape {
  if (!profile) throw new Error("missing --collection");
  if (profile.first !== 1) throw new Error(`the reference inscriber numbers the items from 1, but the collection profile says first ${profile.first}`);
  return { supply: profile.supply };
}

function batchSizeOf(profile: CollectionProfile): number {
  if (profile.batchSize === undefined) throw new Error("the collection profile needs batchSize, the number of items in each reveal");
  return profile.batchSize;
}

/** The genesis and the batches of a mint, from the canonical zip. `plan` and `sign` both use this. */
function planContent(canonical: Awaited<ReturnType<typeof loadCanonical>>, batchSize: number, field5: Uint8Array): PlanContent {
  return {
    genesis: { body: canonical.collectionJson, leafList: canonical.leafList, field5 },
    batches: groupsOf(canonical.items, batchSize).map((group, index) => ({
      name: `batch-${index}`,
      items: canonical.items.slice(group.start, group.start + group.count).map((item, offset) => ({
        ...item,
        number: group.start + offset + 1,
      })),
    })),
  };
}

async function readProfile(flag: Record<string, string | boolean>, required: true): Promise<CollectionProfile>;
async function readProfile(flag: Record<string, string | boolean>, required: false): Promise<CollectionProfile | null>;
async function readProfile(flag: Record<string, string | boolean>, required: boolean): Promise<CollectionProfile | null> {
  if (typeof flag.collection !== "string") {
    if (required) throw new Error("missing --collection");
    return null;
  }
  if (!existsSync(flag.collection)) throw new Error(`missing collection profile ${flag.collection}`);
  const specifier = "../protocol/profile.mjs";
  const parsed = JSON.parse(readFileSync(flag.collection, "utf8")) as unknown;
  const loaded = await import(specifier) as { parseCollectionProfile: (value: unknown) => CollectionProfile };
  return loaded.parseCollectionProfile(parsed);
}

async function attributesOf(metadata: Uint8Array): Promise<{ trait_type: string; value: string }[]> {
  const decoded = decodeCbor(metadata) as { meta?: { attributes?: { trait_type: string; value: string }[] } };
  return decoded.meta?.attributes ?? [];
}

/** The sale secret of the keyfile. A keyfile made with `keygen --no-sale` has none. */
function saleSecretOf(secrets: { saleSecret: Uint8Array | null }): Uint8Array {
  if (!secrets.saleSecret) throw new Error("this keyfile has no sale secret (it was made with --no-sale), but the collection declares a sale");
  return secrets.saleSecret;
}

/** A collection with no sale has no reserve and no commitment. An assignment file that says otherwise is refused. */
function assertNoSaleAssignment(assignment: { reserve?: number[]; sale?: number[]; saleCommitment?: string }): void {
  if ((assignment.reserve?.length ?? 0) > 0 || (assignment.sale?.length ?? 0) > 0 || assignment.saleCommitment !== undefined) {
    throw new Error("the assignment has a reserve, sale ids, or a sale commitment, but the collection profile declares no sale");
  }
}

type FundingFile = { txid: string; vout: number; value: string; script: string };

/** `plan` and `sign` of one stand-alone P2MR Inscription. Offline. The files, not the plan, decide what is signed. */
async function runSingle(command: "plan" | "sign", flag: Record<string, string | boolean>): Promise<void> {
  const content = await readSingleContent(flag);
  const network = parseNetwork(typeof flag.network === "string" ? flag.network : undefined);
  const marker = parseMarker(typeof flag.marker === "string" ? flag.marker : undefined);
  assertMarkerForNetwork(marker, network);
  if (command === "plan") {
    const pubs = JSON.parse(readFileSync(text(flag, "pub"), "utf8")) as { issuerPublic: string; recoveryPublic: string };
    const utxo = JSON.parse(readFileSync(text(flag, "utxo"), "utf8")) as FundingFile;
    const plan = buildSinglePlan({
      network,
      marker,
      feeRate: Number(text(flag, "fee-rate")),
      issuerPublic: Buffer.from(pubs.issuerPublic, "hex"),
      recoveryPublic: Buffer.from(pubs.recoveryPublic, "hex"),
      creator: text(flag, "creator"),
      change: text(flag, "change"),
      utxo: { txid: utxo.txid, vout: utxo.vout, value: BigInt(utxo.value), script: Buffer.from(utxo.script, "hex") },
      inscription: content.single,
    });
    process.stdout.write(`${summary(plan, flag["show-marker"] === true)}\n`);
    if (flag["dry-run"]) return;
    writeFileSync(text(flag, "out"), `${JSON.stringify(plan)}\n`);
    return;
  }
  await init();
  const passphrase = await readPassphrase("Keyfile passphrase: ");
  const secrets = openKeyfile(text(flag, "key"), passphrase);
  passphrase.fill(0);
  try {
    const plan = JSON.parse(readFileSync(text(flag, "plan"), "utf8")) as MintPlan;
    if (secrets.issuerPublic !== plan.issuerPublic) throw new Error("keyfile does not match the plan");
    const utxo = JSON.parse(readFileSync(text(flag, "utxo"), "utf8")) as { txid?: unknown; vout?: unknown };
    if (typeof utxo.txid !== "string" || typeof utxo.vout !== "number") throw new Error("--utxo must be the funding file, with txid and vout");
    const signed = signPlan(plan, secrets.issuerSecret, new Set(), {
      fundingTxid: utxo.txid,
      fundingVout: utxo.vout,
      creator: text(flag, "creator"),
      sale: null,
      holder: null,
      change: text(flag, "change"),
    }, undefined, undefined, content);
    process.stdout.write(`${summary(signed, flag["show-marker"] === true)}\n`);
    if (flag["dry-run"]) return;
    writeFileSync(text(flag, "out"), `${JSON.stringify(signed)}\n`);
  } finally {
    zeroSecrets(secrets);
  }
}

/** The rows that ask the node about itself. A failed call fails all three rows. */
async function nodeRows(rpc: ReturnType<typeof httpRpc>, network: ReturnType<typeof parseNetwork>): Promise<Check[]> {
  try {
    const info = await rpc.call<{ chain: string; blocks: number; headers: number; initialblockdownload: boolean }>("getblockchaininfo");
    const version = await rpc.call<{ subversion: string }>("getnetworkinfo");
    return nodeChecks({ ...info, subversion: version.subversion }, network);
  } catch (error) {
    const message = error instanceof Error ? error.message : "node call failed";
    return [
      { name: "node chain", pass: false, detail: message },
      { name: "node synced", pass: false, detail: message },
      { name: "node version", pass: false, detail: message },
    ];
  }
}

/** The rows for the funding output, looked up on the node. */
async function fundingRows(rpc: ReturnType<typeof httpRpc>, utxo: FundingFile, signed: MintPlan): Promise<Check[]> {
  let found = false;
  let confirmations = 0;
  let valueBits: bigint | null = null;
  let scriptHex: string | null = null;
  try {
    const tx = await rpc.call<{ confirmations?: number; vout?: { value: number; scriptPubKey: { hex: string } }[] }>("getrawtransaction", [utxo.txid, true]);
    found = true;
    confirmations = tx.confirmations ?? 0;
    const output = tx.vout?.[utxo.vout];
    if (output) {
      valueBits = bitsFromQbt(output.value);
      scriptHex = output.scriptPubKey.hex;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!message.includes("No such")) return [{ name: "funding utxo", pass: false, detail: message || "lookup failed" }];
  }
  return fundingChecks({
    found,
    confirmations,
    valueBits,
    scriptHex,
    fileValueBits: BigInt(utxo.value),
    requiredBits: requiredBits(signed),
    expectedScriptHex: signed.fanout.spentScript,
  });
}

/** `preflight --single`: the node, the funding, the addresses, the fee, and the files against the signed plan. */
async function preflightSingle(flag: Record<string, string | boolean>): Promise<void> {
  const network = parseNetwork(typeof flag.network === "string" ? flag.network : undefined);
  assertBroadcastNetwork(network, typeof flag["confirm-network"] === "string" ? flag["confirm-network"] : undefined);
  const unsigned = JSON.parse(readFileSync(text(flag, "plan"), "utf8")) as MintPlan;
  const signed = JSON.parse(readFileSync(text(flag, "signed"), "utf8")) as MintPlan;
  const utxo = JSON.parse(readFileSync(text(flag, "utxo"), "utf8")) as FundingFile;
  const pubs = JSON.parse(readFileSync(text(flag, "pub"), "utf8")) as { issuerPublic: string };
  const content = await readSingleContent(flag);
  const checks: Check[] = [];
  const agree = signed.network === network && unsigned.network === network;
  checks.push({ name: "plan network", pass: agree, detail: agree ? network : `unsigned ${unsigned.network}, signed ${signed.network}, asked ${network}` });
  const rpc = httpRpc(text(flag, "rpc"), text(flag, "rpc-user"), text(flag, "rpc-password"));
  checks.push(...await nodeRows(rpc, network));
  const funding = fundingAddress(Buffer.from(pubs.issuerPublic, "hex"), network);
  checks.push(...addressChecks(network, signed.creator, null, signed.change, funding));
  checks.push(...await fundingRows(rpc, utxo, signed));
  checks.push(feeRateCheck(signed.feeRate));
  checks.push(...weightChecks(signed));
  checks.push(...signedBodyChecks(unsigned, signed));
  checks.push(...singleChecks(unsigned, signed, content, pubs.issuerPublic));
  process.stdout.write(formatReport(checks));
  if (!reportOk(checks)) process.exitCode = 1;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const flag = flags(rest);
  if (command === "sign" || command === "keygen" || command === "assign" || command === "address" || command === "price") {
    if (flag.rpc || flag["rpc-user"] || flag["rpc-password"]) throw new Error("this step is offline and refuses an RPC URL");
  }
  const single = assertSingleFlags(command, flag);
  if (single && command !== "preflight") {
    await runSingle(command as "plan" | "sign", flag);
    return;
  }
  if (command === "address") {
    const pubs = JSON.parse(readFileSync(text(flag, "pub"), "utf8")) as { issuerPublic: string };
    const network = parseNetwork(typeof flag.network === "string" ? flag.network : undefined);
    const address = fundingAddress(Buffer.from(pubs.issuerPublic, "hex"), network);
    process.stdout.write(`${network} funding address ${address}\nSend QBT to this address in one payment. The wallet cannot spend it. Do not use it as Reserve, Sale, Change, or Revenue.\n`);
    return;
  }
  if (command === "keygen") {
    await init();
    const passphrase = await readPassphrase("Keyfile passphrase: ");
    try {
      const created = createKeyfile(passphrase, undefined, flag["no-sale"] !== true);
      writeKeyfile(text(flag, "out"), created.body, { issuerPublic: created.secrets.issuerPublic, recoveryPublic: created.secrets.recoveryPublic });
      zeroSecrets(created.secrets);
      process.stdout.write("Wrote the encrypted keyfile and a public JSON file.\nKeep two encrypted copies in two places. Do not store the passphrase with them.\nRun the address command with the public JSON file to get the funding address.\n");
      if (flag["no-sale"] === true) process.stdout.write("This keyfile has no sale secret. Use it only for a collection that declares no sale.\n");
    } finally {
      passphrase.fill(0);
    }
    return;
  }
  if (command === "assign" || command === "plan" || command === "sign") {
    const profile = command === "sign" ? await readProfile(flag, false) : await readProfile(flag, true);
    // A rehearsal sign passes --assignment and no collection profile. It must
    // not need the collection zip. Every other path recomputes the root.
    // A plan that inscribes only a price has no item and no reserve. It is signed without the zip.
    const earlyPlan = command === "sign" && typeof flag.plan === "string" ? JSON.parse(readFileSync(flag.plan, "utf8")) as MintPlan : null;
    const priceField = profile && earlyPlan ? pricePlanField(earlyPlan) : null;
    const signWithoutZip = command === "sign" && (priceField !== null || (!profile && typeof flag.assignment === "string"));
    // `plan` splits the items into reveals of the declared size, and `sign` rebuilds them the same way.
    // Ask for the size before the zip is read.
    const batchSize = (command === "plan" || (command === "sign" && !signWithoutZip && profile)) ? batchSizeOf(profile as CollectionProfile) : 0;
    const canonical = signWithoutZip ? null : await loadCanonical(text(flag, "zip"), shapeOf(profile));
    const root = canonical
      ? merkleRoot(canonical.items.map((item, index) => leafPreimage(index + 1, item.body, item.metadata ?? new Uint8Array())))
      : "";
    if (profile && canonical) assertRoot(root, profile.root);
    if (command === "assign") {
      if (!canonical) throw new Error("missing --zip");
      if (profile && !profile.sale) {
        // No sale: nothing to draw and nothing to commit to, so no keyfile is read.
        if (flag.key !== undefined) throw new Error("the collection profile declares no sale, so assign takes no --key");
        writeFileSync(text(flag, "out"), `${JSON.stringify({ reserve: [], sale: [] }, null, 2)}\n`);
        process.stdout.write("The collection declares no sale. Wrote an empty assignment: no reserve, no sale ids, no sale commitment.\n");
        return;
      }
      await init();
      const passphrase = await readPassphrase("Keyfile passphrase: ");
      const secrets = openKeyfile(text(flag, "key"), passphrase);
      passphrase.fill(0);
      try {
        const reserveSpecifier = "../protocol/reserve.mjs";
        const reserve = await import(reserveSpecifier) as { selectReserve: (pieces: { id: number; attributes: { trait_type: string; value: string }[] }[], seed: Buffer, options: { groups: CollectionProfile["reserveGroups"]; extra: number }) => { reserve: number[]; sale: number[] } };
        const pieces = [];
        for (let i = 0; i < canonical.items.length; i += 1) {
          pieces.push({ id: i + 1, attributes: await attributesOf(canonical.items[i].metadata ?? new Uint8Array()) });
        }
        if (!profile) throw new Error("missing --collection");
        const saleSecret = saleSecretOf(secrets);
        const selected = reserve.selectReserve(pieces, Buffer.from(saleSecret), { groups: profile.reserveGroups, extra: profile.reserveExtra });
        const saleCommitment = createHash("sha256").update(saleSecret).digest("hex");
        writeFileSync(text(flag, "out"), `${JSON.stringify({ reserve: selected.reserve, sale: selected.sale, saleCommitment }, null, 2)}\n`);
        process.stdout.write(`Wrote ${selected.reserve.length} reserve ids and ${selected.sale.length} sale ids.\nWrote the sale commitment. The secret was not written.\n`);
      } finally {
        zeroSecrets(secrets);
      }
      return;
    }
    if (command === "plan") {
      if (!canonical) throw new Error("missing --zip");
      const pubs = JSON.parse(readFileSync(text(flag, "pub"), "utf8")) as { issuerPublic: string; recoveryPublic: string };
      const assignment = JSON.parse(readFileSync(text(flag, "assignment"), "utf8")) as { reserve: number[]; saleCommitment?: string };
      const utxo = JSON.parse(readFileSync(text(flag, "utxo"), "utf8")) as { txid: string; vout: number; value: string; script: string };
      const network = parseNetwork(typeof flag.network === "string" ? flag.network : undefined);
      const marker = parseMarker(typeof flag.marker === "string" ? flag.marker : undefined);
      assertMarkerForNetwork(marker, network);
      const noSale = Boolean(profile && !profile.sale);
      if (noSale) {
        if (flag.sale !== undefined) throw new Error("the collection profile declares no sale, so plan takes no --sale");
        assertNoSaleAssignment(assignment);
      } else if (profile) {
        // The profile declares the reserve size. An assignment of another size would fail at `sign`, so refuse it here.
        assertReserveSize(assignment.reserve, profile.reserveCount);
      }
      const plan = buildPlan({
        network,
        marker,
        feeRate: Number(text(flag, "fee-rate")),
        issuerPublic: Buffer.from(pubs.issuerPublic, "hex"),
        recoveryPublic: Buffer.from(pubs.recoveryPublic, "hex"),
        creator: text(flag, "creator"),
        sale: noSale ? null : text(flag, "sale"),
        holder: holderFlag(flag.holder, noSale, "plan"),
        change: text(flag, "change"),
        root,
        utxo: { txid: utxo.txid, vout: utxo.vout, value: BigInt(utxo.value), script: Buffer.from(utxo.script, "hex") },
        ...planContent(canonical, batchSize, await mainnetOrCollectionField(network, flag, pubs.issuerPublic, root, assignment.saleCommitment, profile)),
        reserve: new Set(assignment.reserve),
      });
      process.stdout.write(`${summary(plan, flag["show-marker"] === true)}\n`);
      if (flag["dry-run"]) return;
      writeFileSync(text(flag, "out"), `${JSON.stringify(plan)}\n`);
      return;
    }
    await init();
    const passphrase = await readPassphrase("Keyfile passphrase: ");
    const secrets = openKeyfile(text(flag, "key"), passphrase);
    passphrase.fill(0);
    try {
      const plan = earlyPlan ?? JSON.parse(readFileSync(text(flag, "plan"), "utf8")) as MintPlan;
      const noSale = plan.noSale === true;
      if (profile && profile.sale === noSale) throw new Error("the plan and the collection profile disagree about the sale");
      if (noSale && flag.sale !== undefined) throw new Error("this plan has no sale, so sign takes no --sale");
      let reserveIds: number[];
      let saleIds: number[] = [];
      const traitPieces: { id: number; attributes: { trait_type: string; value: string }[] }[] = [];
      if (canonical) {
        for (let i = 0; i < canonical.items.length; i += 1) {
          traitPieces.push({ id: i + 1, attributes: await attributesOf(canonical.items[i].metadata ?? new Uint8Array()) });
        }
      }
      if (priceField && profile) {
        // The reserve and the sale list belong to the mint, not to the price. What the price needs from the
        // assignment is the sale commitment, an independent record of the hash of this collection's secret.
        if (typeof flag.assignment !== "string") throw new Error("a price plan needs --assignment, the file from assign, to check the sale secret against its sale commitment");
        const recorded = JSON.parse(readFileSync(flag.assignment, "utf8")) as { saleCommitment?: string };
        const seed = Buffer.from(saleSecretOf(secrets));
        try {
          const failed = priceSigningChecks({ seed, commitment: recorded.saleCommitment, field: priceField, collectionSchema: profile.schema }).filter((check) => !check.pass);
          if (failed.length) throw new Error(failed.map((check) => `${check.name}: ${check.detail}`).join("; "));
        } finally {
          seed.fill(0);
        }
        reserveIds = [];
      } else if (noSale) {
        if (typeof flag.assignment === "string") assertNoSaleAssignment(JSON.parse(readFileSync(flag.assignment, "utf8")) as { reserve?: number[]; sale?: number[]; saleCommitment?: string });
        reserveIds = [];
      } else if (typeof flag.assignment === "string") {
        const parsed = JSON.parse(readFileSync(flag.assignment, "utf8")) as { reserve: number[]; sale?: number[] };
        reserveIds = parsed.reserve;
        saleIds = parsed.sale ?? [];
      } else {
        const reserveSpecifier = "../protocol/reserve.mjs";
        const reserve = await import(reserveSpecifier) as { selectReserve: (pieces: { id: number; attributes: { trait_type: string; value: string }[] }[], seed: Buffer, options: { groups: CollectionProfile["reserveGroups"]; extra: number }) => { reserve: number[]; sale: number[] } };
        if (!canonical) throw new Error("missing --zip");
        if (!profile) throw new Error("missing --collection");
        const selected = reserve.selectReserve(traitPieces, Buffer.from(saleSecretOf(secrets)), { groups: profile.reserveGroups, extra: profile.reserveExtra });
        reserveIds = selected.reserve;
        saleIds = selected.sale;
      }
      // The indexer repeats this selection after the seed is revealed. Refuse to
      // sign a reserve it would not reproduce. Rehearsal plans have no zip; their
      // builders already ran the same check.
      if (canonical && profile && !noSale) {
        const genesisReveal = plan.reveals.find((reveal) => reveal.name === "genesis");
        const field = genesisReveal ? genesisFieldFromLeaf(genesisReveal.leaf, plan.marker) : null;
        const seed = Buffer.from(saleSecretOf(secrets));
        try {
          const reproduction = await reserveReproductionChecks({
            seed,
            pieces: traitPieces,
            reserve: reserveIds,
            sale: saleIds,
            field,
            profile,
          });
          const failed = reproduction.filter((check) => !check.pass);
          if (failed.length) throw new Error(failed.map((check) => `${check.name}: ${check.detail}`).join("; "));
        } finally {
          seed.fill(0);
        }
      }
      if (secrets.issuerPublic !== plan.issuerPublic) throw new Error("keyfile does not match the plan");
      const utxo = JSON.parse(readFileSync(text(flag, "utxo"), "utf8")) as { txid?: unknown; vout?: unknown };
      if (typeof utxo.txid !== "string" || typeof utxo.vout !== "number") throw new Error("--utxo must be the funding file, with txid and vout");
      // Rebuild the genesis and every batch from the zip, with the issuer key and the sale commitment taken
      // from the keyfile, not from the plan. A price plan has no zip: `signPlan` rebuilds it from its own
      // price record, which was checked against the assignment above.
      const content = canonical && profile && !priceField
        ? planContent(canonical, batchSize, await mainnetOrCollectionField(
          plan.network,
          flag,
          secrets.issuerPublic,
          root,
          noSale ? undefined : createHash("sha256").update(saleSecretOf(secrets)).digest("hex"),
          profile,
        ))
        : undefined;
      const signed = signPlan(plan, secrets.issuerSecret, new Set(reserveIds), {
        fundingTxid: utxo.txid,
        fundingVout: utxo.vout,
        creator: text(flag, "creator"),
        sale: noSale ? null : text(flag, "sale"),
        holder: holderFlag(flag.holder, noSale, "sign") ?? null,
        change: text(flag, "change"),
      }, profile?.root, priceField ? 0 : profile?.reserveCount, content);
      process.stdout.write(`${summary(signed, flag["show-marker"] === true)}\n`);
      if (flag["dry-run"]) return;
      writeFileSync(text(flag, "out"), `${JSON.stringify(signed)}\n`);
    } finally {
      zeroSecrets(secrets);
    }
    return;
  }
  if (command === "broadcast") {
    const plan = JSON.parse(readFileSync(text(flag, "plan"), "utf8")) as MintPlan;
    const network = parseNetwork(typeof flag.network === "string" ? flag.network : plan.network);
    assertBroadcastNetwork(network, typeof flag["confirm-network"] === "string" ? flag["confirm-network"] : undefined);
    const rpc = httpRpc(text(flag, "rpc"), text(flag, "rpc-user"), text(flag, "rpc-password"));
    if (flag["confirm-timeout"] === true) throw new Error("--confirm-timeout needs a number of seconds");
    const confirmTimeoutSeconds = typeof flag["confirm-timeout"] === "string" ? Number(flag["confirm-timeout"]) : undefined;
    const result = await broadcastPlan(plan, rpc, {
      network,
      typed: typeof flag["confirm-network"] === "string" ? flag["confirm-network"] : undefined,
      mine: flag.mine === true,
      confirmTimeoutSeconds,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "preflight" && single) {
    await preflightSingle(flag);
    return;
  }
  if (command === "preflight") {
    const network = parseNetwork(typeof flag.network === "string" ? flag.network : undefined);
    assertBroadcastNetwork(network, typeof flag["confirm-network"] === "string" ? flag["confirm-network"] : undefined);
    const unsigned = JSON.parse(readFileSync(text(flag, "plan"), "utf8")) as MintPlan;
    const signed = JSON.parse(readFileSync(text(flag, "signed"), "utf8")) as MintPlan;
    const assignment = JSON.parse(readFileSync(text(flag, "assignment"), "utf8")) as { reserve: number[]; sale?: number[] };
    const utxo = JSON.parse(readFileSync(text(flag, "utxo"), "utf8")) as { txid: string; vout: number; value: string; script: string };
    const pubs = JSON.parse(readFileSync(text(flag, "pub"), "utf8")) as { issuerPublic: string };
    const profile = await readProfile(flag, true);
    const canonical = await loadCanonical(text(flag, "zip"), shapeOf(profile));
    const leaves = canonical.items.map((item, index) => leafPreimage(index + 1, item.body, item.metadata ?? new Uint8Array()));
    const root = merkleRoot(leaves);
    const pieces = [];
    for (let i = 0; i < canonical.items.length; i += 1) {
      pieces.push({ id: i + 1, attributes: await attributesOf(canonical.items[i].metadata ?? new Uint8Array()) });
    }
    const checks = [];
    if (signed.network !== network || unsigned.network !== network) {
      checks.push({ name: "plan network", pass: false, detail: `unsigned ${unsigned.network}, signed ${signed.network}, asked ${network}` });
    } else {
      checks.push({ name: "plan network", pass: true, detail: network });
    }
    const rpc = httpRpc(text(flag, "rpc"), text(flag, "rpc-user"), text(flag, "rpc-password"));
    checks.push(...await nodeRows(rpc, network));
    checks.push(rootCheck(root, profile.root));
    checks.push(...quotaChecks(assignment.reserve, pieces, profile.reserveGroups, profile.reserveExtra));
    const funding = fundingAddress(Buffer.from(pubs.issuerPublic, "hex"), network);
    const noSale = !profile.sale;
    if (noSale || signed.noSale === true) {
      const agree = noSale === (signed.noSale === true);
      checks.push({
        name: "sale declaration",
        pass: agree,
        detail: agree ? "the profile and the plan declare no sale" : "the plan and the collection profile disagree about the sale",
      });
    }
    checks.push(...addressChecks(network, signed.creator, signed.noSale ? null : signed.sale, signed.change, funding, signed.holder));
    checks.push(...await fundingRows(rpc, utxo, signed));
    checks.push(feeRateCheck(signed.feeRate));
    checks.push(...weightChecks(signed));
    checks.push(...signedBodyChecks(unsigned, signed));
    const genesis = signed.reveals.find((reveal) => reveal.name === "genesis");
    const field = genesis ? genesisFieldFromLeaf(genesis.leaf, signed.marker) : null;
    checks.push(...genesisChecks(field, {
      schema: profile.schema,
      name: profile.name,
      supply: profile.supply,
      first: profile.first,
      namePrefix: profile.namePrefix,
      itemType: profile.itemType,
      root: profile.root,
      sale: profile.sale,
    }));
    // Same selection the indexer runs at seed reveal. The sale secret is read
    // and wiped. Without --key the rows fail, so a mismatch cannot be skipped.
    if (noSale) {
      // Nothing to reproduce: no sale secret, no reserve, no sale list. The rows above and the quota rows cover it.
    } else if (typeof flag.key !== "string") {
      checks.push({ name: "seed hash", pass: false, detail: "pass --key so preflight can hash the sale secret" });
      checks.push({ name: "reserve reproduction", pass: false, detail: "sale secret was not provided" });
      checks.push({ name: "sale complement", pass: false, detail: "sale secret was not provided" });
    } else {
      const passphrase = await readPassphrase("Keyfile passphrase: ");
      const secrets = openKeyfile(flag.key, passphrase);
      passphrase.fill(0);
      const seed = Buffer.from(saleSecretOf(secrets));
      try {
        if (secrets.issuerPublic !== pubs.issuerPublic) throw new Error("keyfile does not match the public file");
        checks.push(...await reserveReproductionChecks({
          seed,
          pieces,
          reserve: assignment.reserve,
          sale: assignment.sale ?? [],
          field,
          profile,
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : "reserve reproduction failed";
        checks.push({ name: "reserve reproduction", pass: false, detail: message });
      } finally {
        seed.fill(0);
        zeroSecrets(secrets);
      }
    }
    process.stdout.write(formatReport(checks));
    if (!reportOk(checks)) process.exitCode = 1;
    return;
  }
  if (command === "price") {
    const pubs = JSON.parse(readFileSync(text(flag, "pub"), "utf8")) as { issuerPublic: string; recoveryPublic: string };
    const utxo = JSON.parse(readFileSync(text(flag, "utxo"), "utf8")) as { txid: string; vout: number; value: string; script: string };
    const network = parseNetwork(typeof flag.network === "string" ? flag.network : undefined);
    if (flag.schema === true) throw new Error("missing --schema");
    // Same mask the indexer takes. Omitted means the launch collection schema,
    // which derives the launch price text. Mainnet refuses any other schema.
    const collectionSchema = typeof flag.schema === "string" ? flag.schema : LAUNCH_COLLECTION_SCHEMA;
    if (network === "mainnet" && collectionSchema !== LAUNCH_COLLECTION_SCHEMA) {
      throw new Error("mainnet refuses a rehearsal schema");
    }
    const schema = priceSchemaFor(collectionSchema);
    if (network === "mainnet" && schema !== LAUNCH_PRICE_SCHEMA) {
      throw new Error("mainnet refuses a rehearsal price schema");
    }
    const price = parsePrice(JSON.parse(readFileSync(text(flag, "price"), "utf8")));
    const genesis = text(flag, "genesis");
    if (!/^[0-9a-f]{64}i[0-9]+$/.test(genesis)) throw new Error("--genesis must be a P2MR Inscription id");
    const profile = await readProfile(flag, false);
    // A price opens a sale (PINS-6 §5.1). A collection that declares no sale has none to open.
    if (profile && !profile.sale) throw new Error("the collection profile declares no sale, so there is no price P2MR Inscription to build");
    const root = profile?.root ?? text(flag, "root");
    if (!/^[0-9a-f]{64}$/.test(root)) throw new Error("--root must be 64 hex characters");
    const field5 = await encodePriceField({ genesis, price, schema });
    const plan = buildPlan({
      network,
      marker: parseMarker(typeof flag.marker === "string" ? flag.marker : undefined),
      feeRate: Number(text(flag, "fee-rate")),
      issuerPublic: Buffer.from(pubs.issuerPublic, "hex"),
      recoveryPublic: Buffer.from(pubs.recoveryPublic, "hex"),
      creator: text(flag, "creator"),
      sale: text(flag, "sale"),
      change: text(flag, "change"),
      root,
      utxo: { txid: utxo.txid, vout: utxo.vout, value: BigInt(utxo.value), script: Buffer.from(utxo.script, "hex") },
      genesis: { body: priceBody(schema), leafList: new Uint8Array(), field5, bodyType: "text/plain" },
      batches: [],
      reserve: new Set(),
    });
    process.stdout.write(`${summary(plan, flag["show-marker"] === true)}\nprice schema ${schema}\n`);
    if (flag["dry-run"]) return;
    writeFileSync(text(flag, "out"), `${JSON.stringify(plan)}\n`);
    process.stdout.write("Wrote the price plan. It is not a mint. Sign it, then broadcast it when the sale opens. The first confirmed valid price P2MR Inscription is the one indexers keep.\n");
    return;
  }
  throw new Error("commands: keygen, address, assign, plan, sign, broadcast, preflight, price");
}

async function mainnetOrCollectionField(
  network: ReturnType<typeof parseNetwork>,
  flag: Record<string, string | boolean>,
  issuer: string,
  root: string,
  saleCommitment: string | undefined,
  profile: CollectionProfile | null,
): Promise<Uint8Array> {
  if (!profile) throw new Error("missing --collection");
  if (!profile.sale) {
    // The genesis of a collection with no sale has the eight base keys, on every network.
    if (saleCommitment !== undefined) throw new Error("the collection profile declares no sale, but the assignment has a saleCommitment");
    return encodeGenesisField({
      schema: profile.schema,
      name: profile.name,
      supply: profile.supply,
      first: profile.first,
      namePrefix: profile.namePrefix,
      itemType: profile.itemType,
      root,
      issuer,
    });
  }
  if (network === "mainnet") {
    if (!saleCommitment || !/^[0-9a-f]{64}$/.test(saleCommitment)) throw new Error("assignment is missing saleCommitment; run assign again");
    return encodeGenesisField({
      schema: profile.schema,
      name: profile.name,
      supply: profile.supply,
      first: profile.first,
      namePrefix: profile.namePrefix,
      itemType: profile.itemType,
      root,
      issuer,
      saleCommitment,
    });
  }
  const specifier = "../collection/canonical.mjs";
  const canonical = await import(specifier) as { encodeCbor: (value: unknown) => Uint8Array };
  return canonical.encodeCbor({
    schema: profile.schema,
    name: profile.name,
    supply: profile.supply,
    first: profile.first,
    name_prefix: profile.namePrefix,
    root,
    issuer,
    item_type: profile.itemType,
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "mint command failed";
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
