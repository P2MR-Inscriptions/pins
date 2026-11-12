// SPDX-License-Identifier: Apache-2.0

export const PREVIEW_BYTES: number;
export function normalizeType(raw: unknown): string;
export function mediaKind(raw: unknown): "image" | "svg" | "text" | "audio" | "video" | "html" | "other";
