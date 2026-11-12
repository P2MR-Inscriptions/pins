// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { init, keygen } from "@qbit-oss/pqc";
import { createKeyfile, KEYFILE_LIMITS, openKeyfile, writeKeyfile, zeroSecrets } from "./keyfile.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "keyfiles");
const FIXTURE_PASSPHRASE = Buffer.from("pins-test-fixture-passphrase");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Expected = Record<string, { issuerPublic: string; recoveryPublic: string; hasSale: boolean; saleSecretHex: string | null; issuerSecretSha: string; recoverySecretSha: string }>;
const expected = JSON.parse(readFileSync(join(FIXTURES, "expected.json"), "utf8")) as Expected;
const tmp = () => mkdtempSync(join(tmpdir(), "pins-keyfile-"));

test("keyfiles written by earlier versions still open, with the same keys", async () => {
  await init();
  for (const name of ["v1.0.0", "main-with-sale", "main-no-sale"]) {
    const file = JSON.parse(readFileSync(join(FIXTURES, `${name}.keyfile.json`), "utf8"));
    assert.deepEqual([file.version, file.kdf, file.n, file.r, file.p], [1, "scrypt", 16384, 8, 1]);
    const opened = openKeyfile(join(FIXTURES, `${name}.keyfile.json`), FIXTURE_PASSPHRASE);
    const want = expected[name]!;
    assert.equal(opened.issuerPublic, want.issuerPublic, name);
    assert.equal(opened.recoveryPublic, want.recoveryPublic, name);
    assert.equal(sha(opened.issuerSecret), want.issuerSecretSha, name);
    assert.equal(sha(opened.recoverySecret), want.recoverySecretSha, name);
    assert.equal(opened.saleSecret === null ? null : Buffer.from(opened.saleSecret).toString("hex"), want.saleSecretHex, name);
    zeroSecrets(opened);
  }
});

test("a wrong passphrase still fails", async () => {
  await init();
  assert.throws(() => openKeyfile(join(FIXTURES, "v1.0.0.keyfile.json"), Buffer.from("not the passphrase")));
});

test("a new keyfile round-trips, with and without a sale secret", async () => {
  await init();
  const dir = tmp();
  const pass = Buffer.from("disposable-passphrase");
  for (const withSale of [true, false]) {
    const made = createKeyfile(pass, undefined, withSale);
    const path = join(dir, `${withSale ? "sale" : "nosale"}.key`);
    writeKeyfile(path, made.body, { issuerPublic: made.secrets.issuerPublic, recoveryPublic: made.secrets.recoveryPublic });
    const file = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual([file.version, file.kdf, file.n, file.r, file.p], [1, "scrypt", 16384, 8, 1], "the cost this tool writes is unchanged");
    const opened = openKeyfile(path, pass);
    assert.equal(opened.issuerPublic, made.secrets.issuerPublic);
    assert.equal(opened.recoveryPublic, made.secrets.recoveryPublic);
    assert.ok(Buffer.from(opened.issuerSecret).equals(made.secrets.issuerSecret));
    assert.ok(Buffer.from(opened.recoverySecret).equals(made.secrets.recoverySecret));
    assert.equal(opened.saleSecret === null, !withSale);
    if (withSale) assert.ok(Buffer.from(opened.saleSecret!).equals(made.secrets.saleSecret!));
    zeroSecrets(opened);
    zeroSecrets(made.secrets);
  }
});

test("the recovery key is an independent draw, not a function of the issuer draw", async () => {
  await init();
  const pass = Buffer.from("disposable-passphrase");
  const entropy = Uint8Array.from({ length: 128 }, (_, i) => (i * 5 + 11) & 255);
  const old = keygen(entropy.map((byte, index) => (byte + index + 1) & 0xff));
  const a = createKeyfile(pass, entropy);
  const b = createKeyfile(pass, entropy);
  assert.equal(a.secrets.issuerPublic, b.secrets.issuerPublic, "the issuer key follows the issuer draw");
  assert.notEqual(a.secrets.recoveryPublic, b.secrets.recoveryPublic, "two keyfiles from one issuer draw do not share a recovery key");
  assert.notEqual(a.secrets.recoveryPublic, Buffer.from(old.publicKey).toString("hex"), "the old derivation is no longer used");
  const fixed = createKeyfile(pass, entropy, true, entropy.map((byte, index) => (byte + index + 1) & 0xff));
  assert.equal(fixed.secrets.recoveryPublic, expected["v1.0.0"]!.recoveryPublic, "an explicit recovery draw reproduces the old key");
  for (const k of [a, b, fixed]) zeroSecrets(k.secrets);
});

