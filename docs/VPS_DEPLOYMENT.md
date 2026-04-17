# VPS Deployment Runbook

This runbook deploys RedDwarf to a single Hetzner-style VPS with the dashboard reachable publicly at a real domain over TLS, and every other surface kept private.

Target posture used throughout this doc:

- Domain: `maniax-bros.uk` (A record for `reddwarf.maniax-bros.uk` points at the VPS)
- Public surface: dashboard + operator API + GitHub webhook, all under `https://reddwarf.maniax-bros.uk`
- Private surfaces: OpenClaw Control UI (`:3578`) and Postgres (`:55532`), reachable only via SSH tunnel or Tailscale
- Password protection: the dashboard's existing `REDDWARF_OPERATOR_TOKEN` bearer login
- TLS: Caddy + Let's Encrypt (automatic)
- Service management: systemd unit running `pnpm start`

Adapt the hostnames and user paths to your own values as you go. No code changes are required — everything is env-driven.

---

## 1. Prerequisites on the VPS

- Fresh Ubuntu 22.04 / 24.04 LTS (or similar Debian-family distro).
- DNS A record for `reddwarf.maniax-bros.uk` pointed at the VPS IP.
- Docker Engine + Compose plugin installed.
- Node 22+ (via `nvm` or the NodeSource repo).
- Corepack enabled: `corepack enable`.
- Git.
- A non-root user (this runbook assumes `derek` — adjust).

```bash
# Quick sanity
docker --version
docker compose version
node --version   # must be >= 22
corepack --version
```

## 2. Clone and install

```bash
cd /home/derek
git clone https://github.com/derekrivers/RedDwarf.git
cd RedDwarf
corepack pnpm install
```

## 3. Environment configuration

```bash
cp .env.example .env
```

Edit `.env`. The values specific to a public-domain deployment:

```bash
# Active model provider (keep your chosen posture)
REDDWARF_MODEL_PROVIDER=openai-codex
REDDWARF_MODEL_FAILOVER_ENABLED=false

# Public URL for the operator API. Used by the dashboard and any GitHub
# Actions workflow that needs to call /projects/advance on PR merge.
REDDWARF_API_URL=https://reddwarf.maniax-bros.uk
REDDWARF_OPERATOR_API_URL=https://reddwarf.maniax-bros.uk

# CORS origin for the dashboard. Same-origin in the Caddy layout below, so
# this mainly guards against embedding in other origins.
REDDWARF_DASHBOARD_ORIGIN=https://reddwarf.maniax-bros.uk

# Skip the Vite dev server — in production, Caddy serves the built dashboard
# static files. Only the operator API + polling daemon need to run on the host.
REDDWARF_SKIP_DASHBOARD=true

# Webhook-driven intake. Generate a secret and put the same value in your
# GitHub repo's webhook settings (Secret field, under Settings → Webhooks).
REDDWARF_WEBHOOK_SECRET=$(openssl rand -hex 32)
REDDWARF_WEBHOOK_PATH=/webhooks/github
# Switch polling off if you only want webhook intake. "auto" keeps both;
# "never" disables polling entirely when the webhook is configured.
REDDWARF_POLL_MODE=never

# Required secrets (fill in real values)
GITHUB_TOKEN=ghp_...
OPENCLAW_HOOK_TOKEN=$(openssl rand -hex 32)
OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)
REDDWARF_OPERATOR_TOKEN=$(openssl rand -hex 32)
# Model-provider credentials depending on your REDDWARF_MODEL_PROVIDER choice.
# For openai-codex, neither direct-API key is needed; the Codex OAuth profiles
# are created via `openclaw models auth login --provider openai-codex` later.
```

Write down `REDDWARF_OPERATOR_TOKEN` securely — this is the dashboard password.

## 4. Firewall rules

On Hetzner Cloud, create a firewall with these inbound rules and attach it to the VPS:

| Proto | Port | Source | Purpose |
|---|---|---|---|
| TCP | 22 | your home IP / tailnet | SSH |
| TCP | 80 | 0.0.0.0/0, ::/0 | Caddy HTTP → auto-redirect to HTTPS |
| TCP | 443 | 0.0.0.0/0, ::/0 | Caddy HTTPS (dashboard, API, webhook) |

