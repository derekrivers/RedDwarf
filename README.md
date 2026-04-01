# RedDwarf

RedDwarf is a TypeScript policy-pack monorepo for an OpenClaw-powered AI Dev Squad.

The repo is designed to be bind-mounted into an OpenClaw Docker container during development and packaged into immutable versioned policy-pack artifacts for runtime promotion, while Postgres stores task manifests, planning specs, policy decisions, evidence metadata, and observability events. Version 1 is intentionally conservative:

- planning-first
- human-gated
- durable and auditable
- full pipeline from GitHub issue intake through planning, developer code generation (via OpenClaw), validation, and SCM branch/PR creation — proven end-to-end with real GitHub PRs

## Repository Shape

- `packages/contracts`: shared domain schemas and types, including partitioned memory contracts
- `packages/policy`: eligibility, risk, approval, and guardrail logic
- `packages/control-plane`: lifecycle, planning pipeline orchestration, developer- and validation-phase orchestration, durable evidence archival, scoped secret lease injection, concurrency/stale-run enforcement, approval queue and decision helpers, OpenClaw context and runtime instruction materialization helpers, managed workspace lifecycle helpers, and structured observability hooks
- `packages/execution-plane`: agent definitions and disabled future phases
- `packages/evidence`: persistence schema, SQL migrations, policy snapshot storage, approval-request persistence, partitioned memory persistence/query helpers, pipeline-run persistence, Postgres-backed repository implementations, and run summaries
- `packages/integrations`: read-only GitHub, CI, and secrets adapter contracts, deterministic issue-intake helpers, scoped lease redaction helpers, and v1 mutation guards
- `agents/`, `prompts/`, `schemas/`, `standards/`: mounted runtime assets consumed by OpenClaw
- `infra/docker`: local stack topology for OpenClaw and Postgres

## Quick Start

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine + Compose plugin)
- Node.js ≥ 22 (`node --version`)
- Corepack (`corepack enable`)
- Git

### OpenClaw registry access

The Docker Compose stack pulls `ghcr.io/openclaw/openclaw:latest` from the GitHub Container Registry. If the image is not yet publicly available, you will need to authenticate:

```bash
echo $GITHUB_TOKEN | docker login ghcr.io -u <your-github-username> --password-stdin
```

Contact the openclaw organisation if you do not have access.

### OpenClaw Control UI access

If you want to open the OpenClaw Control UI from the host browser, set `OPENCLAW_GATEWAY_TOKEN` in the repo-root `.env` before starting the `openclaw` profile. The compose stack explicitly references that file with `env_file: ../../.env`, and the standard `setup` / `start` flows now generate `runtime-data/openclaw-home/openclaw.json` from RedDwarf's typed OpenClaw config before the container starts. That keeps `gateway.bind` on `lan` while letting the live runtime config carry the current browser, Discord, and agent-roster settings.

```bash
OPENCLAW_GATEWAY_TOKEN=<long-random-token>
```

After startup, open `http://127.0.0.1:3578/` and authenticate with `OPENCLAW_GATEWAY_TOKEN`. The separate RedDwarf operator API now also requires `REDDWARF_OPERATOR_TOKEN` for every route except `/health`.

### One-command bootstrap (recommended)

```bash
git clone <repo-url>
cd RedDwarf
corepack enable
corepack pnpm install
cp .env.example .env          # review and edit as needed
corepack pnpm run setup           # compose:up → Postgres → migrate → health check → workspace cleanup
```

`pnpm run setup` is idempotent — safe to re-run if the stack is already running.

### Manual steps (if preferred)

1. Enable Corepack: `corepack enable`
2. Install dependencies: `corepack pnpm install`
3. Copy env file: `cp .env.example .env` (Windows: `Copy-Item .env.example .env`)
4. Start the local stack: `corepack pnpm compose:up`
5. Apply DB schema: `corepack pnpm db:migrate`
6. Confirm the stack is healthy: `corepack pnpm verify:postgres`

### Run all verification checks

```bash
corepack pnpm verify:all      # runs all 18 feature verification scripts in sequence
```

Or run individual checks:

```bash
corepack pnpm typecheck        # TypeScript compilation
corepack pnpm test             # unit tests
corepack pnpm verify:postgres  # planning pipeline + Postgres integration
corepack pnpm verify:package   # packaged policy-pack integrity
```

