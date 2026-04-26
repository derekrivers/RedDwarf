# VPS Operations Guide

Day-2 operations for a RedDwarf deployment running on a Linux VPS under systemd + Docker + Caddy.

This guide assumes the stack is already deployed per [docs/VPS_DEPLOYMENT.md](VPS_DEPLOYMENT.md) and is running. Use this document when you need to restart after a change, tail logs, apply updates from master, tweak configuration, or diagnose failures.

Path conventions in every example:
- Repo: `/root/RedDwarf`
- Systemd unit: `reddwarf.service`
- Caddy site: `reddwarf.maniax-bros.uk`
- Adapt to your own values.

---

## At a glance — the commands you'll use weekly

| Task | Command |
|---|---|
| Restart RedDwarf | `sudo systemctl restart reddwarf` |
| Stop RedDwarf | `sudo systemctl stop reddwarf` |
| Start RedDwarf | `sudo systemctl start reddwarf` |
| Is it running? | `sudo systemctl status reddwarf` |
| Live logs | `sudo journalctl -u reddwarf -f` |
| Recent logs | `sudo journalctl -u reddwarf -n 100 --no-pager` |
| Health check | `curl -s https://reddwarf.maniax-bros.uk/api/health` |
| Apply update from master | see §3 |
| Edit VPS-specific env | `sudo systemctl edit reddwarf` (see §5) |
| Reload Caddy config | `sudo systemctl reload caddy` |

---

## 1. How the pieces fit together

```
systemd (reddwarf.service)
    │
    └── corepack pnpm start   ← what systemd actually runs
            │
            ├── pnpm build (tsc -b)            — compiles TypeScript packages
            └── node scripts/start-stack.mjs
                    │
                    ├── loads /root/RedDwarf/.env
                    ├── applies systemd Environment= overrides (take priority)
                    ├── docker compose up -d openclaw postgres
                    ├── runs migrations
                    ├── starts operator API on :8080
                    ├── starts polling / webhook / dispatcher loops
                    └── stdout → journald (via systemd)

Caddy (caddy.service)
    │
    └── serves https://reddwarf.maniax-bros.uk
            │
            ├── /            → static dashboard build (packages/dashboard/dist)
            ├── /api/*       → reverse_proxy to 127.0.0.1:8080 (strip /api)
            └── /webhooks/*  → reverse_proxy to 127.0.0.1:8080
```

Three independent things restart independently:
- `sudo systemctl restart reddwarf` — the Node process and Docker stack
- `sudo systemctl reload caddy` — Caddy picks up a new Caddyfile, no dropped connections
- `docker compose restart openclaw` — just the OpenClaw container, without touching Postgres or the Node process

---

## 2. Starting, stopping, checking

```bash
# Full stack, normal restart
sudo systemctl restart reddwarf

# Is the process up and healthy?
sudo systemctl status reddwarf

# Is it auto-starting on boot?
sudo systemctl is-enabled reddwarf        # → enabled / disabled
sudo systemctl is-active reddwarf         # → active / inactive / failed

# Enable / disable auto-start
sudo systemctl enable reddwarf
sudo systemctl disable reddwarf
```

`status` output tells you (top to bottom): service name, load state, active state + since when, main PID, memory, CPU time, and the last ~10 log lines. If you see `Active: failed`, use `journalctl` (§4) to find the error.

---

## 3. Applying updates from master

Standard flow when there's a commit on master you want to deploy:

```bash
cd /root/RedDwarf

# Pull latest
git fetch origin
git log --oneline HEAD..origin/master    # preview what you're about to pull
git pull origin master

# Fresh deps (safe even if lockfile is unchanged)
corepack pnpm install

# Rebuild TypeScript packages + dashboard
corepack pnpm build
corepack pnpm --filter @reddwarf/dashboard build

# Fix dashboard permissions if you changed them under chmod o+x
# (only needed if Caddy returns 403 after a build)
chmod -R o+rX packages/dashboard/dist

# Restart the stack
sudo systemctl restart reddwarf

# Confirm the new code is live
sudo journalctl -u reddwarf -n 30 --no-pager | tail -20
curl -sI https://reddwarf.maniax-bros.uk | head -3
```

