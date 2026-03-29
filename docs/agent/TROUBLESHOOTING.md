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

## OpenClaw `/hooks/agent` returns `404` even though `/health` is healthy

- Symptom: `curl http://localhost:3578/health` returns `200`, but RedDwarf developer dispatch fails with `OpenClaw dispatch to .../hooks/agent returned 404: Not Found`.
- Root cause: the gateway config did not enable hook ingress. Current OpenClaw requires an explicit `hooks` block, a hook token, a `defaultSessionKey`, and `allowedSessionKeyPrefixes` that include `hook:` when request-supplied session keys are allowed.
- Failing approach: treating `/health` success as proof that `/hooks/agent` is enabled, or seeding an `openclaw.json` without a `hooks` section.
- Working workaround: generate or seed [infra/docker/openclaw.json](/c:/Dev/RedDwarf/infra/docker/openclaw.json) with `hooks.enabled: true`, `path: "/hooks"`, `defaultSessionKey: "hook:ingress"`, `allowRequestSessionKey: true`, and `allowedSessionKeyPrefixes: ["hook:", "github:issue:"]`, then force-recreate the `openclaw` service.
- Verification: `curl http://localhost:3578/health`; `curl -X POST http://localhost:3578/hooks/agent -H "Authorization: Bearer <OPENCLAW_HOOK_TOKEN>" -H "Content-Type: application/json" -d "{}"`; a healthy hook ingress should return `400 {"ok":false,"error":"message required"}` rather than `404`.

## OpenClaw container starts but the gateway never becomes healthy after config changes

- Symptom: `docker compose ... ps openclaw` stays `unhealthy` or restart-loops, `curl http://localhost:3578/health` returns `STATUS:000`, and OpenClaw logs only repeated `Config observe anomaly: ... missing-meta-vs-last-good` messages.
- Root cause: stale state in `runtime-data/openclaw-home` can accumulate `openclaw.json.clobbered.*` artifacts and leave `config-health.json` pinned to `missing-meta-vs-last-good`, which causes current OpenClaw builds to choke on config observation and sometimes hit a config-read stack overflow.
- Failing approach: repeatedly force-recreating the container against the same corrupted `runtime-data/openclaw-home` and expecting the gateway to recover on its own.
- Working workaround: stop the OpenClaw container, move `runtime-data/openclaw-home` aside to a timestamped backup, create a fresh `runtime-data/openclaw-home` directory, then recreate the service so it reseeds clean state from [infra/docker/openclaw.json](/c:/Dev/RedDwarf/infra/docker/openclaw.json).
- Verification: `docker stop docker-openclaw-1`; move `runtime-data/openclaw-home` to a backup name; `docker compose -f infra/docker/docker-compose.yml --profile openclaw up -d --force-recreate openclaw`; confirm `docker compose ... ps openclaw` is `healthy` and `curl http://localhost:3578/health` returns `200`.

## OpenClaw agent turns fail with `Sandbox mode requires Docker, but the "docker" command was not found in PATH`

- Symptom: live dispatch reaches OpenClaw, then agent lanes fail immediately with errors such as `Sandbox mode requires Docker, but the "docker" command was not found in PATH`.
- Root cause: the Docker-hosted OpenClaw deployment was still asking OpenClaw to launch its own nested Docker sandbox (`sandbox.mode=all`), but the OpenClaw container image does not include an inner `docker` CLI.
- Failing approach: preserving per-agent `sandbox.mode=all` in `openclaw.json` and expecting Docker-in-Docker sandboxing to work inside the existing OpenClaw container.
- Working workaround: for this deployment, generate or seed agent configs with `sandbox: { mode: "off" }` and rely on the outer container boundary plus explicit tool allowlists. The current generator in [packages/control-plane/src/openclaw-config.ts](/c:/Dev/RedDwarf/packages/control-plane/src/openclaw-config.ts) and Docker template in [infra/docker/openclaw.json](/c:/Dev/RedDwarf/infra/docker/openclaw.json) now do this.
- Verification: recreate OpenClaw, dispatch a developer session, and confirm the logs no longer contain the missing-`docker` sandbox error.

## OpenClaw warns that agent allowlists contain unknown entries like `group:memory`