### Windows-specific notes

- Use `127.0.0.1` instead of `localhost` in database connection strings when running host-side scripts on Windows with WSL2. `localhost` resolves via the WSL relay and misses the Docker-bound Postgres listener. The default `.env` already uses `127.0.0.1`.
- Postgres is exposed on port `55532` (not the standard `5432`) to avoid conflicts with any locally installed Postgres.
- Some verification scripts spawn child processes. If you see `spawn EPERM` errors inside a sandboxed environment (e.g., Claude Code terminal), re-run the command with elevated permissions or outside the sandbox. See `docs/agent/TROUBLESHOOTING.md` for documented workarounds.

## Running the Full Stack

### One command (recommended)

```bash
corepack pnpm start
```

This single command boots the entire RedDwarf stack:

1. **Infrastructure** — starts Docker Compose (Postgres + OpenClaw), waits for Postgres, applies migrations
2. **Housekeeping** — sweeps stale pipeline runs from prior crashes, cleans up old workspace directories (>24h)
3. **Operator API** — starts the HTTP server on port 8080 for approvals, evidence, and monitoring
4. **Polling daemon** — watches GitHub for `ai-eligible` issues (if configured)

Press `Ctrl+C` to shut down all services gracefully.

### Configuration

`.env.example` is now grouped into four classes:

- Boot-time: infrastructure, connection strings, and filesystem paths that are resolved before startup and require a restart when changed.
- Runtime-configurable: polling, dispatch, OpenClaw feature toggles, log level, pool tuning, retry budgets, and token budgets. These are the first candidates for the future operator config UI.
- Secrets: API keys and operator credentials. Keep these out of any plaintext UI.
- Dev / E2E: local verification helpers, not part of normal production operation.

At startup, RedDwarf loads `.env` first and then overlays any matching rows from the Postgres-backed `operator_config` table for runtime-configurable keys. If the table does not exist yet, startup falls back to `.env` only.

**Boot-time**

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_IMAGE` | `ghcr.io/openclaw/openclaw:latest` | OpenClaw container image to run in the local Docker stack |
| `OPENCLAW_HOST_PORT` | `3578` | Host port for the OpenClaw Control UI |
| `POSTGRES_DB` | `reddwarf` | Local Postgres database name |
| `POSTGRES_USER` | `reddwarf` | Local Postgres username |
| `POSTGRES_PASSWORD` | `reddwarf` | Local Postgres password |
| `POSTGRES_HOST_PORT` | `55532` | Host port for Docker-managed Postgres |
| `DATABASE_URL` | `postgresql://reddwarf:reddwarf@postgres:5432/reddwarf` | In-container Postgres connection string |
| `HOST_DATABASE_URL` | `postgresql://reddwarf:reddwarf@127.0.0.1:55532/reddwarf` | Host-side Postgres connection string used by local scripts |
| `REDDWARF_POLICY_SOURCE_ROOT` | `../../` | Source tree root used when packaging the policy pack |
| `REDDWARF_POLICY_ROOT` | `/opt/reddwarf` | Runtime-visible policy-pack root inside managed environments |
| `REDDWARF_WORKSPACE_ROOT` | `/var/lib/reddwarf/workspaces` | Runtime-visible managed workspace root |
| `REDDWARF_EVIDENCE_ROOT` | `/var/lib/reddwarf/evidence` | Runtime-visible evidence archive root |
| `REDDWARF_HOST_WORKSPACE_ROOT` | `runtime-data/workspaces` | Host-side workspace root used by local scripts and E2E runs |
| `REDDWARF_HOST_EVIDENCE_ROOT` | `runtime-data/evidence` | Host-side evidence archive root |
| `REDDWARF_POLICY_PACKAGE_OUTPUT_ROOT` | `artifacts/policy-packs` | Output directory for packaged policy assets |
| `REDDWARF_OPENCLAW_WORKSPACE_ROOT` | `runtime-data/openclaw-workspaces` | Host-mounted OpenClaw session workspace root |
| `REDDWARF_OPENCLAW_CONFIG_PATH` | `runtime-data/openclaw.json` | Generated OpenClaw runtime config path |

**Runtime-configurable**