If the build fails with TypeScript errors in the dashboard, it's usually because `@reddwarf/contracts` didn't get its `.d.ts` refreshed — `pnpm build` from the root handles that; don't skip it before the dashboard-filtered build.

### 3.1 Deploying from CI (M23 F-178)

The manual flow above is wrapped by [`scripts/vps-update.sh`](../scripts/vps-update.sh) and invoked by the [`Deploy to VPS`](../.github/workflows/deploy-vps.yml) GitHub Actions workflow. The workflow is `workflow_dispatch` only — it never fires on push, so deploys still require an explicit operator click.

To enable it, configure these on the GitHub repo:

| Kind     | Name                   | Purpose                                                                 |
|----------|------------------------|-------------------------------------------------------------------------|
| Secret   | `VPS_SSH_HOST`         | Hostname or IP of the VPS.                                              |
| Secret   | `VPS_SSH_USER`         | SSH user (typically `root`).                                            |
| Secret   | `VPS_SSH_PRIVATE_KEY`  | Private key whose public half is in `~/.ssh/authorized_keys` on the VPS. |
| Variable | `VPS_SSH_PORT`         | Optional. SSH port. Default `22`.                                       |
| Variable | `VPS_REPO_PATH`        | Optional. Checkout path on the VPS. Default `/root/RedDwarf`.           |
| Variable | `VPS_SERVICE_NAME`     | Optional. systemd unit. Default `reddwarf`.                             |

Generate a fresh keypair for the deploy workflow — don't reuse a human key:

```bash
ssh-keygen -t ed25519 -C "reddwarf-deploy" -f ~/.ssh/reddwarf_deploy -N ""
# Copy the public half onto the VPS
ssh-copy-id -i ~/.ssh/reddwarf_deploy.pub root@<vps-host>
# Paste the private half into VPS_SSH_PRIVATE_KEY as a secret
cat ~/.ssh/reddwarf_deploy
```

The workflow then:

1. Resolves optional variables and writes the SSH key into the runner's agent.
2. Pins the VPS host key via `ssh-keyscan`.
3. SSHes in and runs `bash scripts/vps-update.sh --ref <ref> --service <service>` from the existing checkout.
4. Deletes the private key from the runner on every exit path.

`scripts/vps-update.sh` is idempotent: it fetches `origin`, checks out the requested ref (skipping if already there), runs `pnpm install`, builds the workspace and the dashboard, re-applies the Caddy-friendly asset permissions, and finally `systemctl restart`s the service. It then asserts the unit is `active` before returning; a failed restart exits non-zero and dumps the last 50 journal lines.

The script is safe to run manually on the VPS too. Setting `--ref feature/foo` lets you test a branch on the live host without touching master:

```bash
cd /root/RedDwarf
bash scripts/vps-update.sh --ref origin/feature/foo
```

If the SSH user is not root, they need NOPASSWD sudo for `systemctl restart <service>` — otherwise the restart step will hang waiting for a password the workflow can't supply. When running as root the script skips `sudo` entirely.

---

## 4. Viewing logs

Logs live in systemd's journal (systemd-journald). Two modes:

```bash
# Live tail — Ctrl-C to exit
sudo journalctl -u reddwarf -f

# Last N lines (non-follow)
sudo journalctl -u reddwarf -n 200 --no-pager

# Since a specific time / relative
sudo journalctl -u reddwarf --since "1 hour ago" --no-pager
sudo journalctl -u reddwarf --since "2026-04-17 15:00" --no-pager

# Filter by grep (anything pipeable works)
sudo journalctl -u reddwarf --since "30 minutes ago" --no-pager \
  | grep -iE "error|warn|fail"

# Just error-level and above
sudo journalctl -u reddwarf -p warning --since "1 hour ago" --no-pager
```

