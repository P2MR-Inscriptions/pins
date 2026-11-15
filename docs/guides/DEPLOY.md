<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deploy the node, the indexer, and the explorer

This page shows how to run a synced Qbit mainnet node, the PINS indexer, and the explorer as services on one machine, and how to reach the explorer from a LAN or over SSH. The paths, user names, and addresses below are examples. Replace them with the values on your machine. Do not copy a personal home directory or a private address into these files.

The explorer and the indexer listen on loopback only. The node's RPC stays on loopback too. A reverse proxy or an SSH tunnel is what other machines talk to, not those ports.

Node.js 22.13 to 24 is required. The tools run from a checkout of this repository, not from `node_modules` as a published package (see the root README). After you clone it to `/var/lib/pins`:

```text
cd /var/lib/pins
npm ci --ignore-scripts
npm --prefix explorer ci --ignore-scripts
```

## Users and directories

Create a system user for the node and one for the PINS tools, and the directories they own:

- User `qbit`, directory `/var/lib/qbit`: the node's data directory.
- User `pins`, directory `/var/lib/pins`: the checkout, the index database, and the explorer `.env`.

The indexer must be able to read the node's RPC login. The node rewrites `.cookie` as owner-only each time it starts, so a second user cannot rely on reading that file. Either run the indexer as the same user as the node, or set `rpcuser` and `rpcpassword` in `qbit.conf` and pass `QBIT_RPC_USER` and `QBIT_RPC_PASSWORD` in an environment file that only the `pins` user can read. The units below use a cookie and assume the indexer can read `/var/lib/qbit` (same user, or a login of the user-and-password kind).

## Qbit Core

Install Qbit Core v1.0.1 ([pinned versions](../PINNED_VERSIONS.md)). Run it with `-txindex` and without `-prunewitnesses=1`. The RPC port on mainnet is 8352. A unit with systemd's notify type:

```systemd
[Unit]
Description=Qbit Core
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=qbit
Group=qbit
ExecStart=/usr/bin/qbitd -datadir=/var/lib/qbit -txindex -startupnotify='systemd-notify --ready' -shutdownnotify='systemd-notify --stopping'
Restart=on-failure
TimeoutStartSec=300
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
```

If you copy a complete data directory from another machine, stop the node there first, copy the directory onto `/var/lib/qbit`, then start this unit. The chain data is kept, so the node does not resync. The cookie is written again on start. More on that is in [Log in to your node](NODE-LOGIN.md).

## Indexer

The first catch-up on mainnet can take several hours. The HTTP API does not listen until that catch-up has finished, so the explorer has nothing to read until the indexer has reached the tip. Node may print an `ExperimentalWarning` about SQLite; it is harmless.

Do not set `MemoryDenyWriteExecute` on a Node service: the runtime needs to write executable memory.

```systemd
[Unit]
Description=PINS indexer
After=qbitd.service
Requires=qbitd.service

[Service]
Type=simple
User=pins
Group=pins
WorkingDirectory=/var/lib/pins
ExecStart=/usr/bin/node --experimental-strip-types /var/lib/pins/scripts/indexer-run.ts --db /var/lib/pins/index.sqlite --rpc http://127.0.0.1:8352/ --rpc-datadir /var/lib/qbit --network mainnet --confirm-network mainnet --port 8787 --genesis 15d6f9c48865b579f7d1144e4d2d71d905c6fe04458bebc814052a3e39a07784i0
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

`--genesis` is the Flatbits genesis, the public example. Point it at your own genesis id when you feature another collection, or drop the flag if you are not following one collection. The same command as a foreground run, with the default data directory, is in [the Flatbits example](../examples/flatbits.md#verify-the-example).

## Explorer

The explorer binds to loopback only. Fill `explorer/.env` from `.env.example`. A mainnet cookie login (the path must be absolute; a leading `~` in `.env` is not expanded):

```text
HOST=127.0.0.1
PORT=8080
INDEXER_URL=http://127.0.0.1:8787
QBIT_RPC_URL=http://127.0.0.1:8352/
QBIT_RPC_DATADIR=/var/lib/qbit
PINS_NETWORK=mainnet
TRUSTED_HOSTS=192.0.2.10
TRUST_PROXY=1
```

`TRUSTED_HOSTS` is the name or address clients put in the `Host` header, without a port. `TRUST_PROXY=1` is required behind a reverse proxy on the same machine, so the explorer reads `X-Forwarded-Host` and rate-limits by the last `X-Forwarded-For` address. Leave both empty when you only open the explorer through an SSH tunnel to loopback.

```systemd
[Unit]
Description=PINS explorer
After=pins-indexer.service
Requires=pins-indexer.service

[Service]
Type=simple
User=pins
Group=pins
WorkingDirectory=/var/lib/pins/explorer
ExecStart=/usr/bin/node --env-file-if-exists=/var/lib/pins/explorer/.env --experimental-strip-types /var/lib/pins/explorer/server/index.ts
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Start the explorer only after the indexer is listening. A first mainnet catch-up can take several hours; until then this unit will fail to read the indexer.

Install the three files under `/etc/systemd/system/` (for example `qbitd.service`, `pins-indexer.service`, and `pins-explorer.service`), then:

```text
sudo systemctl daemon-reload
sudo systemctl enable --now qbitd.service
sudo systemctl enable --now pins-indexer.service
# wait until the indexer is listening on 127.0.0.1:8787
sudo systemctl enable --now pins-explorer.service
```

## Reverse proxy

Caddy on the same machine can listen on a LAN address and forward to the explorer on loopback. The addresses below are documentation examples, not a private LAN. Bind the proxy to the interface you intend, and keep auto HTTPS off when you are serving plain HTTP on a LAN.

```caddyfile
{
    auto_https off
}

http://192.0.2.10:80 {
    bind 192.0.2.10
    reverse_proxy 127.0.0.1:8080
}
```

Clients then open `http://192.0.2.10/`. Set `TRUSTED_HOSTS` to that same address (or to the DNS name you use) and `TRUST_PROXY=1`. Do not forward the node's RPC port or the indexer port through this proxy.

## LAN firewall

The node RPC (8352), the indexer (8787), and the explorer (8080) should stay reachable only on loopback. Allow the proxy port only from the networks that should use the explorer. With `ufw`, for a documentation-range LAN of `192.0.2.0/24`:

```text
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow from 192.0.2.0/24 to any port 80 proto tcp
sudo ufw enable
```

Do not allow 8352, 8787, or 8080 from the LAN. If you have no reverse proxy and you use only the SSH tunnel below, allow SSH and nothing else for this purpose.

## SSH tunnel

To open the explorer on your own machine without a reverse proxy or a LAN port, forward loopback 8080:

```text
ssh -N -L 8080:127.0.0.1:8080 user@192.0.2.10
```

Then open `http://127.0.0.1:8080/` locally. In that case leave `TRUSTED_HOSTS` and `TRUST_PROXY` empty, because the `Host` header is loopback.