**Do not** open 3578 (OpenClaw Control UI), 5173 (Vite dev — we don't run it in prod), 8080 (operator API — Caddy proxies to it), or 55532 (Postgres). All three are reachable locally on the VPS or via SSH tunnel.

If you prefer `ufw`:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from <your-home-ip> to any port 22 proto tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

## 5. Install Caddy

Caddy provisions and renews Let's Encrypt certs automatically; no certbot needed.

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

## 6. Caddyfile

Replace `/etc/caddy/Caddyfile` with:

```caddyfile
reddwarf.maniax-bros.uk {
    encode zstd gzip

    # Dashboard static bundle (produced by `pnpm --filter @reddwarf/dashboard build`)
    root * /home/derek/RedDwarf/packages/dashboard/dist

    # Operator API — strip the /api prefix so GET /api/health reaches the
    # operator API as GET /health (matches the Vite dev proxy behaviour).
    handle_path /api/* {
        reverse_proxy 127.0.0.1:8080
    }

    # GitHub webhook — no prefix strip; the operator API serves at exactly
    # /webhooks/github. Ensure REDDWARF_WEBHOOK_PATH=/webhooks/github.
    handle /webhooks/* {
        reverse_proxy 127.0.0.1:8080
    }

    # SPA fallback: any other path serves index.html so client-side routes work.
    handle {
        try_files {path} /index.html
        file_server
    }

    # Security headers worth having
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

Validate and restart:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl restart caddy
sudo systemctl enable caddy
```

Caddy will obtain a TLS certificate automatically on first request. Confirm:

```bash
curl -sI https://reddwarf.maniax-bros.uk | head -5
# Expect: HTTP/2 200 (or 401 for /api/anything without a token)
```

## 7. Build the dashboard

```bash
cd /home/derek/RedDwarf
corepack pnpm install
corepack pnpm --filter @reddwarf/dashboard build
# Outputs to packages/dashboard/dist/
```

Re-run this step whenever you pull new dashboard changes.

## 8. Bootstrap RedDwarf infra

```bash
corepack pnpm run setup
```

This brings up Postgres and OpenClaw via Docker Compose, applies migrations, and generates the OpenClaw runtime config.

## 9. Codex OAuth (only if using the subscription lane)

If `REDDWARF_MODEL_PROVIDER=openai-codex`, each agent needs a Codex OAuth profile. Run the dashboard-guided flow (the OpenClaw Settings page walks you through it), or from the shell:

```bash
docker compose -f infra/docker/docker-compose.yml --profile openclaw exec openclaw \
  node dist/index.js models auth login --provider openai-codex --set-default
```

Verify:

```bash
for role in reddwarf-coordinator reddwarf-analyst reddwarf-arch-reviewer \
            reddwarf-validator reddwarf-developer reddwarf-developer-opus; do
  test -f runtime-data/workspaces/.agents/$role/agent/auth-profiles.json \
    && echo "$role: ok" \
    || echo "$role: MISSING"
done
```

## 10. Systemd unit for the stack

The `pnpm start` command runs in the foreground. Wrap it in a systemd unit so it survives SSH disconnects, auto-restarts on failure, and captures logs to journald.

Create `/etc/systemd/system/reddwarf.service`:

```ini
[Unit]
Description=RedDwarf control plane (operator API + polling daemon + OpenClaw)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=derek
WorkingDirectory=/home/derek/RedDwarf
Environment=PATH=/home/derek/.nvm/versions/node/v22.12.0/bin:/usr/bin:/bin
ExecStart=/home/derek/.nvm/versions/node/v22.12.0/bin/corepack pnpm start
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Adjust the Node path to match your install (`which node` gives you the right value). Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable reddwarf
sudo systemctl start reddwarf
sudo systemctl status reddwarf
journalctl -u reddwarf -f       # live logs
```

## 11. First browser check

Open `https://reddwarf.maniax-bros.uk`.

- Login screen should load.
- Paste your `REDDWARF_OPERATOR_TOKEN` into the login form.
- Dashboard home should render with live health status.

If the dashboard loads but API calls fail with 401, the bearer token is wrong. If the page doesn't load at all, check `sudo journalctl -u caddy -n 50`.

## 12. GitHub webhook (intake)

In the polled repo's GitHub Settings → Webhooks → Add webhook:

- Payload URL: `https://reddwarf.maniax-bros.uk/webhooks/github`
- Content type: `application/json`
- Secret: the `REDDWARF_WEBHOOK_SECRET` value from your `.env`
- Which events? — "Let me select individual events" → check **Issues**, **Pull requests**, **Pull request reviews** (and any others your pipeline reacts to).

Test by opening a throwaway issue with the `ai-eligible` label. Within a second or two you should see intake events in `journalctl -u reddwarf`.

## 13. Private access to OpenClaw Control UI and Postgres

Neither is publicly exposed. To reach them, use an SSH tunnel from your laptop:

```bash
# OpenClaw Control UI → http://localhost:3578 on your laptop
ssh -N -L 3578:127.0.0.1:3578 derek@<vps-ip>

# Postgres → 127.0.0.1:55532 on your laptop
ssh -N -L 55532:127.0.0.1:55532 derek@<vps-ip>
```

Alternative: install Tailscale on both the VPS and your laptop and access them at `http://<vps-name>.<tailnet>.ts.net:3578` etc. That's the posture [docs/tailscale-funnel-setup.md](tailscale-funnel-setup.md) already describes.

## 14. Operational helpers

- **Health probe:** `curl -sf https://reddwarf.maniax-bros.uk/api/health`
- **Restart after `.env` changes:** `sudo systemctl restart reddwarf`
- **Rebuild dashboard after pulling code:** `corepack pnpm --filter @reddwarf/dashboard build && sudo systemctl reload caddy` (Caddy doesn't cache static files aggressively, but a reload is free)
- **Upgrade OpenClaw image:** edit `OPENCLAW_IMAGE` in `.env`, `docker compose pull`, `sudo systemctl restart reddwarf`.
- **Tail JSON access log:** `sudo tail -f /var/log/caddy/reddwarf-access.log`

## 15. What a compromise looks like (and isn't worried about)

- **Operator token leaked** → rotate via `POST /secrets/REDDWARF_OPERATOR_TOKEN/rotate` or by editing `.env` and restarting. All sessions invalidate immediately.
- **Someone scans port 80/443** → they hit Caddy, get a login page, can't do anything without the operator token.
- **Direct-API credential exfiltration risk** → none. F-157 scoping keeps both `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` out of the container env entirely when you're on the Codex subscription lane. See [packages/control-plane/src/openclaw-config.ts](../packages/control-plane/src/openclaw-config.ts) and [scripts/lib/config.mjs::applyOpenClawApiKeyScope](../scripts/lib/config.mjs).
- **Postgres exposure** → the `ports:` block in `infra/docker/docker-compose.yml` binds to the VPS's `0.0.0.0:55532`. If the firewall at §4 is in place, external traffic can't reach it. For extra safety, change the bind to `127.0.0.1:55532:5432` in the compose file so it only accepts connections from the VPS's loopback.

## 16. Troubleshooting

**Dashboard loads but API requests return 502**
The operator API isn't up. Check `sudo systemctl status reddwarf` and `journalctl -u reddwarf -n 100`.

**Caddy can't get a TLS certificate**
DNS A record must point at the VPS before first `systemctl start caddy`. Verify with `dig reddwarf.maniax-bros.uk +short`. Also check Caddy's logs: `sudo journalctl -u caddy -n 50`.

**Webhook receives events but pipeline doesn't pick them up**
Confirm `REDDWARF_WEBHOOK_SECRET` matches on both sides. Check `/api/health` — if polling is degraded, the webhook handler will still work but run events may lag. Check `journalctl -u reddwarf` for HMAC verification errors.

**Codex OAuth profile expires**
Re-auth via the dashboard's OpenClaw Settings page (guided flow) or the `openclaw models auth login --provider openai-codex` command inside the container. The restore snapshot at `runtime-data/secrets/codex-auth-profile.json` survives stack restarts but not OAuth expiry.