OpenClaw runs in Docker, so its logs are separate:

```bash
# Follow OpenClaw logs live
docker compose -f /root/RedDwarf/infra/docker/docker-compose.yml --profile openclaw \
  logs -f openclaw

# Last 200 lines
docker compose -f /root/RedDwarf/infra/docker/docker-compose.yml --profile openclaw \
  logs --tail=200 openclaw
```

Caddy too:

```bash
sudo journalctl -u caddy -f
sudo journalctl -u caddy -n 100 --no-pager
```

Caddy's per-site access log also lives at `/var/log/caddy/reddwarf-access.log` (JSON per line — `jq` friendly).

---

## 5. Configuration — `.env` vs systemd overrides

Three places configuration can live. Use the right one:

| Where | Use for | Survives `git pull`? |
|---|---|---|
| Repo source code | Safe defaults every deploy shares | Yes, but changes need a PR |
| `/root/RedDwarf/.env` | Repo-shared configuration (tokens, model provider, feature flags) | No — `.env` is gitignored, survives pulls, but values are the same across machines that use the same `.env.example` baseline |
| Systemd `Environment=` override | **VPS-specific tweaks** that shouldn't be copied back to your laptop | Yes — lives in `/etc/systemd/system/reddwarf.service.d/override.conf`, outside the repo |

Rule of thumb: **if the value is specific to this VPS and would break on other machines, it goes in the systemd override**. Examples:

- `REDDWARF_API_HOST=0.0.0.0` — needed on Linux VPS so Docker containers can reach the operator API via `host.docker.internal`. Would break loopback-only posture on dev machines.
- Public URL overrides (if they differ from `.env`)
- Machine-specific paths

Anything else — feature flags, tuning knobs, model-provider choice — goes in `.env`.

### Editing the override

```bash
sudo systemctl edit reddwarf
```

Opens an editor for the override file. Add or modify lines under `[Service]`:

```ini
[Service]
Environment=REDDWARF_API_HOST=0.0.0.0
Environment=REDDWARF_SOME_OTHER_KEY=value
```

Save, then:

```bash
sudo systemctl daemon-reload
sudo systemctl restart reddwarf
```

### Viewing current effective config

```bash
# Base unit + all overrides in one view
sudo systemctl cat reddwarf

# Only what overrides exist
sudo systemctl cat reddwarf | grep -A5 '\.service\.d/override\.conf'

# What env vars the running process actually has
sudo cat /proc/$(pgrep -f "node scripts/start-stack")/environ | tr '\0' '\n' | grep ^REDDWARF_
```

### Editing `.env`

Straightforward — `sudo nano /root/RedDwarf/.env`, save, `sudo systemctl restart reddwarf`. The stack re-reads `.env` on every start.

---

## 6. Inspecting pipeline state without the dashboard

Useful when diagnosing or when the dashboard is wonky.

```bash
# Set the token once per session
TOKEN=$(grep '^REDDWARF_OPERATOR_TOKEN=' /root/RedDwarf/.env | cut -d= -f2)

# Health
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/health | python3 -m json.tool

# Recent runs
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:8080/runs?limit=10" | python3 -m json.tool

# Recent tasks
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:8080/tasks?limit=10" | python3 -m json.tool

# What's blocked + pending approval
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/blocked | python3 -m json.tool

# Drill into a specific run (events included)
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:8080/runs/<runId>" | python3 -m json.tool
```

---

## 7. Accessing private surfaces (OpenClaw Control UI, Postgres)

Neither is exposed publicly on the VPS. To reach them from your laptop, use SSH port forwards:

```bash
# From your laptop — OpenClaw Control UI at http://localhost:3578 in your browser
ssh -N -L 3578:127.0.0.1:3578 root@<vps-ip>

# From your laptop — Postgres at 127.0.0.1:55532 for local clients (pgcli, DBeaver, psql)
ssh -N -L 55532:127.0.0.1:55532 root@<vps-ip>
```

