// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { init } from "@qbit-oss/pqc";
import { createKeyfile, openKeyfile, readPassphrase, writeKeyfile, zeroSecrets } from "./keyfile.ts";

test("a new secret file is mode 0600, is not overwritten, and a failed public file removes only the new secret", async () => {
  await init();
  const dir = mkdtempSync(join(tmpdir(), "pins-key-"));
  const pass = Buffer.from("disposable-passphrase");
  const made = createKeyfile(pass);
  const path = join(dir, "issuer.key");
  writeKeyfile(path, made.body, { issuerPublic: made.secrets.issuerPublic, recoveryPublic: made.secrets.recoveryPublic });
  assert.equal((statSync(path).mode & 0o777).toString(8), "600");
  assert.equal((statSync(`${path}.pub.json`).mode & 0o777).toString(8), "644");
  const opened = openKeyfile(path, pass);
  assert.equal(opened.issuerPublic, made.secrets.issuerPublic);
  zeroSecrets(opened);
  const kept = readFileSync(path);
  assert.throws(() => writeKeyfile(path, made.body, { issuerPublic: made.secrets.issuerPublic, recoveryPublic: made.secrets.recoveryPublic }));
  assert.ok(readFileSync(path).equals(kept));
  const other = join(dir, "other.key");
  writeFileSync(`${other}.pub.json`, "keep-public");
  assert.throws(() => writeKeyfile(other, made.body, { issuerPublic: made.secrets.issuerPublic, recoveryPublic: made.secrets.recoveryPublic }));
  assert.equal(readFileSync(`${other}.pub.json`, "utf8"), "keep-public");
  assert.equal(existsSync(other), false);
  const linkTarget = join(dir, "target.key");
  writeFileSync(linkTarget, "do-not-touch", { mode: 0o600 });
  symlinkSync(linkTarget, join(dir, "link.key"));
  assert.throws(() => writeKeyfile(join(dir, "link.key"), made.body, { issuerPublic: made.secrets.issuerPublic, recoveryPublic: made.secrets.recoveryPublic }));
  assert.equal(readFileSync(linkTarget, "utf8"), "do-not-touch");
  zeroSecrets(made.secrets);
});

test("PINS_KEY_PASSPHRASE still supplies the passphrase without a terminal", async () => {
  const previous = process.env.PINS_KEY_PASSPHRASE;
  process.env.PINS_KEY_PASSPHRASE = "from-env";
  try {
    const got = await readPassphrase("Keyfile passphrase: ");
    assert.equal(got.toString("utf8"), "from-env");
    got.fill(0);
  } finally {
    if (previous === undefined) delete process.env.PINS_KEY_PASSPHRASE;
    else process.env.PINS_KEY_PASSPHRASE = previous;
  }
});

test("a terminal passphrase is not echoed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pins-pass-"));
  const ask = join(dir, "ask.mts");
  writeFileSync(ask, `
import { readPassphrase } from ${JSON.stringify(join(process.cwd(), "packages/inscriber/keyfile.ts"))};
process.stderr.write("READY\\n");
const value = await readPassphrase("Keyfile passphrase: ");
process.stdout.write("LEN=" + String(value.length) + "\\n");
value.fill(0);
`);
  const script = `
import os, pty, select, time
token = b"EchoToken42"
pid, fd = pty.fork()
if pid == 0:
    os.execvp(${JSON.stringify(process.execPath)}, [${JSON.stringify(process.execPath)}, "--experimental-strip-types", ${JSON.stringify(ask)}])
seen = b""
sent = False
end = time.time() + 8
while time.time() < end:
    ready, _, _ = select.select([fd], [], [], 0.2)
    if fd in ready:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        seen += chunk
        if b"Keyfile passphrase:" in seen and not sent:
            os.write(fd, token + b"\\n")
            sent = True
    elif sent and b"LEN=" in seen:
        break
print("ECHO", token in seen)
print("BODY", seen.decode("utf-8", "replace").split("LEN=", 1)[-1].strip())
`;
  const child = spawn("python3", ["-c", script]);
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { out += chunk; });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(code, 0, out);
  assert.match(out, /ECHO False/);
});
