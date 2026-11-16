// SPDX-License-Identifier: Apache-2.0

/**
 * Turn a getblock verbosity-3 result into the block the rules engine applies.
 * Output values are read from the transaction hex, not from JSON numbers.
 * JSON numbers cannot hold a coinbase amount exactly.
 */
import { createHash } from "node:crypto";
import { hexToBytes } from "@qbit-oss/protocol";
import { readCompactSize, writeCompactSize } from "../inscriber/compact.ts";
import { isP2mr } from "./address.ts";
import { rpcAmountFromBits } from "./amount.ts";
import type { FollowNetwork } from "./chains.ts";
import type { ChainBlock, ChainTx } from "./pins.ts";

export type RpcPrevout = {
  value: unknown;
  scriptPubKey?: { hex?: string };
};

export type RpcVin = {
  coinbase?: string;
  txid?: string;
  vout?: number;
  txinwitness?: string[];
  prevout?: RpcPrevout;
};

export type RpcTransaction = {
  txid: string;
  hex: string;
  vin: RpcVin[];
  vout: { scriptPubKey: { hex: string } }[];
};

export type RpcBlock = {
  hash: string;
  height: number;
  previousblockhash?: string;
  tx: RpcTransaction[];
};

type Parsed = {
  inputs: { coinbase: boolean; prevTxid?: string; prevVout?: number; sequence: number; witness: Uint8Array[] }[];
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
    const sequence = new DataView(raw.buffer, raw.byteOffset + offset, 4).getUint32(0, true);
    offset += 4;
    const coinbase = vout === 0xffffffff;
    vins.push({
      coinbase,
      prevTxid: coinbase ? undefined : Buffer.from(prev).reverse().toString("hex"),
      prevVout: coinbase ? undefined : vout,
      sequence,
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

const SUBSIDY_INITIAL = 21_000_000_000n;
const SUBSIDY_NUMERATOR = 598n;
const SUBSIDY_DENOMINATOR = 625n;
/** Blocks between stepdowns. Regtest is short, as in Qbit Core's chain parameters. */
const SUBSIDY_STEP_INTERVAL: Record<FollowNetwork, number> = { mainnet: 43_200, testnet4: 43_200, regtest: 150 };

/** PINS-2 §5.1: the block subsidy in bits, from the height alone. */
export function subsidyAt(height: number, network: FollowNetwork): bigint {
  let subsidy = SUBSIDY_INITIAL;
  for (let steps = Math.floor(height / SUBSIDY_STEP_INTERVAL[network]); steps > 0 && subsidy > 0n; steps -= 1) {
    subsidy = (subsidy / SUBSIDY_DENOMINATOR) * SUBSIDY_NUMERATOR + ((subsidy % SUBSIDY_DENOMINATOR) * SUBSIDY_NUMERATOR) / SUBSIDY_DENOMINATOR;
  }
  return subsidy;
}

/**
 * PINS-1 §4.2: the leaf script is the second-to-last witness item once an annex is removed,
 * and the control block, the last item, must carry leaf version 0xc0. A reserved version
 * is not a P2MR Inscription.
 */
function leafScript(witness: Uint8Array[]): Uint8Array | undefined {
  if (witness.length < 2) return undefined;
  const end = witness[witness.length - 1]?.[0] === 0x50 ? witness.length - 1 : witness.length;
  if (end < 2) return undefined;
  const control = witness[end - 1];
  if (control.length === 0 || (control[0] & 0xfe) !== 0xc0) return undefined;
  return witness[end - 2];
}

/**
 * `lookup` returns an output value this indexer has already stored.
 * `p2mr` says whether a stored output is P2MR, and returns undefined when this indexer
 * has no record of its script. An input that spends a known non-P2MR output has no leaf script.
 * Outputs created earlier in the same block are visible to later transactions.
 * The subsidy comes from the height (PINS-2 §5.1). It is not read back from the coinbase,
 * so a coinbase that claims less than the subsidy and the fees leaves a lost tail.
 */
export function toChainBlock(
  block: RpcBlock,
  lookup: (txid: string, vout: number) => bigint | undefined,
  network: FollowNetwork,
  p2mr: (txid: string, vout: number) => boolean | undefined = () => undefined,
): ChainBlock {
  const seen = new Map<string, { value: bigint; p2mr: boolean }>();
  const txs: ChainTx[] = [];
  for (const tx of block.tx) {
    const parsed = parseTransaction(hexToBytes(tx.hex));
    const inputs = parsed.inputs.map((input, index) => {
      if (input.coinbase) return { coinbase: true, value: 0n };
      const key = `${input.prevTxid}:${input.prevVout}`;
      const earlier = seen.get(key);
      const value = earlier?.value ?? lookup(input.prevTxid ?? "", input.prevVout ?? -1);
      if (value === undefined) throw new Error(`output ${key} has no stored value`);
      const spendsP2mr = earlier?.p2mr ?? p2mr(input.prevTxid ?? "", input.prevVout ?? -1);
      const witness = input.witness.length > 0 ? input.witness : (tx.vin[index]?.txinwitness ?? []).map((item) => hexToBytes(item));
      return {
        prevTxid: input.prevTxid,
        prevVout: input.prevVout,
        value,
        leafScript: spendsP2mr === false ? undefined : leafScript(witness),
        p2mr: spendsP2mr,
        witnessItems: witness.length,
      };
    });
    parsed.outputs.forEach((output, vout) => seen.set(`${tx.txid}:${vout}`, { value: output.value, p2mr: isP2mr(output.script) }));
    txs.push({
      txid: tx.txid,
      inputs,
      outputs: parsed.outputs.map((output) => ({ value: output.value, script: output.script })),
    });
  }
  return {
    hash: block.hash,
    height: block.height,
    subsidy: subsidyAt(block.height, network),
    txs,
  };
}

/**
 * The same ChainBlock as `toChainBlock`, built from a parsed raw block. Values
 * come from `lookup` and from outputs earlier in this block. There is no
 * second decode of transaction hex.
 */
export function chainBlockFromRaw(
  raw: RawBlock,
  hash: string,
  height: number,
  lookup: (txid: string, vout: number) => bigint | undefined,
  network: FollowNetwork,
  p2mr: (txid: string, vout: number) => boolean | undefined = () => undefined,
): ChainBlock {
  const seen = new Map<string, { value: bigint; p2mr: boolean }>();
  const txs: ChainTx[] = [];
  for (const tx of raw.txs) {
    const inputs = tx.inputs.map((input) => {
      if (input.coinbase) return { coinbase: true as const, value: 0n };
      const key = `${input.prevTxid}:${input.prevVout}`;
      const earlier = seen.get(key);
      const value = earlier?.value ?? lookup(input.prevTxid ?? "", input.prevVout ?? -1);
      if (value === undefined) throw new Error(`output ${key} has no stored value`);
      const spendsP2mr = earlier?.p2mr ?? p2mr(input.prevTxid ?? "", input.prevVout ?? -1);
      return {
        prevTxid: input.prevTxid,
        prevVout: input.prevVout,
        value,
        leafScript: spendsP2mr === false ? undefined : leafScript(input.witness),
        p2mr: spendsP2mr,
        witnessItems: input.witness.length,
      };
    });
    tx.outputs.forEach((output, vout) => seen.set(`${tx.txid}:${vout}`, { value: output.value, p2mr: isP2mr(output.script) }));
    txs.push({
      txid: tx.txid,
      inputs,
      outputs: tx.outputs.map((output) => ({ value: output.value, script: output.script })),
    });
  }
  return {
    hash,
    height,
    subsidy: subsidyAt(height, network),
    txs,
  };
}

/** The 8-decimal amount and script hex of one spent output, as getblock verbosity 3 writes them. */
export function rpcPrevout(value: bigint, script: Uint8Array): RpcPrevout {
  return { value: rpcAmountFromBits(value), scriptPubKey: { hex: Buffer.from(script).toString("hex") } };
}

/**
 * Fill `vin[].prevout` from parent transaction hex (the same data Qbit Core
 * reads from undo data). Parents may be earlier in this block or supplied by
 * `lookup`. Used by tests and by a replay that has raw blocks, not by the
 * live follow path.
 */
export function fillBlockPrevouts(block: RpcBlock, lookup: (txid: string) => string | undefined = () => undefined): RpcBlock {
  const inBlock = new Map(block.tx.map((tx) => [tx.txid, tx.hex]));
  return {
    ...block,
    tx: block.tx.map((tx) => {
      const parsed = parseTransaction(hexToBytes(tx.hex));
      const vin = parsed.inputs.map((input, index) => {
        const existing = tx.vin[index] ?? {};
        if (input.coinbase) return { ...existing, coinbase: existing.coinbase ?? "00" };
        const hex = (input.prevTxid ? inBlock.get(input.prevTxid) : undefined) ?? (input.prevTxid ? lookup(input.prevTxid) : undefined);
        if (!hex || input.prevTxid === undefined || input.prevVout === undefined) {
          throw new Error(`missing parent ${input.prevTxid}:${input.prevVout} while filling prevout`);
        }
        const parent = parseTransaction(hexToBytes(hex));
        const output = parent.outputs[input.prevVout];
        if (!output) throw new Error(`output ${input.prevTxid}:${input.prevVout} is missing`);
        return {
          ...existing,
          txid: input.prevTxid,
          vout: input.prevVout,
          prevout: rpcPrevout(output.value, output.script),
        };
      });
      return { ...tx, vin };
    }),
  };
}


/** Qbit canonical layout: AuxPoW flag is bit 8, only when the top bits are 0x20000000. */
const BLOCK_VERSION_TOP_BITS = 0x20000000;
const BLOCK_VERSION_TOP_MASK = 0xe0000000;
const BLOCK_VERSION_AUXPOW = 0x00000100;

function dsha(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(createHash("sha256").update(bytes).digest()).digest();
}

/**
 * Decode a getblock verbosity-0 hex string. Node's hex decoder is used
 * instead of a per-character check, and the length is checked so an invalid
 * body is refused rather than silently shortened.
 */
export function bytesFromRpcHex(hex: string): Buffer {
  if (hex.length % 2 !== 0) throw new Error("block hex has an odd length");
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length !== hex.length / 2) throw new Error("block hex is not hexadecimal");
  return bytes;
}

function u32(raw: Uint8Array, offset: number): number {
  if (offset + 4 > raw.length) throw new Error("block is truncated");
  return new DataView(raw.buffer, raw.byteOffset + offset, 4).getUint32(0, true);
}

function isAuxpowVersion(version: number): boolean {
  return (version & BLOCK_VERSION_TOP_MASK) === BLOCK_VERSION_TOP_BITS && (version & BLOCK_VERSION_AUXPOW) !== 0;
}

/**
 * One transaction in a raw block: the BIP144 bytes, its txid, and the decoded
 * inputs and outputs. `next` is the offset after this transaction.
 */
export type RawTx = {
  txid: string;
  hex: string;
  next: number;
  inputs: Parsed["inputs"];
  outputs: Parsed["outputs"];
};

export type RawBlock = {
  previousblockhash: string;
  txs: RawTx[];
};

/** Read one transaction at `offset` (witness layout if the marker is present). */
export function readTransaction(raw: Uint8Array, offset: number, includeHex = true): RawTx {
  const start = offset;
  offset += 4;
  if (offset + 1 >= raw.length) throw new Error("transaction is truncated");
  const marker = raw[offset] === 0 && raw[offset + 1] === 1;
  if (marker) offset += 2;
  const inStart = offset;
  const parsed = parseTransaction(raw.subarray(start));
  // Walk the same bytes to find the end, including the 4-byte lock time.
  let pos = inStart;
  const inputCount = readCompactSize(raw, pos);
  pos = inputCount.next;
  for (let i = 0; i < inputCount.value; i += 1) {
    pos += 36;
    const script = readCompactSize(raw, pos);
    pos = script.next + script.value + 4;
  }
  const outputCount = readCompactSize(raw, pos);
  pos = outputCount.next;
  for (let i = 0; i < outputCount.value; i += 1) {
    pos += 8;
    const script = readCompactSize(raw, pos);
    pos = script.next + script.value;
  }
  const outEnd = pos;
  if (marker) {
    for (let i = 0; i < inputCount.value; i += 1) {
      const count = readCompactSize(raw, pos);
      pos = count.next;
      for (let j = 0; j < count.value; j += 1) {
        const item = readCompactSize(raw, pos);
        pos = item.next + item.value;
      }
    }
  }
  const next = pos + 4;
  if (next > raw.length) throw new Error("transaction is truncated");
  const encoded = raw.subarray(start, next);
  const stripped = marker
    ? Buffer.concat([Buffer.from(raw.subarray(start, start + 4)), Buffer.from(raw.subarray(inStart, outEnd)), Buffer.from(raw.subarray(pos, next))])
    : Buffer.from(encoded);
  return {
    txid: Buffer.from(dsha(stripped)).reverse().toString("hex"),
    hex: includeHex ? Buffer.from(encoded).toString("hex") : "",
    next,
    inputs: parsed.inputs,
    outputs: parsed.outputs,
  };
}

function skipVector32(raw: Uint8Array, offset: number): number {
  const count = readCompactSize(raw, offset);
  const next = count.next + count.value * 32 + 4;
  if (next > raw.length) throw new Error("block is truncated");
  return next;
}

function skipAuxpow(raw: Uint8Array, offset: number): number {
  // CAuxPow: a no-witness coinbase, two merkle branches, the parent 80-byte header.
  offset = readTransaction(raw, offset).next;
  offset = skipVector32(raw, offset);
  offset = skipVector32(raw, offset);
  if (offset + 80 > raw.length) throw new Error("block is truncated");
  return offset + 80;
}

/**
 * Decode a getblock verbosity-0 payload (the block's raw bytes). AuxPoW
 * (Qbit version bit 0x100) is skipped; the hash of the block is the 80-byte
 * header, not the AuxPoW payload.
 */
export function parseRawBlock(raw: Uint8Array, options?: { includeHex?: boolean }): RawBlock {
  if (raw.length < 80) throw new Error("block is truncated");
  const includeHex = options?.includeHex ?? true;
  const previousblockhash = Buffer.from(raw.subarray(4, 36)).reverse().toString("hex");
  let offset = 80;
  if (isAuxpowVersion(u32(raw, 0))) offset = skipAuxpow(raw, offset);
  const count = readCompactSize(raw, offset);
  offset = count.next;
  const txs: RawTx[] = [];
  for (let i = 0; i < count.value; i += 1) {
    const tx = readTransaction(raw, offset, includeHex);
    txs.push(tx);
    offset = tx.next;
  }
  if (offset !== raw.length) throw new Error("block has trailing bytes");
  return { previousblockhash, txs };
}

/** The hex a test RPC can return for getblock verbosity 0, from already-known transactions. */
export function rawBlockHex(block: Pick<RpcBlock, "previousblockhash" | "tx">): string {
  const header = Buffer.alloc(80);
  header.writeUInt32LE(1, 0);
  if (block.previousblockhash) Buffer.from(block.previousblockhash, "hex").reverse().copy(header, 4);
  const txs = block.tx.map((item) => Buffer.from(item.hex, "hex"));
  return Buffer.concat([header, writeCompactSize(txs.length), ...txs]).toString("hex");
}

/** An RpcBlock built from raw transactions, with no prevout fields. */
export function rpcBlockFromRaw(raw: RawBlock, hash: string, height: number): RpcBlock {
  return {
    hash,
    height,
    previousblockhash: raw.previousblockhash,
    tx: raw.txs.map((tx) => ({
      txid: tx.txid,
      hex: tx.hex,
      vin: tx.inputs.map((input) => (
        input.coinbase
          ? { coinbase: "00" }
          : { txid: input.prevTxid, vout: input.prevVout }
      )),
      vout: tx.outputs.map((output) => ({ scriptPubKey: { hex: Buffer.from(output.script).toString("hex") } })),
    })),
  };
}

/** True when a non-coinbase input spends an output this store has not seen and this block does not create. */
export function rawBlockNeedsPrevouts(
  raw: RawBlock,
  known: (txid: string, vout: number) => bigint | undefined,
): boolean {
  const created = new Set(raw.txs.map((tx) => tx.txid));
  for (const tx of raw.txs) {
    for (const input of tx.inputs) {
      if (input.coinbase || !input.prevTxid || input.prevVout === undefined) continue;
      if (created.has(input.prevTxid)) continue;
      if (known(input.prevTxid, input.prevVout) === undefined) return true;
    }
  }
  return false;
}
