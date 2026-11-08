export function normalizeHash(hash: string | null | undefined): string;
export function isDetailHash(hash: string): boolean;
export function isTransientHash(hash: string): boolean;
export function isListHash(hash: string): boolean;
export function fallbackListHash(): string;
export function backHash(lastListHash: string | null | undefined, here: string): string;
export function backLabel(hash: string): string;
