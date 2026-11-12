// SPDX-License-Identifier: Apache-2.0

/**
 * Encrypted issuer keyfile. The passphrase and the secret bytes are not logged.
 * JavaScript strings cannot be wiped; the passphrase is copied into a buffer
 * that is zeroed, and the secret key bytes are zeroed after use.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { keygen } from "@qbit-oss/pqc";

export type PublicKeys = { issuerPublic: string; recoveryPublic: string };

/** `saleSecret` is null in a keyfile made with `keygen --no-sale`. */
type Secrets = PublicKeys & { issuerSecret: Uint8Array; recoverySecret: Uint8Array; saleSecret: Uint8Array | null };

type FileBody = {
  version: 1;
  kdf: "scrypt";
  salt: string;
  n: number;
  r: number;
  p: number;
  iv: string;
  tag: string;
  ciphertext: string;
};

/**
 * What this tool writes: scrypt N = 2^14, r = 8, p = 1, a 16-byte salt, a 12-byte IV and a 16-byte tag. Every keyfile
 * made so far has exactly these values, and they are not changed here.
 */
const N = 16384;
const R = 8;
const P = 1;

/**
 * What `openKeyfile` accepts. The file carries its own scrypt parameters, so a file that is not ours could ask for a
 * cost that exhausts memory or time, or for a cost below what this tool writes. The floor is the cost this tool
 * writes. The ceiling is far above it (about 512 times the work, 1 GiB of memory) so that a stronger setting chosen
 * later still opens.
 */
export const KEYFILE_LIMITS = Object.freeze({
  minN: N, maxN: 2 ** 20,
  minR: R, maxR: 16,
  minP: P, maxP: 16,
  maxWork: 2 ** 26,       // N * r * p
  maxMemory: 2 ** 30,     // 128 * N * r bytes
  maxCiphertextBytes: 2 ** 20,
});

function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

function hexOf(name: string, value: unknown, bytes: number | null): Buffer {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{2})*$/i.test(value)) throw new Error(`the keyfile field ${name} is not hex`);
  const out = Buffer.from(value, "hex");
  if (bytes !== null && out.length !== bytes) throw new Error(`the keyfile field ${name} must be ${bytes} bytes, not ${out.length}`);
  if (bytes === null && out.length > KEYFILE_LIMITS.maxCiphertextBytes) throw new Error(`the keyfile field ${name} is larger than ${KEYFILE_LIMITS.maxCiphertextBytes} bytes`);
  return out;
}

/** Check a keyfile before the passphrase is stretched. Throws a plain message that names the value and the limit. */
function checkBody(body: unknown): FileBody {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("the keyfile is not a JSON object");
  const file = body as Record<string, unknown>;
  if (file.version !== 1) throw new Error(`the keyfile version is ${JSON.stringify(file.version)}; this tool reads version 1`);
  if (file.kdf !== "scrypt") throw new Error(`the keyfile key derivation is ${JSON.stringify(file.kdf)}; this tool reads scrypt`);
  const { n, r, p } = file;
  for (const [name, value] of [["n", n], ["r", r], ["p", p]] as const) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`the keyfile scrypt parameter ${name} is not a positive integer`);
  }
  const L = KEYFILE_LIMITS;
  const [nn, rr, pp] = [n as number, r as number, p as number];
  if (!isPowerOfTwo(nn)) throw new Error(`the keyfile scrypt parameter n=${nn} is not a power of two`);
  if (nn < L.minN || rr < L.minR || pp < L.minP) {
    throw new Error(`the keyfile scrypt parameters (n=${nn}, r=${rr}, p=${pp}) are weaker than this tool's minimum (n=${L.minN}, r=${L.minR}, p=${L.minP}); refusing to open it`);
  }
  if (nn > L.maxN || rr > L.maxR || pp > L.maxP || nn * rr * pp > L.maxWork || 128 * nn * rr > L.maxMemory) {
    throw new Error(`the keyfile scrypt parameters (n=${nn}, r=${rr}, p=${pp}) ask for more memory or time than this tool accepts (n up to ${L.maxN}, r up to ${L.maxR}, p up to ${L.maxP}, at most ${L.maxMemory / 2 ** 20} MiB); refusing to open it`);
  }
  hexOf("salt", file.salt, 16);
  hexOf("iv", file.iv, 12);
  hexOf("tag", file.tag, 16);
  hexOf("ciphertext", file.ciphertext, null);
  return file as unknown as FileBody;
}

function popCodePoint(bytes: number[]): void {
  if (bytes.length === 0) return;
  bytes.pop();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (bytes.length > 0) {
    try {
      decoder.decode(Uint8Array.from(bytes));
      return;
    } catch {
      bytes.pop();
    }
  }
}

/**
 * Read a passphrase from a terminal without echo.
 * `PINS_KEY_PASSPHRASE` is unchanged and is for tests. A real key should not use it:
 * the value is visible to other processes of the same user.
 */
