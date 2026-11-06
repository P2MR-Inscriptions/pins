// SPDX-License-Identifier: Apache-2.0

/**
 * HRPs below are copied from Qbit Core v1.0.0 `src/kernel/chainparams.cpp`
 * (tag v1.0.0, 16 July 2026), not from the JavaScript network table:
 *   CMainParams     bech32_hrp = "qb"
 *   CTestNet4Params bech32_hrp = "tq"
 *   CRegTestParams  bech32_hrp = "qbrt"
 * Signet also uses "tq". This test does not treat signet as testnet4.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { addressToScriptPubKey } from "@qbit-oss/protocol";
import { addressOf } from "./address.ts";

const HRP = {
  mainnet: "qb",
  testnet4: "tq",
  regtest: "qbrt",
} as const;

/** `OP_2 PUSH32 <32 bytes>`. The 32 bytes are the P2MR program. */
function p2mrScript(): Uint8Array {
  const script = new Uint8Array(34);
  script[0] = 0x52;
  script[1] = 0x20;
  for (let i = 0; i < 32; i += 1) script[2 + i] = i + 1;
  return script;
}

/** Bech32 separator is the last `1`. The HRP is everything before it. */
function hrpOf(address: string): string {
  const separator = address.lastIndexOf("1");
  assert.ok(separator > 0, address);
  return address.slice(0, separator);
}

test("one P2MR script encodes the v1.0.0 HRP on each network and decodes back", () => {
  const script = p2mrScript();
  for (const network of ["mainnet", "testnet4", "regtest"] as const) {
    const address = addressOf(script, network);
    assert.equal(hrpOf(address), HRP[network], network);
    assert.equal(address, address.toLowerCase());
    const decoded = addressToScriptPubKey(address, network);
    assert.equal(Buffer.from(decoded).toString("hex"), Buffer.from(script).toString("hex"));
  }
});
