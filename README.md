# RedDwarf

RedDwarf is a TypeScript policy-pack monorepo for an OpenClaw-powered AI Dev Squad.

The repo is designed to be bind-mounted into an OpenClaw Docker container during development and packaged into immutable versioned policy-pack artifacts for runtime promotion, while Postgres stores task manifests, planning specs, policy decisions, evidence metadata, and observability events. Version 1 is intentionally conservative:

- planning-first
- human-gated
- durable and auditable
- no autonomous code-writing or PR creation

## Repository Shape

- `packages/contracts`: shared domain schemas and types, including partitioned memory contracts
- `packages/policy`: eligibility, risk, approval, and guardrail logic
- `packages/control-plane`: lifecycle, planning pipeline orchestration, concurrency/stale-run enforcement, approval queue and decision helpers, OpenClaw context and runtime instruction materialization helpers, managed workspace lifecycle helpers, and structured observability hooks
- `packages/execution-plane`: agent definitions and disabled future phases
- `packages/evidence`: persistence schema, SQL migrations, policy snapshot storage, approval-request persistence, partitioned memory persistence/query helpers, pipeline-run persistence, Postgres-backed repository implementations, and run summaries
- `packages/integrations`: read-only GitHub and CI adapter contracts, deterministic issue-intake helpers, and v1 mutation guards
- `agents/`, `prompts/`, `schemas/`, `standards/`: mounted runtime assets consumed by OpenClaw
- `infra/docker`: local stack topology for OpenClaw and Postgres

## Quick Start

1. Enable Corepack if needed: `corepack enable`
2. Install dependencies: `corepack pnpm install`
3. Copy env file: `Copy-Item .env.example .env`
4. Start the local stack: `docker compose -f infra/docker/docker-compose.yml up -d`
5. Apply DB schema: `corepack pnpm db:migrate`
6. Run checks: `corepack pnpm typecheck`, `corepack pnpm test`, `corepack pnpm verify:postgres`, `corepack pnpm verify:context`, `corepack pnpm verify:workspace-manager`, `corepack pnpm verify:approvals`, `corepack pnpm verify:observability`, `corepack pnpm verify:integrations`, `corepack pnpm verify:memory`, `corepack pnpm verify:concurrency`, and `corepack pnpm verify:package`

## Runtime Model

- `openclaw` runs as a container and can mount either this repo read-only for development or a packaged policy-pack artifact from `artifacts/policy-packs/.../policy-root` for immutable promotion.
- `postgres` stores manifests, planning specs, policy snapshots, approval requests and decisions, evidence metadata, run events, durable pipeline-run records for overlap control, derived run summaries, and partitioned memory across task, project, organization, and external scopes.
- Host-side verification uses `POSTGRES_HOST_PORT` and defaults to `55432` to avoid collisions with an existing local Postgres on `5432`.
- Host-side DB clients should use `127.0.0.1` instead of `localhost` on this Windows setup because `localhost` can resolve through `wslrelay` and miss the Docker-bound listener.
- Host-side context materialization defaults to `REDDWARF_HOST_WORKSPACE_ROOT=runtime-data/workspaces` and writes `.context/` plus generated `SOUL.md`, `AGENTS.md`, `TOOLS.md`, and `skills/reddwarf-task/SKILL.md` files into each workspace. Managed workspaces also receive `.workspace/workspace.json`, isolated `scratch/`, and `artifacts/` directories and can be explicitly destroyed through the workspace manager.
- GitHub and CI integrations are modeled as read-only adapters in v1. Issue intake and status reads are supported; branch, PR, label, workflow, and secret mutations stay blocked behind explicit `V1MutationDisabledError` guards.
- Concurrency is conservative by default: overlapping active runs for the same task source are serialized, stale runs are retired based on heartbeat age, and fresh overlaps are blocked with durable run-level evidence. Planning runs that require downstream mutation also open a durable approval queue entry and remain blocked until a human approves or rejects the request.
- `runtime-workspace` and `runtime-evidence` are separate writable volumes for container runtime use. Standard lifecycle commands are `corepack pnpm workspace:materialize` and `corepack pnpm workspace:destroy`.
- This repo is the Dev Squad definition repo, not the product code repo.

## Versioned Policy Packs

- Build a versioned artifact with `corepack pnpm package:policy-pack`.
- Verify the packaged runtime with `corepack pnpm verify:package`.
- Point Docker Compose at the packaged root with `REDDWARF_POLICY_SOURCE_ROOT=<artifact path>`.
- Packaged artifacts contain the runtime assets, built package dist output, packaged manifests, and a self-contained runtime `node_modules` tree materialized from the repo's installed dependency graph.

