// SPDX-License-Identifier: Apache-2.0

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host.trim().toLowerCase());
}

export function hostnameOf(hostHeader: string): string {
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? trimmed : trimmed.slice(1, end);
  }
  return trimmed.replace(/:\d+$/, "");
}

/** Bind address does not grant Host trust. Only loopback and TRUSTED_HOSTS match. */
export function hostAllowed(hostHeader: string, trustedHosts: readonly string[]): boolean {
  const host = hostnameOf(hostHeader);
  if (isLoopbackHost(host)) return true;
  return trustedHosts.includes(host);
}

/**
 * The client address a trusted proxy reports in `X-Forwarded-For`. A proxy appends the address it saw,
 * so the last element is the one it vouches for. Earlier elements come from the client and can be forged.
 */
export function forwardedClient(header: string | string[] | undefined): string | null {
  const text = Array.isArray(header) ? header.join(",") : header;
  if (typeof text !== "string") return null;
  const last = text.split(",").pop()?.trim();
  return last ? last : null;
}

export function assertHttpUrl(url: string, label: string, loopbackOnly: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (parsed.username || parsed.password) throw new Error(`${label} must not contain credentials`);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${label} must be http or https`);
  if (loopbackOnly && !isLoopbackHost(parsed.hostname.replace(/^\[|\]$/g, ""))) {
    throw new Error(`${label} must stay on loopback`);
  }
}