The `-N` means "no remote command, just the tunnel." Leave the SSH session running in a terminal while you're using the forwarded port. Ctrl-C closes the tunnel.

For longer-term access, install Tailscale on both the VPS and your laptop — each machine gets a private `*.tailnet.ts.net` URL reachable only by devices in your tailnet.

---

## 8. Caddy operations

```bash
# View current Caddyfile (with any imports resolved)
sudo cat /etc/caddy/Caddyfile

# Validate syntax (2.6+ needs explicit adapter)
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

# Hot reload (no dropped connections)
sudo systemctl reload caddy

# Hard restart (drops connections briefly)
sudo systemctl restart caddy

# Check TLS cert status
curl -sI https://reddwarf.maniax-bros.uk | head -5

# Caddy auto-formats its Caddyfiles — apply cosmetic fixes
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo systemctl reload caddy

# If you want to test something without reloading the service
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
```

If Caddy fails to obtain a Let's Encrypt cert on boot, check:
1. DNS A record actually resolves to the VPS IP (`dig reddwarf.maniax-bros.uk +short`).
2. Firewall allows inbound 80 + 443 from 0.0.0.0/0 (ACME HTTP-01 needs port 80).
3. Nothing else is listening on 80 or 443 (`sudo ss -tlnp | grep -E ':80 |:443 '`).

---

## 9. Docker operations

OpenClaw is a Docker container. Common operations:

```bash
# See running containers (with openclaw profile)
cd /root/RedDwarf
docker compose -f infra/docker/docker-compose.yml --profile openclaw ps

# Restart OpenClaw only (without touching Postgres or the Node process)
docker compose -f infra/docker/docker-compose.yml --profile openclaw restart openclaw

# Shell into the OpenClaw container
docker compose -f infra/docker/docker-compose.yml --profile openclaw exec openclaw sh

# Run an OpenClaw CLI command
docker compose -f infra/docker/docker-compose.yml --profile openclaw exec openclaw \
  node dist/index.js models status

# Pull a newer OpenClaw image after changing OPENCLAW_IMAGE in .env
docker compose -f infra/docker/docker-compose.yml --profile openclaw pull
sudo systemctl restart reddwarf

# See what image is currently running
docker inspect docker-openclaw-1 --format '{{.Config.Image}}'
```

---

## 10. Codex OAuth re-sync

If `REDDWARF_MODEL_PROVIDER=openai-codex`, Codex tokens expire every ~5 days and auto-refresh. If the VPS can't refresh (because the original fresh-OAuth flow on the VPS hit a scope issue), you'll need to resync from the laptop when tokens are close to expiring.

**Check expiry:**

```bash
docker compose -f /root/RedDwarf/infra/docker/docker-compose.yml --profile openclaw exec -T openclaw \
  node dist/index.js models status --agent reddwarf-analyst 2>&1 | grep -A1 "OAuth/token"
```

Look for `expires in Nd`. Anything under 2d, resync.

**Resync from laptop (WSL/Linux):**

```bash
# On LAPTOP
cd /home/derek/code/RedDwarf
tar czf /tmp/reddwarf-codex-auth.tar.gz \
  runtime-data/workspaces/.agents/*/agent/auth-profiles.json \
  runtime-data/secrets/codex-auth-profile.json
scp /tmp/reddwarf-codex-auth.tar.gz root@<vps-ip>:/tmp/

# On VPS
cd /root/RedDwarf
tar xzf /tmp/reddwarf-codex-auth.tar.gz -C .
chown -R 1000:1000 runtime-data/workspaces/.agents/ runtime-data/secrets/
sudo systemctl restart reddwarf
```

Verify with the `models status` check above. Expiry should be ~5d again.

Longer-term fix: upgrade the ChatGPT subscription to Pro (fresh OAuth on the VPS works cleanly with Pro). Or fall back to the direct OpenAI API via `REDDWARF_MODEL_PROVIDER=openai` and `OPENAI_API_KEY=...`.

---

## 11. Automated housekeeping (runs on every boot)

The stack cleans up after itself automatically. Configured via `.env`:

