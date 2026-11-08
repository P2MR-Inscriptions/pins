// SPDX-License-Identifier: Apache-2.0

/**
 * Mint CLI. `plan` and `broadcast` may use a regtest node. `sign` and `keygen`
 * must not be given an RPC URL. The default network is regtest.
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
  parsePrice,
  quotaChecks,
  reserveReproductionChecks,
  reportOk,
  requiredBits,
  rootCheck,
  signedBodyChecks,
  weightChecks,
} from "./preflight.ts";
import { createKeyfile, openKeyfile, readPassphrase, writeKeyfile, zeroSecrets } from "./keyfile.ts";
import { assertBroadcastNetwork, parseNetwork } from "./network.ts";
import { buildPlan, type MintPlan } from "./plan.ts";
import { signPlan } from "./sign.ts";
import { assertRoot, merkleRoot, leafPreimage } from "./verify.ts";
import { loadCanonical } from "../../scripts/canonical-batch.ts";

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
    `sale holding ${plan.sale}`,
    `change ${plan.change}`,
    formatMarkerLine(plan.marker, showMarker),
  ];
  return lines.join("\n");
}

type CollectionProfile = {
  name: string;
  namePrefix: string;
  supply: number;
  first: number;
  schema: string;
  itemType: string;
  root: string;
  reserveGroups: { trait_type: string; value: string; count: number }[];
  reserveExtra: number;
  reserveCount: number;
};

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

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const flag = flags(rest);
  if (command === "sign" || command === "keygen" || command === "assign" || command === "address" || command === "price") {
    if (flag.rpc || flag["rpc-user"] || flag["rpc-password"]) throw new Error("this step is offline and refuses an RPC URL");
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
      const created = createKeyfile(passphrase);
      writeKeyfile(text(flag, "out"), created.body, { issuerPublic: created.secrets.issuerPublic, recoveryPublic: created.secrets.recoveryPublic });
      zeroSecrets(created.secrets);
      process.stdout.write("Wrote the encrypted keyfile and a public JSON file.\nKeep two encrypted copies in two places. Do not store the passphrase with them.\nRun the address command with the public JSON file to get the funding address.\n");
    } finally {
      passphrase.fill(0);
    }
    return;
  }
  if (command === "assign" || command === "plan" || command === "sign") {
    const profile = command === "sign" ? await readProfile(flag, false) : await readProfile(flag, true);
    // A rehearsal sign passes --assignment and no collection profile. It must
    // not need the collection zip. Every other path recomputes the root.
    const signWithoutZip = command === "sign" && !profile && typeof flag.assignment === "string";
    const canonical = signWithoutZip ? null : await loadCanonical(text(flag, "zip"));
    const root = canonical
      ? merkleRoot(canonical.items.map((item, index) => leafPreimage(index + 1, item.body, item.metadata ?? new Uint8Array())))
      : "";
    if (profile && canonical) assertRoot(root, profile.root);
    if (command === "assign") {
      if (!canonical) throw new Error("missing --zip");
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
        const selected = reserve.selectReserve(pieces, Buffer.from(secrets.saleSecret), { groups: profile.reserveGroups, extra: profile.reserveExtra });
        const saleCommitment = createHash("sha256").update(secrets.saleSecret).digest("hex");
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
      const plan = buildPlan({
        network,
        marker,
        feeRate: Number(text(flag, "fee-rate")),
        issuerPublic: Buffer.from(pubs.issuerPublic, "hex"),
        recoveryPublic: Buffer.from(pubs.recoveryPublic, "hex"),
        creator: text(flag, "creator"),
        sale: text(flag, "sale"),
        change: text(flag, "change"),
        root,
        utxo: { txid: utxo.txid, vout: utxo.vout, value: BigInt(utxo.value), script: Buffer.from(utxo.script, "hex") },
        genesis: { body: canonical.collectionJson, leafList: canonical.leafList, field5: await mainnetOrCollectionField(network, flag, pubs.issuerPublic, root, assignment.saleCommitment, profile) },
        batches: canonical.groupsOf625.map((group, index) => ({
          name: `batch-${index}`,
          items: canonical.items.slice(group.start, group.start + group.count).map((item, offset) => ({
            ...item,
            number: group.start + offset + 1,
          })),
        })),
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
      const plan = JSON.parse(readFileSync(text(flag, "plan"), "utf8")) as MintPlan;
      let reserveIds: number[];
      let saleIds: number[] = [];
      const traitPieces: { id: number; attributes: { trait_type: string; value: string }[] }[] = [];
      if (canonical) {
        for (let i = 0; i < canonical.items.length; i += 1) {
          traitPieces.push({ id: i + 1, attributes: await attributesOf(canonical.items[i].metadata ?? new Uint8Array()) });
        }
      }
      if (typeof flag.assignment === "string") {
        const parsed = JSON.parse(readFileSync(flag.assignment, "utf8")) as { reserve: number[]; sale?: number[] };
        reserveIds = parsed.reserve;
        saleIds = parsed.sale ?? [];
      } else {
        const reserveSpecifier = "../protocol/reserve.mjs";
        const reserve = await import(reserveSpecifier) as { selectReserve: (pieces: { id: number; attributes: { trait_type: string; value: string }[] }[], seed: Buffer, options: { groups: CollectionProfile["reserveGroups"]; extra: number }) => { reserve: number[]; sale: number[] } };
        if (!canonical) throw new Error("missing --zip");
        if (!profile) throw new Error("missing --collection");
        const selected = reserve.selectReserve(traitPieces, Buffer.from(secrets.saleSecret), { groups: profile.reserveGroups, extra: profile.reserveExtra });
        reserveIds = selected.reserve;
        saleIds = selected.sale;
      }
      // The indexer repeats this selection after the seed is revealed. Refuse to
      // sign a reserve it would not reproduce. Rehearsal plans have no zip; their
      // builders already ran the same check.
      if (canonical && profile) {
        const genesisReveal = plan.reveals.find((reveal) => reveal.name === "genesis");
        const field = genesisReveal ? genesisFieldFromLeaf(genesisReveal.leaf, plan.marker) : null;
        const seed = Buffer.from(secrets.saleSecret);
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
      const signed = signPlan(plan, secrets.issuerSecret, new Set(reserveIds), {
        fundingTxid: utxo.txid,
        fundingVout: utxo.vout,
        creator: text(flag, "creator"),
        sale: text(flag, "sale"),
        change: text(flag, "change"),
      }, profile?.root, profile?.reserveCount);
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
  if (command === "preflight") {
    const network = parseNetwork(typeof flag.network === "string" ? flag.network : undefined);
    assertBroadcastNetwork(network, typeof flag["confirm-network"] === "string" ? flag["confirm-network"] : undefined);
    const unsigned = JSON.parse(readFileSync(text(flag, "plan"), "utf8")) as MintPlan;
    const signed = JSON.parse(readFileSync(text(flag, "signed"), "utf8")) as MintPlan;
    const assignment = JSON.parse(readFileSync(text(flag, "assignment"), "utf8")) as { reserve: number[]; sale?: number[] };
    const utxo = JSON.parse(readFileSync(text(flag, "utxo"), "utf8")) as { txid: string; vout: number; value: string; script: string };
    const pubs = JSON.parse(readFileSync(text(flag, "pub"), "utf8")) as { issuerPublic: string };
    const profile = await readProfile(flag, true);
    const canonical = await loadCanonical(text(flag, "zip"));
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
    try {
      const info = await rpc.call<{ chain: string; blocks: number; headers: number; initialblockdownload: boolean }>("getblockchaininfo");
      const version = await rpc.call<{ subversion: string }>("getnetworkinfo");
      checks.push(...nodeChecks({ ...info, subversion: version.subversion }, network));
    } catch (error) {
      const message = error instanceof Error ? error.message : "node call failed";
      checks.push({ name: "node chain", pass: false, detail: message });
      checks.push({ name: "node synced", pass: false, detail: message });
      checks.push({ name: "node version", pass: false, detail: message });
    }
    checks.push(rootCheck(root, profile.root));
    checks.push(...quotaChecks(assignment.reserve, pieces, profile.reserveGroups, profile.reserveExtra));
    const funding = fundingAddress(Buffer.from(pubs.issuerPublic, "hex"), network);
    checks.push(...addressChecks(network, signed.creator, signed.sale, signed.change, funding));
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
      if (!message.includes("No such")) {
        checks.push({ name: "funding utxo", pass: false, detail: message || "lookup failed" });
      }
    }
    if (!checks.some((check) => check.name === "funding utxo")) {
      checks.push(...fundingChecks({
        found,
        confirmations,
        valueBits,
        scriptHex,
        fileValueBits: BigInt(utxo.value),
        requiredBits: requiredBits(signed),
        expectedScriptHex: signed.fanout.spentScript,
      }));
    }
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
    }));
    // Same selection the indexer runs at seed reveal. The sale secret is read
    // and wiped. Without --key the rows fail, so a mismatch cannot be skipped.
    if (typeof flag.key !== "string") {
      checks.push({ name: "seed hash", pass: false, detail: "pass --key so preflight can hash the sale secret" });
      checks.push({ name: "reserve reproduction", pass: false, detail: "sale secret was not provided" });
      checks.push({ name: "sale complement", pass: false, detail: "sale secret was not provided" });
    } else {
      const passphrase = await readPassphrase("Keyfile passphrase: ");
      const secrets = openKeyfile(flag.key, passphrase);
      passphrase.fill(0);
      const seed = Buffer.from(secrets.saleSecret);
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
    if (!/^[0-9a-f]{64}i[0-9]+$/.test(genesis)) throw new Error("--genesis must be an inscription id");
    const profile = await readProfile(flag, false);
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
    process.stdout.write("Wrote the price plan. It is not a mint. Sign it, then broadcast it when the sale opens. The first confirmed valid price inscription is the one indexers keep.\n");
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
