// SPDX-License-Identifier: Apache-2.0

/**
 * The funding file of `plan` (`utxo.json`), written from what a node says about the funding address.
 * The funding address is the one `address` prints. No wallet holds it, so a wallet's `listunspent` never shows it.
 * This module asks the node for the transaction (`getrawtransaction`, which needs `-txindex` for a transaction
 * that is not in the mempool) or scans the node's set of unspent outputs for the address (`scantxoutset`).
 * It writes nothing and signs nothing.
 */
import { addressToScriptPubKey, bytesToHex } from "@qbit-oss/protocol";
import type { Rpc } from "../indexer/follow.ts";
import { bitsFromQbt } from "./preflight.ts";
import type { MintNetwork } from "./network.ts";

/** The shape `plan` and `preflight` read: `value` is a decimal string of bits. */
export type FundingFile = { txid: string; vout: number; value: string; script: string };

export type FoundFunding = { file: FundingFile; confirmations: number };

type RawTx = { confirmations?: number; vout?: { value: number; n: number; scriptPubKey: { hex: string } }[] };
type Scan = { success: boolean; unspents?: { txid: string; vout: number; scriptPubKey: string; amount: number; height: number }[] };

/** The 6 confirmations that `preflight` asks of the funding output. */
export const FUNDING_CONFIRMATIONS = 6;

/**
 * With `txid`: the one output of that transaction that pays `address`.
 * Without it: the one unspent output of `address` that the node's UTXO set holds.
 * More than one match is refused, because the fan-out spends exactly one output.
 */
export async function findFunding(rpc: Rpc, address: string, network: MintNetwork, txid?: string): Promise<FoundFunding> {
  const script = bytesToHex(addressToScriptPubKey(address, network));
  if (txid !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error("--txid must be 64 lowercase hex characters");
    let tx: RawTx;
    try {
      tx = await rpc.call<RawTx>("getrawtransaction", [txid, true]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("No such")) throw new Error(`the node does not know transaction ${txid}: wrong id, a node that is not synced, or no -txindex (a transaction that is not in the mempool needs it)`, { cause: error });
      throw error;
    }
    const hits = (tx.vout ?? []).filter((output) => output.scriptPubKey.hex === script);
    if (hits.length === 0) throw new Error(`transaction ${txid} pays nothing to ${address}`);
    if (hits.length > 1) throw new Error(`transaction ${txid} pays ${address} in ${hits.length} outputs; fund the address with one payment`);
    const [hit] = hits;
    const spent = await rpc.call<unknown>("gettxout", [txid, hit.n, true]);
    if (spent === null) throw new Error(`output ${txid}:${hit.n} is already spent`);
    return { file: { txid, vout: hit.n, value: bitsFromQbt(hit.value).toString(), script }, confirmations: tx.confirmations ?? 0 };
  }
  const scan = await rpc.call<Scan>("scantxoutset", ["start", [`addr(${address})`]]);
  if (!scan.success) throw new Error("the node could not finish the scan; try again, or pass --txid");
  const unspents = scan.unspents ?? [];
  if (unspents.length === 0) throw new Error(`the node holds no unspent output for ${address}; pay it, wait for a block, or pass --txid`);
  if (unspents.length > 1) {
    throw new Error(`${unspents.length} unspent outputs pay ${address} (${unspents.map((item) => `${item.txid}:${item.vout}`).join(", ")}); pass --txid to choose the one payment`);
  }
  const [hit] = unspents;
  const tip = await rpc.call<number>("getblockcount");
  return {
    file: { txid: hit.txid, vout: hit.vout, value: bitsFromQbt(hit.amount).toString(), script: hit.scriptPubKey },
    confirmations: Math.max(0, tip - hit.height + 1),
  };
}