| Variable | Default | Description |
|----------|---------|-------------|
| `REDDWARF_POLL_REPOS` | _(disabled)_ | Comma-separated `owner/repo` list to poll (e.g. `acme/platform,acme/api`) |
| `REDDWARF_POLL_INTERVAL_MS` | `30000` | Polling interval in milliseconds |
| `REDDWARF_DISPATCH_INTERVAL_MS` | `15000` | Ready-task dispatch loop interval in milliseconds |
| `REDDWARF_API_PORT` | `8080` | Operator API port |
| `REDDWARF_API_URL` | `http://127.0.0.1:8080` | Optional full base URL override for the operator API; mainly used by `reddwarf submit` when the API is not on the default local port |
| `REDDWARF_LOG_LEVEL` | `info` | Structured runtime log level for poller, dispatcher, and pipeline logs |
| `REDDWARF_SKIP_OPENCLAW` | `false` | Set to `true` to skip OpenClaw startup |
| `REDDWARF_DRY_RUN` | `false` | Suppress SCM and follow-up GitHub mutations while still exercising the pipeline |
| `REDDWARF_OPENCLAW_BROWSER_ENABLED` | `true` | Enable OpenClaw's built-in browser so Holly can inspect live library docs and API references |
| `REDDWARF_OPENCLAW_DISCORD_ENABLED` | `false` | Emit a native `channels.discord` block into the generated OpenClaw runtime config |
| `REDDWARF_OPENCLAW_DISCORD_DM_POLICY` | `pairing` | Direct-message policy for the native OpenClaw Discord bridge |
| `REDDWARF_OPENCLAW_DISCORD_GROUP_POLICY` | `allowlist` | Server policy for the native OpenClaw Discord bridge |
| `REDDWARF_OPENCLAW_DISCORD_GUILD_IDS` | _(empty)_ | Comma-separated Discord server ids to allow when Discord mode is enabled |
| `REDDWARF_OPENCLAW_DISCORD_REQUIRE_MENTION` | `true` | Require mentions inside allowed Discord servers by default |
| `REDDWARF_OPENCLAW_DISCORD_NOTIFICATIONS_ENABLED` | `false` | Enable Discord streaming history, component styling, and presence updates in the generated OpenClaw config |
| `REDDWARF_OPENCLAW_DISCORD_STREAMING` | `partial` | Discord streaming mode for native OpenClaw replies |
| `REDDWARF_OPENCLAW_DISCORD_HISTORY_LIMIT` | `24` | Recent message history count to retain in the Discord bridge |
| `REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_ENABLED` | `true` | Turn on OpenClaw's native Discord presence updates when notifications are enabled |
| `REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_INTERVAL_MS` | _(empty)_ | Optional override for the Discord presence refresh cadence |
| `REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_MIN_UPDATE_INTERVAL_MS` | _(empty)_ | Optional minimum interval between presence updates |
| `REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_HEALTHY_TEXT` | _(empty)_ | Optional custom healthy-status presence text |
| `REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_DEGRADED_TEXT` | _(empty)_ | Optional custom degraded-status presence text |
| `REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_EXHAUSTED_TEXT` | _(empty)_ | Optional custom exhausted-status presence text |
| `REDDWARF_OPENCLAW_DISCORD_EXEC_APPROVALS_ENABLED` | `false` | Enable native OpenClaw approval prompts in Discord |
| `REDDWARF_OPENCLAW_DISCORD_APPROVER_IDS` | _(empty)_ | Comma-separated Discord user ids allowed to resolve native OpenClaw approval prompts |
| `REDDWARF_OPENCLAW_DISCORD_EXEC_APPROVAL_TARGET` | `channel` | Where OpenClaw posts approval prompts: `dm`, `channel`, or `both` |
| `REDDWARF_OPENCLAW_DISCORD_ACCENT_COLOR` | `#d7263d` | Accent color for native Discord button components and cards |
| `REDDWARF_DB_POOL_MAX` | `10` | Max Postgres connections in the shared `pg.Pool` |
| `REDDWARF_DB_POOL_CONNECTION_TIMEOUT_MS` | `5000` | Fail DB connection attempts after this many milliseconds |
| `REDDWARF_DB_POOL_IDLE_TIMEOUT_MS` | `30000` | Evict idle Postgres clients after this many milliseconds |
| `REDDWARF_DB_POOL_QUERY_TIMEOUT_MS` | `15000` | Fail Postgres queries after this many milliseconds |
| `REDDWARF_DB_POOL_STATEMENT_TIMEOUT_MS` | `15000` | Ask Postgres to cancel statements that exceed this runtime |
| `REDDWARF_DB_POOL_MAX_LIFETIME_SECONDS` | `300` | Recycle Postgres clients after this lifetime |
| `REDDWARF_MAX_RETRIES_ARCHITECT` | `2` | Planning retry budget alias for the architect phase |
| `REDDWARF_MAX_RETRIES_DEVELOPER` | `1` | Development retry budget alias |
| `REDDWARF_MAX_RETRIES_VALIDATOR` | `1` | Validation retry budget alias |
| `REDDWARF_MAX_RETRIES_REVIEWER` | `1` | Architecture-review retry budget alias |
| `REDDWARF_MAX_RETRIES_SCM` | `1` | SCM retry budget |
| `REDDWARF_TOKEN_BUDGET_ARCHITECT` | `80000` | Planning token budget |
| `REDDWARF_TOKEN_BUDGET_DEVELOPER` | `120000` | Development token budget |
| `REDDWARF_TOKEN_BUDGET_VALIDATOR` | `40000` | Validation token budget |
| `REDDWARF_TOKEN_BUDGET_REVIEWER` | `60000` | Architecture-review token budget |
| `REDDWARF_TOKEN_BUDGET_SCM` | `40000` | SCM token budget |
| `REDDWARF_TOKEN_BUDGET_OVERAGE_ACTION` | `warn` | Budget overage behavior: warn or block |

