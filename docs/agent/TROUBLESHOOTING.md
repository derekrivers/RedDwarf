# Troubleshooting

## GitHub Actions `docker compose ... config` fails because `.secrets` is missing

- Symptom: CI fails on `docker compose -f infra/docker/docker-compose.yml config` with `env file .../.secrets not found`.
- Root cause: the compose file now intentionally reads both `.env` and `.secrets`, but a clean GitHub Actions checkout only creates `.env` unless the workflow also creates the empty companion secrets file.
- Failing approach: copying `.env.example` to `.env` in CI and then validating Compose without first creating `.secrets`.
- Working workaround: add a workflow step such as `touch .secrets` before any `docker compose ... config` or `docker compose ... up` command. This mirrors the repo's normal `setup` / `start` behavior, which already ensures the file exists locally.
- Verification: rerun the workflow and confirm `docker compose -f infra/docker/docker-compose.yml config` succeeds on a clean checkout.

## `corepack pnpm ...` fails immediately in WSL with a Windows Node path

- Symptom: repo scripts such as `corepack pnpm verify:package` fail before running project code with errors like `/mnt/c/Program Files/nodejs/corepack: cannot execute: required file not found`, and direct calls to `"/mnt/c/Program Files/nodejs/node.exe"` fail with `WSL ... UtilBindVsockAnyPort ... socket failed 1`.
- Root cause: this shell session has no usable Linux `node` or `pnpm` on `PATH`, and the fallback Windows-installed Node/Corepack binaries under `/mnt/c/Program Files/nodejs` are not executable from the current WSL environment.
- Failing approach: retrying repo `corepack pnpm ...` scripts from the same WSL shell without first providing a Linux Node toolchain or switching to a host shell that can run the Windows Node installation.
- Working workaround: run the verification from a shell with native Linux `node`/`pnpm` available on `PATH`, or rerun it from the Windows host shell where the installed `corepack` and `node.exe` work normally.
- Verification: `which node`, `which pnpm`, `node --version`, and then the target repo command such as `corepack pnpm verify:package` should all succeed before relying on the result.

## `apply_patch` fails in the Windows sandbox

- Symptom: `functions.apply_patch` returns `windows sandbox: setup refresh failed with status exit code: 1`.
- Root cause: the local Windows sandbox intermittently fails while refreshing the patch-edit environment, so the patch helper never starts.
- Failing approach: direct `apply_patch` edits for repository files.
- Working workaround: use narrow PowerShell or inline Python file edits, then immediately rerun `corepack pnpm typecheck` and the affected test/verify commands.
- Verification: `corepack pnpm typecheck`, `corepack pnpm test`, and any feature-specific Postgres verification still pass after the scripted edit.

## New GitHub issues stop appearing in /approvals even though the source issue is open

- Symptom: a fresh `ai-eligible` GitHub issue exists upstream, but RedDwarf never creates the corresponding manifest or approval row, `GET /approvals` stays unchanged, and the stack appears idle rather than failed.
- Root cause: before the March 29, 2026 fail-fast patch, unresolved repository or network promises could leave the poller or ready-task dispatcher stuck in an in-flight state forever, so later interval ticks only saw `already running` behavior and never advanced the cursor or dispatch queue.
- Failing approach: checking only issue labels or approvals API output without also checking persisted polling health and long-running active tasks.
- Working workaround: on older builds, inspect `GET /health` polling cursor timestamps plus any long-running active run, then manually re-run intake or restart the stack. On current builds, rely on the added cycle/request timeouts so the loop fails fast, logs an error, and enters backoff instead of silently freezing.
- Verification: `corepack pnpm typecheck`; `corepack pnpm test -- packages/control-plane/src/index.test.ts packages/integrations/src/index.test.ts packages/execution-plane/src/index.test.ts`.

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

## OpenClaw Control UI keeps saying `pairing required` after pasting the gateway token

- Symptom: the OpenClaw container is healthy, `/health` works, the runtime `openclaw.json` contains real token values, but the browser still loops between `token_missing`, `connect failed`, and `pairing required`.
- Root cause: the browser is creating a pending operator-device pairing request on the gateway WebSocket, but that request has not been approved inside the running OpenClaw container yet. Resetting browser storage or `runtime-data/openclaw-home/devices` alone does not clear the requirement once a new pending request has been issued.
- Failing approach: repeatedly pasting `OPENCLAW_GATEWAY_TOKEN`, wiping browser state, or recreating `runtime-data/openclaw-home` without approving the newly pending device request.
- Working workaround:
  - list pending requests inside the running container with `docker exec -it docker-openclaw-1 node dist/index.js devices list`
  - note the pending request id for the `operator` role
  - approve it with `docker exec -it docker-openclaw-1 node dist/index.js devices approve <request-id>`
  - reload the Control UI in the same browser session and reconnect
