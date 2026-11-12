// SPDX-License-Identifier: Apache-2.0

/**
 * Build the unsigned mint. One fan-out pays 17 commit outputs. After that
 * fan-out is confirmed, the 17 reveals are independent. This step does not
 * hold a secret key and does not broadcast.
 */
import { createHash } from "node:crypto";
import { addressToScriptPubKey, buildControlBlock, p2mrAddressFromRoot, p2mrLeafHash, p2mrScriptPubKey, P2MR_LEAF_VERSION_V1, type P2mrTransaction } from "@qbit-oss/protocol";
import { commitTree, itemsLeaf, rawWitnessTransaction, recoveryFor, POSTAGE, type RevealItem } from "./reveal.ts";
import { revealWeight } from "./weight.ts";
import { assertMarkerForNetwork, markerHex, PINS_MARKER } from "./marker.ts";
import { assertPostage, assertRevealWeight, assertSeparateChange } from "./verify.ts";
import type { MintNetwork } from "./network.ts";

export type Utxo = { txid: string; vout: number; value: bigint; script: Uint8Array };

export type PlanOutput = { item: number | null; address: string; value: string };

export type RevealPlan = {
  name: string;
  txid: string;
  weight: number;
  fee: string;
  commitValue: string;
  commitAddress: string;
  leaf: string;
  control: string;
  spentScript: string;
  raw: string;
  outputs: PlanOutput[];
};

export type MintPlan = {
  version: 1;
  network: MintNetwork;
  feeRate: number;
  issuerPublic: string;
  recoveryPublic: string;
  creator: string;
  /** Holding address of the sale items. For a plan with no sale it is `creator`, and `noSale` is true. */
  sale: string;
  /** Present, and true, only in a plan for a collection with no sale: every item goes to `creator`. */
  noSale?: true;
  /** Plain mint change. Not Reserve, not Sale, and not Revenue. */
  change: string;
  /** Envelope marker, 8 hex characters. Launch value is 70696e73 (`pins`). */
  marker: string;
  root: string;
  fanout: { raw: string; txid: string; fee: string; spentValue: string; spentScript: string; leaf: string; control: string };
  reveals: RevealPlan[];
  signed: boolean;
};

function txidOf(raw: Uint8Array): string {
  const hash = createHash("sha256").update(createHash("sha256").update(raw).digest()).digest();
  return Buffer.from(hash).reverse().toString("hex");
}

function feeFor(bytes: number, rate: number): bigint {
  return BigInt(Math.ceil(bytes * rate));
}

function hex(raw: Uint8Array): string {
  return Buffer.from(raw).toString("hex");
}

function internalTxid(display: string): Uint8Array {
  return Uint8Array.from(Buffer.from(display, "hex").reverse());
}

