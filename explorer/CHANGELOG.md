# Changelog

## 1.0.1

- `npm run dev` follows `MOCK_PORT` and `PORT`. The explorer reads the mock this command started.
- If either port is already in use, the command exits with an error and does not leave that mock or explorer running.
- Explorer package 1.0.1. The PINS protocol and the pinned indexer commit are unchanged.

## 1.0.0

- Explorer package 1.0.0. The pinned PINS indexer commit is unchanged. This is not a protocol release.
- The Qbit page follows the architecture and consensus documents. It does not claim that no coins can be transferred after they are mined.
- How it works explains the working directory, the Qbit node, the indexer, and the explorer, with commands in order and the result to expect.
- A working install, including 0.2.18 and 0.2.19, does not run `npm ci` or `npm run setup` and does not replace `.env`, `vendor/`, or `data/`.
- What is Qbit states the checked Qbit facts directly. The footer sentence stays “PINS is an independent protocol.”
- Desktop, tablet, and phone layouts are unchanged.

## 0.2.19

- Below 1280px the header uses a menu button. At 1280px and wider the menu stays in the header row.
- Below 1280px the latest feature, its heading, and its number are centered. The heading stays on one line. The footer groups are centered.
- On a phone the home title stays on one line and the two sentences stay on two lines. The title sits closer to those sentences.
- On a phone and on a tablet the space above the latest feature matches the space below it. The tablet feature frame is the larger approved size.
- The desktop layout at 1280px and wider is the 0.2.18 layout. The sentence in the footer stays “PINS is an independent protocol.”

## 0.2.18

- Previous, next, and Back draw their arrows. Status marks draw the same way.
- The centered footer sentence stays “PINS is an independent protocol.”
- The Qbit page keeps “PINS is an independent protocol.” and drops the old affiliation line.
- PNG, JPEG, GIF, WebP, SVG, text, JSON, audio, and video are shown in the existing frame. A web page runs only after a click, in a sandbox that cannot reach this explorer. Other types stay in that frame with a download.
- The detail frame has a fullscreen control. The inscribed page cannot open fullscreen by itself.

## 0.2.12

- Home keeps a 160px gap under the header and an 80px gap under the introduction when the desktop viewport is tall enough. On a shorter desktop the upper gap shrinks first, then the lower gap, so the page stays in view. The 15-item block is not resized for that. A phone scrolls.
- The state hash is the full 64 hex characters, on the left, in monospace. It is not shortened.
- Qbit is a page in the menu. Its links are the public qbit.org documents checked on 8 Nov 2026.

## 0.2.11

- The home introduction no longer absorbs the spare window height. The heading is READ FROM YOUR OWN NODE, and LATEST P2MR INSCRIPTION uses Chakra Petch Bold.
- The footer has three zones: the state hash on the left, the Qbit credit in the center, and the network status on the right. The short hash keeps the full value in its title, disclosure, and copy button.
- On-chain and Authentic sit on one row, and only when that check is current. How it works headings use the Qbit green, darker on a light page.

## 0.2.10

- The home introduction is larger and takes the spare vertical space, so the 15-item block keeps its size and sits 40px above the footer line when the window is tall enough. A shorter window scrolls instead of shrinking the art.
- Inscription, collection, address, block, and transaction pages request 104 rows. The indexer piece read stays at 100.
- A detail shows On-chain only when the indexed tip includes that inscription's block. Authentic stays the collection check. Mock, stale, and unknown do not get the On-chain label.
- The footer reads “Built on”, then the Qbit logo, then “PINS is an independent protocol.” The words before and after the logo use the same type.

## 0.2.9

- The home introduction sits above the latest block. That block stays one feature plus two rows of seven, and the cards grow together so the group is larger and centered.
- How it works uses a wider column and a slightly larger reading size. Section links stay compact so they can sit on one row when the window is wide enough.
- Detail keeps Back on the right. The control is a left arrow and the word Back, both in Qbit green. The close control is gone.

## 0.2.8

- Home shows the latest P2MR Inscription on the left and fourteen more, in two rows of seven, at the same card size. The latest item is not repeated in that grid. The list request is capped at 15.
- Browse all P2MR Inscriptions and Open the Flatbits collection sit on one row under that grid. A short read-only introduction follows.
- The footer keeps status on the left. The Qbit logo and “PINS is an independent protocol built on Qbit.” sit together on the right.
- How it works is a wider centered column. The menu order is Latest P2MR Inscriptions, FLATBITS collection, How it works.
- Light mode uses a light mat behind the art. Detail returns with Back and Close, using the previous list. Collection pagination matches the card row, at most 13 cards wide. The page size stays 100.

## 0.2.7

- The homepage is the earlier two-row grid of the latest P2MR Inscriptions, at most 24, in chain order. The large single-item hero is gone. Authentic and holder counters stay off the homepage.
- The header keeps the PINS mark and title on the left. Flatbits, Latest P2MR Inscriptions, and How it works sit with search and the theme control on the right.
- How it works is a centered column. The short title block is centered. The body stays left aligned. Fresh setup and an update that already works stay separate.
- The face is self-hosted Chakra Petch, Latin weights 400 and 500. Visible nouns are PINS, 1 P2MR Inscription, or P2MR Inscriptions.

