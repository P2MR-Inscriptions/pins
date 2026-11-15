// SPDX-License-Identifier: Apache-2.0

/**
 * The checks `preflight --record` runs on the signed plan of a record P2MR Inscription (PINS-5 sections 7 and 8.5).
 * They read the plan and the collection files, never a node: the node rows are the ones every preflight has.
 */
import { parseMarker } from "./marker.ts";
import type { MintNetwork } from "./network.ts";
import { groupLeaf, revealGroups, type MintPlan } from "./plan.ts";
import { fieldBytesFromLeaf, type Check } from "./preflight.ts";
import { parseRecord, recordInputOf, recordInscription, saleCommitmentOf, schemaOf, unsoldAddressScript, type ParsedRecord, type RecordKind } from "./records.ts";

export type RecordCheckInput = {
  kind: RecordKind;
  signed: MintPlan;
  issuerPublicHex: string;
  network: MintNetwork;
  /** The genesis root of the collection profile. */
  root: string;
  /** The supply of the collection profile. */
  supply: number;
  /** The sale commitment the assignment recorded, for a sale reveal. */
  saleCommitment?: string;
  /** The funding address of the issuer key. */
  funding: string;
};

/** The record in the plan's own reveal leaf, or null when the leaf has none. */
export function recordOfPlan(plan: Pick<MintPlan, "marker" | "reveals">): ParsedRecord | null {
  if (plan.reveals.length !== 1) return null;
  const bytes = fieldBytesFromLeaf(plan.reveals[0].leaf, plan.marker);
  return bytes ? parseRecord(bytes) : null;
}

function row(name: string, problems: string[], ok: string): Check {
  return { name, pass: problems.length === 0, detail: problems.length === 0 ? ok : problems.join("; ") };
}

export function recordChecks(input: RecordCheckInput): Check[] {
  const { signed } = input;
  const shape: string[] = [];
  if (signed.single !== true || signed.noSale !== true) shape.push("the plan is not one stand-alone P2MR Inscription");
  if (signed.root !== "" || signed.holder !== undefined) shape.push("the plan carries a collection root or a holder");
  if (signed.reveals.length !== 1 || signed.reveals[0]?.name !== "inscription") shape.push("the plan is not one reveal named `inscription`");
  if (signed.issuerPublic !== input.issuerPublicHex) shape.push("issuer key differs from the public file");
  const rows: Check[] = [row("record plan", shape, "one P2MR Inscription, signed by the issuer key of the public file")];

  const parsed = shape.length === 0 ? recordOfPlan(signed) : null;
  const problems: string[] = [];
  let detail = "";
  if (!parsed) problems.push("the reveal leaf holds no record of PINS-5");
  else {
    if (parsed.kind !== input.kind) problems.push(`the plan holds a ${schemaOf(parsed.kind)} record, not ${schemaOf(input.kind)}`);
    if (parsed.root !== input.root) problems.push("the record root is not the root of the collection profile");
    if (parsed.kind === "close") {
      if (parsed.count !== input.supply) problems.push(`count ${parsed.count} is not the supply ${input.supply}`);
      detail = `count ${parsed.count}`;
    } else if (parsed.kind === "sale-reveal") {
      if (input.saleCommitment === undefined || !/^[0-9a-f]{64}$/.test(input.saleCommitment)) problems.push("the assignment records no sale commitment to compare with");
      else if (saleCommitmentOf(parsed.saleSecret) !== input.saleCommitment) problems.push("SHA-256 of the sale secret is not the sale commitment");
      detail = "SHA-256 of the sale secret is the sale commitment";
    } else {
      try {
        unsoldAddressScript(parsed.address, input.network);
        const apart = [signed.creator, signed.change, input.funding];
        if (apart.includes(parsed.address)) problems.push("the unsold address is also the creator, the change or the funding address; it is used only for the unsold items");
      } catch (error) {
        problems.push(error instanceof Error ? error.message : "the unsold address is not valid");
      }
      detail = `address ${parsed.address}`;
    }
  }
  rows.push(row(`${schemaOf(input.kind)} record`, problems, detail));

  const content: string[] = [];
  if (parsed) {
    try {
      const leaf = Buffer.from(groupLeaf(Buffer.from(input.issuerPublicHex, "hex"), revealGroups({ single: recordInscription(recordInputOf(parsed, input.network)) })[0], parseMarker(signed.marker))).toString("hex");
      if (leaf !== signed.reveals[0].leaf) content.push("the reveal leaf is not the leaf of this record with its schema body and text/plain");
    } catch (error) {
      content.push(error instanceof Error ? error.message : "could not rebuild the leaf");
    }
  } else content.push("no record to rebuild");
  rows.push(row("record content", content, "leaf rebuilt from the record"));
  return rows;
}