function parts(path: string) {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function withBody(dir: string, edit: (body: Record<string, unknown>) => void): string {
  const body = parts(join(FIXTURES, "v1.0.0.keyfile.json"));
  edit(body);
  const path = join(dir, `edited-${randomBytes(4).toString("hex")}.key`);
  writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
  return path;
}

test("absurd scrypt parameters are refused with a clear message, before any key stretching", async () => {
  await init();
  const dir = tmp();
  const cases: Array<[string, (b: Record<string, unknown>) => void, RegExp]> = [
    ["n = 2^40", (b) => { b.n = 2 ** 40; }, /more memory or time than this tool accepts/],
    ["n = 2^21", (b) => { b.n = 2 ** 21; }, /more memory or time than this tool accepts/],
    ["r = 1000", (b) => { b.r = 1000; }, /more memory or time than this tool accepts/],
    ["p = 1000", (b) => { b.p = 1000; }, /more memory or time than this tool accepts/],
    ["work above the ceiling", (b) => { b.n = 2 ** 20; b.r = 16; b.p = 16; }, /more memory or time than this tool accepts/],
    ["memory above the ceiling", (b) => { b.n = 2 ** 20; b.r = 16; }, /more memory or time than this tool accepts/],
  ];
  for (const [name, edit, message] of cases) {
    const started = Date.now();
    assert.throws(() => openKeyfile(withBody(dir, edit), FIXTURE_PASSPHRASE), message, name);
    assert.ok(Date.now() - started < 1000, `${name} was refused without running scrypt`);
  }
});

test("too-weak scrypt parameters are refused with a clear message", async () => {
  await init();
  const dir = tmp();
  const cases: Array<[string, (b: Record<string, unknown>) => void]> = [
    ["n = 2^13", (b) => { b.n = 8192; }],
    ["n = 2", (b) => { b.n = 2; }],
    ["r = 1", (b) => { b.r = 1; }],
    ["r = 7", (b) => { b.r = 7; }],
  ];
  for (const [name, edit] of cases) {
    assert.throws(() => openKeyfile(withBody(dir, edit), FIXTURE_PASSPHRASE), /weaker than this tool's minimum \(n=16384, r=8, p=1\)/, name);
  }
});

test("malformed parameters and fields are refused", async () => {
  await init();
  const dir = tmp();
  const cases: Array<[string, (b: Record<string, unknown>) => void, RegExp]> = [
    ["n not a power of two", (b) => { b.n = 20000; }, /not a power of two/],
    ["n a string", (b) => { b.n = "16384"; }, /not a positive integer/],
    ["p zero", (b) => { b.p = 0; }, /not a positive integer/],
    ["r fractional", (b) => { b.r = 8.5; }, /not a positive integer/],
    ["n missing", (b) => { delete b.n; }, /not a positive integer/],
    ["version 2", (b) => { b.version = 2; }, /version is 2/],
    ["other kdf", (b) => { b.kdf = "pbkdf2"; }, /key derivation is "pbkdf2"/],
    ["short salt", (b) => { b.salt = "00"; }, /salt must be 16 bytes/],
    ["short iv", (b) => { b.iv = "00"; }, /iv must be 12 bytes/],
    ["tag not hex", (b) => { b.tag = "zz".repeat(16); }, /tag is not hex/],
    ["ciphertext not a string", (b) => { b.ciphertext = 5; }, /ciphertext is not hex/],
  ];
  for (const [name, edit, message] of cases) {
    assert.throws(() => openKeyfile(withBody(dir, edit), FIXTURE_PASSPHRASE), message, name);
  }
  const notJson = join(dir, "text.key");
  writeFileSync(notJson, "not json");
  assert.throws(() => openKeyfile(notJson, FIXTURE_PASSPHRASE), /not valid JSON/);
  const array = join(dir, "array.key");
  writeFileSync(array, "[]");
  assert.throws(() => openKeyfile(array, FIXTURE_PASSPHRASE), /not a JSON object/);
  assert.throws(() => openKeyfile(join(dir, "missing.key"), FIXTURE_PASSPHRASE), /ENOENT/);
});

test("a keyfile with a stronger cost than this tool writes still opens", async () => {
  await init();
  const dir = tmp();
  const inner = { issuerPublic: "aa", recoveryPublic: "bb", issuerSecret: "cc", recoverySecret: "dd", saleSecret: "ee" };
  for (const [n, r, p] of [[32768, 8, 1], [65536, 8, 2], [16384, 16, 1]] as const) {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(Buffer.from("strong"), salt, 32, { N: n, r, p, maxmem: 2 * 128 * n * r });
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(inner), "utf8"), cipher.final()]);
    const path = join(dir, `strong-${n}-${r}-${p}.key`);
    writeFileSync(path, JSON.stringify({ version: 1, kdf: "scrypt", salt: salt.toString("hex"), n, r, p, iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("hex") }));
    const opened = openKeyfile(path, Buffer.from("strong"));
    assert.equal(opened.issuerPublic, "aa");
    assert.equal(Buffer.from(opened.saleSecret!).toString("hex"), "ee");
  }
});

test("the accepted limits are the documented ones", () => {
  assert.deepEqual({ ...KEYFILE_LIMITS }, { minN: 16384, maxN: 1048576, minR: 8, maxR: 16, minP: 1, maxP: 16, maxWork: 67108864, maxMemory: 1073741824, maxCiphertextBytes: 1048576 });
});