## 0.2.6

- The homepage leads with the latest inscribed PINS, ordered by block height, transaction index, and input index. More recent PINS follow. Flatbits stays the collection link.
- The inscription list can be shown before every collection piece page has been read. Piece totals stay hidden until that check finishes. Image bytes for the homepage are capped, and a small content cache avoids repeating those indexer reads.
- An Authentic badge appears beside an inscription only when the indexer piece check confirms that inscription and the snapshot is not stale.
- Detail has a Back control. It returns to the previous explorer list, including its query and scroll. A direct link falls back to Latest P2MR Inscriptions.
- Space Grotesk replaces Outfit. Art sits on a near-black mat. The collection heading is uppercase. The genesis panel sits between the authenticity summary and the manifest check.
- The footer stacks the Qbit logo above “Built on Qbit” and says PINS is an independent protocol. The homepage is one latest inscription and a sparse grid of the next few.
- The first wait shows a small circular spinner. Its moving edge is the Qbit wordmark green from the official logo. Status colors stay separate: green only for a current snapshot or a connected node, amber for syncing or stale, red for an error or a disconnected node.
- The header mark is the official PINS avatar with only the full-canvas plate removed. The Qbit wordmark is the unmodified file from qbit.org. How it works is a page in the menu.

## 0.2.5

- The page name is PINS Explorer. The header uses the PINS avatar from the protocol repository. Flatbits stays the collection link. The other menu item is Latest P2MR Inscriptions.
- Pixel mats use the previous neutral backing. Pagination is centered. The collection manifest block has space under it. The home introduction stays on one line on a wide screen and wraps on a narrow one.
- Outfit is self-hosted. The theme control is a sun or moon icon. A small script in the page head applies the saved theme before the first paint.
- While the first index snapshot is loading, the notice stays on screen. Status polling does not replace the page or the images.
- The footer links to https://qbit.org with the logo file served by that site.

## 0.2.4

- The local page uses the Flatbits sale palette from that site's `src/styles.css` (and the warn pair in `site-chrome.tsx`). No font files and no remote styles or scripts are loaded.
- Home preview walls request at most 12 images each. Collection, inscription, and address grids stay at 100 rows. Block and transaction image grids render 100 at a time from the response already in hand. A navigation cancels the previous page's fetches. Status polling is one request at a time and pauses while the tab is hidden.
- Fresh setup also applies `patches/0005-output-identity.patch` after the genesis and credential patches. A vendor that already has those changes is left as it is. Setup still does not replace `.env` or `data/`.

## 0.2.3

- Stop passing `--proto-redir`. Curl 8.18.0 treats a leading `=` as "permit only", so `=-all` is the unknown protocol `-all` and the option is rejected. A bare `-all` is also rejected because the value starts with a dash, and an empty redirect protocol list is rejected as well.
- Curl is now started with `-q` first and `--max-redirs 0`. A curlrc cannot turn on redirects, and `-L` still does not contact the redirect target. Credentials stay on stdin.
- `patches/0004-curl-max-redirs.patch` is that one-line change for a 0.2.1 vendor that already has `0003` applied. A new setup uses the corrected `0002` patch.

## 0.2.2

- Curl is invoked with `--proto-redir =-all`. A separate `-all` makes current curl report `option --proto-redir: is badly used here`. The `=` form is what curl accepts for a value that starts with a dash, and it still denies every protocol on redirect.
- `patches/0003-curl-proto-redir.patch` is that one-line change for a vendor already built with 0.2.1. A new setup uses the corrected `0002` patch and does not need `0003`.

## 0.2.1

- Setup applies the genesis patch before it checks the credential patch. Checking the second patch against a clean pin made `git apply` stop at `scripts/indexer-run.ts:69`, so the indexer never installed.
- A second run continues from patches already present. Setup refuses to `reset` or `clean` a dirty `vendor/pins`, and it does not change `.env` or `data/`.
- The patch test now fails if the credential patch is checked before the genesis patch, and it covers a retry after only the first patch is present.

## 0.2.0

- RPC credentials are read from `.env` or `qbit.conf` as literal text and passed in the indexer environment. npm, node, and curl arguments no longer carry them. The indexer change is `patches/0002-rpc-credentials-off-argv.patch` on PINS `3e014f4ff156a35eea4b8613e37116fd124aa719`.
- The genesis filter remains `patches/0001-indexer-genesis-flag.patch`. The id comes from the operator manifest.
- Content fetches use `redirect: "error"`, a byte cap, and a timeout. HTML and JSON are `text/plain`. SVG and other non-raster types download. Page and content responses keep their Content-Security-Policy.
- RPC stays on an allow-list. Credential URLs are rejected. Node error text is not shown to the browser.
- Host checks stay in force when the process binds beyond loopback. Only loopback names and `TRUSTED_HOSTS` are accepted.
- A snapshot is published only when the tip still matches at the end of the read. A failed refresh keeps the previous snapshot and marks it stale.
- Added `.env.example`, rate and concurrency limits, and loopback tests for redirects, size, content types, RPC, paths, hosts, manifests, and reorg reads.
