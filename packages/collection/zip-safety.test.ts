// SPDX-License-Identifier: Apache-2.0

/**
 * A collection zip is untrusted input. Its entries are checked before anything is written: no path that leaves the
 * folder, no repeated name, no link or special file, and limits on the count and the sizes. `unzip` never overwrites.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { crc32 } from "node:zlib";
import { DEFAULT_ZIP_LIMITS, checkZipEntries, extractZip, listZip } from "./canonical.mjs";

type Entry = { name: string; data?: Buffer; mode?: number };

/** A zip with stored entries. `mode` is the Unix mode, 0o100644 for a file and 0o120777 for a symbolic link. */
function zipOf(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = entry.data ?? Buffer.alloc(0);
    const sum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function scratch(entries: Entry[]): { zip: string; dest: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pins-zip-"));
  const zip = join(dir, "in.zip");
  const dest = join(dir, "out");
  writeFileSync(zip, zipOf(entries));
  mkdirSync(dest);
  return { zip, dest, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a plain zip lists and extracts, and is read only", () => {
  const { zip, dest, done } = scratch([
    { name: "images/", mode: 0o040755 },
    { name: "images/1.png", data: Buffer.from("png") },
    { name: "collection.json", data: Buffer.from("{}") },
  ]);
  try {
    const before = readFileSync(zip);
    assert.deepEqual(listZip(zip).map((e) => [e.kind, e.size, e.name]), [["d", 0, "images/"], ["-", 3, "images/1.png"], ["-", 2, "collection.json"]]);
    extractZip(zip, dest);
    assert.equal(readFileSync(join(dest, "images/1.png"), "utf8"), "png");
    assert.equal(readFileSync(join(dest, "collection.json"), "utf8"), "{}");
    assert.deepEqual(readFileSync(zip), before);
  } finally {
    done();
  }
});

test("an entry that leaves the folder, or is not a plain path, is refused before anything is written", () => {
  for (const name of ["../escape.txt", "a/../../escape.txt", "/etc/escape.txt", "a\\b.txt", "C:/escape.txt", "a/.."]) {
    const { zip, dest, done } = scratch([{ name: "ok.txt", data: Buffer.from("x") }, { name, data: Buffer.from("y") }]);
    try {
      assert.throws(() => extractZip(zip, dest), /Refusing/, name);
      assert.deepEqual(readdirSync(dest), [], `nothing written for ${JSON.stringify(name)}`);
      assert.equal(existsSync(join(dest, "..", "escape.txt")), false);
    } finally {
      done();
    }
  }
});

test("a control character in a name is refused when the listing shows it", () => {
  assert.throws(() => checkZipEntries([{ kind: "-", size: 1, name: "bad\u0001name" }]), /Refusing zip entry/);
  assert.throws(() => checkZipEntries([{ kind: "-", size: 1, name: "" }]), /Refusing zip entry/);
});

test("a repeated name is refused, so no entry replaces another", () => {
  const { zip, dest, done } = scratch([{ name: "a.txt", data: Buffer.from("one") }, { name: "a.txt", data: Buffer.from("two") }]);
  try {
    assert.throws(() => extractZip(zip, dest), /appears twice/);
    assert.deepEqual(readdirSync(dest), []);
  } finally {
    done();
  }
});

test("a symbolic link or a special file is refused", () => {
  for (const mode of [0o120777, 0o010644, 0o020644]) {
    const { zip, dest, done } = scratch([{ name: "x", data: Buffer.from("/etc/passwd"), mode }]);
    try {
      assert.throws(() => extractZip(zip, dest), /link or a special file/, mode.toString(8));
      assert.deepEqual(readdirSync(dest), []);
    } finally {
      done();
    }
  }
});

test("limits on the number of entries and on the sizes", () => {
  const { zip, dest, done } = scratch([
    { name: "a", data: Buffer.alloc(10) },
    { name: "b", data: Buffer.alloc(10) },
    { name: "c", data: Buffer.alloc(10) },
  ]);
  try {
    assert.throws(() => extractZip(zip, dest, { ...DEFAULT_ZIP_LIMITS, maxEntries: 2 }), /3 entries, the limit is 2/);
    assert.throws(() => extractZip(zip, dest, { ...DEFAULT_ZIP_LIMITS, maxEntryBytes: 9 }), /10 bytes, the limit is 9/);
    assert.throws(() => extractZip(zip, dest, { ...DEFAULT_ZIP_LIMITS, maxTotalBytes: 25 }), /more than 25 bytes in all/);
    assert.deepEqual(readdirSync(dest), []);
    extractZip(zip, dest, { maxEntries: 3, maxEntryBytes: 10, maxTotalBytes: 30 });
    assert.deepEqual(readdirSync(dest).sort(), ["a", "b", "c"]);
  } finally {
    done();
  }
});

test("the default limits take a real size collection", () => {
  const entries = Array.from({ length: 20_004 }, (_, index) => ({ kind: "-", size: 800, name: `images/${index}.png` }));
  checkZipEntries(entries, DEFAULT_ZIP_LIMITS);
  assert.throws(() => checkZipEntries([{ kind: "-", size: 2 ** 27, name: "big" }], DEFAULT_ZIP_LIMITS), /limit/);
});

test("the extraction folder must be empty, so nothing is overwritten", () => {
  const { zip, dest, done } = scratch([{ name: "a.txt", data: Buffer.from("new") }]);
  try {
    writeFileSync(join(dest, "a.txt"), "old");
    assert.throws(() => extractZip(zip, dest), /must be empty/);
    assert.equal(readFileSync(join(dest, "a.txt"), "utf8"), "old");
  } finally {
    done();
  }
});

test("a missing unzip program is reported by name", () => {
  const { zip, dest, done } = scratch([{ name: "a.txt", data: Buffer.from("x") }]);
  const path = process.env.PATH;
  try {
    process.env.PATH = "";
    assert.throws(() => extractZip(zip, dest), /`unzip` program \(Info-ZIP\) is required/);
  } finally {
    process.env.PATH = path;
    done();
  }
});

test("a file that is not a zip is refused with a short message", () => {
  const dir = mkdtempSync(join(tmpdir(), "pins-zip-"));
  try {
    const zip = join(dir, "bad.zip");
    writeFileSync(zip, "not a zip");
    assert.throws(() => listZip(zip), /unzip could not read bad\.zip/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
