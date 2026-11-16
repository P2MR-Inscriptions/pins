// SPDX-License-Identifier: Apache-2.0

// Local setup guide. Text only. No remote calls and no credentials.
// Explorer package 1.0.1.

export const pinsSource = {
  href: "https://github.com/P2MR-Inscriptions/pins",
  label: "PINS on GitHub",
};

export const guideSections = [
  {
    id: "prerequisites",
    title: "Prerequisites",
    blocks: [
      { kind: "p", text: "This guide is for explorer 1.0.1.\nThat number is this package.\nIt is not a PINS protocol version." },
      { kind: "p", text: "Open a terminal in the directory that contains package.json.\nRun every command below from that directory.\nThat directory is explorer/ inside the PINS repository.\nDo not install this explorer as a global npm package." },
      { kind: "p", text: "Use Node.js 22.13 up to 24 (older than 25).\nNode 22.12 and older do not have node:sqlite without a flag.\nCheck with node -v." },
      { kind: "p", text: "A real index needs a local Qbit node that has finished sync.\nThe indexer reads the block, including its witness scripts.\nIf those scripts are missing, it stops with “witness pruned” and refuses that transaction.\nStart the node the way you already run Qbit Core.\nThis explorer does not start the node." },
      { kind: "p", text: "This build listens only on loopback.\nThe default explorer address is http://127.0.0.1:8080.\nThe default indexer address is http://127.0.0.1:8787.\nNode RPC stays on loopback." },
      { kind: "p", text: "From this directory, npm ci --ignore-scripts installs this explorer's tools.\nThe indexer is the one in the parent directory, the PINS repository.\nnpm run dev serves synthetic data at http://127.0.0.1:8080 and shows a mock banner.\nIt does not use your node." },
    ],
  },
  {
    id: "configuration",
    title: "Configuration",
    blocks: [
      { kind: "p", text: "Copy .env.example to .env once, in this directory.\nThen use one of the RPC settings below.\nThe files are read as literal text.\nA value is not executed as a shell command." },
      { kind: "ul", items: [
        "Set QBIT_CONF to the path of the qbit.conf the node already uses.\nOnly rpcuser, rpcpassword, rpcbind, and rpcport are read.\nDo not change qbit.conf for this explorer.",
        "Or set QBIT_RPC_URL, QBIT_RPC_USER, and QBIT_RPC_PASSWORD together.\nThe URL must be loopback HTTP.",
        "Or, for a node that started without rpcuser, set QBIT_RPC_URL and QBIT_RPC_DATADIR (the node's data directory), with PINS_NETWORK for a regtest or testnet4 node.\nOr name the cookie file itself with QBIT_RPC_COOKIE_FILE.\nThe cookie is read for every call, and only for a URL on this machine.",
      ] },
      { kind: "p", text: "If QBIT_CONF is set and QBIT_RPC_URL is empty, the port is rpcport, or 8352 when rpcport is absent.\nThe indexer calls 127.0.0.1.\nThe explorer uses rpcbind only when that value is a loopback address.\nOtherwise the explorer also uses 127.0.0.1." },
      { kind: "p", text: "Leave the user and password out of commands, tickets, and screenshots." },
    ],
  },
  {
    id: "fresh-setup",
    title: "Fresh setup",
    blocks: [
      { kind: "p", text: "Use this for a first install." },
      { kind: "steps", items: [
        { label: "Install the indexer's tools", code: "npm --prefix .. ci --ignore-scripts", text: "Expected: the command finishes and node_modules is present in the parent directory.\nThe indexer is the one in that PINS repository.\nNothing is downloaded." },
        { label: "Install the local tools", code: "npm ci --ignore-scripts", text: "Expected: the command finishes and node_modules is present.\nThe indexer is not running yet." },
        { label: "Create the local settings", code: "cp .env.example .env", text: "Edit .env with one of the RPC settings in Configuration.\nExpected: .env exists on this computer only.\nDo not paste it into a ticket." },
      ] },
    ],
  },
  {
    id: "two-processes",
    title: "Node, indexer, and explorer",
    blocks: [
      { kind: "p", text: "The Qbit node, the indexer, and the explorer are three programs.\nThe node checks Qbit blocks.\nThe indexer reads that node and stores the result in data/index.sqlite.\nThe explorer reads the indexer and serves this page.\nNone of them is a wallet." },
      { kind: "p", text: "Use two terminals in this directory and leave both running.\nThe node should already be running.\nStart the indexer first." },
      { kind: "steps", items: [
        { label: "Terminal 1, indexer", code: "npm run indexer", text: "Expected: the terminal stays open.\nThe first catch-up can take a long time.\nThe HTTP API on 127.0.0.1:8787 starts only after that catch-up.\nUntil then the indexer does not answer HTTP, because each node call waits for the RPC response.\nnpm run indexer follows mainnet unless PINS_NETWORK is regtest or testnet4." },
        { label: "Terminal 2, explorer", code: "npm start", text: "Expected: the terminal stays open and the page is at http://127.0.0.1:8080.\nYou can open it during catch-up.\nThe footer then shows the indexer as unreachable, or the page says the first snapshot is still loading.\nThat wait is normal.\nStop a process with Ctrl+C in its own terminal, and start it again with the same command and no extra arguments.\nReload the browser after you restart the explorer." },
      ] },
    ],
  },
  {
    id: "snapshot",
    title: "Snapshot and preview",
    blocks: [
      { kind: "p", text: "After the indexer API answers, this explorer reads the P2MR Inscription list first.\nThat preview shows the latest P2MR Inscriptions, ordered by block height, then the transaction's position in the block, then the envelope index.\nIt does not show collection item totals." },
      { kind: "p", text: "Collection items arrive 100 at a time.\nThe homepage does not wait for every page.\nCollection totals and the Authentic badge stay hidden until that item check finishes and the snapshot is not stale.\nReload the page after the footer leaves syncing if the totals are still hidden." },
      { kind: "p", text: "A full snapshot is kept only when the indexer tip is the same at the start and the end of the read.\nIf the tip moves, that mix is not published.\nThe footer can say stale and keep the last consistent snapshot.\nWait, or reload later.\nDo not delete the database." },
    ],
  },
  {
    id: "read-only",
    title: "Read-only",
    blocks: [
      { kind: "p", text: "The explorer does not sign and does not broadcast.\nIt does not keep a wallet.\nIts own node calls are only getblockcount, getblockhash, getblockheader, and getrawtransaction.\nThe indexer is the separate process that reads blocks." },
      { kind: "p", text: "PNG, JPEG, GIF, and WebP are drawn in the same frame.\nText and JSON are shown there as plain text, cut off after 2,048 bytes.\nAudio and video use the browser's own controls in that frame.\nThey start only after a click.\nA web page runs only after a click, in a frame whose sandbox is allow-scripts and whose response sets connect-src to none.\nThat frame cannot fetch this explorer or the indexer.\nIt can still change the address of its own frame, which the response cannot stop, so open only pages you trust.\nSVG is shown as an image, so its scripts do not run.\nOther formats stay in the frame with the content type and a download.\nThe detail page can enlarge that frame.\nThe sandbox does not cap processor time.\nStop closes the page." },
      { kind: "p", text: "A password is placed in the indexer process environment.\nIt is not an argument to npm or node.\nThe indexer sends it to the node in an Authorization header.\nA cookie login passes only the path of the cookie file.\nnpm --silent only hides npm's log line." },
    ],
  },
  {
    id: "status",
    title: "Status",
    blocks: [
      { kind: "p", text: "The footer reports what this process last read.\nGreen is not a general health light." },
      { kind: "ul", items: [
        "Network is the chain name from the indexer.",
        "Indexed in green, with current, means the snapshot height matches the indexer tip.\nIt does not mean the collection is authentic.",
        "Indexed in amber means syncing, stale, or behind that tip.\nSyncing covers the preview, before the full snapshot is ready.\nA connected node is not treated as a current index.",
        "Count is how many P2MR Inscriptions are in the snapshot.\nOne is 1 P2MR Inscription.\nIt is not an authentic total.",
        "Node in green means RPC answered.\nIt does not mean the index is synced.\nRed means disconnected.\nOff means RPC was not configured.",
        "A red Indexer tag means this page could not read the indexer.",
      ] },
      { kind: "p", text: "The state hash is the full 64 hex characters, next to State.\nIt identifies the snapshot.\nIt is not a secret." },
    ],
  },
  {
    id: "authenticity",
    title: "Authenticity",
    blocks: [
      { kind: "p", text: "An Authentic badge is shown only when the indexer piece record for that exact P2MR Inscription has authentic set to true and the snapshot is not stale.\nAny other result does not show the badge.\nThis explorer does not recompute the collection check.\nManifest fields stay labeled apart from chain data." },
      { kind: "p", text: "Every P2MR Inscription has one global number, counted from 0 in the order of block, transaction, and envelope.\nThe thumbnail captions write it as Pins #N.\nThe latest P2MR Inscription on the home page and each P2MR Inscription's own page write it as P2MR Inscription #N.\nA collection also numbers its items from its own first number.\nThat item number is shown only in the collection view and in the Collection facts of an item, and it is not the global number.\nThe search box takes the global number (7, #7, 10,001, Pins #7, P2MR Inscription #7), a P2MR Inscription id, a transaction id, an address, or a block (block 5).\nIt does not search by item number." },
    ],
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    blocks: [
      { kind: "p", text: "Run these from the directory that contains package.json.\nThey take no passwords and no extra arguments." },
      { kind: "code", text: "node -v\nnpm test" },
      { kind: "p", text: "Expected: node -v prints a version from 22.13 up to, but not including, 25.\nnpm test uses loopback fixtures.\nIt does not contact your node and does not print RPC values." },
      { kind: "ul", items: [
        "If the explorer says the indexer is unreachable, confirm npm run indexer is still running and that catch-up has finished.\nPort 8787 is silent until then.\nThen reload the browser.",
        "If the indexer prints witness pruned, the node did not return the witness scripts.\nUse a synced node that still has those scripts.\nDo not change qbit.conf from these steps.",
        "If npm run indexer says to run npm ci in the repository root, run npm --prefix .. ci --ignore-scripts and start it again.",
        "If the page looks old, reload it.\nDo not restart the indexer for a page-only change.",
      ] },
      { kind: "p", text: "Do not put the RPC user or password in a command, a URL, or a bug report." },
    ],
  },
];
