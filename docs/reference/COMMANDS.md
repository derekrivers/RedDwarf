# Commands Reference

Every `pnpm` script in [package.json](../../package.json), grouped by purpose. Prefix each with `corepack` if pnpm isn't on your `PATH`.

## Lifecycle

| Command | Purpose |
|---|---|
| `pnpm start` | **Recommended entrypoint.** Builds, brings up Docker Compose, runs migrations, sweeps stale runs, starts operator API, dashboard, and polling daemon in one foreground process. |
| `pnpm run setup` | Infrastructure + migrations + health check + workspace cleanup. Does not start the operator API. |
| `pnpm teardown` | Sweeps in-flight runs, stops services, cleans old workspaces. Preserves the database volume by default. Flags: `-- --dry-run`, `-- --clean-evidence <days>`, `-- --destroy-volumes`. |
| `pnpm operator:api` | Start the operator API standalone on `:8080` (also launches the dashboard dev server on `:5173`). |
| `pnpm compose:up` | `docker compose up -d` for Postgres only. |
| `pnpm compose:up:openclaw` | `docker compose up -d` with the `openclaw` profile (Postgres + OpenClaw gateway). |
| `pnpm compose:down` | Stop the Docker stack without housekeeping. |

## Build and static analysis

| Command | Purpose |
|---|---|
| `pnpm build` | `tsc -b` across the monorepo. |
| `pnpm typecheck` | `tsc -b --pretty false`. Non-writing. |
| `pnpm test` | `vitest run`. Unit tests only — does not run E2E. |
| `pnpm test:postgres` | Integration tests that need a live Postgres. Auto-starts the container if needed. |
| `pnpm lint` | `eslint .`. |
| `pnpm format:check` | `prettier --check .`. |

## Database

| Command | Purpose |
|---|---|
| `pnpm db:generate` | Generate a new migration with `drizzle-kit`. |
| `pnpm db:migrate` | Apply pending SQL migrations. Idempotent; `pnpm start` runs this automatically. |

## OpenClaw

| Command | Purpose |
|---|---|
| `pnpm generate:openclaw-config` | Regenerate `runtime-data/openclaw-home/openclaw.json` from RedDwarf's typed config surface. `pnpm setup` and `pnpm start` do this automatically. |
| `pnpm workspace:materialize` | Materialise an OpenClaw workspace (context bundle + bootstrap files). Mostly for scripted demos and verification. |
| `pnpm workspace:destroy` | Destroy a materialised workspace. |

## Policy pack

| Command | Purpose |
|---|---|
| `pnpm package:policy-pack` | Build a versioned immutable policy-pack artifact under `artifacts/policy-packs/`. |
| `pnpm validate:policy-pack` | Sanity-check a packaged artifact. |
| `pnpm verify:package` | End-to-end verification of the packaged runtime. |

## CLIs (via repo `bin`)

| Command | Purpose |
|---|---|
| `pnpm exec reddwarf submit …` | Submit a task directly to the operator API. See `pnpm exec reddwarf --help`. |
| `pnpm exec reddwarf report --last` | Export the most recent run as markdown (or JSON with `--json`). |
| `pnpm reddwarf:report` | Alias for `reddwarf report`. |

## Evidence

| Command | Purpose |
|---|---|
| `pnpm query:evidence` | Browse evidence rows and archive directories. |
| `pnpm cleanup:evidence` | Remove old evidence. Dry-run by default. Pair with `--max-age-days N` and `--delete`. |
| `pnpm cleanup:approvals` | Prune stale approval requests. |

## Verification suites

Each runs a focused integration check. All depend on a built tree (`pnpm build`), which they invoke themselves.

| Command | Covers |
|---|---|
| `pnpm verify:all` | Aggregate suite — runs every individual `verify:*` below. |
| `pnpm verify:postgres` | Planning pipeline + Postgres integration. |
| `pnpm verify:context` | Workspace context materialisation. |
| `pnpm verify:observability` | Run-event streams and summaries. |
| `pnpm verify:integrations` | GitHub / CI / secrets adapter contracts. |
| `pnpm verify:memory` | Partitioned memory records (task / project / org / external). |
| `pnpm verify:concurrency` | Durable pipeline-run locking and stale-run retirement. |
| `pnpm verify:workspace-manager` | Workspace lifecycle helpers. |
| `pnpm verify:approvals` | Approval queue and decision workflow. |
| `pnpm verify:development` | Developer-phase orchestration. |
| `pnpm verify:validation` | Validation-phase orchestration. |
| `pnpm verify:secrets` | Scoped secret lease injection + redaction. |
| `pnpm verify:scm` | SCM branch/PR adapter fixtures and guards. |
| `pnpm verify:evidence` | Evidence archival schema and retrieval. |
| `pnpm verify:recovery` | Failure-recovery retry and escalation paths. |
| `pnpm verify:operator-api` | Operator HTTP API contract. |
| `pnpm verify:operator-mcp` | MCP bridge server behaviour. |
| `pnpm verify:report-cli` | `reddwarf report` CLI. |
| `pnpm verify:submit-cli` | `reddwarf submit` CLI. |
| `pnpm verify:knowledge-ingestion` | Knowledge ingestion pipeline. |
| `pnpm verify:bootstrap-alignment` | Generated bootstrap files stay aligned with agent contracts. |

## E2E and chaos

Do not run as part of CI. Each consumes real GitHub resources and LLM tokens.

| Command | Purpose |
|---|---|
| `pnpm e2e` | Full end-to-end integration test against a real repo. `E2E_TARGET_REPO=owner/repo` required. See [DEMO_RUNBOOK.md](../DEMO_RUNBOOK.md). |
| `pnpm e2e:cleanup` | Close/delete GitHub resources from a prior E2E run. |
| `pnpm e2e:chaos` | Runs all three chaos scenarios below in sequence. |
| `pnpm e2e:chaos:kill-recover` | Kill the operator process mid-run and verify recovery. |
| `pnpm e2e:chaos:pg-restart` | Restart Postgres mid-run and verify the pool reconnects. |
| `pnpm e2e:chaos:openclaw-kill` | Kill the OpenClaw container mid-run. |
| `pnpm chaos:run` | Generic chaos orchestrator (see [chaos-engineering.md](../chaos-engineering.md)). |
| `pnpm loadtest` | `k6 run tests/k6-operator-api.js`. Requires `k6` on the host. |

## See also

- [GETTING_STARTED.md](../GETTING_STARTED.md) — when you'd reach for each command during normal work.
- [OPERATOR_API.md](OPERATOR_API.md) — HTTP surface these commands interact with.
- [chaos-engineering.md](../chaos-engineering.md) — chaos scenarios and expected behaviour.