**Secrets**

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_TOKEN` | _(required)_ | GitHub PAT for issue intake, branch publishing, PR creation, and cleanup |
| `ANTHROPIC_API_KEY` | _(required for Anthropic planning)_ | Anthropic API key for planning and provider-backed execution |
| `OPENCLAW_HOOK_TOKEN` | _(required when dispatching to OpenClaw)_ | Privileged hook-ingress token for RedDwarf -> OpenClaw dispatch |
| `OPENCLAW_BASE_URL` | `http://localhost:3578` | Base URL for the OpenClaw gateway HTTP API |
| `OPENCLAW_GATEWAY_TOKEN` | _(required for Control UI)_ | Browser auth token for the OpenClaw Control UI |
| `OPENCLAW_DISCORD_BOT_TOKEN` | _(required when Discord is enabled)_ | Bot token for OpenClaw's native Discord integration |
| `REDDWARF_OPERATOR_TOKEN` | _(required)_ | Bearer token for all operator API routes except `/health` |

**Dev / E2E**

| Variable | Default | Description |
|----------|---------|-------------|
| `E2E_TARGET_REPO` | _(unset)_ | Target repository in `owner/repo` format for the live E2E workflow |
| `E2E_USE_OPENCLAW` | `false` | Dispatch developer work through the live OpenClaw runtime during E2E |
| `E2E_CLEANUP` | `false` | Close or delete created GitHub resources after E2E completes |

**Example — full stack with polling:**

```bash
REDDWARF_POLL_REPOS=owner/repo corepack pnpm start
```

**Example — infrastructure + operator API only (no polling):**

```bash
corepack pnpm start
```

### Starting services separately

If you prefer to run services in separate terminals:

```bash
corepack pnpm run setup                    # infrastructure + migrations + health check
corepack pnpm compose:up:openclaw          # OpenClaw gateway (if not already started)
corepack pnpm operator:api                 # operator API on :8080
```

The operator API now exposes configuration endpoints alongside the existing approvals and runs surface:

- `GET /config` returns runtime-configurable settings with current value, default, description, and source.
- `GET /config/schema` returns JSON-schema-style metadata for those settings.
- `PUT /config` persists one or more runtime-configurable settings to the Postgres-backed `operator_config` table.

### OpenClaw Discord channel

Feature 99 uses OpenClaw's native Discord channel support instead of a custom RedDwarf bot. To turn it on for the generated runtime config:

```bash
export REDDWARF_OPENCLAW_DISCORD_ENABLED=true
export OPENCLAW_DISCORD_BOT_TOKEN=<discord-bot-token>
export REDDWARF_OPENCLAW_DISCORD_GUILD_IDS=<guild-id>
corepack pnpm generate:openclaw-config
```

