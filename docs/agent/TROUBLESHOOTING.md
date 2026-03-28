# Troubleshooting

## `apply_patch` fails in the Windows sandbox

- Symptom: `functions.apply_patch` returns `windows sandbox: setup refresh failed with status exit code: 1`.
- Root cause: the local Windows sandbox intermittently fails while refreshing the patch-edit environment, so the patch helper never starts.
- Failing approach: direct `apply_patch` edits for repository files.
- Working workaround: use narrow PowerShell or inline Python file edits, then immediately rerun `corepack pnpm typecheck` and the affected test/verify commands.
- Verification: `corepack pnpm typecheck`, `corepack pnpm test`, and any feature-specific Postgres verification still pass after the scripted edit.

## Vitest commands fail or skip in the sandbox

- Symptom: `corepack pnpm test`, focused commands such as `corepack pnpm test -- packages/control-plane/src/index.test.ts`, or `corepack pnpm test:postgres` fail with `spawn EPERM` while loading `vitest.config.ts`, or the Postgres file runs but all DB-backed tests are skipped.
- Root cause: in this Windows sandbox, Vitest/Vite may not be allowed to spawn the esbuild helper process, and the Postgres test file only enables the DB suite when `HOST_DATABASE_URL` or `DATABASE_URL` is present.
- Failing approach: rerunning Vitest-based commands inside the default sandbox, especially without the DB env vars for `test:postgres`.
- Working workaround: rerun Vitest commands with escalated permissions when the spawn error appears. For DB-backed coverage, prefer `corepack pnpm verify:postgres`, `corepack pnpm verify:approvals`, `corepack pnpm verify:development`, `corepack pnpm verify:validation`, `corepack pnpm verify:evidence`, and `corepack pnpm verify:scm` when `test:postgres` is skipped by missing env vars.
- Verification: `corepack pnpm typecheck`, `corepack pnpm test`, focused `corepack pnpm test -- ...` suites, `corepack pnpm verify:postgres`, `corepack pnpm verify:approvals`, `corepack pnpm verify:workspace-manager`, `corepack pnpm verify:development`, `corepack pnpm verify:validation`, `corepack pnpm verify:evidence`, and `corepack pnpm verify:scm`.

## Workspace-local validation commands hit `spawn EPERM` in the sandbox

- Symptom: `corepack pnpm verify:validation`, `corepack pnpm verify:secrets`, `corepack pnpm verify:evidence`, `corepack pnpm verify:scm`, or direct `runValidationPhase(...)` executions fail with a `PlanningPipelineFailure` whose root cause is `spawn EPERM` when the validation runner launches workspace-local commands.
- Root cause: the Windows sandbox can block child-process creation from Node even when the command being launched is just `process.execPath -e ...` inside the managed workspace.
- Failing approach: running validation-phase command execution inside the default sandbox.
- Working workaround: rerun validation orchestration outside the sandbox when `spawn EPERM` appears; in this repo that means rerunning `corepack pnpm verify:validation`, `corepack pnpm verify:secrets`, `corepack pnpm verify:evidence`, `corepack pnpm verify:scm`, or `corepack pnpm verify:recovery` with escalated permissions.
- Verification: `corepack pnpm typecheck`, `corepack pnpm test`, `corepack pnpm verify:validation`, `corepack pnpm verify:secrets`, `corepack pnpm verify:evidence`, `corepack pnpm verify:scm`, and `corepack pnpm verify:recovery` all pass once the validation runner is allowed to spawn its workspace-local commands.


## Archived evidence cleanup

- Symptom: feature verifiers or ad hoc phase runs leave durable artifact files behind even after destroyTaskWorkspace(...) succeeds.
- Root cause: feature 22 archives handoffs, logs, results, reports, and diffs under the evidence root, which is intentionally separate from the managed workspace root.
- Failing approach: deleting only the workspace root or assuming destroyTaskWorkspace(...) also removes archived evidence.
- Working workaround: when a verifier or manual run overrides evidenceRoot, clean that directory explicitly after assertions; if no override is provided, remember the default archive location is the sibling ../evidence directory next to the workspace root.
- Verification: rerun the relevant verifier, then confirm the workspace is removed while archived files persist until the explicit evidence-root cleanup runs.

## OpenClaw UI loads but RedDwarf agents do not appear

