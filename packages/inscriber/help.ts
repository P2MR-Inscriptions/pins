// SPDX-License-Identifier: Apache-2.0

/**
 * The text of `--help` for every command of the inscriber. One table, so the overview and the page of each command
 * cannot disagree, and a test keeps it in step with the flags that `cli.ts` and `single.ts` read.
 */

export type Option = { flag: string; value?: string; text: string };
export type CommandHelp = { name: string; summary: string; network: "offline" | "node"; options: Option[]; notes?: string[] };

const LOGIN: Option[] = [
  { flag: "--rpc", value: "<url>", text: "The node's RPC URL, for example http://127.0.0.1:18452/" },
  { flag: "--rpc-user", value: "<user>", text: "RPC user, with --rpc-password. Or the variable QBIT_RPC_USER" },
  { flag: "--rpc-password", value: "<password>", text: "RPC password. Or the variable QBIT_RPC_PASSWORD, which keeps it off the command line" },
  { flag: "--rpc-cookie-file", value: "<path>", text: "The node's .cookie file instead of a user and password. Or the variable QBIT_RPC_COOKIE_FILE" },
  { flag: "--rpc-datadir", value: "<dir>", text: "The node's data directory instead of a user and password; the cookie of --network is read from it. Or the variable QBIT_RPC_DATADIR" },
];

const NETWORK: Option = { flag: "--network", value: "regtest|testnet4|mainnet", text: "The chain. Default regtest" };
const MARKER: Option = { flag: "--marker", value: "pins|<8 hex>", text: "The envelope marker. Default pins; another value is for a rehearsal, and mainnet refuses it" };
const SHOW_MARKER: Option = { flag: "--show-marker", text: "Print the marker even when it is not pins" };
const DRY_RUN: Option = { flag: "--dry-run", text: "Print the summary and write nothing" };
const OUT = (what: string): Option => ({ flag: "--out", value: "<file>", text: what });
const FEE_RATE: Option = { flag: "--fee-rate", value: "<bits/vB>", text: "Fee rate in bits per virtual byte" };
const UTXO: Option = { flag: "--utxo", value: "<file>", text: "The funding output file (see the utxo command)" };
const PUB: Option = { flag: "--pub", value: "<file>", text: "The public JSON file that keygen wrote" };
const COLLECTION: Option = { flag: "--collection", value: "<profile.json>", text: "The collection profile" };
const ZIP: Option = { flag: "--zip", value: "<collection.zip>", text: "The collection zip" };
const ASSIGNMENT: Option = { flag: "--assignment", value: "<file>", text: "The assignment file that assign wrote" };
const CREATOR: Option = { flag: "--creator", value: "<address>", text: "Receives the genesis, the leaf list and the reserve items (a single P2MR Inscription goes here)" };
const SALE: Option = { flag: "--sale", value: "<address>", text: "Sale holding address for the items that are not reserved. Not for a collection with no sale" };
const CHANGE: Option = { flag: "--change", value: "<address>", text: "Receives the change of every reveal" };
const HOLDER: Option = { flag: "--holder", value: "<address>", text: "For a collection with no sale: receives the items instead of --creator" };
const KEY: Option = { flag: "--key", value: "<keyfile>", text: "The encrypted keyfile that keygen wrote. The passphrase is typed on a terminal" };
const UNSOLD_ADDRESS: Option = { flag: "--unsold-address", value: "<address>", text: "The witness-v2 P2MR address that receives the unsold items, in lowercase. Used only for them" };
const RECORD_FILES: Option[] = [KEY, PUB, UTXO, COLLECTION, CREATOR, CHANGE, FEE_RATE, NETWORK, MARKER, SHOW_MARKER, DRY_RUN];
const SINGLE: Option[] = [
  { flag: "--single", text: "One stand-alone P2MR Inscription instead of a collection. It takes the three flags below and none of --collection, --zip, --assignment, --sale, --holder, --root" },
  { flag: "--body", value: "<file>", text: "With --single: the body, inscribed exactly as the file holds it. Not empty" },
  { flag: "--content-type", value: "<mime>", text: "With --single: an ASCII MIME type of at most 255 characters, for example text/plain;charset=utf-8" },
  { flag: "--metadata", value: "<file>", text: "With --single: optional metadata, JSON in the item record form" },
];