- Symptom: OpenClaw logs warnings such as `agents.reddwarf-developer.tools.allow allowlist contains unknown entries (group:memory)`.
- Root cause: RedDwarf role definitions were still including `group:memory`, but that tool group is not available in the current OpenClaw runtime, so the allow entry can never resolve.
- Failing approach: leaving `group:memory` in the machine-readable role definitions or the seeded Docker template after the runtime reports it as unknown.
- Working workaround: remove `group:memory` from the execution-plane role definitions, the Docker template, and the human-readable bootstrap `TOOLS.md` files. The current source of truth no longer includes it.
- Verification: recreate OpenClaw and inspect the seeded `runtime-data/openclaw-home/openclaw.json`; the agent `tools.allow` arrays should no longer contain `group:memory`, and subsequent logs should not emit the unknown-group warning.

## OpenClaw warns that the `coding` profile contains unavailable tools like `apply_patch` or `image_generate`

- Symptom: OpenClaw logs warnings such as `tools.profile (coding) allowlist contains unknown entries (apply_patch, image_generate)`.
- Root cause: the built-in `coding` profile in the current OpenClaw release references shipped tools that are not available in this runtime/provider/model/config combination.
- Failing approach: keeping analyst, validator, or developer agents on `tools.profile: "coding"` when the runtime reports unavailable profile members.
- Working workaround: do not use the built-in `coding` profile in this runtime. Use `tools.profile: "full"` plus RedDwarf's explicit `tools.allow`/`tools.deny` group lists so built-in file/runtime tools remain available without inheriting the broken `coding` profile entries.
- Verification: recreate OpenClaw, inspect the seeded `runtime-data/openclaw-home/openclaw.json`, and confirm the affected agents use `"profile": "full"`; subsequent dispatch logs should no longer complain about `apply_patch` or `image_generate` coming from the `coding` profile.

## OpenClaw developer runs time out even though the agent finished work in a different workspace path

- Symptom: pnpm e2e reaches developer dispatch, then fails with Timed out waiting for OpenClaw developer completion..., while the OpenClaw session logs show the developer wrote docs/health-check.md and developer-handoff.md under /var/lib/reddwarf/workspaces/<workspaceId> instead of the nested E2E workspace path.
- Root cause: the OpenClaw prompt used workspaceId to build runtime paths and dropped any nested path segments under the host workspace root, so OpenClaw wrote to the wrong mounted directory when E2E used untime-data/workspaces/e2e-*/<workspaceId>.
- Failing approach: deriving runtime-visible workspace paths as join(REDDWARF_WORKSPACE_ROOT, workspace.workspaceId) for every run.
- Working workaround: set REDDWARF_HOST_WORKSPACE_ROOT in the E2E runner and derive the runtime-visible path from the relative path between the real host workspace root and workspace.workspaceRoot; keep REDDWARF_WORKSPACE_ROOT as the container-visible mount root.
- Verification: rerun E2E_TARGET_REPO=derekrivers/FirstVoyage E2E_USE_OPENCLAW=true E2E_CLEANUP=false corepack pnpm e2e and confirm the developer phase completes, validation returns wait_scm, and SCM opens a real PR.

## OpenClaw developer handoff times out even though the developer agent committed changes

- Symptom: `pnpm e2e` reaches developer dispatch, the OpenClaw developer agent writes `developer-handoff.md` and commits code changes to the repo, but the handoff awaiter times out because `git status --porcelain` reports a clean working tree.
- Root cause: the developer agent (Lister) committed changes directly using `git add && git commit` instead of leaving them as unstaged modifications. The `repositoryHasChanges` check only tested `git status --porcelain`, which returns empty for a committed repo.
- Failing approach: relying solely on `git status --porcelain` to detect developer work product.
- Working workaround: `repositoryHasChanges` now also checks `git rev-list --count HEAD > 1` to detect local commits beyond the initial shallow clone. The commit publisher similarly handles pre-committed changes by checking for commits beyond the base branch instead of requiring uncommitted files.
- Verification: rerun `E2E_TARGET_REPO=derekrivers/FirstVoyage E2E_USE_OPENCLAW=true corepack pnpm e2e` and confirm the developer phase completes, validation returns `await_scm`, and SCM opens a real PR.
