// SPDX-License-Identifier: Apache-2.0

export const CONTENT_RETRIES: number;
export function retryDelayMs(header: string | null | undefined, attempt: number, base?: number): number;
export function fetchWithRetry(url: string, init?: RequestInit, opts?: { attempts?: number }): Promise<Response>;
export function attachImageRetry(img: HTMLImageElement, url: string, onGiveUp: () => void): void;
