# RedDwarf

RedDwarf is a TypeScript policy-pack monorepo for an OpenClaw-powered AI Dev Squad.

The repo is designed to be bind-mounted into an OpenClaw Docker container during development and packaged into immutable versioned policy-pack artifacts for runtime promotion, while Postgres stores task manifests, planning specs, policy decisions, evidence metadata, and observability events. Version 1 is intentionally conservative:

- planning-first
- human-gated
- durable and auditable
- developer orchestration, workspace-local validation, durable evidence archival, scoped secret leases, and approval-gated SCM handoff are available, while product code-writing still remains disabled by default

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

After startup, open `http://127.0.0.1:3578/` and authenticate with `OPENCLAW_GATEWAY_TOKEN`.

### One-command bootstrap (recommended)

```bash
git clone <repo-url>
cd RedDwarf
corepack enable
corepack pnpm install
cp .env.example .env          # review and edit as needed
corepack pnpm setup           # compose:up → wait for Postgres → db:migrate → health check
```

`pnpm setup` is idempotent — safe to re-run if the stack is already running.

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

## Demo

For a complete walkthrough from a fresh clone to a real planning cycle with GitHub inputs and an LLM-generated plan, see [docs/DEMO_RUNBOOK.md](docs/DEMO_RUNBOOK.md).

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
