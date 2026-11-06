// SPDX-License-Identifier: Apache-2.0

/**
 * Encrypted issuer keyfile. The passphrase and the secret bytes are not logged.
 * JavaScript strings cannot be wiped; the passphrase is copied into a buffer
 * that is zeroed, and the secret key bytes are zeroed after use.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { keygen } from "@qbit-oss/pqc";

export type PublicKeys = { issuerPublic: string; recoveryPublic: string };

type Secrets = PublicKeys & { issuerSecret: Uint8Array; recoverySecret: Uint8Array; saleSecret: Uint8Array };

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

const N = 16384;

export async function readPassphrase(prompt: string): Promise<Buffer> {
  const fromEnv = process.env.PINS_KEY_PASSPHRASE;
  if (fromEnv) return Buffer.from(fromEnv, "utf8");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write(prompt);
  if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
  const text = await new Promise<string>((resolve) => {
    rl.question("", (answer) => resolve(answer));
  });
  rl.close();
  process.stdout.write("\n");
  return Buffer.from(text, "utf8");
}

export function createKeyfile(passphrase: Buffer, entropy: Uint8Array = randomBytes(128)): { secrets: Secrets; body: FileBody } {
  const issuer = keygen(entropy);
  const recovery = keygen(entropy.map((byte, index) => (byte + index + 1) & 0xff));
  const secrets: Secrets = {
    issuerPublic: Buffer.from(issuer.publicKey).toString("hex"),
    recoveryPublic: Buffer.from(recovery.publicKey).toString("hex"),
    issuerSecret: issuer.secretKey,
    recoverySecret: recovery.secretKey,
    saleSecret: randomBytes(32),
  };
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, { N, r: 8, p: 1 });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify({
    issuerPublic: secrets.issuerPublic,
    recoveryPublic: secrets.recoveryPublic,
    issuerSecret: Buffer.from(secrets.issuerSecret).toString("hex"),
    recoverySecret: Buffer.from(secrets.recoverySecret).toString("hex"),
    saleSecret: Buffer.from(secrets.saleSecret).toString("hex"),
  }));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  plaintext.fill(0);
  key.fill(0);
  const body: FileBody = {
    version: 1,
    kdf: "scrypt",
    salt: salt.toString("hex"),
    n: N,
    r: 8,
    p: 1,
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    ciphertext: ciphertext.toString("hex"),
  };
  return { secrets, body };
}

export function writeKeyfile(path: string, body: FileBody, publics: PublicKeys): void {
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
  writeFileSync(`${path}.pub.json`, `${JSON.stringify(publics, null, 2)}\n`);
}

export function openKeyfile(path: string, passphrase: Buffer): Secrets {
  const body = JSON.parse(readFileSync(path, "utf8")) as FileBody;
  const key = scryptSync(passphrase, Buffer.from(body.salt, "hex"), 32, { N: body.n, r: body.r, p: body.p });
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(body.iv, "hex"));
  decipher.setAuthTag(Buffer.from(body.tag, "hex"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(body.ciphertext, "hex")), decipher.final()]);
  key.fill(0);
  const parsed = JSON.parse(plaintext.toString("utf8")) as {
    issuerPublic: string;
    recoveryPublic: string;
    issuerSecret: string;
    recoverySecret: string;
    saleSecret: string;
  };
  plaintext.fill(0);
  return {
    issuerPublic: parsed.issuerPublic,
    recoveryPublic: parsed.recoveryPublic,
    issuerSecret: Buffer.from(parsed.issuerSecret, "hex"),
    recoverySecret: Buffer.from(parsed.recoverySecret, "hex"),
    saleSecret: Buffer.from(parsed.saleSecret, "hex"),
  };
}

export function zeroSecrets(secrets: Secrets): void {
  secrets.issuerSecret.fill(0);
  secrets.recoverySecret.fill(0);
  secrets.saleSecret.fill(0);
}
