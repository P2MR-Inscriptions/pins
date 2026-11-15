// SPDX-License-Identifier: Apache-2.0

/** Public errors never repeat a credential or a URL that embeds one. */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*:[^\s/@]*@/gi, "$1[redacted]@");
  const unique = [...secrets].filter((secret) => secret.length > 0).sort((left, right) => right.length - left.length);
  for (const secret of unique) out = out.split(secret).join("[redacted]");
  return out.replace(/\s+/g, " ").trim().slice(0, 240);
}

export function publicError(error: unknown, secrets: readonly string[] = []): string {
  const text = error instanceof Error ? error.message : "request failed";
  const redacted = redactSecrets(text, secrets);
  if (!redacted || redacted === "[redacted]") return "request failed";
  return redacted;
}