export const COMMANDS: CommandHelp[] = [
  {
    name: "keygen",
    summary: "Make the encrypted issuer keyfile and its public JSON file. Offline.",
    network: "offline",
    options: [
      OUT("The keyfile to write (mode 0600; an existing file is never overwritten). The public JSON file is written beside it"),
      { flag: "--no-sale", text: "Leave the sale secret out, for a collection that declares no sale" },
    ],
    notes: ["The keyfile is encrypted with scrypt (N = 2^17) and the passphrase you type. Keep two copies in two places."],
  },
  {
    name: "address",
    summary: "Print the funding address of an issuer key. Offline.",
    network: "offline",
    options: [PUB, NETWORK],
  },
  {
    name: "utxo",
    summary: "Ask your node for the funding output of the issuer key and write utxo.json. Reads only; sends nothing.",
    network: "node",
    options: [
      PUB,
      NETWORK,
      ...LOGIN,
      { flag: "--txid", value: "<txid>", text: "Pick the payment when the address has several outputs (needs the node's txindex=1)" },
      OUT("The funding file to write (txid, vout, value, script)"),
      DRY_RUN,
    ],
    notes: ["Prints the address, the output and its confirmations. preflight wants 6 confirmations."],
  },
  {
    name: "root",
    summary: "Print the Merkle root of a collection zip, or check a profile's root. Offline.",
    network: "offline",
    options: [
      ZIP,
      { flag: "--supply", value: "<n>", text: "The number of items in the zip (first is 1). Needed without --collection" },
      { ...COLLECTION, text: "A profile: its supply is used and its root is checked against the zip" },
    ],
  },
  {
    name: "assign",
    summary: "Draw the reserve and the sale list from the keyfile and write the assignment. Offline.",
    network: "offline",
    options: [KEY, COLLECTION, ZIP, OUT("The assignment file to write (reserve ids, sale ids, saleCommitment). It does not hold the sale secret")],
    notes: ["A collection with no sale gets an empty assignment and needs no --key."],
  },
  {
    name: "plan",
    summary: "Build the unsigned fan-out and reveals of a collection, or of one P2MR Inscription with --single. Reads the funding file.",
    network: "offline",
    options: [PUB, UTXO, ASSIGNMENT, COLLECTION, ZIP, CREATOR, SALE, CHANGE, HOLDER, FEE_RATE, NETWORK, MARKER, SHOW_MARKER, DRY_RUN, OUT("The unsigned plan to write"), ...SINGLE],
    notes: ["A collection needs --assignment, --collection and --zip. With --single it needs --body and --content-type instead, and no --assignment, --sale or --holder."],
  },
  {
    name: "sign",
    summary: "Check a plan against the files and sign it with the keyfile. Offline.",
    network: "offline",
    options: [KEY, { flag: "--plan", value: "<file>", text: "The unsigned plan" }, COLLECTION, ZIP, ASSIGNMENT, UTXO, CREATOR, SALE, CHANGE, HOLDER, NETWORK, MARKER, SHOW_MARKER, DRY_RUN, OUT("The signed plan to write"), ...SINGLE],
    notes: [
      "--creator, --sale, --change and --utxo are the values given to plan; they are not read from the plan.",
      "A plan from the price command is signed with --collection and --assignment and no --zip.",
      "--network and --marker apply to --single; a collection takes them from the plan.",
    ],
  },
  {
    name: "broadcast",
    summary: "Send the signed plan to your node: the fan-out, then the reveals.",
    network: "node",
    options: [
      { flag: "--plan", value: "<file>", text: "The signed plan" },
      { ...NETWORK, text: "The chain. Default: the plan's. mainnet and testnet4 also need --confirm-network" },
      { flag: "--confirm-network", value: "<name>", text: "The exact network name again, required for mainnet and testnet4" },
      ...LOGIN,
      { flag: "--mine", text: "Regtest only: mine while waiting and send all the reveals before mining any" },
      { flag: "--confirm-timeout", value: "<seconds>", text: "How long to wait for each confirmation" },
    ],
    notes: ["Running it again skips a transaction that is already confirmed."],
  },
  {
    name: "preflight",
    summary: "Check a signed plan against your node and the files before broadcast. Every row must be PASS.",
    network: "node",
    options: [
      { flag: "--plan", value: "<file>", text: "The unsigned plan" },
      { flag: "--signed", value: "<file>", text: "The signed plan" },
      UTXO, PUB, ASSIGNMENT, COLLECTION, ZIP,
      { ...KEY, text: "The keyfile, to reproduce the reserve and check the sale commitment. Without it those rows fail" },
      NETWORK,
      { flag: "--confirm-network", value: "<name>", text: "The exact network name again, required for mainnet and testnet4" },
      ...LOGIN,
      ...SINGLE,
      { flag: "--record", value: "unsold-address|sale-reveal|close", text: "Check the signed plan of one record instead of a launch. It takes --signed, --utxo, --pub, --collection and, for sale-reveal, --assignment" },
    ],
    notes: [
      "A collection needs --assignment, --collection and --zip. With --single it needs --body and --content-type instead.",
      "With --record the plan is the signed one of unsold-address, sale-reveal or close, and --zip, --plan, --key and --single are not used.",
    ],
  },
  {
    name: "price",
    summary: "Build the plan of the price P2MR Inscription that opens a sale. Offline; it does not broadcast.",
    network: "offline",
    options: [
      PUB,
      { flag: "--price", value: "<price.json>", text: "The price record" },
      { flag: "--genesis", value: "<txid>i<n>", text: "The id of the collection's genesis P2MR Inscription" },
      UTXO, CREATOR, SALE, CHANGE, FEE_RATE, NETWORK, MARKER, SHOW_MARKER, DRY_RUN,
      { flag: "--root", value: "<64 hex>", text: "The collection's Merkle root. Not needed with --collection" },
      { ...COLLECTION, text: "The collection profile, instead of --root" },
      { flag: "--schema", value: "<name>", text: "A rehearsal collection schema. Mainnet refuses any but the launch schema" },
      OUT("The price plan to write"),
    ],
  },
  {
    name: "unsold-address",
    summary: "Make the signed plan of the pins-unsold-address/1 P2MR Inscription that commits the unsold address. Offline; it does not broadcast.",
    network: "offline",
    options: [...RECORD_FILES, UNSOLD_ADDRESS, OUT("The signed plan to write")],
    notes: [
      "PINS-5 section 8.5: inscribe it before the sale reveal. The first valid commitment counts. It needs a collection that declares a sale.",
      "The plan is signed with the issuer key, so the command asks for the keyfile passphrase. Check it with preflight --record unsold-address, then send it with broadcast.",
    ],
  },
  {
    name: "sale-reveal",
    summary: "Make the signed plan of the pins-sale-reveal/1 P2MR Inscription that closes the sale and publishes the sale secret. Offline; it does not broadcast.",
    network: "offline",
    options: [...RECORD_FILES, ASSIGNMENT, OUT("The signed plan to write (mode 0600). It holds the sale secret")],
    notes: [
      "The plan holds the sale secret and broadcast makes it public. The command refuses a keyfile whose secret does not hash to the saleCommitment of the assignment.",
      "Check it with preflight --record sale-reveal --assignment, then send it with broadcast.",
    ],
  },
  {
    name: "unsold-transfer",
    summary: "Build the unsigned PSBTs that move the unsold sale items to the committed unsold address. Offline; it signs and sends nothing.",
    network: "offline",
    options: [
      { flag: "--items", value: "<file>", text: "JSON list of the unsold sale items, the outputs of the sale address that hold them: the rows of the wallet's listunspent for that address as they are, or txid, vout and value in bits" },
      { flag: "--sale-pub", value: "<64 hex>", text: "The 32-byte sale key that holds those outputs, the key of the mr(pk(...)) sale address. Left out, it is the key in the desc of the rows of --items" },
      { flag: "--funding", value: "<file>", text: "JSON list of the fee coins, one for each transaction: rows of listunspent (with desc), or txid, vout, value in bits and pub, the key that holds it" },
      UNSOLD_ADDRESS,
      CHANGE, FEE_RATE, NETWORK, DRY_RUN,
      { flag: "--per-tx", value: "<n>", text: "Items in each transaction. Default: as many as one standard transaction holds" },
      OUT("The PSBT files to write: <prefix>-1.psbt, <prefix>-2.psbt and so on, in base64"),
    ],
    notes: [
      "Output i pays the unsold address the value of input i and the fee coin is the last input, so every item keeps its offset (PINS-3 section 3). A fee coin must carry no P2MR Inscription.",
      "Sign each PSBT with the wallet that holds the sale key, and check the commitment on the indexer first (docs/guides/SALE-AND-TRADE.md).",
    ],
  },
  {
    name: "close",
    summary: "Make the signed plan of the pins-close/1 P2MR Inscription that closes the collection. Offline; it does not broadcast.",
    network: "offline",
    options: [...RECORD_FILES, OUT("The signed plan to write")],
    notes: [
      "PINS-5 section 7: inscribe it once the last item batch is confirmed. No P2MR Inscription after it is an item. It works for a collection with or without a sale.",
      "The count is the supply of the profile. Check it with preflight --record close, then send it with broadcast.",
    ],
  },
];

