<!-- SPDX-License-Identifier: Apache-2.0 -->

# Glossary

The words of PINS, in the sense the specifications use them. A name in `code type` is a name in the code or on the wire, and it keeps its spelling.

| Word | Meaning |
|---|---|
| **P2MR Inscription** | A body with a content type (and optional fields), written into a Qbit transaction inside an envelope that never runs, and bound to one bit. The noun of the whole project. The verb is *inscribe* |
| **Inscribe** | To put a P2MR Inscription on the chain: commit, then reveal |
| **PINS** | The protocol of P2MR Inscriptions. PINS-1 to PINS-6 are its standards |
| **Qbit** | The post-quantum network PINS runs on. The asset is QBT, and 1 QBT is 100,000,000 bits |
| **Bit** | The smallest unit of QBT, and the unit of ownership: a P2MR Inscription is bound to one bit of an output |
| **P2MR** | Pay-to-Merkle-Root, Qbit's witness version 2 output: a 32-byte program, script path only |
| **Leaf, leaf version `0xc0`** | A script in the Merkle tree of a P2MR output. The active leaf version is `0xc0` |
| **Envelope** | `OP_FALSE OP_IF … OP_ENDIF` in a revealed leaf. It starts with the marker and holds the fields and the body in pushes that are never executed (PINS-1 §4) |
| **Marker** | The 4 bytes `pins` (`70 69 6e 73`) at the start of an envelope. It is fixed, because it is in use on mainnet |
| **Field, tag** | A value in an envelope with a number: `content_type` (1), `pointer` (2), metadata (5), and so on. Odd unknown tags are ignored, even unknown tags make a P2MR Inscription opaque (PINS-1 §5) |
| **Body, content type** | The data of a P2MR Inscription, and its MIME type |
| **Metadata (field 5)** | A CBOR map in field 5, read by the strict reader of PINS-4 |
| **Commit, reveal** | The two steps of inscribing. The commit pays to an output whose Merkle tree has the leaf. The reveal spends it and shows the leaf, and with it the envelope |
| **Fan-out** | The one transaction of a launch that pays every commit, so that the reveals are independent of each other |
| **Batch** | Several items revealed in one transaction. `batchSize` of the profile sets how many |
| **ID** | `<txid>i<n>`: the txid of the reveal and the index of the envelope in it (PINS-1 §6.1) |
| **Number** | The place of a P2MR Inscription in one sequence that starts at 0, ordered by block, transaction and envelope (PINS-2 §4.1). It is global: every P2MR Inscription has one, whether or not it belongs to a collection |
| **Activation height** | The first block an indexer reads. Mainnet: 161,948 |
| **Indexer** | A program that reads the chain with the rules of PINS and derives numbers, locations and owners |
| **State hash (`stateHash`)** | The SHA-256 of the state of every P2MR Inscription at a tip. Two indexers on the same chain agree on it (PINS-2 §4.4) |
| **Replay** | Running an indexer over a range of mainnet and comparing its `stateHash` with the recorded one |
| **Vector** | A recorded input and the result the rule must give, in a JSON file in [docs/specs/vectors](specs/vectors/README.md). Another implementation can check itself against it |
| **FIFO** | First in, first out: the bits of the inputs of a transaction flow into the outputs in order, and a P2MR Inscription follows its bit (PINS-3) |
| **Opaque** | A P2MR Inscription with an unknown even tag: numbered and tracked, but not interpreted |
| **Burned, lost, unbound** | A P2MR Inscription on an `OP_RETURN` output, one whose bit lands in the part of the block subsidy and fees that the coinbase does not claim, and one whose first bit is at or after the value of the inputs (PINS-3) |
| **Collection** | A genesis P2MR Inscription and the items whose Merkle leaves match its root (PINS-5) |
| **Genesis** | The P2MR Inscription that carries the collection's name, supply, Merkle root, issuer key and, with a sale, the sale commitment |
| **Leaf list** | A P2MR Inscription that lists the leaf hashes of the collection, so that anyone can rebuild the root |
| **Item** | One P2MR Inscription of a collection, numbered from `first` (1 for Flatbits) for `supply` numbers. This is the collection's own series, not the P2MR Inscription number |
| **Merkle leaf, root** | `SHA-256(uint32be n, SHA-256 body, SHA-256 field 5)` of an item, and the root of the tree over all leaves (PINS-5 §5.1) |
| **Issuer key** | The key that signs the reveals of a collection. An item is authentic only under it |
| **Authentic** | An item that meets the seven rules of PINS-5 §9: it comes after the genesis and before the closing, is signed by the issuer key, matches leaf `n` of the root, and is the first P2MR Inscription to do so for its number. A copy is never authentic |
| **Profile** | The JSON file that gives the name, supply, batch size and sale choice of a collection. It is an input, not a default |
| **Reserve** | The items that the creator keeps, chosen by a draw that anyone can reproduce (PINS-5 §8) |
| **Sale, sale commitment** | The items that are not reserved, sold in an order that the sale secret fixes. The genesis commits to the SHA-256 of that secret before the sale (PINS-5 §8) |
| **Price P2MR Inscription** | The `pins-price/1` P2MR Inscription that opens a sale and gives `price_bits` (PINS-6 §5.1) |
| **Sale reveal** | The `pins-sale-reveal/1` P2MR Inscription that publishes the sale secret and ends the sale (PINS-5 §8.5) |
| **Unsold address** | The P2MR address that receives the sale items nobody bought. The issuer commits it in a `pins-unsold-address/1` P2MR Inscription before the sale reveal (PINS-5 §8.5) |
| **Closing** | The `pins-close/1` P2MR Inscription that freezes a collection: an item after it is not authentic |
| **Trade, PSBT** | A purchase in one transaction: the buyer pays and receives the output together, signed with `0x83` (`SIGHASH_SINGLE\|ANYONECANPAY`) (PINS-6) |
| **Keyfile** | The encrypted file that `keygen` writes. It holds the issuer key, the recovery key and, unless `--no-sale`, the sale secret |
| **Funding address** | The single-key P2MR address of the issuer key that `address` prints. It receives the one payment that funds a launch |
| **Plan** | The unsigned transactions of a launch, as `plan` writes them. `sign` rebuilds and checks them before it signs |
| **Preflight** | The checks run before broadcast. Every row must say `PASS` |
| **Regtest, testnet4, mainnet** | The private test chain on your computer, the public test network, and the real network |
| **`CONFIRMATIONS_FINAL`** | 6. A marketplace treats a sale as final after that many confirmations |
