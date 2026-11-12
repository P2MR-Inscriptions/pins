// SPDX-License-Identifier: Apache-2.0

/**
 * Where each output of a mint goes. One rule, used to build a plan and to check one before it is signed,
 * so the two cannot drift apart.
 *
 * - The genesis and the leaf list go to the creator.
 * - A numbered item goes to the creator when it is in the reserve, and to the holder otherwise.
 * - The last output of every reveal is mint change and goes to the change address.
 *
 * The holder is the sale address of a collection with a sale. A collection with no sale has no reserve, and its
 * holder is the creator unless the plan names another address.
 */
import type { MintPlan } from "./plan.ts";

export type Destinations = { creator: string; holder: string; reserve: ReadonlySet<number> };

/** The address of the genesis or the leaf list (`number` is `null`) or of a numbered item. */
export function itemAddress(destinations: Destinations, number: number | null): string {
  if (number === null) return destinations.creator;
  return destinations.reserve.has(number) ? destinations.creator : destinations.holder;
}

/** The destinations a plan declares, with the reserve the operator supplies beside it. */
export function destinationsOf(plan: Pick<MintPlan, "creator" | "sale" | "noSale" | "holder">, reserve: ReadonlySet<number>): Destinations {
  if (plan.noSale) return { creator: plan.creator, holder: plan.holder ?? plan.creator, reserve: new Set() };
  return { creator: plan.creator, holder: plan.sale, reserve };
}