export async function readPassphrase(prompt: string): Promise<Buffer> {
  const fromEnv = process.env.PINS_KEY_PASSPHRASE;
  if (fromEnv) return Buffer.from(fromEnv, "utf8");
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("passphrase must be typed on a terminal; PINS_KEY_PASSPHRASE is only for tests");
  }
  const stdin = process.stdin;
  stdin.setRawMode(true);
  process.stdout.write(prompt);
  stdin.resume();
  const bytes: number[] = [];
  let restored = false;
  const cleanup = () => {
    if (restored) return;
    restored = true;
    stdin.off("data", onData);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    process.stdout.write("\n");
  };
  const onData = (chunk: Buffer) => {
    for (const byte of chunk) {
      if (byte === 0x03) {
        cleanup();
        process.exit(130);
      } else if (byte === 0x7f || byte === 0x08) {
        popCodePoint(bytes);
      } else if (byte === 0x0d || byte === 0x0a) {
        cleanup();
        finish(bytes);
      } else if (byte === 0x15) {
        bytes.length = 0;
      } else if (byte >= 0x20) {
        bytes.push(byte);
      }
    }
  };
  let finish = (_value: number[]) => undefined;
  try {
    const text = await new Promise<string>((resolve, reject) => {
      finish = (value) => {
        try {
          resolve(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(value)));
        } catch (error) {
          reject(error instanceof Error ? error : new Error("passphrase is not UTF-8"));
        }
      };
      stdin.on("data", onData);
    });
    return Buffer.from(text, "utf8");
  } catch (error) {
    cleanup();
    throw error;
  }
}

/**
 * `withSale` false leaves the sale secret out. It is for a collection that declares no sale.
 * The issuer key and the recovery key each come from their own 128-byte draw. Earlier versions derived the recovery
 * key from the issuer draw, so one draw fixed both. `entropy` and `recoveryEntropy` are for tests that need fixed keys.
 */
export function createKeyfile(passphrase: Buffer, entropy: Uint8Array = randomBytes(128), withSale = true, recoveryEntropy: Uint8Array = randomBytes(128)): { secrets: Secrets; body: FileBody } {
  const issuer = keygen(entropy);
  const recovery = keygen(recoveryEntropy);
  const secrets: Secrets = {
    issuerPublic: Buffer.from(issuer.publicKey).toString("hex"),
    recoveryPublic: Buffer.from(recovery.publicKey).toString("hex"),
    issuerSecret: issuer.secretKey,
    recoverySecret: recovery.secretKey,
    saleSecret: withSale ? randomBytes(32) : null,
  };
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, { N, r: R, p: P });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify({
    issuerPublic: secrets.issuerPublic,
    recoveryPublic: secrets.recoveryPublic,
    issuerSecret: Buffer.from(secrets.issuerSecret).toString("hex"),
    recoverySecret: Buffer.from(secrets.recoverySecret).toString("hex"),
    ...(secrets.saleSecret ? { saleSecret: Buffer.from(secrets.saleSecret).toString("hex") } : {}),
  }));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  plaintext.fill(0);
  key.fill(0);
  const body: FileBody = {
    version: 1,
    kdf: "scrypt",
    salt: salt.toString("hex"),
    n: N,
    r: R,
    p: P,
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    ciphertext: ciphertext.toString("hex"),
  };
  return { secrets, body };
}

export function writeKeyfile(path: string, body: FileBody, publics: PublicKeys): void {
  const secret = `${JSON.stringify(body, null, 2)}\n`;
  const pubPath = `${path}.pub.json`;
  writeFileSync(path, secret, { flag: "wx", mode: 0o600 });
  try {
    writeFileSync(pubPath, `${JSON.stringify(publics, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
}

export function openKeyfile(path: string, passphrase: Buffer): Secrets {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code) throw error;
    throw new Error("the keyfile is not valid JSON", { cause: error });
  }
  const body = checkBody(parsed);
  // The memory limit of scryptSync is 32 MiB unless it is raised. Twice the need leaves room for a stronger file.
  const key = scryptSync(passphrase, Buffer.from(body.salt, "hex"), 32, { N: body.n, r: body.r, p: body.p, maxmem: 2 * 128 * body.n * body.r });
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(body.iv, "hex"));
  decipher.setAuthTag(Buffer.from(body.tag, "hex"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(body.ciphertext, "hex")), decipher.final()]);
  key.fill(0);
  const inner = JSON.parse(plaintext.toString("utf8")) as {
    issuerPublic: string;
    recoveryPublic: string;
    issuerSecret: string;
    recoverySecret: string;
    saleSecret?: string;
  };
  plaintext.fill(0);
  return {
    issuerPublic: inner.issuerPublic,
    recoveryPublic: inner.recoveryPublic,
    issuerSecret: Buffer.from(inner.issuerSecret, "hex"),
    recoverySecret: Buffer.from(inner.recoverySecret, "hex"),
    saleSecret: typeof inner.saleSecret === "string" ? Buffer.from(inner.saleSecret, "hex") : null,
  };
}

export function zeroSecrets(secrets: Secrets): void {
  secrets.issuerSecret.fill(0);
  secrets.recoverySecret.fill(0);
  secrets.saleSecret?.fill(0);
}
