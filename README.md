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

If you want to open the OpenClaw Control UI from the host browser, set `OPENCLAW_GATEWAY_TOKEN` in the repo-root `.env` before starting the `openclaw` profile. The compose stack explicitly references that file with `env_file: ../../.env`, then seeds [infra/docker/openclaw.json](/c:/Dev/RedDwarf/infra/docker/openclaw.json) into the writable host-backed state directory at `runtime-data/openclaw-home`, which forces `gateway.bind` to `lan` while still letting OpenClaw persist its own runtime state.

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

| Variable | Default | Description |
|----------|---------|-------------|
| `REDDWARF_POLL_REPOS` | _(disabled)_ | Comma-separated `owner/repo` list to poll (e.g. `acme/platform,acme/api`) |
| `REDDWARF_POLL_INTERVAL_MS` | `30000` | Polling interval in milliseconds |
| `REDDWARF_API_PORT` | `8080` | Operator API port |
| `REDDWARF_OPERATOR_TOKEN` | _(required)_ | Bearer token for all operator API routes except `/health` |
| `REDDWARF_DB_POOL_MAX` | `10` | Max Postgres connections in the shared `pg.Pool` |
| `REDDWARF_DB_POOL_CONNECTION_TIMEOUT_MS` | `5000` | Fail DB connection attempts after this many milliseconds |
| `REDDWARF_DB_POOL_IDLE_TIMEOUT_MS` | `30000` | Evict idle Postgres clients after this many milliseconds |
| `REDDWARF_DB_POOL_QUERY_TIMEOUT_MS` | `15000` | Fail Postgres queries after this many milliseconds |
| `REDDWARF_DB_POOL_STATEMENT_TIMEOUT_MS` | `15000` | Ask Postgres to cancel statements that exceed this runtime |
| `REDDWARF_DB_POOL_MAX_LIFETIME_SECONDS` | `300` | Recycle Postgres clients after this lifetime |
| `REDDWARF_LOG_LEVEL` | `info` | Structured runtime log level for poller, dispatcher, and pipeline logs |
| `REDDWARF_SKIP_OPENCLAW` | `false` | Set to `true` to skip OpenClaw startup |

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

This creates a real GitHub issue, runs every pipeline phase (planning → approval → developer → validation → SCM), and opens a real pull request. Set `E2E_CLEANUP=true` to close all created GitHub resources afterwards. Set `E2E_USE_OPENCLAW=true` to dispatch through the live OpenClaw agent runtime.

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
