# RedDwarf VPS Deployment

One-time install of RedDwarf on a fresh Linux VPS behind Caddy + Let's Encrypt, running under systemd. After this, day-2 operations (restart, logs, updates, config tweaks) live in [VPS_OPERATIONS.md](VPS_OPERATIONS.md).

The path through this doc produces a deployment that looks like:

```
Internet → 443 (Caddy, auto-TLS)
            │
            ├── /                → static dashboard (symlinked from repo build)
            ├── /api/*           → reverse_proxy 127.0.0.1:8080  (operator API)
            └── /webhooks/*      → reverse_proxy 127.0.0.1:8080  (GitHub webhooks)

systemd (reddwarf.service)
    └── corepack pnpm start
            └── docker compose up -d postgres openclaw
                + operator API (127.0.0.1 or 0.0.0.0:8080)
                + dashboard dev server (disabled; Caddy serves the build)
                + polling daemon
```

## What you need before you start

- A Linux VPS with root SSH access. This guide targets Ubuntu 24.04 LTS; other Debian-family distros should work with minor substitutions.
- A domain you control, with an A record pointing to the VPS's public IPv4 (and optionally an AAAA for IPv6). Let's Encrypt HTTP-01 validation uses port 80.
- Edge firewall (VPS provider's cloud firewall, or host-level `ufw`/`nftables`) configured so only 80/443 and SSH are reachable from the internet. Do not expose 8080, 5173, 3578, or 55532.
- A GitHub PAT, an LLM API key, and three random tokens as per [GETTING_STARTED.md §2](GETTING_STARTED.md#2-clone-and-configure).

Path conventions below assume:
- Repo checked out at `/root/RedDwarf`
- Domain `reddwarf.example.com` (substitute your own)

## 1. Prepare the host

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git ca-certificates gnupg lsb-release
```

Verify DNS resolves before proceeding:

```bash
dig reddwarf.example.com +short
```

It should print your VPS's public IP.

## 2. Install Docker CE

Using Docker's official apt repository (not the distro's `docker.io`):

```bash
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
```

Verify:

```bash
docker --version
docker compose version
```

## 3. Install Node.js 22 + Corepack

Using NodeSource's official distribution:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo corepack enable
```

Verify:

```bash
node --version     # v22.x
corepack pnpm --version
```

## 4. Install Caddy

From Ubuntu's repository (sufficient for 24.04; for a newer Caddy use the Cloudsmith apt repo instead):

```bash
sudo apt install -y caddy
sudo systemctl enable --now caddy
```

## 5. Clone and configure RedDwarf

```bash
sudo -i   # run the rest as root
cd /root
git clone <repo-url> RedDwarf
cd RedDwarf
corepack pnpm install
cp .env.example .env
```

Edit `/root/RedDwarf/.env`. Fill in the five required secrets per [GETTING_STARTED.md §2](GETTING_STARTED.md#2-clone-and-configure), and set this **VPS-specific** value:

```env
REDDWARF_API_HOST=0.0.0.0
```

This is the single non-default setting unique to Linux VPS deploys. On Docker Desktop, `host.docker.internal` routes through a NAT that reaches the default `127.0.0.1` bind, so the default works. On Linux Docker CE, `host.docker.internal` resolves to the docker-bridge gateway address, which cannot reach `127.0.0.1` on the host — the operator API must bind `0.0.0.0` for the OpenClaw container's webhooks and plugin callbacks to reach it. The Caddy layer still keeps port 8080 off the public internet.

Optional VPS values to consider:
- `REDDWARF_WEBHOOK_SECRET` — enables the GitHub webhook receiver; see [WEBHOOK_SETUP.md](WEBHOOK_SETUP.md).
- `REDDWARF_MODEL_PROVIDER` — `anthropic` (default), `openai`, or `openai-codex`.

## 6. First build

Build the packages and the dashboard SPA:

```bash
corepack pnpm build
corepack pnpm --filter @reddwarf/dashboard build
```

The dashboard build lands at `/root/RedDwarf/packages/dashboard/dist/`.

## 7. Wire up Caddy

Create the site's docroot as a symlink into the build directory, so future rebuilds go live without a copy step:

```bash
sudo mkdir -p /srv/reddwarf
sudo ln -s /root/RedDwarf/packages/dashboard/dist /srv/reddwarf/dashboard
sudo chmod -R o+rX /root/RedDwarf/packages/dashboard/dist
```

The `o+rX` is needed because `/root/` is mode `700` and Caddy runs as the `caddy` user. The symlink target permissions matter more than `/srv/reddwarf` itself.

Write `/etc/caddy/Caddyfile`:

```caddyfile
reddwarf.example.com {
    encode zstd gzip

    root * /srv/reddwarf/dashboard

    handle_path /api/* {
        reverse_proxy 127.0.0.1:8080
    }

    handle /webhooks/* {
        reverse_proxy 127.0.0.1:8080
    }

    handle {
        try_files {path} /index.html
        file_server
    }

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
    }

    log {
        output file /var/log/caddy/reddwarf-access.log
        format json
    }
}
```

Three routing rules:
- `handle_path /api/*` — strips the `/api` prefix before forwarding. The dashboard SPA talks to `/api/health`, `/api/approvals/…`; the operator API sees these as `/health`, `/approvals/…`.
- `handle /webhooks/*` — does **not** strip; the operator API's webhook receiver lives at `/webhooks/github`.
- `handle` — SPA fallback so client-side routes like `/approvals/:id` don't 404 on refresh.

Validate, then reload:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

Caddy will request a Let's Encrypt certificate automatically on first load. Watch it happen:

```bash
sudo journalctl -u caddy -f
```

You should see an `obtain` + `obtained` pair for `reddwarf.example.com` within 30–60 seconds.

## 8. Install the systemd unit

Create `/etc/systemd/system/reddwarf.service`:

```ini
[Unit]
Description=RedDwarf control plane (operator API + polling daemon + OpenClaw orchestration)
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
User=root
WorkingDirectory=/root/RedDwarf
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/usr/bin/corepack pnpm start
Restart=on-failure
RestartSec=10
TimeoutStopSec=60
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now reddwarf
```

Tail the boot logs:

```bash
sudo journalctl -u reddwarf -f
```

First start takes ~30–60 seconds while Docker pulls Postgres and the OpenClaw image, applies migrations, and sweeps stale runs.

## 9. Edge firewall posture

The VPS provider firewall (or `ufw` / `nftables` if you're managing it on-host) should allow **only**:

- TCP 22 from your admin IPs (SSH)
- TCP 80 from `0.0.0.0/0` (Let's Encrypt HTTP-01 renewal)
- TCP 443 from `0.0.0.0/0` (public traffic)

Explicitly block or leave unconfigured:

- TCP 8080 — operator API (only reached through Caddy)
- TCP 5173 — dashboard dev server (not used in this deploy)
- TCP 3578 — OpenClaw Control UI (reach via SSH port forward — see [VPS_OPERATIONS.md §7](VPS_OPERATIONS.md#7-accessing-private-surfaces-openclaw-control-ui-postgres))
- TCP 55532 — Postgres (same)

The operator API is bearer-auth'd, but it has not been hardened against public traffic — don't rely on auth alone.

## 10. Verify the deploy

From your laptop:

```bash
# TLS cert works
curl -sI https://reddwarf.example.com | head -3

# Operator API round-trips through Caddy's /api/* rule
curl -s https://reddwarf.example.com/api/health | python3 -m json.tool

# Dashboard loads
curl -sI https://reddwarf.example.com | grep -i content-type   # expects text/html
```

Open [https://reddwarf.example.com](https://reddwarf.example.com) in a browser and paste your `REDDWARF_OPERATOR_TOKEN`.

![Operator dashboard home](images/dashboard-home.png)

Add a repo, file an `ai-eligible` issue on it, approve the plan — end-to-end flow matches [GETTING_STARTED.md §§4–6](GETTING_STARTED.md#4-submit-your-first-task).

## 11. Next steps

- **Day-2 operations** — [VPS_OPERATIONS.md](VPS_OPERATIONS.md). Starting/stopping, logs, pulling updates from master, SSH port forwards for the private surfaces, diagnostic recipes.
- **GitHub webhooks** (replaces polling) — [WEBHOOK_SETUP.md](WEBHOOK_SETUP.md). Payload URL is `https://reddwarf.example.com/webhooks/github`.
- **Codex OAuth** (if `REDDWARF_MODEL_PROVIDER=openai-codex`) — [VPS_OPERATIONS.md §10](VPS_OPERATIONS.md#10-codex-oauth-re-sync) covers the periodic resync.
- **Backups** — `postgres-data` is a Docker-managed volume. For a durable backup, `docker compose -f infra/docker/docker-compose.yml exec postgres pg_dump -U reddwarf reddwarf | gzip > /root/backups/reddwarf-$(date +%F).sql.gz` is a reasonable starting point; wire it into cron.

## Troubleshooting the install

| Symptom | Likely cause | Fix |
|---|---|---|
| `caddy validate` reports an unknown directive | Caddy version older than the Caddyfile needs | `caddy version`; if < 2.6, install from the Cloudsmith apt repo. |
| Let's Encrypt fails with "no valid A or AAAA records" | DNS not propagated yet | `dig reddwarf.example.com +short`; wait a few minutes, retry. |
| Let's Encrypt fails with "connection refused" on :80 | Edge firewall blocks 80 | Allow 80 from `0.0.0.0/0` — Let's Encrypt needs it for HTTP-01 renewal, not just initial issue. |
| Dashboard returns 403 | Caddy can't read the build dir | `chmod -R o+rX /root/RedDwarf/packages/dashboard/dist` and reload Caddy. |
| Dashboard returns 502 | Operator API not up | `systemctl status reddwarf`, then `journalctl -u reddwarf -n 200 --no-pager`. |
| `/api/health` returns 404 through Caddy but works on `:8080` | Caddyfile rule missing or misordered | `handle_path /api/*` must precede the generic `handle` block. Reload Caddy. |
| OpenClaw Discord or WebChat plugin fails to reach the Operator API | `REDDWARF_API_HOST` still `127.0.0.1` | Set `REDDWARF_API_HOST=0.0.0.0` in `.env` and `systemctl restart reddwarf`. See [VPS_OPERATIONS.md §12](VPS_OPERATIONS.md#12-common-failures-and-diagnostic-recipes). |
| systemd keeps restarting reddwarf every 10 s | Postgres health-check or OpenClaw image pull failing | Tail `journalctl -u reddwarf -f` during the restart cycle; the last ~20 lines before the crash are the real error. |
| `corepack pnpm start` fails with `ENOSPC` | Disk full from runtime-data | `docker system prune -f` and check `du -sh /root/RedDwarf/runtime-data/*`; evidence retention is 14 days by default (`REDDWARF_EVIDENCE_MAX_AGE_DAYS`). |

For broader operational issues once the stack is up, see [VPS_OPERATIONS.md §12](VPS_OPERATIONS.md#12-common-failures-and-diagnostic-recipes).
