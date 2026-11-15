<!-- SPDX-License-Identifier: Apache-2.0 -->

# Single P2MR Inscriptions

This guide inscribes one P2MR Inscription with the reference inscriber. Rehearse on regtest first: [Try it on your own regtest node](REGTEST.md#5-a-single-p2mr-inscription) does exactly this on a private node.

A P2MR Inscription does not need a collection. PINS-1 defines one P2MR Inscription as an envelope with a content type and a body in a revealed leaf. A collection (PINS-5) is a layer on top of it: a genesis P2MR Inscription and the items that match its Merkle root.

Steps, in order (the commands of the reference inscriber are in [docs/inscriber/README.md](../inscriber/README.md)):

1. `keygen --no-sale --out issuer.key`, then `address --pub issuer.key.pub.json --network regtest`, on a machine with no network. A single P2MR Inscription reads no sale secret, and a keyfile made with a sale secret works too.
2. Pay the funding address in one payment, wait for 6 confirmations, and write that output to `utxo.json` with `utxo` (one object: `txid`, `vout`, `value` in bits as a decimal string, `script` in hex; it must be the issuer key's own P2MR address). A wallet's `listunspent` does not show it, because no wallet owns the address.
3. Run `plan --single`, then `sign --single` offline, then `preflight --single`, then `broadcast` (the four commands are below).
4. Point the [indexer](../../packages/indexer/README.md) at the same node and read the P2MR Inscription from `/inscription/{id}`.

- **The indexer** numbers, locates and tracks every P2MR Inscription with the marker, in or out of a collection. `/inscription/{id}`, `/content/{id}`, `/inscriptions?owner=` and `/output/{outpoint}` answer for any of them. `/collection` and `/pieces` are only about a collection. A single P2MR Inscription is never a collection item, so it is never authentic in the sense of PINS-5 §9.
- **The reference inscriber inscribes one with `--single`.** `plan`, `sign` and `preflight` take `--single`, a `--body` file, a `--content-type`, and optionally `--metadata`. There is no genesis, no collection profile, no zip, no assignment, no reserve and no sale. One fan-out pays one reveal, and the reveal holds the one P2MR Inscription and the change.
- **The body is inscribed exactly as the file holds it**, with any content type that is a short ASCII MIME type (for example `text/plain;charset=utf-8` or `image/png`). It is not converted. `--metadata` is a JSON file with the same record form as an item of a collection, `{"meta": {"name": "...", "attributes": [{"trait_type": "...", "value": "..."}]}}`, and is written as field 5 in canonical form. Leave it out for no field 5.
- **Where the output goes** follows the same destination rule as every other output (`packages/inscriber/destination.ts`): the P2MR Inscription goes to `--creator`, and the last output of the reveal is change, which goes to `--change`. The funding address (from `address`) must be a third address. Keep `--creator` in a wallet you do not pay from, because the output it receives holds a P2MR Inscription and a payment can spend it. `--sale`, `--holder`, `--collection`, `--zip`, `--assignment` and `--root` are refused with `--single`.
- **`sign --single` does not trust the plan.** It rebuilds the reveal leaf from the body, content type and metadata files and the issuer key of the keyfile, and refuses a plan whose leaf, outputs or addresses differ. The files you pass to `sign` are the ones that get signed. A plan cannot move itself into the single path, and a single plan cannot be signed as a collection plan.
- **The id** of the P2MR Inscription is the txid of the reveal, `i0`. `plan` prints it before anything is broadcast.

```text
node --experimental-strip-types packages/inscriber/cli.ts plan --single --body note.txt --content-type "text/plain;charset=utf-8" --pub issuer.key.pub.json --utxo utxo.json --creator <address> --change <address> --fee-rate 1 --network regtest --out plan.json
node --experimental-strip-types packages/inscriber/cli.ts sign --single --body note.txt --content-type "text/plain;charset=utf-8" --key issuer.key --plan plan.json --utxo utxo.json --creator <address> --change <address> --network regtest --out plan.signed.json
node --experimental-strip-types packages/inscriber/cli.ts preflight --single --body note.txt --content-type "text/plain;charset=utf-8" --network regtest --plan plan.json --signed plan.signed.json --utxo utxo.json --pub issuer.key.pub.json --rpc http://127.0.0.1:18452/ --rpc-user YOUR_RPC_USER --rpc-password YOUR_RPC_PASSWORD
node --experimental-strip-types packages/inscriber/cli.ts broadcast --plan plan.signed.json --network regtest --mine --rpc http://127.0.0.1:18452/ --rpc-user YOUR_RPC_USER --rpc-password YOUR_RPC_PASSWORD
```

`--single` takes `plan`, `sign` and `preflight`. `keygen`, `address` and `broadcast` are the same as for a collection, and there is no `assign` step because there is no reserve. The keyfile may be made with `keygen --no-sale`, since no sale secret is read. On mainnet, pass `--network mainnet` and `--confirm-network mainnet` to `preflight` and `broadcast`, as for a collection. The same rule holds as everywhere: rehearse on regtest first, and a launch of your own is described in [the launch guide](COLLECTION-LAUNCH.md).

A collection of one item still works (a profile with `"supply": 1`, `"batchSize": 1`, and `"sale": false`). It writes a genesis and one image item, which is two P2MR Inscriptions, and is for a collection that you mean to be a collection.