const byName = new Map(COMMANDS.map((command) => [command.name, command]));

export function isCommand(name: string | undefined): boolean {
  return name !== undefined && byName.has(name);
}

function optionHead(option: Option): string {
  return `  ${option.flag}${option.value ? ` ${option.value}` : ""}`;
}

/** The overview: every command with its summary, and how to ask for one command's options. */
export function overviewText(): string {
  const width = Math.max(...COMMANDS.map((command) => command.name.length)) + 2;
  return [
    "Usage: npm run inscribe -- <command> [options]",
    "       node --experimental-strip-types packages/inscriber/cli.ts <command> [options]",
    "",
    "Commands:",
    ...COMMANDS.map((command) => `  ${command.name.padEnd(width)}${command.summary}`),
    "",
    "Run `<command> --help` for the options of one command.",
    "The default network is regtest. Only utxo, broadcast and preflight talk to a node; the other commands refuse an RPC URL, and plan reads the funding file instead.",
    "The node login is a user and password, or the node's cookie: docs/guides/NODE-LOGIN.md.",
    "",
  ].join("\n");
}

/** The page of one command. */
export function commandText(name: string): string {
  const command = byName.get(name);
  if (!command) throw new Error(`unknown command ${name}`);
  const width = Math.max(...command.options.map((option) => optionHead(option).length)) + 2;
  return [
    `Usage: npm run inscribe -- ${command.name} [options]`,
    "",
    command.summary,
    command.network === "node" ? "It talks to your node, so it needs --rpc and a login." : "It does not talk to a node.",
    "",
    "Options:",
    ...command.options.map((option) => `${optionHead(option).padEnd(width)}${option.text}`),
    ...(command.notes?.length ? ["", ...command.notes] : []),
    "",
  ].join("\n");
}