- Verification: rerun `docker exec -it docker-openclaw-1 node dist/index.js devices list` and confirm the request is no longer pending, then reload `http://127.0.0.1:3578/` and verify the UI connects without emitting new `pairing required` websocket closures.

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
- Root cause: RedDwarf's current Docker-hosted OpenClaw topology is not wired for the Docker sandbox backend. The seeded gateway container does not have usable Docker backend access, so enabling OpenClaw sandbox modes that expect Docker-backed session isolation fails at runtime.
- Failing approach: preserving per-agent `sandbox.mode=all` or `sandbox.mode=non-main` in `openclaw.json` and expecting the current Docker-hosted gateway container to launch Docker-backed sandboxes without additional backend wiring.
- Working workaround: for the current deployment, generate or seed agent configs with `sandbox: { mode: "off" }` and rely on the outer container boundary plus explicit tool allowlists. The current generator in [packages/control-plane/src/openclaw-config.ts](/c:/Dev/RedDwarf/packages/control-plane/src/openclaw-config.ts) and Docker template in [infra/docker/openclaw.json](/c:/Dev/RedDwarf/infra/docker/openclaw.json) now do this.
- Unblocking paths:
  - preferred: run OpenClaw directly on a Linux host or VPS and let the gateway use host Docker for sandboxed sessions
  - alternative: rebuild the Docker deployment around OpenClaw's upstream sandbox-enabled container flow so the gateway container has supported Docker backend access
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

## Operator API now returns `401 unauthorized` for routes that used to work locally

- Symptom: `curl` or a local script can still reach `GET /health`, but `GET /approvals`, `GET /blocked`, `POST /approvals/:id/resolve`, or `POST /tasks/:taskId/dispatch` now return `401 {"error":"unauthorized"...}`.
- Root cause: feature 94 hardened the localhost operator surface. Every operator route except `GET /health` now requires the configured `REDDWARF_OPERATOR_TOKEN` via `Authorization: Bearer <token>` or `x-reddwarf-operator-token`.
- Failing approach: treating the operator API as an unauthenticated localhost control port, or starting `scripts/start-stack.mjs` / `scripts/start-operator-api.mjs` without `REDDWARF_OPERATOR_TOKEN` set.
- Working workaround: set `REDDWARF_OPERATOR_TOKEN` in the environment before starting the stack, then include `Authorization: Bearer ${REDDWARF_OPERATOR_TOKEN}` on every protected operator request. Manual dispatch roots are also now restricted to the configured managed roots, so do not pass arbitrary filesystem paths.
- Verification: `corepack pnpm verify:operator-api`; `curl http://127.0.0.1:8080/health`; `curl http://127.0.0.1:8080/approvals -H "Authorization: Bearer <REDDWARF_OPERATOR_TOKEN>"`.

## OpenClaw cannot register RedDwarf commands as `/status`, `/approve`, or `/reject`

- Symptom: a custom OpenClaw plugin tries to register RedDwarf operator commands named `/status`, `/approve`, or `/reject`, but the gateway keeps the built-in behavior or rejects the plugin command registration.
- Root cause: current OpenClaw builds reserve those slash-command names for gateway-native commands. Plugins can add new command names, but they cannot safely override the built-ins.
- Failing approach: implementing feature 121 with exact command names and expecting the RedDwarf plugin to replace the upstream `/status`, `/approve`, or `/reject` handlers.
- Working workaround: keep the RedDwarf-specific commands on non-conflicting aliases such as `/rdstatus`, `/rdapprove`, and `/rdreject`, while using exact `/runs` and `/submit` because those names are not reserved in the current runtime.
- Verification: `docker compose -f infra/docker/docker-compose.yml exec -T openclaw sh -lc "node openclaw.mjs plugins inspect reddwarf-operator --json"` should show the RedDwarf plugin commands, and the built-in slash-command docs still list `/status` and `/approve` as native OpenClaw commands.

## OpenClaw warns that a repo plugin may auto-load because `plugins.allow` is empty

- Symptom: after adding a repo-mounted OpenClaw plugin, gateway logs warn that `plugins.allow is empty; discovered non-bundled plugins may auto-load`.
- Root cause: OpenClaw treats repo plugins as non-bundled code and expects an explicit trust list in `plugins.allow` so only named plugin ids are permitted to load from configured paths.
- Failing approach: adding `plugins.load.paths` and `plugins.entries` for a repo plugin without also pinning the trusted plugin ids.
- Working workaround: set `plugins.allow` explicitly in both the generated config and the checked-in template. For feature 121, RedDwarf now trusts only `reddwarf-operator`.
- Verification: regenerate `runtime-data/openclaw-home/openclaw.json`, recreate the OpenClaw container, and confirm `node openclaw.mjs plugins inspect reddwarf-operator --json` reports `status: "loaded"` without the trust warning.

