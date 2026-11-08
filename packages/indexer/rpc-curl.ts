// SPDX-License-Identifier: Apache-2.0

/**
 * Curl reads the RPC user from stdin (`--config -`).
 * The password is not a curl argument. Callers may still pass `--rpc-password`
 * to this process; that remains visible in this process's own arguments.
 */

export function assertRpcEndpoint(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("RPC URL is not valid");
  }
  if (parsed.username || parsed.password) throw new Error("RPC URL must not contain credentials");
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("RPC URL must be http or https");
}

export function curlConfigQuoted(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("RPC credential must be a single line");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Arguments contain no user or password. The password is only in `input`.
 * Redirects are refused with `--max-redirs 0`, and `-q` is first so a curlrc
 * cannot enable `--location`.
 */
export function curlRpcInvocation(url: string, user: string, password: string, bodyFile: string, timeoutSeconds = 180): { args: string[]; input: string } {
  assertRpcEndpoint(url);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error("curl timeout must be positive");
  if (/[\r\n\0]/.test(user) || /[\r\n\0]/.test(password)) throw new Error("RPC credential must be a single line");
  const input = `user = ${curlConfigQuoted(`${user}:${password}`)}\n`;
  const args = ["-q", "-sS", "--max-redirs", "0", "-m", String(timeoutSeconds), "--config", "-", "-H", "content-type: application/json", "--data-binary", `@${bodyFile}`, url];
  if (args.join("\0").includes(`${user}:${password}`)) throw new Error("refusing to put RPC credentials on the curl command line");
  return { args, input };
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  const unique = [...secrets].filter((secret) => secret.length > 0).sort((a, b) => b.length - a.length);
  for (const secret of unique) out = out.split(secret).join("[redacted]");
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*:[^\s/@]*@/gi, "$1[redacted]@");
  return out.slice(0, 240);
}
