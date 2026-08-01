# Phase 2 — Running on the UGREEN NAS

## 1. Get the code onto the NAS

Copy the project folder to the NAS (excluding `node_modules`, `data`, `.env`) via
the NAS's file manager, `scp`, or by cloning the git repo directly on the NAS if
you push it somewhere reachable. A reasonable target path:

```
/volume1/docker/household-finance-app/
```

## 2. Install Docker (Container Manager) on UGOS

Open the UGOS app store and install **Container Manager** (UGOS's Docker
front-end). This gives you both a GUI and CLI (`docker`, `docker compose`)
over SSH.

## 3. Create your `.env` on the NAS

Copy `.env.example` to `.env` in the project folder on the NAS and fill in
`ANTHROPIC_API_KEY`. This file is never baked into the image — it's read at
container start via `env_file` in `docker-compose.yml`.

## 4. Build and start the container

SSH into the NAS, then from the project folder:

```bash
docker compose up -d --build
```

This builds the image, creates the `household-finance-app` container, and
mounts `./data` on the host into `/data` in the container — so
`data/finance.db` lives on the NAS filesystem and survives container
rebuilds/restarts. Check it's up:

```bash
curl http://localhost:3000/health
docker compose logs -f
```

## 5. Survive a reboot

`docker-compose.yml` already sets `restart: unless-stopped`, so the container
comes back up automatically after a NAS reboot as long as Docker/Container
Manager is set to start on boot (default in UGOS).

## 6. Backups

`scripts/backup-db.js` does a consistency-safe SQLite backup (handles WAL
mode correctly, unlike a raw file copy) into a directory you choose.

Schedule it daily via **Control Panel → Task Scheduler** in UGOS, running:

```bash
docker exec household-finance-app node scripts/backup-db.js /data/backups
```

Since `/data` is the mounted volume, backups land in
`<project>/data/backups/` on the NAS host too. For extra safety, also point
a NAS volume snapshot schedule (if your UGREEN model supports Btrfs
snapshots) at that same folder, or periodically copy `data/backups/` to a
second volume/external drive.

## 7. Tailscale for remote access

Goal: reach the API from your phone off your home network, without opening
a public port.

1. On the NAS: install Tailscale — either a native UGOS package if available,
   or run it as a container (`tailscale/tailscale` image) with `network_mode:
   host` so it can route to the other container. Authenticate it to your
   Tailscale account (`tailscale up`).
2. On your phone/laptop: install the Tailscale app, sign into the same
   account.
3. Once both are connected, the NAS gets a stable Tailscale IP (or
   MagicDNS name like `nas.tailnet-name.ts.net`). From your phone, hit
   `http://<tailscale-ip-or-name>:3000/health` to confirm reachability.
4. Do **not** additionally port-forward 3000 on your router — Tailscale is
   the whole point of avoiding that.

**Done when:** the backend runs unattended on the NAS, survives a reboot,
and you can hit `/health` from your phone over Tailscale while off your home
Wi-Fi.