| What | Controlled by | Default |
|---|---|---|
| Stale workspace dirs (>24h) removed | hardcoded at 24h | always on |
| OpenClaw config backups (`openclaw.json.bak*`, `.clobbered.*`) | `REDDWARF_OPENCLAW_BACKUP_CLEANUP_ENABLED` / `_MAX_AGE_DAYS` | enabled, 14d |
| Evidence directory retention | `REDDWARF_EVIDENCE_BOOT_CLEANUP_ENABLED` / `_MAX_AGE_DAYS` | enabled, 14d |
| Stale pipeline-run sweep | `REDDWARF_PERIODIC_SWEEP_ENABLED` / `_INTERVAL_MS` | enabled, 5min |

If evidence retention is too aggressive for your audit needs, increase `REDDWARF_EVIDENCE_MAX_AGE_DAYS` (e.g., `90` for a quarter, `365` for a year) and `sudo systemctl restart reddwarf`.

Manual ad-hoc cleanup (not run automatically):

```bash
# Preview what a 90-day evidence cleanup would remove (dry run)
cd /root/RedDwarf
node scripts/cleanup-evidence.mjs --max-age-days 90

# Actually delete
node scripts/cleanup-evidence.mjs --max-age-days 90 --delete
```

---

## 12. Common failures and diagnostic recipes

### "Active: failed" from systemctl status

```bash
sudo journalctl -u reddwarf -n 200 --no-pager | tail -60
```

The last few lines before the crash are the real error. Usual suspects: Postgres not ready, OpenClaw image pull failed, an env var has a typo.

### Dashboard returns 502

Operator API isn't up. `sudo systemctl status reddwarf` and check for `Active: active (running)`. If it's active but Caddy still 502s, check the bind address — it should be on `0.0.0.0:8080` or `127.0.0.1:8080`, not on a different port:

```bash
sudo ss -tlnp | grep :8080
```

### Dashboard returns 403

Caddy can read the Caddyfile but can't read the dashboard build files — permissions issue. Fix:

```bash
chmod -R o+rX /root/RedDwarf/packages/dashboard/dist
sudo systemctl reload caddy
```

### Discord slash commands return "Command failed"

Container can't reach the operator API on the host. Verify `REDDWARF_API_HOST=0.0.0.0` is set either in `.env` or the systemd override, and the operator API is listening on all interfaces:

```bash
sudo ss -tlnp | grep :8080    # should show 0.0.0.0:8080
docker compose -f infra/docker/docker-compose.yml --profile openclaw exec -T openclaw \
  curl -sI --max-time 5 http://host.docker.internal:8080/health
# expected: HTTP/1.1 401 Unauthorized — 401 proves TCP handshake works
```

### Runs show up but the crew-feed on the dashboard home is empty

`REDDWARF_EXECUTION_ITEMS_ENABLED` isn't set to `true`. Without it, agents don't emit the structured `AGENT_PROGRESS_ITEM` events the feed renders. Add it to `.env`, restart, submit a new issue.

### GitHub webhook deliveries are red in the repo settings

Depends on the status code:
- **401** → secret mismatch between `REDDWARF_WEBHOOK_SECRET` in `.env` and what you typed in GitHub's webhook config. Re-enter both identically (no trailing whitespace).
- **404** → payload URL wrong. Should be `https://<your-domain>/webhooks/github`.
- **No deliveries at all** → webhook not `Active` in GitHub, or the domain isn't reachable (DNS / firewall).

### Auto-merge merges PRs but the queue stops advancing (M25)

Symptom: a sub-ticket PR gets auto-merged, then the next ticket never dispatches. In the target repo's Actions tab you'll see `RedDwarf Ticket Advance` runs failing with `::error::REDDWARF_OPERATOR_API_URL is not set` (or the `_TOKEN` variant).

Root cause: `reddwarf-advance.yml` was installed in the target repo (this happens automatically at first project approval), but its required Actions secret + variable haven't been set on that specific repo. The workflow exits 1 on every PR merge, so the operator API never receives the `/projects/advance` callback that dispatches the next ticket.