- Symptom: the Control UI opens, but the repo-specific agents are missing, `node openclaw.mjs agents list` only shows defaults or fails to show the RedDwarf roster, and logs may mention invalid `agents` keys.
- Root cause: RedDwarf was still generating the older object-keyed agent config shape (`agents.reddwarf-coordinator`, etc.), but current OpenClaw expects per-agent entries under `agents.list[]` with explicit `id` fields.
- Failing approach: copying a legacy `openclaw.json` template into runtime state and expecting current OpenClaw to discover repo agents from keyed object entries.
- Working workaround: update both the control-plane generator and [infra/docker/openclaw.json](/c:/Dev/RedDwarf/infra/docker/openclaw.json) to use `agents.list[]`, then force-recreate the `openclaw` service so it reseeds `runtime-data/openclaw-home/openclaw.json`. Verify with `docker compose -f infra/docker/docker-compose.yml exec openclaw sh -lc "node openclaw.mjs agents list"`.
- Verification: the running config in `runtime-data/openclaw-home/openclaw.json` contains `agents.list`, `docker compose -f infra/docker/docker-compose.yml exec openclaw sh -lc "node openclaw.mjs agents list"` prints `reddwarf-coordinator`, `reddwarf-analyst`, and `reddwarf-validator`, and `curl http://127.0.0.1:3578/` plus `curl http://127.0.0.1:3578/health` both return `200`.
## OpenClaw container is healthy but the host cannot open the UI

- Symptom: `docker compose ps` shows `openclaw` healthy on host port `3578`, `Test-NetConnection 127.0.0.1 -Port 3578` succeeds, but `curl http://127.0.0.1:3578/health` or opening `http://127.0.0.1:3578/` from the host returns an empty reply or a closed connection.
- Root cause: OpenClaw defaults to binding the gateway to `127.0.0.1:18789` inside the container. Docker still publishes the port, but host traffic cannot reach a loopback-only listener inside the container.
- Failing approach: starting the `openclaw` profile with only `OPENCLAW_HOST_PORT` set and assuming the published port alone makes the UI reachable.
- Working workaround: seed [infra/docker/openclaw.json](/c:/Dev/RedDwarf/infra/docker/openclaw.json) into the writable host-backed runtime directory at `runtime-data/openclaw-home/openclaw.json`, reference the repo-root `.env` directly from `infra/docker/docker-compose.yml` with `env_file: ../../.env`, and do not also override `OPENCLAW_HOOK_TOKEN` or `OPENCLAW_GATEWAY_TOKEN` under the service `environment:` block. Then recreate the `openclaw` service. Use `http://127.0.0.1:3578/` for the Control UI and `http://127.0.0.1:8080/` only for the separate RedDwarf operator API.
- Verification: `docker compose -f infra/docker/docker-compose.yml logs openclaw` should show `ws://0.0.0.0:18789` without any `EACCES` around `openclaw.json`; host requests to `http://127.0.0.1:3578/` should return `200`, and `runtime-data/openclaw-home` should contain `openclaw.json`, `canvas/`, and `logs/`.

## `pnpm e2e` fails with `ECONNREFUSED 127.0.0.1:55532`

- Symptom: `corepack pnpm e2e` creates or starts processing a live GitHub issue, then fails during planning with `connect ECONNREFUSED 127.0.0.1:55532` from `PostgresPlanningRepository.listPipelineRuns(...)`.
- Root cause: the E2E script was assuming the local Docker-backed Postgres stack and schema were already ready before it called `runPlanningPipeline(...)`; it also allowed `E2E_USE_OPENCLAW=true` to proceed without first checking whether the gateway was actually reachable.
- Failing approach: running `pnpm e2e` before `pnpm run setup`, or enabling `E2E_USE_OPENCLAW=true` without a reachable gateway, then relying on a later pipeline phase to surface those missing local prerequisites after the GitHub issue has already been created.
- Working workaround: run `corepack pnpm run setup` first, or use the updated `scripts/e2e-integration.mjs` which now executes the same setup preflight automatically before it creates any GitHub issue. If `E2E_USE_OPENCLAW=true`, the script now also validates `OPENCLAW_BASE_URL`, `OPENCLAW_HOOK_TOKEN`, and `/health` reachability before issue creation.
- Verification: `corepack pnpm build`; `corepack pnpm run setup`; `Test-NetConnection 127.0.0.1 -Port 55532`; if using OpenClaw, confirm `${OPENCLAW_BASE_URL}/health`; rerun `corepack pnpm e2e`.

## `pnpm e2e` opens a follow-up SCM failure issue saying `No commits between ...`

- Symptom: the live E2E run creates a source issue successfully, then later opens a follow-up GitHub issue for SCM failure with a GitHub `422` response stating there are no commits between `main` and the RedDwarf branch.
- Root cause: the current default developer workflow is still read-only, so it produces evidence and validation output but no product-code commit. Routing those runs into SCM creates an impossible PR request.
- Failing approach: sending any read-only developer run straight from validation into SCM just because the task requested `can_open_pr`.
- Working workaround: use the updated pipeline, which now keeps read-only `can_open_pr` tasks at `await_review` and only allows SCM when the developer handoff records `codeWriteEnabled: true`.
- Verification: `corepack pnpm build`; `corepack pnpm test -- packages/control-plane/src/index.test.ts`; rerun the live E2E and confirm it stops after validation with `await_review` instead of creating a follow-up SCM failure issue.
