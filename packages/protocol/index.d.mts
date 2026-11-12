// SPDX-License-Identifier: Apache-2.0
// Types of index.mjs, for the packages that read it without allowJs.
export const RESERVE_DOMAIN: number;
export const SALE_DOMAIN: number;
export const CONFIRMATIONS_FINAL: number;
export const STANDARDS: readonly { readonly id: string; readonly status: "draft" | "final" }[];