export function buildPlan(input: {
  network: MintNetwork;
  feeRate: number;
  issuerPublic: Uint8Array;
  recoveryPublic: Uint8Array;
  creator: string;
  /** `null` for a collection with no sale. Every item then goes to `creator` and `reserve` must be empty. */
  sale: string | null;
  change: string;
  root: string;
  utxo: Utxo;
  /** Omitted means `pins`. Mainnet refuses any other value. */
  marker?: Uint8Array;
  genesis: { body: Uint8Array; leafList: Uint8Array; field5?: Uint8Array; bodyType?: string };
  batches: { name: string; items: (RevealItem & { number: number })[] }[];
  reserve: Set<number>;
}): MintPlan {
  if (!Number.isFinite(input.feeRate) || input.feeRate <= 0) throw new Error("fee rate must be a positive finite number");
  assertSeparateChange(input.creator, input.sale, input.change);
  if (input.sale === null && input.reserve.size > 0) throw new Error("a collection with no sale has no reserve");
  const marker = input.marker ?? PINS_MARKER;
  assertMarkerForNetwork(marker, input.network);
  const fundingLeaf = recoveryFor(input.issuerPublic);
  const fundingScript = p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, fundingLeaf));
  if (Buffer.from(fundingScript).toString("hex") !== Buffer.from(input.utxo.script).toString("hex")) {
    throw new Error("funding utxo is not spent by the issuer key");
  }
  const recovery = recoveryFor(input.recoveryPublic);
  const changeScript = addressToScriptPubKey(input.change, input.network);
  const reveals: { name: string; script: Uint8Array; tree: ReturnType<typeof commitTree>; outputs: { value: bigint; scriptPubKey: Uint8Array; plan: PlanOutput }[]; fee: bigint }[] = [];
  const groups = [
    {
      name: "genesis",
      items: [
        { number: null, body: input.genesis.body, contentType: input.genesis.bodyType ?? "application/json", metadata: input.genesis.field5 },
        ...(input.genesis.leafList.length
          ? [{ number: null, body: input.genesis.leafList, contentType: "application/octet-stream" }]
          : []),
      ] as { number: number | null; body: Uint8Array; contentType: string; metadata?: Uint8Array }[],
    },
    ...input.batches.map((batch) => ({ name: batch.name, items: batch.items })),
  ];
  for (const group of groups) {
    const script = itemsLeaf(input.issuerPublic, group.items.map((item) => ({
      body: item.body,
      contentType: item.contentType,
      metadata: "metadata" in item ? item.metadata : undefined,
    })), undefined, undefined, marker);
    const tree = commitTree(script, recovery);
    const outputs = group.items.map((item) => {
      const address = item.number !== null && input.reserve.has(item.number) ? input.creator : item.number === null ? input.creator : (input.sale ?? input.creator);
      assertPostage(POSTAGE, `${group.name} item ${item.number ?? "genesis"}`);
      return {
        value: POSTAGE,
        scriptPubKey: addressToScriptPubKey(address, input.network),
        plan: { item: item.number, address, value: POSTAGE.toString() },
      };
    });
    outputs.push({ value: POSTAGE, scriptPubKey: changeScript, plan: { item: null, address: input.change, value: POSTAGE.toString() } });
    const weight = revealWeight(script.length, group.items.length);
    assertRevealWeight(weight, group.name);
    const fee = feeFor(weight, input.feeRate);
    reveals.push({ name: group.name, script, tree, outputs, fee });
  }
  const commitValues = reveals.map((reveal) => POSTAGE * BigInt(reveal.outputs.length) + reveal.fee);
  const fanoutBody = fanoutTransaction(input, commitValues, reveals.map((reveal) => p2mrAddressFromRoot(reveal.tree.root, input.network)));
  const fanoutTxid = txidOf(fanoutBody.raw);
  const planned: RevealPlan[] = reveals.map((reveal, index) => {
    const tx: P2mrTransaction = {
      version: 2,
      locktime: 0,
      inputs: [{ prevout: { txid: internalTxid(fanoutTxid), vout: index }, sequence: 0xfffffffe }],
      outputs: reveal.outputs.map((output) => ({ value: output.value, scriptPubKey: output.scriptPubKey })),
    };
    const raw = rawWitnessTransaction(tx, [[]]);
    return {
      name: reveal.name,
      txid: txidOf(raw),
      weight: revealWeight(reveal.script.length, reveal.outputs.length - 1),
      fee: reveal.fee.toString(),
      commitValue: commitValues[index].toString(),
      commitAddress: p2mrAddressFromRoot(reveal.tree.root, input.network),
      leaf: hex(reveal.script),
      control: hex(reveal.tree.revealControl),
      spentScript: hex(p2mrScriptPubKey(reveal.tree.root)),
      raw: hex(raw),
      outputs: reveal.outputs.map((output) => output.plan),
    };
  });
  const spent = commitValues.reduce((sum, value) => sum + value, 0n) + BigInt(fanoutBody.fee);
  if (spent > input.utxo.value) throw new Error(`funding utxo holds ${input.utxo.value} bits, plan spends ${spent}`);
  return {
    version: 1,
    network: input.network,
    feeRate: input.feeRate,
    issuerPublic: Buffer.from(input.issuerPublic).toString("hex"),
    recoveryPublic: Buffer.from(input.recoveryPublic).toString("hex"),
    creator: input.creator,
    sale: input.sale ?? input.creator,
    ...(input.sale === null ? { noSale: true as const } : {}),
    change: input.change,
    marker: markerHex(marker),
    root: input.root,
    fanout: {
      raw: hex(fanoutBody.raw),
      txid: fanoutTxid,
      fee: String(fanoutBody.fee),
      spentValue: input.utxo.value.toString(),
      spentScript: hex(input.utxo.script),
      leaf: hex(recoveryFor(input.issuerPublic)),
      control: hex(buildControlBlock(P2MR_LEAF_VERSION_V1, [])),
    },
    reveals: planned,
    signed: false,
  };
}

function fanoutTransaction(input: { network: MintNetwork; feeRate: number; utxo: Utxo; change: string }, values: bigint[], addresses: string[]): { raw: Uint8Array; fee: number } {
  const outputs = addresses.map((address, index) => ({ value: values[index], scriptPubKey: addressToScriptPubKey(address, input.network) }));
  const total = values.reduce((sum, value) => sum + value, 0n);
  const draft = rawWitnessTransaction({
    version: 2,
    locktime: 0,
    inputs: [{ prevout: { txid: internalTxid(input.utxo.txid), vout: input.utxo.vout }, sequence: 0xfffffffe }],
    outputs: [...outputs, { value: 10_000n, scriptPubKey: addressToScriptPubKey(input.change, input.network) }],
  }, [[]]);
  // One PQC signature, a short leaf, and a depth-0 control block are added at signing.
  const fee = feeFor(draft.length + 3_800, input.feeRate);
  const change = input.utxo.value - total - fee;
  if (change < 0n) throw new Error("funding utxo cannot cover the fan-out");
  const tx: P2mrTransaction = {
    version: 2,
    locktime: 0,
    inputs: [{ prevout: { txid: internalTxid(input.utxo.txid), vout: input.utxo.vout }, sequence: 0xfffffffe }],
    outputs: [...outputs, { value: change, scriptPubKey: addressToScriptPubKey(input.change, input.network) }],
  };
  return { raw: rawWitnessTransaction(tx, [[]]), fee: Number(fee) };
}
