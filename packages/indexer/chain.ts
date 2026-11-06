// SPDX-License-Identifier: Apache-2.0

/**
 * Turn a getblock verbosity-3 result into the block the rules engine applies.
 * Output values are read from the transaction hex, not from JSON numbers.
 * JSON numbers cannot hold a coinbase amount exactly.
 */
import { hexToBytes } from "@qbit-oss/protocol";
import { readCompactSize } from "../inscriber/compact.ts";
import type { ChainBlock, ChainTx } from "./pins.ts";

export type RpcTransaction = {
  txid: string;
  hex: string;
  vin: { coinbase?: string; txid?: string; vout?: number; txinwitness?: string[] }[];
  vout: { scriptPubKey: { hex: string } }[];
};

export type RpcBlock = {
  hash: string;
  height: number;
  previousblockhash?: string;
  tx: RpcTransaction[];
};

type Parsed = {
  inputs: { coinbase: boolean; prevTxid?: string; prevVout?: number; witness: Uint8Array[] }[];
  outputs: { value: bigint; script: Uint8Array }[];
};

function slice(raw: Uint8Array, offset: number, length: number): Uint8Array {
  if (offset + length > raw.length) throw new Error("transaction is truncated");
  return raw.subarray(offset, offset + length);
}

/** BIP144 decode of the inputs, outputs, and witness stacks. */
export function parseTransaction(raw: Uint8Array): Parsed {
  let offset = 4;
  const marker = raw[offset] === 0 && raw[offset + 1] === 1;
  if (marker) offset += 2;
  const inputs = readCompactSize(raw, offset);
  offset = inputs.next;
  const vins: Parsed["inputs"] = [];
  for (let i = 0; i < inputs.value; i += 1) {
    const prev = slice(raw, offset, 32);
    offset += 32;
    if (offset + 4 > raw.length) throw new Error("transaction is truncated");
    const vout = new DataView(raw.buffer, raw.byteOffset + offset, 4).getUint32(0, true);
    offset += 4;
    const script = readCompactSize(raw, offset);
    if (script.next + script.value > raw.length) throw new Error("transaction is truncated");
    offset = script.next + script.value;
    if (offset + 4 > raw.length) throw new Error("transaction is truncated");
    offset += 4;
    const coinbase = vout === 0xffffffff;
    vins.push({
      coinbase,
      prevTxid: coinbase ? undefined : Buffer.from(prev).reverse().toString("hex"),
      prevVout: coinbase ? undefined : vout,
      witness: [],
    });
  }
  const outputs = readCompactSize(raw, offset);
  offset = outputs.next;
  const vouts: Parsed["outputs"] = [];
  for (let i = 0; i < outputs.value; i += 1) {
    if (offset + 8 > raw.length) throw new Error("transaction is truncated");
    const value = new DataView(raw.buffer, raw.byteOffset + offset, 8).getBigUint64(0, true);
    offset += 8;
    const script = readCompactSize(raw, offset);
    offset = script.next;
    vouts.push({ value, script: slice(raw, offset, script.value) });
    offset += script.value;
  }
  if (marker) {
    for (const input of vins) {
      const count = readCompactSize(raw, offset);
      offset = count.next;
      for (let i = 0; i < count.value; i += 1) {
        const item = readCompactSize(raw, offset);
        offset = item.next;
        input.witness.push(slice(raw, offset, item.value));
        offset += item.value;
      }
    }
  }
  return { inputs: vins, outputs: vouts };
}

function leafScript(witness: Uint8Array[]): Uint8Array | undefined {
  if (witness.length < 2) return undefined;
  const end = witness[witness.length - 1]?.[0] === 0x50 ? witness.length - 1 : witness.length;
  return end >= 2 ? witness[end - 2] : undefined;
}

/**
 * `lookup` returns an output value this indexer has already stored.
 * Outputs created earlier in the same block are visible to later transactions.
 */
export function toChainBlock(block: RpcBlock, lookup: (txid: string, vout: number) => bigint | undefined): ChainBlock {
  const seen = new Map<string, bigint>();
  const txs: ChainTx[] = [];
  for (const tx of block.tx) {
    const parsed = parseTransaction(hexToBytes(tx.hex));
    const inputs = parsed.inputs.map((input, index) => {
      if (input.coinbase) return { coinbase: true, value: 0n };
      const key = `${input.prevTxid}:${input.prevVout}`;
      const value = seen.get(key) ?? lookup(input.prevTxid ?? "", input.prevVout ?? -1);
      if (value === undefined) throw new Error(`output ${key} has no stored value`);
      const witness = input.witness.length > 0 ? input.witness : (tx.vin[index]?.txinwitness ?? []).map((item) => hexToBytes(item));
      return { prevTxid: input.prevTxid, prevVout: input.prevVout, value, leafScript: leafScript(witness) };
    });
    parsed.outputs.forEach((output, vout) => seen.set(`${tx.txid}:${vout}`, output.value));
    txs.push({
      txid: tx.txid,
      inputs,
      outputs: parsed.outputs.map((output) => ({ value: output.value, script: output.script })),
    });
  }
  let fees = 0n;
  for (const tx of txs.slice(1)) {
    const inputTotal = tx.inputs.reduce((sum, input) => sum + input.value, 0n);
    const outputTotal = tx.outputs.reduce((sum, output) => sum + output.value, 0n);
    if (inputTotal > outputTotal) fees += inputTotal - outputTotal;
  }
  const claimed = txs[0]?.outputs.reduce((sum, output) => sum + output.value, 0n) ?? 0n;
  return {
    hash: block.hash,
    height: block.height,
    subsidy: claimed > fees ? claimed - fees : 0n,
    txs,
  };
}
