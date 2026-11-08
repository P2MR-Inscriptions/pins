// SPDX-License-Identifier: Apache-2.0

/**
 * Read KEY=VALUE text literally. Nothing in the file is evaluated as a shell command.
 * A value such as $(...) stays the characters written in the file.
 */

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) throw new Error("env file has a line without a name");
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("env file has an invalid name");
    let value = line.slice(eq + 1);
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1);
    }
    if (/[\r\0]/.test(value)) throw new Error("env file value must be a single line");
    out[key] = value;
  }
  return out;
}

/** Bitcoin-style qbit.conf. Only rpcuser, rpcpassword, rpcbind, and rpcport are read. */
export function parseQbitConf(text: string): { rpcuser?: string; rpcpassword?: string; rpcbind?: string; rpcport?: string } {
  const out: { rpcuser?: string; rpcpassword?: string; rpcbind?: string; rpcport?: string } = {};
  for (const raw of text.split(/\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "rpcuser" || key === "rpcpassword" || key === "rpcbind" || key === "rpcport") out[key] = value;
  }
  return out;
}