The standard `setup` and `start` flows now generate `runtime-data/openclaw-home/openclaw.json` from the typed control-plane config, so the Discord block can be driven from `.env` instead of hand-editing the checked-in template. The default posture is conservative: DM pairing, server allowlisting, native commands enabled, and mention requirements on allowed guilds.

For feature 100, OpenClaw can also drive native Discord status visibility and approval prompts:

```bash
export REDDWARF_OPENCLAW_DISCORD_NOTIFICATIONS_ENABLED=true
export REDDWARF_OPENCLAW_DISCORD_EXEC_APPROVALS_ENABLED=true
export REDDWARF_OPENCLAW_DISCORD_APPROVER_IDS=<discord-user-id>
corepack pnpm generate:openclaw-config
```

That emits Discord streaming/history settings, OpenClaw auto-presence, component accent color, and native Discord approval prompts into the runtime config without adding a custom RedDwarf notification service.

### OpenClaw browser for Holly

Feature 101 turns on OpenClaw's built-in browser by default in the generated config so Holly can consult live framework docs and API references during architecture planning when repository context alone is not enough.

```bash
export REDDWARF_OPENCLAW_BROWSER_ENABLED=true
corepack pnpm generate:openclaw-config
```

### Approving plans

Plans requiring human approval appear in the operator API:

```bash
export REDDWARF_OPERATOR_TOKEN=<your-operator-token>
curl http://localhost:8080/health
curl http://localhost:8080/blocked \
  -H "Authorization: Bearer ${REDDWARF_OPERATOR_TOKEN}"
curl -X POST http://localhost:8080/approvals/<id>/resolve \
  -H "Authorization: Bearer ${REDDWARF_OPERATOR_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"decision":"approve","decidedBy":"you","decisionSummary":"Looks good"}'
```

### GitHub issue intake

For remote intake, open a new GitHub issue with the `AI Task` template under `.github/ISSUE_TEMPLATE/ai-task.yml`.

The template:
- applies the `ai-eligible` label automatically
- captures the structured fields RedDwarf already uses well: summary, priority signal, acceptance criteria, affected areas, constraints, and risk class
- reduces freeform issue cleanup before planning starts

### Local CLI task intake

For local intake, use the repo CLI to submit directly to the operator API without opening GitHub:

```bash
export REDDWARF_OPERATOR_TOKEN=<your-operator-token>
corepack pnpm exec reddwarf submit \
  --repo owner/repo \
  --title "Tighten operator retries" \
  --summary "Surface poll failures faster in the operator dashboard." \
  --acceptance "Polling failures appear in /health within one cycle." \
  --path packages/control-plane/src/polling.ts
```

The CLI uses `REDDWARF_API_URL` when set, otherwise it targets `http://127.0.0.1:${REDDWARF_API_PORT:-8080}`. Add `--json` if you want the raw planning response back for scripting.

### Service health checks

| Service | Endpoint | Expected |
|---------|----------|----------|
| Postgres | `pg_isready` via Docker health check | Automatic |
| OpenClaw | `http://127.0.0.1:3578/health` | `200 OK` |
| Operator API | `http://127.0.0.1:8080/health` | `{"status":"ok","repository":{...},"polling":{...},"dispatcher":{...}}` |

### Teardown

```bash
corepack pnpm teardown
```

Safely shuts down the stack: sweeps stale pipeline runs, stops Docker services, cleans old workspaces, and removes stale OpenClaw config. The database volume is **preserved by default**.

```bash
corepack pnpm teardown -- --dry-run            # preview only
corepack pnpm teardown -- --clean-evidence 14  # also clean evidence >14 days
corepack pnpm teardown -- --destroy-volumes    # full reset (destroys database)
```

### Boot-up safety

Every startup (via `pnpm start` or `pnpm run setup`) performs automatic housekeeping:
- Applies pending database migrations idempotently
- Sweeps stale pipeline runs from prior crashed processes
- Cleans up workspace directories older than 24 hours
- Verifies Postgres connectivity before accepting HTTP requests
- Applies exponential backoff on the polling daemon if GitHub is unreachable

## E2E Integration Test

The fastest way to prove the full pipeline end-to-end is the automated integration test:

```bash
E2E_TARGET_REPO=owner/repo corepack pnpm e2e
```

This creates a real GitHub issue, runs intake and planning, auto-approves the resulting request, then drives the approved task through the same `dispatchReadyTask(...)` post-approval path the live stack uses (developer -> validation -> optional SCM). Set `E2E_CLEANUP=true` to close all created GitHub resources afterwards. Set `E2E_USE_OPENCLAW=true` to dispatch the developer phase through the live OpenClaw agent runtime.

The E2E test is **not** part of `pnpm test` — it will never run during CI or local unit testing, and each run consumes Anthropic API tokens.

See [docs/DEMO_RUNBOOK.md](docs/DEMO_RUNBOOK.md) Part 3 for full environment variable reference, expected output, and cleanup instructions.

## Demo

For a complete walkthrough from a fresh clone through each pipeline phase, see [docs/DEMO_RUNBOOK.md](docs/DEMO_RUNBOOK.md).

## Runtime Model

- `openclaw` runs as a container and can mount either this repo read-only for development or a packaged policy-pack artifact from `artifacts/policy-packs/.../policy-root` for immutable promotion.
- The OpenClaw Control UI is served by the OpenClaw gateway on host port `3578` using the seeded [infra/docker/openclaw.json](/c:/Dev/RedDwarf/infra/docker/openclaw.json) template plus writable runtime state under `runtime-data/openclaw-home`. The RedDwarf operator API is a separate host-side process on `127.0.0.1:8080` started with `corepack pnpm operator:api`.
- `postgres` stores manifests, planning specs, policy snapshots, approval requests and decisions, evidence metadata, run events, durable pipeline-run records for overlap control, derived run summaries, and partitioned memory across task, project, organization, and external scopes.
- Host-side verification uses `POSTGRES_HOST_PORT` and defaults to `55532` to avoid collisions with an existing local Postgres on `5432`.
- Host-side DB clients should use `127.0.0.1` instead of `localhost` on this Windows setup because `localhost` can resolve through `wslrelay` and miss the Docker-bound listener.
- Host-side context materialization defaults to `REDDWARF_HOST_WORKSPACE_ROOT=runtime-data/workspaces` and writes `.context/` plus generated `SOUL.md`, `AGENTS.md`, `TOOLS.md`, and `skills/reddwarf-task/SKILL.md` files into each workspace. Managed workspaces also receive `.workspace/workspace.json`, isolated `scratch/`, and `artifacts/` directories and can be explicitly destroyed through the workspace manager.
- GitHub and CI integrations are modeled conservatively in v1. Issue intake and status reads are supported; the SCM phase can create approved branches and pull requests through the GitHub adapter after validation, while labels, issue comments, workflow triggers, and remote secret mutations still stay blocked behind explicit `V1MutationDisabledError` guards. Approved tasks can also receive workspace-local scoped secret leases from the secrets adapter.
- Concurrency is conservative by default: overlapping active runs for the same task source are serialized, stale runs are retired based on heartbeat age, and fresh overlaps are blocked with durable run-level evidence. Planning runs that require downstream mutation open a durable approval queue entry, approved tasks can enter the developer phase in an isolated workspace while code-writing still stays disabled by default, the validation phase can then run deterministic workspace-local lint and test checks, and approved `can_open_pr` tasks can continue into SCM branch/PR creation while review remains blocked.
- Workspace-generated handoffs, validation logs and results, and SCM reports and diff summaries are archived into the evidence root (`REDDWARF_HOST_EVIDENCE_ROOT` or the `runtime-evidence` volume) before temporary workspaces are destroyed.
- `runtime-workspace` and `runtime-evidence` are separate writable volumes for container runtime use. Standard lifecycle commands are `corepack pnpm workspace:materialize` and `corepack pnpm workspace:destroy`.
- This repo is the Dev Squad definition repo, not the product code repo.

## Versioned Policy Packs

- Build a versioned artifact with `corepack pnpm package:policy-pack`.
- Verify the packaged runtime with `corepack pnpm verify:package`.
- Point Docker Compose at the packaged root with `REDDWARF_POLICY_SOURCE_ROOT=<artifact path>`.
- Packaged artifacts contain the runtime assets, built package dist output, packaged manifests, and a self-contained runtime `node_modules` tree materialized from the repo's installed dependency graph.
