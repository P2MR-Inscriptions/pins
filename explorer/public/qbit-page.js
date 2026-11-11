// Qbit sentences are taken from pages fetched on 8 Nov 2026:
// https://qbit.org/architecture
// https://qbit.org/consensus
// https://qbit.org/p2mr
// https://qbit.org/wallet
// PINS sentences are from docs/specs/PINS-1.md and docs/specs/PINS-3.md.
// Explorer package 1.0.1. This file does not change Qbit or PINS.

export const qbitLinks = [
  { href: "https://qbit.org", label: "qbit.org" },
  { href: "https://qbit.org/architecture", label: "Architecture" },
  { href: "https://qbit.org/consensus", label: "Consensus" },
  { href: "https://qbit.org/p2mr", label: "P2MR" },
  { href: "https://qbit.org/whitepaper", label: "White paper" },
  { href: "https://qbit.org/wallet", label: "Wallet" },
  { href: "https://qbit.org/pool/setup", label: "Mining pool" },
  { href: "https://qbit.org/ecosystem", label: "Ecosystem" },
  { href: "https://mempool.qbit.org", label: "Mempool" },
];

export const qbitSections = [
  {
    id: "network",
    title: "The network",
    blocks: [
      { kind: "p", text: "Qbit is a peer-to-peer network for the asset QBT.\nQbit Core is derived from Bitcoin Core 30.2, with its own genesis and consensus rules.\nA spendable output uses Pay-to-Merkle-Root and commits to a 32-byte Merkle root, which is a native witness version 2 program.\nThe public key is not in the output while the QBT is unspent.\nA spend reveals one path and signs it with SLH-DSA-SHA2-128s-bounded30, in the SLH-DSA / SPHINCS+ family.\nThe signature is 3,680 bytes." },
      { kind: "p", text: "New QBT is created as a block subsidy.\nIn the public launch profile that subsidy starts at 210 QBT, with no slow start, and it steps down every 43,200 blocks.\nThere is no premine.\nThe consensus cap on a money value is 210,000,000 QBT.\nBecause each step rounds down, the subsidy schedule sums to slightly less than that cap.\nOne QBT is 100,000,000 bits." },
    ],
  },
  {
    id: "p2mr",
    title: "P2MR",
    blocks: [
      { kind: "p", text: "The 32-byte witness program is the Merkle root.\nA spend reveals a leaf script and a Merkle path, and that root has to match.\nThe active leaf version is 0xc0.\nThe signature check is OP_CHECKSIGPQC." },
    ],
  },
  {
    id: "pins",
    title: "What PINS uses",
    blocks: [
      { kind: "p", text: "PINS writes content into an unexecuted envelope in a revealed P2MR leaf, at leaf version 0xc0.\nThe marker is the four bytes pins.\nEach P2MR Inscription is bound to one bit.\nLater spends move that bit first-in-first-out.\nOne QBT is 100,000,000 bits." },
      { kind: "p", text: "Conforming indexers that apply these rules to the same chain assign the same identifiers, the same numbers, and the same initial bit." },
    ],
  },
  {
    id: "wallet",
    title: "Qbit Wallet",
    blocks: [
      { kind: "p", text: "Qbit Wallet is a free Chrome extension for holding, sending, and receiving QBT.\nKeys are created in the extension, encrypted with the wallet password, and they stay on the device.\nChrome 114 or later can install it.\nBrave and Microsoft Edge can use the same Chrome Web Store listing." },
      { kind: "cta", href: "https://qbit.org/wallet", label: "Get Qbit Wallet" },
    ],
  },
  {
    id: "separate",
    title: "A separate protocol",
    blocks: [
      { kind: "p", text: "PINS is an independent protocol.\nIt is not a consensus change." },
    ],
  },
];