The pre-flight check at project approval logs the exact fix command in `journalctl -u reddwarf` — search for `M25 advance pre-flight`. Or just run the helper script:

```bash
cd /root/RedDwarf
./scripts/configure-target-repo.sh derekrivers/automerge-syndrome
# Replace <owner/repo> with whichever target repo's queue is stuck.
```

The script reads `REDDWARF_OPERATOR_TOKEN` and the public operator-API URL from your local `.env` and pushes them to the target repo as a secret + variable via `gh`. Requires `gh` installed and authenticated against an account with admin access to the target repo. Idempotent — safe to re-run.

After it succeeds, re-trigger the failed Actions run from the GitHub UI (or just wait for the next PR merge) and the queue resumes.

### Codex auth expired and pipeline fails on every dispatch

Resync per §10. If you can't resync (laptop's tokens also expired), either fall back to `REDDWARF_MODEL_PROVIDER=anthropic` with an `ANTHROPIC_API_KEY`, or upgrade your ChatGPT subscription to Pro and re-run the OpenClaw OAuth flow on the VPS.

---

## 13. Shutting down for maintenance

```bash
sudo systemctl stop reddwarf
docker compose -f /root/RedDwarf/infra/docker/docker-compose.yml --profile openclaw down
# Caddy stays up — leaves a 502 for the dashboard until you restart
```

Restart after maintenance:

```bash
sudo systemctl start reddwarf
# Stack brings Postgres + OpenClaw back up via compose itself; no need to run compose up manually
```

Teardown with workspace + evidence cleanup:

```bash
corepack pnpm teardown                           # stop services, clean stale workspaces
corepack pnpm teardown -- --clean-evidence 30   # also prune evidence >30d
corepack pnpm teardown -- --destroy-volumes     # nuclear — deletes Postgres data
```

The destroy-volumes form wipes the database, so only use it when you explicitly want to start over.

---

## 14. What not to do

- **Don't run `pnpm start` manually** while `reddwarf.service` is active — two processes will fight for the same ports. Either stop the service first, or just use `systemctl restart`.
- **Don't edit `/etc/systemd/system/reddwarf.service` directly** — use `sudo systemctl edit reddwarf` for overrides. Direct edits get lost if you ever reinstall the unit.
- **Don't expose port 8080, 5173, 3578, or 55532 to the public internet.** Only 443 (+ 80 for cert renewal) should be in the firewall's allow list. The operator API is bearer-auth'd but hasn't been hardened against public traffic.
- **Don't commit `.env`, `runtime-data/secrets/`, or `runtime-data/openclaw-home/`** to git. They're gitignored for a reason — auth tokens and DB snapshots live there.

---

## Appendix — single-command diagnostic dump

When something's misbehaving and you're not sure what, this paste-once script gives you a one-page health snapshot:

```bash
cd /root/RedDwarf
TOKEN=$(grep '^REDDWARF_OPERATOR_TOKEN=' .env | cut -d= -f2)

echo "=== systemd: reddwarf ==="
sudo systemctl status reddwarf --no-pager | head -12
echo
echo "=== ports ==="
sudo ss -tlnp | grep -E ':80 |:443 |:8080 |:3578 |:55532 '
echo
echo "=== docker ==="
docker compose -f infra/docker/docker-compose.yml --profile openclaw ps
echo
echo "=== operator API health ==="
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/health | python3 -m json.tool | head -30
echo
echo "=== recent runs ==="
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:8080/runs?limit=3" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); [print(f\"{r['runId'][:8]} {r.get('status','?'):>10} task={r.get('taskId','?')[:50]}\") for r in d.get('runs',[])]"
echo
echo "=== last reddwarf errors ==="
sudo journalctl -u reddwarf --since "30 minutes ago" --no-pager \
  | grep -iE "error|fail|ECONN" | tail -8
```

Save it as `~/rd-diag.sh` and keep it around.