## RedDwarf MCP bridge inside OpenClaw cannot reach the operator API

- Symptom: MCP tool calls such as `reddwarf_get_task_history` or `reddwarf_get_run_evidence` fail from inside OpenClaw with connection errors to `127.0.0.1:8080` or `ECONNREFUSED` against the operator API.
- Root cause: the MCP server runs inside the OpenClaw container, so `127.0.0.1` refers to the container itself rather than the host-side operator API process.
- Failing approach: configuring the MCP bridge to inherit the host-default `REDDWARF_API_URL=http://127.0.0.1:8080` without overriding it for the container runtime.
- Working workaround: set `REDDWARF_OPENCLAW_OPERATOR_API_URL=http://host.docker.internal:8080` in the OpenClaw service environment, map `host.docker.internal:host-gateway` in Docker Compose, and inject that value into `mcp.servers.reddwarf.env.REDDWARF_API_URL` when generating `openclaw.json`.
- Verification: regenerate `runtime-data/openclaw-home/openclaw.json`, recreate OpenClaw, and run `docker compose -f infra/docker/docker-compose.yml exec -T openclaw sh -lc "node openclaw.mjs config get mcp.servers"`; the `reddwarf` entry should show `REDDWARF_API_URL` pointing at `http://host.docker.internal:8080`.

## GitHub AI Task issues using the checked-in template still get rejected as under-specified

- Symptom: a GitHub issue created from `.github/ISSUE_TEMPLATE/ai-task.yml` is ingested, but pre-screening blocks planning with `under_specified` and says no affected paths were provided even though the issue includes an `Affected Areas` section.
- Root cause: there were two parser mismatches in `packages/integrations/src/github.ts`: it originally only recognized the heading `Affected Paths`, and it also cleared the active section whenever it saw a blank line. GitHub issue markdown places a blank line after headings like `## Acceptance Criteria`, so the parser discarded the section before it reached the bullet list.
- Failing approach: resubmitting the same issue body with either `Affected Areas` or `Affected Paths` while relying on the original parser to preserve section context across blank lines.
- Working workaround: intake now accepts both `Affected Paths` and `Affected Areas`, and it keeps the current section active across blank lines so standard GitHub markdown sections still populate `acceptanceCriteria` and `affectedPaths`.
- Verification: `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm test -- packages/integrations/src/github.test.ts"` and confirm the parser test covering blank lines after headings passes.
- Additional note: a second follow-up bug let `Affected Paths` continue absorbing later sections like `## Constraints` and `## Risk Class`, which polluted `allowedPaths` and appended `low` to the manifest summary. The parser now drops the active section when any new markdown heading starts, and summary text is built only from the narrative `Summary`, `Why`, and `Desired Outcome` sections.

## OpenClaw developer runs time out with `EACCES: permission denied, mkdir '/home/derek'`

- Symptom: development runs block with `OPENCLAW_COMPLETION_TIMED_OUT`, while `docker compose ... logs openclaw` shows `hook agent failed: Error: EACCES: permission denied, mkdir '/home/derek'` and heartbeat failures against the same path.
- Root cause: the generated `/home/node/.openclaw/openclaw.json` baked the host-only `REDDWARF_OPENCLAW_WORKSPACE_ROOT` path (for example `/home/derek/code/RedDwarf/runtime-data/openclaw-workspaces`) into each agent's `workspace` and `agentDir`. Inside the container only `REDDWARF_WORKSPACE_ROOT` is mounted, so OpenClaw tried to create directories under an unmapped host path and failed before producing a developer handoff.
- Failing approach: generating the runtime config with `REDDWARF_OPENCLAW_WORKSPACE_ROOT` or a host-resolved relative path as the agent workspace root, then recreating OpenClaw and expecting in-container agents to write there.
- Working workaround: generate `openclaw.json` with the container-visible runtime root (`REDDWARF_WORKSPACE_ROOT`, default `/var/lib/reddwarf/workspaces`) and recreate the OpenClaw container. Verify the live config shows `/var/lib/reddwarf/workspaces` for every agent `workspace` and `agentDir`.
- Verification: `node scripts/generate-openclaw-config.mjs /var/lib/reddwarf/workspaces runtime-data/openclaw-home/openclaw.json`; `docker compose -f infra/docker/docker-compose.yml --profile openclaw up -d --force-recreate openclaw`; `docker compose -f infra/docker/docker-compose.yml --profile openclaw exec -T openclaw sh -lc 'grep -n "workspace\\|agentDir" /home/node/.openclaw/openclaw.json | head -n 20'`.
