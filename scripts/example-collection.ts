// SPDX-License-Identifier: Apache-2.0

/**
 * Writes a made-up collection for trying the tools on regtest: the folder `collection/` (images, json,
 * collection.json), `collection.zip`, the profiles `profile.sale.json` and `profile.nosale.json`, and
 * `price.json`. It touches no node and no key. `npm run example:collection -- --out <empty folder>`.
 * The art, the name and the numbers are made up and belong to no real collection.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { exampleCollection, zipOf } from "../packages/collection/example.mjs";

function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) throw new Error(`expected --name value pairs, got ${name ?? "nothing"}`);
    out[name.slice(2)] = value;
  }
  return out;
}

function main(): void {
  const flag = flags(process.argv.slice(2));
  if (!flag.out) throw new Error("missing --out <folder>");
  const out = resolve(flag.out);
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`${out} is not empty; give a new or empty folder`);
  const supply = flag.supply === undefined ? 12 : Number(flag.supply);
  const batchSize = flag["batch-size"] === undefined ? 4 : Number(flag["batch-size"]);
  const example = exampleCollection({ supply, batchSize });
  for (const [name, bytes] of example.files) {
    const path = join(out, "collection", name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  writeFileSync(join(out, "collection.zip"), zipOf(example.files));
  const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(join(out, "profile.sale.json"), json(example.profileSale));
  writeFileSync(join(out, "profile.nosale.json"), json(example.profileNoSale));
  writeFileSync(join(out, "price.json"), json(example.price));
  process.stdout.write(`Wrote ${supply} made-up items to ${out}\nmerkle root ${example.root}\nfiles: collection.zip, collection/, profile.sale.json, profile.nosale.json, price.json\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "failed"}\n`);
  process.exit(1);
}
