# Phase 2 — Running on the UGREEN NAS

## 1. Get the code onto the NAS

UGOS (at least on the DXP4800) doesn't ship `git`, so the simplest path is
downloading a tarball of the (public) GitHub repo instead:

```bash
mkdir -p /volume1/docker/household-finance-app
cd /volume1/docker/household-finance-app
curl -L https://github.com/<you>/<repo>/archive/refs/heads/master.tar.gz -o app.tar.gz
tar -xzf app.tar.gz --strip-components=1
rm app.tar.gz
```

This only works if the repo is public — `curl` has no GitHub credentials.
Options if you'd rather keep it private: use a personal access token in the
curl request, or copy files over an SMB share from File Station instead.

To update later, just re-run the `curl`/`tar` steps to overwrite the files
(your `.env` and `data/` won't be touched since they aren't in the repo).

## 2. Install Docker on UGOS

Open the UGOS app store (全部应用) and install **Docker**. This gives you the
`docker` and `docker compose` CLI over SSH.

Note: on the DXP4800, running `docker` commands over SSH needs `sudo` — your
regular NAS login isn't in the `docker` group by default. Prefix Docker
commands with `sudo` throughout, or add your user to the `docker` group with
`sudo usermod -aG docker $USER` and re-login.

## 3. Create your `.env` on the NAS

Copy `.env.example` to `.env` in the project folder on the NAS and fill in
`ANTHROPIC_API_KEY`. This file is never baked into the image — it's read at
container start via `env_file` in `docker-compose.yml`.

## 4. Build and start the container

SSH into the NAS, then from the project folder:

```bash
sudo docker compose up -d --build
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

We couldn't find a Task Scheduler GUI in this UGOS version's Control Panel,
so schedule it via root's crontab instead (`docker exec` needs root/sudo
access to talk to the Docker socket):

```bash
sudo EDITOR=nano crontab -e
```

Add this line (daily at 3am), then save (`Ctrl+X`, `Y`, `Enter`):

```
0 3 * * * docker exec household-finance-app node scripts/backup-db.js /data/backups >> /volume1/docker/household-finance-app/backup.log 2>&1
```

Verify with `sudo crontab -l`.

Since `/data` is the mounted volume, backups land in
`<project>/data/backups/` on the NAS host too. For extra safety, also point
a NAS volume snapshot schedule (if your UGREEN model supports Btrfs
snapshots) at that same folder, or periodically copy `data/backups/` to a
second volume/external drive.

## 7. Tailscale for remote access

Goal: reach the API from your phone off your home network, without opening
a public port.

There's no native Tailscale package in this UGOS app store either, so it
runs as its own Docker container with host networking:

```bash
mkdir -p /volume1/docker/tailscale/state
sudo docker run -d \
  --name=tailscale \
  --hostname=ugreen-dxp4800 \
  -v /volume1/docker/tailscale/state:/var/lib/tailscale \
  -v /dev/net/tun:/dev/net/tun \
  --network=host \
  --cap-add=NET_ADMIN \
  --cap-add=NET_RAW \
  --restart unless-stopped \
  tailscale/tailscale:latest \
  tailscaled

sudo docker exec tailscale tailscale up
```

`tailscale up` prints a `https://login.tailscale.com/a/...` URL — open it in
any browser and sign into (or create) your Tailscale account to approve the
device. `--network=host` means Tailscale shares the NAS's network stack
directly, so anything already listening on the NAS (like port 3000) becomes
reachable over the Tailscale IP with no extra routing config.

1. On your phone/laptop: install the Tailscale app, sign into the same
   account.
2. Get the NAS's Tailscale IP with `sudo docker exec tailscale tailscale ip -4`
   (a `100.x.y.z` address). From your phone, hit
   `http://<tailscale-ip>:3000/health` to confirm reachability — ideally over
   cellular data, to prove it works off your home network.
3. Do **not** additionally port-forward 3000 on your router — Tailscale is
   the whole point of avoiding that.

**Done when:** the backend runs unattended on the NAS, survives a reboot,
and you can hit `/health` from your phone over Tailscale while off your home
Wi-Fi.
