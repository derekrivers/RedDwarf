# Agent Documentation

## 2026-04-04

- Shifted RedDwarf’s repo-write policy from strict allowlist enforcement to a denylist-first model for code-writing work. `allowedPaths` now remain preferred implementation guidance, while new `deniedPaths` carry the hard blocklist for secrets, git internals, and runtime state.
- Updated workspace context, runtime instructions, developer prompts, and SCM/development enforcement so agents can create adjacent implementation/config/helper files when needed unless they hit a blocked repo path. This removes the previous tendency to fail legitimate scaffolding work on companion files like `vite.config.ts` or `index.html`.
- Added contract, policy, workspace-materialization, and control-plane regression coverage for the new denylist-first path model, including blocked-path prompt text, denied-path artifacts in `.context`, and SCM publish rejection when a blocked file is touched.

- Investigated a live degraded-dashboard report and traced it to persisted polling health rather than the dashboard shell itself. The current dashboard badge only degrades on `repository.status === "degraded"` or `polling.status === "degraded"`.
- Confirmed the live repo cursor for `derekrivers/FirstVoyage` was marked failed with `last_poll_error` showing a Zod `too_big` validation error on `confidenceReason` (`maximum: 300`), which meant planning output length could poison polling health even while Postgres and OpenClaw stayed healthy.
- Updated `packages/control-plane/src/pipeline/planning.ts` to normalize planner confidence reasons before `planningSpecSchema.parse(...)`: trim whitespace, substitute a fallback when blank, and truncate overlong values to the persisted 300-character limit.
- Added regression coverage in `packages/control-plane/src/index.test.ts` proving an overlong planner confidence reason now survives planning, persists safely, and keeps the approval payload aligned with the stored spec.
- Added a troubleshooting entry documenting the degraded-dashboard symptom, root cause, working workaround, and verification path for future poller-health investigations.

## 2026-04-03

- Investigated the live stall on GitHub issue 37 (`derekrivers-firstvoyage-37`) and confirmed the blocker was not the allowed-path gate itself: the generated React workspace had no `.gitignore`, so `git add --all` in the SCM phase would try to stage the full `node_modules/` tree after `npm install`.
- Updated RedDwarf's generated-artifact path expansion so `package.json` now auto-allows both `package-lock.json` and `.gitignore`, and extended workspace/context materialization so the developer-facing allowed-path list includes that companion file instead of implicitly discouraging it.
- Tightened the OpenClaw developer prompt to explicitly say `.gitignore` is approved when `package.json` is in scope, keeping install/build artifacts like `node_modules/` out of version control during package-managed scaffolds.
- Added regression coverage for generated package companion files in allowed-path enforcement, planning snapshots/approval requests, and developer prompt guidance.

## 2026-04-02

- Changed the downstream policy contract so development workspaces are expected to run local verification instead of deferring all execution to validation. `buildPolicySnapshot(...)` now always includes `can_run_tests`, development capabilities in `@reddwarf/policy` explicitly include `can_run_tests`, and the workspace guidance/prompting now tells OpenClaw developers to run the most relevant local checks before handing off.
- Fixed a control-plane bug that still rejected honest developer test runs after the policy change: the OpenClaw developer path was checking `codeWriteEnabled` instead of `toolPolicy.allowedCapabilities.includes("can_run_tests")` when deciding whether test execution claims were legal. The guard now keys off the actual `can_run_tests` capability, so read-only developer workspaces can still run tests while remaining unable to write code unless separately approved.
- Added regression coverage proving: planning snapshots include `can_run_tests`; readonly OpenClaw developer workspaces surface `can_run_tests`; developer handoffs that report executed tests now pass when the capability is present; and prompt text now instructs developers to run tests in development rather than only mentioning deferred validation.

- Hardened the developer-handoff test-claim guardrail after a live issue-34 failure showed the old detector was too broad: it could reject honest deferred-validation wording merely because the handoff mentioned `Vitest` or `pnpm test`.
- Updated the OpenClaw developer prompt so non-test-capable workspaces explicitly say tests must not be described as run, passed, failed, executed, validated, or verified in development, while still allowing honest deferred wording about future validation work.
- Tightened `handoffClaimsTestExecution(...)` so it now flags affirmative execution claims only, while allowing phrases like `Tests were not run in development because can_run_tests is denied` and `Validation should run pnpm test later`.
- Added regression coverage proving the bad `pnpm test completed successfully` handoff still fails while deferred-validation wording now passes.

- Added a second layer of hardening for the issue-32 frontend workflow after confirming the remaining violation was a genuinely unapproved helper file: the developer agent chose the common Vitest pattern of creating `tests/setup.ts` and wiring it through `vite.config.ts`.
- Added `packages/control-plane/src/scope-risks.ts` plus a pre-dispatch scope-risk check in the development phase. When the approved scope includes Vite config and test files but no standalone setup helper path, the pipeline now records a `SCOPE_RISK_DETECTED` warning and injects prompt guidance telling the developer to keep setup inside the approved test file instead of creating `tests/setup.ts`.
- Added regression coverage proving the OpenClaw developer prompt includes the new scope-risk warning before dispatch for the same class of Vite-plus-test tasks that triggered the live issue-32 failure.

- Hardened the approved-path workflow after a live issue-32 failure exposed two separate problems: planning `affectedAreas` entries could include human-readable descriptions after an em dash, and runtime enforcement was treating those full strings as literal paths.
- Added a shared allowed-path normalizer, updated planning/workspace bundling/runtime enforcement to collapse annotated entries such as `tsconfig.json — create or update ...` down to `tsconfig.json`, and added regression coverage proving those annotated entries pass while genuinely extra files like `tests/setup.ts` still fail policy enforcement.
- Tightened the OpenClaw developer prompt so agents are told not to invent helper/setup/config files outside the exact allowed-path list, and to report those needs as blocked instead.
- Reworked `scripts/start-stack.mjs` so Postgres starts first, the operator API comes up next, and OpenClaw starts only after the API is listening; a live OpenClaw recreate after this change stayed clean past the previous `failed to start server "reddwarf" ... connection timed out after 30000ms` failure window.
- Added troubleshooting entries for both the annotated allowed-path false-positive and the OpenClaw MCP startup-order race.

- Fixed an operator API bug affecting the new dashboard approval-detail route: encoded approval request IDs like `task:approval:uuid` were being decoded on the client but not on the `/approvals/:requestId` and `/approvals/:requestId/resolve` server routes.
- Updated `packages/control-plane/src/operator-api.ts` to decode approval IDs before lookup and added regression coverage in `packages/control-plane/src/operator-api.test.ts` for URL-encoded approval IDs on both detail and resolve endpoints.

- Fixed a dashboard startup regression where Vite tried to create `packages/dashboard/node_modules/.vite/deps_temp_*` and failed with `EACCES` on this machine.
- Updated `packages/dashboard/vite.config.ts` so the dashboard now uses `runtime-data/dashboard-vite-cache` by default, with `REDDWARF_DASHBOARD_CACHE_DIR` available as an override when a different writable cache path is needed.
- Added a troubleshooting entry documenting the failing default cache path and the runtime-data workaround for future dashboard startup issues.

- Diagnosed an OpenClaw RedDwarf MCP bridge regression where the gateway kept logging `failed to start server "reddwarf" ... connection timed out after 30000ms` even though the generated `openclaw.json` had the correct per-server `REDDWARF_API_URL=http://host.docker.internal:8080`.
- Root cause: inside the container, the service-level `REDDWARF_API_URL` still defaulted to `http://127.0.0.1:8080`. Direct MCP handshake tests showed the bridge worked when forced to use `host.docker.internal`, but real bundled launches could still fall back to the container-wide env instead of the `mcp.servers.reddwarf.env` override.
- Updated `infra/docker/docker-compose.yml` so the OpenClaw service now exports `REDDWARF_API_URL=${REDDWARF_OPENCLAW_OPERATOR_API_URL:-http://host.docker.internal:8080}` alongside the existing plugin/MCP-specific operator API URL setting.
- Added a troubleshooting note documenting the fallback-env failure mode and the service-level `REDDWARF_API_URL` fix for future OpenClaw MCP debugging.

- Diagnosed an OpenClaw Control UI recovery path that was not yet captured in repo memory: a healthy gateway with real auth tokens can still keep returning `pairing required` until the pending operator-device request is explicitly approved inside the running container.
- Added a troubleshooting entry with the working recovery flow: `docker exec -it docker-openclaw-1 node dist/index.js devices list` to find the pending operator request, then `docker exec -it docker-openclaw-1 node dist/index.js devices approve <request-id>` to approve it before retrying the browser UI.

## 2026-04-01

- Fixed a GitHub Actions regression where `docker compose -f infra/docker/docker-compose.yml config` failed on clean runners because `.secrets` was missing even though Compose now references it for both services.
- Updated `.github/workflows/ci.yml` to create an empty repo-root `.secrets` file after copying `.env.example`, matching the local `setup` / `start` contract.
- Added a troubleshooting note documenting the CI symptom, root cause, and the `touch .secrets` workaround for future workflow changes.

- Added [docs/ARCHITECTURE.md](/home/derek/code/RedDwarf/docs/ARCHITECTURE.md), a current-state architecture reference covering the control-plane/runtime split, pipeline lifecycle, OpenClaw integration model, Discord/WebChat/MCP operator surfaces, storage layout, trust boundaries, and deployment topology with Mermaid diagrams.
- Linked the README to the new architecture doc so operators and contributors have a single entry point for system design context.

- Cleaned up `README.md` and `docs/DEMO_RUNBOOK.md` after the M14 operator-surface rollout so the docs match the current user-facing workflow.
- Replaced the stale demo-runbook advice about a hand-written polling launcher with the real repo-management flow (`corepack pnpm start` plus `POST /repos` or the `/ui` panel), corrected the agent-roster count to five, and clarified that post-approval phases now continue automatically while the stack is running.
- Aligned the OpenClaw config-path defaults across `.env.example`, `scripts/generate-openclaw-config.mjs`, and the operator API metadata so the documented manual generator path now matches the live `runtime-data/openclaw-home/openclaw.json` file used by normal startup.
- Updated `scripts/verify-all.mjs` to include `verify-operator-mcp.mjs`, closing the aggregate verification gap introduced when feature 122 landed.

- Completed feature 122 from `FEATURE_BOARD.md`: added a read-only MCP bridge over the operator API for task history and evidence lookups.
- Added `packages/control-plane/src/operator-mcp.ts` plus `scripts/start-operator-mcp.mjs`, implementing a stdio MCP server that proxies to the existing operator API with read-only tools for task-history search, task detail, task evidence, run listing, run detail, and run evidence.
- Registered that bridge in generated and checked-in OpenClaw runtime config under `mcp.servers.reddwarf`, using the already-established `REDDWARF_OPENCLAW_OPERATOR_API_URL` host mapping and the operator bearer token for authenticated calls from inside the gateway container.
- Added focused unit coverage in `packages/control-plane/src/operator-mcp.test.ts`, extended `packages/control-plane/src/openclaw-config.test.ts` to assert the new MCP config surface, and added `scripts/verify-operator-mcp.mjs` plus the `verify:operator-mcp` package script for a protocol-level end-to-end check.
- Live runtime verification confirmed that the recreated gateway carries `mcp.servers.reddwarf` in `/home/node/.openclaw/openclaw.json` with the expected `node /opt/reddwarf/scripts/start-operator-mcp.mjs` command and the host-reachable operator API URL.
- Verification for feature 122: `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm typecheck"`; `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm test -- packages/control-plane/src/operator-mcp.test.ts packages/control-plane/src/openclaw-config.test.ts"`; `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm verify:operator-mcp"`; `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm build && node scripts/generate-openclaw-config.mjs runtime-data/openclaw-workspaces runtime-data/openclaw-home/openclaw.json"`; `docker compose -f infra/docker/docker-compose.yml --profile openclaw up -d --force-recreate openclaw`; `docker compose -f infra/docker/docker-compose.yml exec -T openclaw sh -lc "node openclaw.mjs config get mcp.servers"`.
- Updated the feature board so feature 122 is marked complete. All M14 items are now delivered.

- Completed feature 121 from `FEATURE_BOARD.md`: registered OpenClaw WebChat operator commands through a repo-mounted `reddwarf-operator` plugin.
- Added a native OpenClaw plugin under `agents/openclaw/plugins/reddwarf-operator/` with command handlers for recent runs, lightweight task submission, and RedDwarf-specific status and approval flows backed by the existing operator API.
- Wired the generated and checked-in `openclaw.json` configs to load that plugin from the mounted policy tree, enabled explicit slash-command parsing in the runtime config, and added `REDDWARF_OPENCLAW_OPERATOR_API_URL` plus a Docker `host.docker.internal` mapping so the gateway container can call the host-side operator API.
- Added an explicit OpenClaw `plugins.allow` trust list for `reddwarf-operator` after live gateway verification surfaced the non-bundled-plugin auto-load warning. The trust-list fix is now part of the generated config and the checked-in template.
- Upstream OpenClaw reserves `/status`, `/approve`, and `/reject`, so the RedDwarf plugin deliberately registers `/rdstatus`, `/rdapprove`, and `/rdreject` while keeping `/runs` and `/submit` on their exact names. This limitation is documented in `README.md` and `docs/agent/TROUBLESHOOTING.md`.
- Expanded config-generation coverage in `packages/control-plane/src/openclaw-config.test.ts` so plugin load paths, plugin config, and explicit command-surface settings stay under test.
- Verification for feature 121: `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm typecheck"`; `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm test -- packages/control-plane/src/openclaw-config.test.ts"`; `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm build && node scripts/generate-openclaw-config.mjs runtime-data/openclaw-workspaces runtime-data/openclaw-home/openclaw.json"`; `docker compose -f infra/docker/docker-compose.yml --profile openclaw up -d --force-recreate openclaw`; `docker compose -f infra/docker/docker-compose.yml exec -T openclaw sh -lc "node openclaw.mjs plugins inspect reddwarf-operator --json"`.
- Updated the feature board so feature 121 is marked complete and feature 122 is now the next actionable M14 item.

- Completed feature 120 from `FEATURE_BOARD.md`: served a single-file operator configuration panel from `GET /ui`.
- Added a browser-first operator panel on the existing operator API server with grouped sections for Polling & Dispatch, DB Pool tuning, Logging, Paths, Status, repo management, recent runs/tasks, and write-only secret rotation.
- Kept the page single-file by rendering inline HTML/CSS/JS from the control-plane package and reusing the existing operator endpoints for live mutations instead of adding a separate frontend build pipeline.
- Added a protected `GET /ui/bootstrap` metadata route so the page can load version, uptime, path values, masked secret status, and OpenClaw reachability after the operator pastes `REDDWARF_OPERATOR_TOKEN` into the page.
- Expanded contract and operator API coverage for the new UI bootstrap response and HTML panel route, and extended `scripts/verify-operator-api.mjs` to assert that `/ui` and `/ui/bootstrap` are live in the Postgres-backed server.
- Verification for feature 120: `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm typecheck"`; `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm test -- packages/contracts/src/index.test.ts packages/control-plane/src/operator-api.test.ts"`; `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work --network host node:22 bash -lc "corepack pnpm verify:operator-api"`.
- Updated the feature board so feature 120 is marked complete and feature 121 is now the next actionable M14 item.
- Completed feature 119 from `FEATURE_BOARD.md`: added write-only operator secret rotation backed by a restricted local `.secrets` store.
- Added typed operator-secret contracts, a `POST /secrets/:key/rotate` operator API route, and allowlisted rotation support for GitHub, Anthropic, OpenClaw, Discord, and operator bearer tokens.
- The rotation flow now persists secrets to a repo-root `.secrets` file with `0600` permissions, updates `process.env` for the current Node process, and returns only non-secret metadata plus restart guidance for long-lived services.
- Updated startup and tooling env loading so `.env` and `.secrets` are both consumed across `start`, `setup`, the operator API entry point, the CLI, teardown, and E2E scripts; `setup` / `start` also create an empty `.secrets` file before Docker Compose starts so Compose can always mount it safely.
- Updated Docker Compose, README, and the demo runbook so the local secret-store behavior and restart expectations are documented.
- Verification for feature 119: `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm typecheck"`; `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm test -- packages/contracts/src/index.test.ts packages/control-plane/src/operator-api.test.ts"`; `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work --network host node:22 bash -lc "corepack pnpm verify:operator-api"`.
- Updated the feature board so feature 119 is marked complete and feature 120 is now the next actionable M14 item.
- Completed feature 118 from `FEATURE_BOARD.md`: expanded the operator observability surface for runs, evidence, and tasks.
- Extended repository query contracts with repo-aware run filters plus first-class task-manifest queries so the operator API can list tasks across states without reconstructing everything from bespoke snapshot routes.
- Added repo-filter support to `GET /runs`, a new `GET /runs/:id/evidence` route, a filtered `GET /tasks` summary route, and `GET /tasks/:id` for task-level history, approvals, and run summaries while keeping the older snapshot/evidence routes intact.
- Added focused in-memory repository coverage for task-manifest and repo-filtered run queries, plus operator API coverage for the new observability routes.
- Expanded `scripts/verify-operator-api.mjs` to exercise the new run evidence and task summary/detail routes against the Postgres-backed operator API.
- Verification for feature 118: `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm typecheck"`; `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm test -- packages/contracts/src/index.test.ts packages/evidence/src/index.test.ts packages/control-plane/src/operator-api.test.ts"`; `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work --network host node:22 bash -lc "corepack pnpm verify:operator-api"`.
- Updated the feature board so feature 118 is marked complete and feature 119 is now the next actionable M14 item.
- Completed feature 117 from `FEATURE_BOARD.md`: added operator repo-management endpoints and moved poll-repo control to the database.
- Added shared operator-repo contracts so `GET /repos`, `POST /repos`, and `DELETE /repos/:owner/:repo` validate against the same typed surface as the rest of the operator API.
- Extended the evidence repository with polling-cursor deletion support and used the existing `github_issue_polling_cursors` table as the durable source of truth for the polled repo roster.
- Updated the operator API to list, create, and delete polled repositories through the cursor store, returning current per-repo polling status without requiring a separate repo table.
- Updated the GitHub polling daemon so it can run against a DB-managed repo roster even when no static `REDDWARF_POLL_REPOS` list is configured at startup.
- Updated `scripts/start-stack.mjs` to seed `REDDWARF_POLL_REPOS` into the DB cursor store only as a backward-compatible bootstrap path; ongoing repo management now belongs to the operator API.
- Expanded focused coverage in `packages/contracts/src/index.test.ts`, `packages/evidence/src/index.test.ts`, `packages/control-plane/src/operator-api.test.ts`, `packages/control-plane/src/polling-daemon.test.ts`, and `scripts/verify-operator-api.mjs`.
- Verification for feature 117: `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm typecheck"`; `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm test -- packages/contracts/src/index.test.ts packages/evidence/src/index.test.ts packages/control-plane/src/operator-api.test.ts packages/control-plane/src/polling-daemon.test.ts"`.
- Updated the feature board so feature 117 is marked complete and feature 118 is now the next actionable M14 item.
- Completed feature 116 from `FEATURE_BOARD.md`: added `GET /config`, `PUT /config`, and `GET /config/schema` to the operator API.
- Extended the operator-config contracts with defaults, descriptions, env parsing helpers, update request and response schemas, and a JSON-schema-style schema response builder so the future UI can validate against the same typed source of truth.
- Updated the operator API to return effective runtime config entries with value, default, description, source, and persisted timestamp; `PUT /config` now validates updates with Zod, persists them to `operator_config`, and applies the serialized value to `process.env` for the current process.
- Expanded focused coverage in `packages/contracts/src/index.test.ts`, `packages/control-plane/src/operator-api.test.ts`, and `scripts/verify-operator-api.mjs` to cover config response metadata, schema exposure, bad-update rejection, and persisted update behavior.
- Updated `README.md` and `docs/DEMO_RUNBOOK.md` so the new configuration endpoints are documented alongside the existing operator routes.
- Verification status for feature 116: coverage was added, but local execution remains blocked in this WSL session because Docker is unavailable, Linux `node`/`pnpm` are absent, and the documented Windows host fallback still cannot resolve the repo path from this environment.
- Updated the feature board so feature 116 is marked complete and feature 117 is now the next actionable M14 item.
- Completed feature 115 from `FEATURE_BOARD.md`: added DB-backed runtime config persistence and startup merge logic.
- Added typed operator-config contracts for runtime-configurable env keys, plus serialization helpers so persisted values can round-trip cleanly between JSONB storage and `process.env`.
- Added `operator_config` persistence to the evidence layer with a new SQL migration (`packages/evidence/drizzle/0012_operator_config.sql`), in-memory and Postgres repository support, row mapping, and focused repository coverage.
- Updated `scripts/lib/config.mjs`, `scripts/start-stack.mjs`, and `scripts/start-operator-api.mjs` so startup now loads `.env`, then overlays any matching runtime-config rows from Postgres before deriving API, polling, OpenClaw, and pool settings.
- Updated the README configuration docs to note that `operator_config` overrides `.env` only for runtime-classified keys.
- Verification status for feature 115: added focused contract, repository, and Postgres-backed tests, but local execution was blocked in this WSL session because Docker is unavailable, Linux `node`/`pnpm` are absent, and the documented Windows host fallback could not resolve the repo path from this environment.
- Updated the feature board so feature 115 is marked complete and feature 116 is now the next actionable M14 item.
- Completed feature 114 from `FEATURE_BOARD.md`: classified the live env surface into boot-time, runtime-configurable, secrets, and dev/E2E tiers.
- Refactored `.env.example` to use grouped section headers for infrastructure, OpenClaw runtime toggles, polling/dispatch/API settings, pool and guardrail controls, secrets, and local E2E helpers.
- Updated the README configuration reference to mirror the same classification so operators can see which values are safe future UI candidates versus restart-required bootstrap settings and plaintext-only secrets.
- Updated the feature board so feature 114 is marked complete and feature 115 is now the next actionable M14 item.
- Reviewed `docs/RedDwarf-UX-Research-Report.md` and reprioritized `FEATURE_BOARD.md` around operator experience rather than only pipeline internals.
- Added a new top-priority `M14 — Operator UX` milestone covering `.env` classification, DB-backed runtime config, Operator API config and repo-management endpoints, richer runs/tasks observability, write-only secret rotation, a single-file `/ui` operator panel, OpenClaw WebChat commands, and an MCP bridge over the Operator API.
- Added a new `M18 — VPS Expansion` milestone covering VPS-specific compose topology, webhook intake, Tailscale Funnel exposure, CI webhook reception, and multi-provider failover after config-schema validation.
- Extended the active board format with explicit `Depends On` and `Deployment` columns so upcoming work is easier to sequence and reason about.
- Current likely next board item: feature 117, add repo-management endpoints and move poll repo control off the comma-string env surface.
- Completed feature 112 from `FEATURE_BOARD.md`: phase retry budget.
- Added explicit per-phase retry-budget configuration via `REDDWARF_MAX_RETRIES_*` env vars, including alias names that match the proposal document (`ARCHITECT`, `DEVELOPER`, `VALIDATOR`, `REVIEWER`) plus repo-native phase names.
- Added durable retry-budget state under `failure.retry_budget.<phase>` so repeated failures now persist attempts, last error, retry limit, and exhausted state independently per phase instead of relying only on the legacy manifest-wide `retryCount`.
- Extended automated recovery to architecture review, so `architecture_review` can now queue one automated retry and then escalate through the existing approval flow when its retry budget is exhausted.
- Kept SCM retry behavior opt-in by config: the retry-budget plumbing supports SCM, but the default limit remains `0` to preserve the repo's earlier first-failure escalation behavior unless `REDDWARF_MAX_RETRIES_SCM` is set.
- Updated `GET /blocked` to include `retryExhaustedEntries` with attempts, retry limit, and last error for failure-automation approvals whose retry budget is exhausted.
- Approval resolution now resets the exhausted retry-budget state when an operator approves a failure-automation request, so the task can be re-queued intentionally after the underlying issue is fixed.
- Added focused coverage in `packages/contracts/src/index.test.ts`, `packages/control-plane/src/index.test.ts`, and `packages/control-plane/src/operator-api.test.ts` for retry-budget state parsing, architecture-review exhaustion, and `/blocked` exhausted-entry reporting.
- Verification for feature 112: `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm typecheck"`; `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm test -- packages/contracts/src/index.test.ts packages/control-plane/src/index.test.ts packages/control-plane/src/operator-api.test.ts"`.
- Completed feature 113 from `FEATURE_BOARD.md`: structured eligibility rejection reasons.
- Added first-class `eligibility_rejections` contracts and evidence storage, plus a new additive SQL migration (`packages/evidence/drizzle/0011_eligibility_rejections.sql`) so rejections are queryable instead of disappearing into phase logs.
- The planning pipeline now records structured rejection rows for both eligibility-gate failures (`label-missing`, `under-specified`) and pre-screen failures (`duplicate`, `under-specified`, `out-of-scope`) with source issue context and dry-run state.
- Added protected operator route `GET /rejected` with `limit`, `reason`, and `since` filters plus a `byReason` breakdown so operators can inspect the current rejection mix without log archaeology.
- Added focused coverage in `packages/contracts/src/index.test.ts`, `packages/control-plane/src/index.test.ts`, and `packages/control-plane/src/operator-api.test.ts` for rejection-record parsing, planning-time rejection persistence, and `/rejected` responses.
- Verification for feature 113: `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm typecheck"`; `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm test -- packages/contracts/src/index.test.ts packages/control-plane/src/index.test.ts packages/control-plane/src/operator-api.test.ts"`.

## 2026-03-26

- Completed feature 18 from `FEATURE_BOARD.md`: developer phase orchestration with code-write disabled by default.
- Enabled the `development` phase in policy/execution routing, added `runDeveloperPhase`, and introduced a deterministic developer handoff flow that provisions an isolated workspace, captures a `developer-handoff.md` artifact, and blocks cleanly pending the future validation phase.
- Expanded workspace tool policy contracts with explicit `codeWriteEnabled: false` and `development_readonly` mode so the runtime instructions and workspace descriptors both express that product code mutation is still disabled by default.
- Added `corepack pnpm verify:development` plus new unit and Postgres-backed coverage for developer-phase persistence, approval handoff, workspace policy metadata, and derived task memory.
- Environment note: `corepack pnpm test:postgres` can hit a sandbox `spawn EPERM` during Vitest startup and the test file is skipped unless `HOST_DATABASE_URL` or `DATABASE_URL` is set; prefer the documented workaround in `docs/agent/TROUBLESHOOTING.md`.
- Completed feature 19 from `FEATURE_BOARD.md`: validation phase runner for lint and test execution in workspaces.
- Added `runValidationPhase`, a deterministic validation agent, `validation_only` workspace tool policy metadata, workspace-local validation logs/report artifacts, and `validation.summary` task memory so approved tasks can advance from developer handoff into automated checks before blocking on review.
- Added `corepack pnpm verify:validation` plus unit and Postgres-backed coverage for validation success and failure paths, validation workspace descriptors, validation memory/evidence persistence, and review-pending run summaries.
- Environment note: `corepack pnpm verify:validation` can also hit a sandbox `spawn EPERM` because the validation runner launches workspace-local child processes; rerun it outside the sandbox and prefer the documented workaround in `docs/agent/TROUBLESHOOTING.md`.
- Updated repository docs and the feature board so features 18 and 19 are marked complete and feature 20 is now the likely next actionable item.
- Likely next board item: feature 20, secrets adapter and scoped credential injection rules.
- Completed feature 20 from `FEATURE_BOARD.md`: secrets adapter and scoped credential injection rules.
- Added scoped secret approvals to policy snapshots, runtime tool contracts, workspace descriptors, and approval summaries so approved development and validation runs can express least-privilege secret scopes without persisting secret values in evidence metadata.
- Added a fixture-backed secrets adapter, workspace-local `.workspace/credentials/secret-env.json` materialization, fail-closed lease issuance, and validation-log redaction so injected values stay out of durable logs while remaining available inside the managed workspace.
- Added unit coverage plus `corepack pnpm verify:secrets` to exercise scoped lease issuance, workspace credential policy metadata, fail-closed behavior when no adapter is configured, and end-to-end redaction during validation command execution.
- Environment note: `corepack pnpm verify:secrets` uses the validation runner and can hit the same Windows sandbox `spawn EPERM` behavior as `corepack pnpm verify:validation`; rerun it outside the sandbox and prefer the documented workaround in `docs/agent/TROUBLESHOOTING.md`.
- Updated repository docs and the feature board so feature 20 is marked complete and feature 21 is now the likely next actionable item.
- Likely next board item: feature 21, SCM adapter with branch and PR creation behind approval gates.
- Completed feature 21 from `FEATURE_BOARD.md`: SCM adapter with branch and PR creation behind approval gates.
- Enabled the `scm` phase in policy and execution routing, added `runScmPhase` plus a deterministic SCM agent, and persisted branch/PR summaries, SCM reports, task memory, and completion metadata back into the manifest and evidence store.
- Validation now hands approved `can_open_pr` tasks directly into SCM because review automation is still blocked; all other tasks still stop after validation with `await_review`.
- Expanded workspace tool policy contracts with `scm_only` mode so SCM workspaces allow `can_open_pr` and evidence capture while product code writes remain disabled.
- Added `corepack pnpm verify:scm` plus unit and Postgres-backed coverage for validation-to-SCM handoff, fixture-backed branch/PR creation, SCM workspace descriptors, and completed-task persistence.
- Environment note: `corepack pnpm verify:scm` traverses the validation runner first and can hit the same Windows sandbox `spawn EPERM` behavior as `corepack pnpm verify:validation`; rerun it outside the sandbox and prefer the documented workaround in `docs/agent/TROUBLESHOOTING.md`.
- Updated repository docs and the feature board so feature 21 is marked complete and feature 22 is now the likely next actionable item.
- Likely next board item: feature 22, evidence artifact archival for diffs, logs, test results, and review outputs.
- Completed feature 22 from `FEATURE_BOARD.md`: evidence artifact archival for diffs, logs, test results, and review outputs.
- Added durable evidence archival helpers in the control plane so developer handoffs, validation logs and results, validation reports, SCM reports, and SCM diff summaries are copied out of temporary workspaces into the evidence root before workspace teardown, with file hashes, byte sizes, source locations, and archived `evidence://` links persisted in evidence metadata.
- Added `corepack pnpm verify:evidence` plus unit and Postgres-backed coverage for archived artifact persistence across workspace destruction, including explicit checks for handoff, log, report, test-result, and diff artifact classes.
- Updated the development and validation verifiers to use dedicated evidence roots and clean them up explicitly because archived artifacts now live outside the managed workspace root.
- Environment note: `corepack pnpm verify:evidence` traverses the validation runner and can hit the same Windows sandbox `spawn EPERM` behavior as `corepack pnpm verify:validation`; rerun it outside the sandbox and prefer the documented workaround in `docs/agent/TROUBLESHOOTING.md`.
- Updated repository docs and the feature board so feature 22 is marked complete and feature 23 is now the likely next actionable item.
- Likely next board item: feature 23, retry, escalation, and follow-up issue automation.
- Completed feature 23 from `FEATURE_BOARD.md`: retry, escalation, and follow-up issue automation.
- Added automated downstream failure recovery in the control plane so developer, validation, and SCM failures now persist recovery decisions, increment retry state for retryable failures, create pending failure-escalation approval requests after retry exhaustion, and optionally open follow-up GitHub issues without dropping the task from the pipeline.
- Validation failure handling now blocks the task with `failure.recovery` task memory, `PHASE_RETRY_SCHEDULED` or `PHASE_ESCALATED` run events, and unique failed/escalated phase records so repeated attempts remain queryable instead of overwriting earlier evidence.
- Extended the GitHub fixture adapter with explicit follow-up issue creation, added focused unit coverage for retry and escalation paths, and added `corepack pnpm verify:recovery` for Postgres-backed verification of retry exhaustion, follow-up issue creation, and pending human escalation state.
- Environment note: `corepack pnpm verify:recovery` traverses the validation runner and can hit the same Windows sandbox `spawn EPERM` behavior as `corepack pnpm verify:validation`; rerun it outside the sandbox and prefer the documented workaround in `docs/agent/TROUBLESHOOTING.md`.
- Updated repository docs and the feature board so feature 23 is marked complete and feature 24 is now the likely next actionable item.
- Likely next board item: feature 24, operator dashboard or API for runs, approvals, evidence, and blocked tasks.
- Completed feature 24 from `FEATURE_BOARD.md`: operator dashboard or API for runs, approvals, evidence, and blocked tasks.
- Added `createOperatorApiServer(config, deps)` to the control-plane package, backed by Node's built-in `http` module (no new external dependencies), exposing: `GET /health`, `GET /runs`, `GET /approvals`, `GET /approvals/:requestId`, `POST /approvals/:requestId/resolve`, `GET /tasks/:taskId/evidence`, `GET /tasks/:taskId/snapshot`, and `GET /blocked`.
- The server tracks its actual bound port after `start()` so callers can use `port: 0` for OS-assigned ports in tests.
- Added 4 focused unit tests covering: empty-repository responses, run/approval filtering by status, single-approval fetch and resolve via POST, and task evidence and snapshot retrieval.
- Added `corepack pnpm verify:operator-api` for Postgres-backed end-to-end verification of all 8 endpoints including the full approval-resolve flow.
- Updated repository docs and the feature board so feature 24 is marked complete and feature 25 is now the likely next actionable item.
- Likely next board item: feature 25, knowledge ingestion pipeline for ADRs, standards, and curated external context.
- Completed feature 25 from `FEATURE_BOARD.md`: knowledge ingestion pipeline for ADRs, standards, and curated external context.
- Added `KnowledgeSource`, `KnowledgeSourceQuery`, `KnowledgeIngestionAdapter`, and `FixtureKnowledgeIngestionAdapter` to the integrations package so callers can define and retrieve project-scoped ADRs, organization-scoped standards, and externally retrieved reference docs through a uniform adapter contract.
- Added `ingestKnowledgeSources(query, deps)` to the control-plane package which lists or fetches sources from the adapter, derives a deterministic `knowledge:<sha256>` memoryId per sourceUri, and saves each source as a `MemoryRecord` with the correct scope, provenance, tags, and sourceUri so `getMemoryContext()` returns them in the right partition without modification.
- The pipeline is idempotent — re-ingesting the same sourceUri upserts the existing record, keeping the memory store stable under repeated runs.
- Added 5 unit tests covering full-batch ingestion, sourceUri filtering, tag filtering, scope filtering, idempotency, and end-to-end appearance in `getMemoryContext`.
- Added `corepack pnpm verify:knowledge-ingestion` for Postgres-backed verification of all ingestion modes plus planning-pipeline context injection.
- Updated repository docs and the feature board so feature 25 is marked complete. All board items through M5 are now delivered.
- Completed a full codebase code review (2026-03-26) covering all 6 packages across code smells, optimisations, and SOLID violations.
- 18 findings recorded as feature board items 26–40 (M6/M7) in `FEATURE_BOARD.md`.
- Full report with problem descriptions, affected line ranges, and concrete fix guidance is at `docs/code-review-m6.md` — read this before picking up any M6 item.
- Likely next board item: feature 26, extract shared concurrency gate utility.
- Completed features 26–31 from `FEATURE_BOARD.md` (M6 refactor pass).
  - Feature 26: extracted `detectOverlappingRuns` helper from the four duplicated stale-run detection loops in `pipeline.ts`.
  - Feature 27: split `control-plane/src/index.ts` (~7000 lines) into `lifecycle.ts`, `logger.ts`, `workspace.ts`, `operator-api.ts`, `knowledge.ts`, `pipeline.ts`, with `index.ts` as a barrel.
  - Feature 28: split `evidence/src/index.ts` (~1519 lines) into `repository.ts`, `postgres-repository.ts`, `factories.ts`, `summarize.ts`, with `index.ts` as a barrel.
  - Feature 29: exported 4 capability constants from `@reddwarf/policy`; imported them in `control-plane/workspace.ts` with aliases, removing duplicated definitions.
  - Feature 30: replaced sequential awaits in `InMemoryPlanningRepository.getTaskSnapshot` with `Promise.all`.
  - Feature 31: removed redundant `workspaceContextBundleSchema.parse` and `runtimeInstructionLayerSchema.parse` calls where the input was already typed as the correct interface.
- Feature 32 (move deterministic agents to execution-plane) is blocked by a circular dependency constraint.
  - `DeterministicDeveloperAgent`, `DeterministicValidationAgent`, and `DeterministicScmAgent` depend on `MaterializedManagedWorkspace` and `WorkspaceContextBundle` (and helpers like `formatLiteralList`, `createScmBranchName`, `createValidationNodeScript`) which live in `control-plane/workspace.ts` and `control-plane/pipeline.ts`.
  - `control-plane` already depends on `execution-plane`; adding the reverse dependency creates a circular package graph.
  - `DeterministicPlanningAgent` only uses contracts types, but its `PlanningAgent` interface and `PlanningDraft` type are defined in `pipeline.ts` — moving it requires also moving those types.
  - Unblocking options for a future M7 pass: (a) move agent interfaces (`PlanningAgent`, `DevelopmentAgent`, `ValidationAgent`, `ScmAgent`) and draft types to `@reddwarf/contracts`; (b) move `MaterializedManagedWorkspace` and related types to `@reddwarf/contracts`; or (c) introduce a new `@reddwarf/agents` package that sits between `execution-plane` and `control-plane`.
- Completed features 33–38 from `FEATURE_BOARD.md` (M6 refactor pass, second half).
  - Feature 33: replaced if/else phase chains in `capabilitiesAllowedForPhase` and `resolveApprovalMode` with `phaseCapabilityMap` lookup table and `planningOnlyPhases` Set constant.
  - Feature 34: `SecretLeaseRequest.riskClass` and `approvalMode` now use imported `RiskClass` and `ApprovalMode` types from `@reddwarf/contracts` instead of inline literal unions.
  - Feature 35: `isCapability` guard now uses `(capabilities as readonly string[]).includes(value)` derived from the contracts `capabilities` tuple rather than a duplicated inline string array.
  - Feature 36: `v1DisabledPhases` exported from `@reddwarf/contracts`; `policy` and `execution-plane` both import and use the shared constant, removing two independent declarations.
  - Feature 37: `archiveStartedAt` captured before evidence persistence calls and `archiveCompletedAt` captured after the final `savePhaseRecord`, so archive durations now reflect real elapsed time.
  - Feature 38: `InMemoryPlanningRepository.listMemoryRecords` now uses a single composed predicate instead of seven chained `.filter()` calls; `redactSecretValues` uses a single compiled regex replace instead of per-secret split/join loops.
- All M6 features (26–31, 33–38) are complete; feature 32 remains blocked by circular dependency constraint (see above). Feature board updated accordingly.
- Likely next board items: features 39–40 (M7: split PlanningRepository interface into read/write contracts; inject pg.Pool into PostgresPlanningRepository constructor).
- Completed features 39–42 from `FEATURE_BOARD.md` (M7 refactor pass).
  - Feature 39: split `PlanningRepository` interface in `packages/evidence/src/repository.ts` into `PlanningCommandRepository` (write methods) and `PlanningQueryRepository` (read/list methods); `PlanningRepository` remains as their intersection for full backward compatibility.
  - Feature 40: changed `PostgresPlanningRepository` constructor to accept a `pg.Pool` instance directly (dependency injection); added `createPostgresPlanningRepository(connectionString, max?)` factory function that creates the pool and wires it in; updated `tests/postgres.test.ts` to use the factory.
  - Feature 41: moved agent interfaces (`PlanningAgent`, `DevelopmentAgent`, `ValidationAgent`, `ScmAgent`), draft types (`PlanningDraft`, `DevelopmentDraft`, `ValidationDraft`, `ScmDraft`, `ValidationCommand`, `ValidationCommandResult`, `ValidationReport`), and `MaterializedManagedWorkspace` into `@reddwarf/contracts/src/index.ts`; removed duplicate definitions from `control-plane/pipeline.ts` and `control-plane/workspace.ts`; updated all imports accordingly.
  - Feature 42: moved `DeterministicPlanningAgent`, `DeterministicDeveloperAgent`, `DeterministicValidationAgent`, `DeterministicScmAgent` into `packages/execution-plane/src/index.ts` with all required private helpers (`formatLiteralList`, `createScmBranchName`, `sanitizeBranchSegment`, `createScmPullRequestBody`, `createValidationNodeScript`); control-plane re-exports the four classes from `@reddwarf/execution-plane` for backward compatibility; feature 32 marked complete.
- All M7 features (39–42) are complete; F32 is also now complete. Feature board updated accordingly.
- Likely next board items: none currently listed; M8 would be the next milestone.

## 2026-03-27

- Diagnosed an OpenClaw host-access issue in the Docker stack: the container published port `3578`, but the gateway was still binding to `127.0.0.1:18789` inside the container, so the host saw an open TCP port with empty HTTP replies and no reachable Control UI.
- Fixed the Docker-side OpenClaw host-access gap by seeding `infra/docker/openclaw.json` into the writable host-backed state directory at `runtime-data/openclaw-home/openclaw.json`, kept `OPENCLAW_GATEWAY_TOKEN` as the host-provided auth secret, and updated `.env.example`, `README.md`, and `docs/DEMO_RUNBOOK.md` with the new startup path.
- Added a troubleshooting entry documenting the symptom (`curl` empty reply on `127.0.0.1:3578`), root cause, and verification path, and clarified that the RedDwarf operator API on `127.0.0.1:8080` is separate from the OpenClaw Control UI on `3578`.
- Follow-up fix: a read-only OPENCLAW_CONFIG_PATH caused startup EACCES errors when OpenClaw tried to persist config seeds. The compose service now seeds the checked-in config template into writable host state before launch, and verification confirmed clean startup plus a reachable Control UI.
- Follow-up fix: docker compose -f infra/docker/docker-compose.yml was not reliably loading the repo-root .env for token values, and explicit ${...:-} token entries under the service environment: block overrode env_file values back to empty. The compose file now references ../../.env directly and relies on env_file for OPENCLAW_HOOK_TOKEN and OPENCLAW_GATEWAY_TOKEN, which verified cleanly after a plain recreate.
- Follow-up fix: current OpenClaw rejected the repository-generated agent config because RedDwarf was still emitting the older object-keyed `agents.{agentId}` shape. The control-plane generator and Docker template now use the current `agents.list[]` schema with explicit `id`, `name`, `workspace`, `agentDir`, and object-style sandbox settings.
- Verification for the agent-roster fix: `corepack pnpm typecheck`; `corepack pnpm test -- packages/control-plane/src/index.test.ts` (rerun outside the sandbox after the documented Vitest `spawn EPERM` failure); `docker compose -f infra/docker/docker-compose.yml --profile openclaw up -d --force-recreate openclaw`; `docker compose -f infra/docker/docker-compose.yml exec openclaw sh -lc "node openclaw.mjs agents list"`; `curl http://127.0.0.1:3578/`; `curl http://127.0.0.1:3578/health`.

- Completed all ten features from `FEATURE_BOARD.md` M8 milestone (F43–F52).
  - Feature 43 (RestGitHubAdapter): implemented `GitHubAdapter` backed by the GitHub REST API using Node 22 `fetch`; `fetchIssueCandidate`, `listIssueCandidates`, `readIssueStatus`, `createIssue`, `createBranch`, `createPullRequest` are all live; `addLabels`/`removeLabels`/`commentOnIssue` remain V1-disabled; `createRestGitHubAdapter` factory reads `GITHUB_TOKEN` from env.
  - Feature 44 (AnthropicPlanningAgent): implemented `PlanningAgent` that calls the Anthropic Messages API with the policy-pack system prompt; `parsePlanningDraft` extracts JSON from the response with a graceful fallback; `createPlanningAgent({ type: "anthropic" | "deterministic" })` factory enables configurable selection; reads `ANTHROPIC_API_KEY` from env.
  - Feature 45 (Real GitHub SCM adapter): `createBranch` fetches the base ref SHA then creates the new ref; `createPullRequest` opens the PR; both implemented in `RestGitHubAdapter` as part of F43; approval gate enforcement stays in the control-plane pipeline.
  - Feature 46 (EnvVarSecretsAdapter): implemented `SecretsAdapter` reading from env vars with configurable prefix (`REDDWARF_SECRET_` by default); supports explicit scope map or automatic scope-prefixed env var discovery; enforces high-risk guard; `createEnvVarSecretsAdapter` factory provided.
  - Feature 47 (Execution-plane unit tests): added `packages/execution-plane/src/index.test.ts` with 24 tests covering all four `DeterministicXxxAgent` classes, `agentDefinitions`, `phaseIsExecutable`, and `createPlanningAgent`; all pass.
  - Feature 48 (verify:all): added `scripts/verify-all.mjs` running all 18 verify scripts as isolated child processes with pass/fail summary; exposed as `pnpm verify:all`.
  - Feature 49 (setup script): added `scripts/setup.mjs` — `compose:up`, 60s Postgres readiness poll, `db:migrate`, health check table query; safe to re-run; exposed as `pnpm run setup`.
  - Feature 50 (evidence cleanup): added `scripts/cleanup-evidence.mjs` with configurable `--max-age-days` threshold, dry-run by default, `--delete` for actual removal; reports eligible dirs/sizes; exposed as `pnpm cleanup:evidence`.
  - Feature 51 (demo runbook): added `docs/DEMO_RUNBOOK.md` covering stack bootstrap, GitHub token + Anthropic API key setup, filing a demo issue, running the full pipeline, inspecting Postgres evidence, and the approval workflow.
  - Feature 52 (README improvements): added prerequisites section, OpenClaw registry access guide, `pnpm run setup` one-command bootstrap, `verify:all` shortcut, Windows `127.0.0.1` note, port `55532` explanation, and `spawn EPERM` workaround pointer.
- All M8 features (F43–F52) are complete. Feature board updated accordingly.
- Post-M8 runbook validation session (2026-03-27): manually tested the full `docs/DEMO_RUNBOOK.md` end-to-end against `derekrivers/FirstVoyage` on GitHub. Fixes applied during the session:
  - `psql` not available on Windows — added `scripts/query-evidence.mjs` and `docker exec` alternative; exposed as `pnpm query:evidence`.
  - Table names had wrong `reddwarf_` prefix in query script and runbook — corrected to `planning_specs`, `phase_records`, `run_events`.
  - `phase_records` column names wrong (`started_at`/`completed_at` do not exist) — corrected to `created_at`, `actor`, `summary`.
  - `AnthropicPlanningAgent` had no retry logic — added 3-attempt backoff for 429/529 responses.
  - Operator API startup command used `InMemoryPlanningRepository` — replaced with `createPostgresPlanningRepository`; added `scripts/start-operator-api.mjs`; exposed as `pnpm operator:api`.
  - Approval resolve endpoint required `decidedBy` and `decisionSummary` but runbook omitted them.
  - Approval decision enum value is `"approve"` not `"approved"`.
  - `start-operator-api.mjs` import paths used `./packages/` instead of `../packages/`.
- Runbook is now fully manually verified end-to-end including the high-risk approval workflow.
- Likely next board items: none; M9 would be the next milestone.

## 2026-03-27 — Phase 2 planning

- Agreed Phase 2 architecture: RedDwarf remains the control plane (intake, policy, risk, approvals, evidence, orchestration); OpenClaw is the bounded execution runtime (agent sessions, workspace loading, tool enforcement, sandboxed execution, model routing).
- HTTP dispatch via `/hooks/agent` is the primary RedDwarf→OpenClaw contract. Session key pattern: `github:issue:<repo>:<issue_number>`. agentId selected by RedDwarf policy. CLI dispatch is backup/debug only. Shared-volume watching is not the primary dispatch mechanism — evidence/artifacts only.
- Code writing (`codeWriteEnabled`) remains disabled in Phase 2. Agent roles, skills, memory, and scope require careful design before enabling mutation.
- Review phase is Phase 3 or later.
- Features F53–F63 added to the board covering M9 (automated intake, agent definitions) and M10 (openclaw.json generation, HTTP dispatch adapter, session capture, developer phase wiring, bootstrap alignment).
- Likely next board item: F53, GitHub issue polling daemon.
- Completed feature 53 from `FEATURE_BOARD.md`: GitHub issue polling daemon with configurable interval and deduplication against existing planning specs.
- Added `createGitHubIssuePollingDaemon(config, deps)` to the control-plane package. It polls one or more GitHub repositories on a configurable interval, converts new `ai-eligible` issue candidates into planning inputs, runs the planning pipeline, and skips issues that already have a persisted planning spec for the same GitHub source.
- Added `PlanningRepository.hasPlanningSpecForSource(source)` to the evidence layer with in-memory and Postgres implementations so polling dedupe is based on durable planning-spec existence rather than on manifest presence alone.
- Added focused unit coverage for polling intake and duplicate suppression in `packages/control-plane/src/index.test.ts`, plus source-dedupe coverage in `packages/evidence/src/index.test.ts`.
- Verification for F53: `corepack pnpm typecheck`; `corepack pnpm test -- packages/control-plane/src/index.test.ts packages/evidence/src/index.test.ts` (rerun outside the sandbox after the documented Vitest `spawn EPERM` failure).
- Updated the feature board so feature 53 is marked complete and feature 54 is now the next actionable M9 item.
- Likely next board item: feature 54, polling cursor persistence in Postgres with per-repo last-seen issue tracking and operator API health exposure.
- Completed feature 54 from `FEATURE_BOARD.md`: polling cursor persistence in Postgres with per-repo last-seen issue tracking and operator API health exposure.
- Added `GitHubIssuePollingCursor` contracts, evidence persistence, and SQL migration support so each polled repository now stores `lastSeenIssueNumber`, poll timestamps, success or failure status, and the last poll error in both in-memory and Postgres repositories.
- Updated `createGitHubIssuePollingDaemon` to read and persist per-repo cursors, plan only unseen issue numbers, and record failed poll attempts without losing the previous last-seen checkpoint.
- Expanded the operator API `GET /health` response to include polling health summary data for all persisted repositories, including degraded status when any repo has a failed last poll.
- Verification for F54: `corepack pnpm typecheck`; `corepack pnpm test -- packages/contracts/src/index.test.ts packages/control-plane/src/index.test.ts packages/evidence/src/index.test.ts`; `node scripts/apply-sql-migrations.mjs`; `corepack pnpm verify:operator-api`.
- Environment note: after evidence-schema changes, run `node scripts/apply-sql-migrations.mjs` before Postgres-backed verify scripts or the live database may be missing newly added tables.
- Updated the feature board so feature 54 is marked complete and feature 55 is now the next actionable M9 item.
- Likely next board item: feature 55, OpenClaw agent role definitions and bootstrap files for coordinator, analyst, and validator agents.
- Completed feature 55 from `FEATURE_BOARD.md`: OpenClaw agent role definitions and bootstrap files for coordinator, analyst, and validator agents.
- Added typed `OpenClawAgentRoleDefinition` contracts plus `openClawAgentRoleDefinitions` and `getOpenClawAgentRoleDefinition(...)` in the execution-plane so future config generation can reference stable coordinator, analyst, and validator role metadata.
- Added versioned bootstrap assets under `agents/openclaw/<role>/...` for each role, including `IDENTITY.md`, `SOUL.md`, `AGENTS.md`, `TOOLS.md`, and a role-specific `skills/reddwarf-openclaw/SKILL.md`.
- Expanded packaged policy-pack verification so `corepack pnpm verify:package` proves those OpenClaw bootstrap files survive into the immutable runtime artifact.
- Verification for F55: `corepack pnpm typecheck`; `corepack pnpm test -- packages/contracts/src/index.test.ts packages/execution-plane/src/index.test.ts` (rerun outside the sandbox after the documented Vitest `spawn EPERM` failure); `corepack pnpm verify:package`.
- Updated the feature board so feature 55 is marked complete and feature 56 is now the next actionable M9 item.
- Likely next board item: feature 56, per-agent tool policy specification with profiles, allow or deny lists, sandbox settings, and Anthropic model binding.
- Completed feature 56 from `FEATURE_BOARD.md`: per-agent tool policy specification with profiles, allow or deny lists, sandbox settings, and Anthropic model binding.
- Extended the OpenClaw role contracts with typed runtime-policy metadata covering tool profile, allow list, deny list, sandbox mode, and Anthropic model binding so future `openclaw.json` generation can stay data-driven.
- Updated the coordinator, analyst, and validator role definitions with conservative per-agent policies: minimal read-only coordination, coding-profile read-only analysis, and coding-profile workspace-write validation.
- Aligned each role-specific `TOOLS.md` bootstrap file with the machine-readable policy so the human-readable bootstrap guidance matches the config source of truth.
- Verification for F56: `corepack pnpm typecheck`; `corepack pnpm test -- packages/contracts/src/index.test.ts packages/execution-plane/src/index.test.ts` (rerun outside the sandbox after the documented Vitest `spawn EPERM` failure); `corepack pnpm verify:package`.
- Updated the feature board so feature 56 is marked complete. All M9 features are now delivered.



## 2026-03-28

- Diagnosed the live `pnpm e2e` failure against `derekrivers/FirstVoyage`: the script created a real GitHub issue, completed intake, then failed inside `runPlanningPipeline(...)` with `connect ECONNREFUSED 127.0.0.1:55532` because the local Postgres stack had not been bootstrapped before the first repository query.
- Updated `scripts/e2e-integration.mjs` so it now runs the existing idempotent `scripts/setup.mjs` preflight before creating any GitHub issue. This ensures Docker Compose startup, Postgres readiness, and SQL migrations happen before the E2E flow creates external GitHub resources.
- The E2E failure mode is now fail-fast and targeted: if local setup cannot complete, the script stops before issue creation and tells the operator to run `corepack pnpm run setup`; if `E2E_USE_OPENCLAW=true`, it also now checks `OPENCLAW_BASE_URL`, `OPENCLAW_HOOK_TOKEN`, and gateway reachability before creating any GitHub issue.
- Verification for this fix: `corepack pnpm build`; `node scripts/e2e-integration.mjs` now fails fast on blocked Docker access; `corepack pnpm run setup`; `E2E_TARGET_REPO=derekrivers/FirstVoyage E2E_CLEANUP=true E2E_USE_OPENCLAW=false corepack pnpm e2e`; `E2E_USE_OPENCLAW=true` now fails before issue creation when the gateway is unavailable.
- Fixed the follow-up SCM failure reproduced by live E2E issue `derekrivers/FirstVoyage#6`: validation no longer hands read-only developer runs into SCM, `runScmPhase(...)` now rejects direct SCM entry when `development.handoff.codeWriteEnabled` is false, and `scripts/e2e-integration.mjs` now treats `await_review` as the expected terminal state for the current read-only workflow instead of forcing SCM.
- Added focused control-plane coverage for the new routing: read-only `can_open_pr` tasks now stay blocked for review, while the SCM happy path remains covered by explicitly simulating a future write-enabled developer handoff in the fixture-backed test.
- Verification for the SCM-routing fix: `corepack pnpm build`; `corepack pnpm test -- packages/control-plane/src/index.test.ts`; live deterministic `pnpm e2e` should now stop cleanly after validation/review instead of opening a follow-up SCM failure issue.
- Completed feature 84 from `FEATURE_BOARD.md` (M12): Dave Lister developer agent.
  - Added `"developer"` to `openClawAgentRoles` enum in `packages/contracts/src/enums.ts`.
  - Added `reddwarf-developer` role definition to `openClawAgentRoleDefinitions` in `packages/execution-plane/src/index.ts` with `workspace_write` sandbox, `coding` tool profile, and `anthropic/claude-sonnet-4-6` model binding.
  - Created full bootstrap workspace under `agents/openclaw/lister/`: IDENTITY.md, SOUL.md, AGENTS.md, TOOLS.md, USER.md, HEARTBEAT.md.
  - Created two skill directories: `skills/implement_architecture_plan/SKILL.md` and `skills/report_deviation_or_blocker/SKILL.md`.
  - Updated developer phase OpenClaw dispatch default from `reddwarf-analyst` to `reddwarf-developer` in `packages/control-plane/src/pipeline.ts`.
  - Updated `infra/docker/openclaw.json` Docker template with `reddwarf-developer` agent entry.
  - Updated bootstrap alignment marker regex to include `developer` and `lister`.
  - Updated `scripts/verify-packaged-policy-pack.mjs` to expect 4 OpenClaw role definitions.
  - Verification: `corepack pnpm typecheck`; `corepack pnpm test -- packages/execution-plane/src/index.test.ts` (37 tests pass including 3 new developer role tests); `corepack pnpm test -- packages/control-plane/src/index.test.ts` (48 tests pass); `corepack pnpm verify:package` (4 roles, all bootstrap files resolved).
- Likely next board item: feature 85, OpenAI provider support.
- Discovered an additional gap after feature 84: the live OpenClaw developer path is still not PR-capable end to end. The current workflow still materializes context-only workspaces, advances after dispatch acceptance rather than completed developer output, and the SCM phase creates a branch plus PR without first publishing a commit from workspace changes.
- Added feature 85 to `FEATURE_BOARD.md` as the new next actionable item: PR-capable OpenClaw E2E path covering target-repo workspace materialization, completed developer-session handoff, commit publication, and real PR creation.
- OpenAI provider support and GitHub intake allowlisting shifted to features 86 and 87 respectively so the board order matches the actual MVP blocker.
- Likely next board item: feature 85, PR-capable OpenClaw E2E path.
- Progress on feature 85 (PR-capable OpenClaw E2E): added live target-repo checkout bootstrapping, developer-session completion waiting, workspace commit publication, and SCM publication from workspace git state. The live E2E script now dispatches `reddwarf-developer`, preflights `/hooks/agent`, and only proceeds when Postgres plus OpenClaw ingress are reachable.
- Fixed the initial live OpenClaw ingress failure: current OpenClaw requires `hooks.enabled`, a hook token, `defaultSessionKey`, and `allowedSessionKeyPrefixes` including `hook:` when request-supplied session keys are enabled. The generated config and Docker template now seed `/hooks` with `defaultSessionKey: "hook:ingress"` and allow both `hook:` and `github:issue:` prefixes.
- Fixed a Docker-hosted runtime mismatch: nested OpenClaw sandboxing required an inner `docker` binary, which is not available inside the OpenClaw container. The generated Docker-hosted agent config now uses `sandbox: { mode: "off" }` and relies on the outer container boundary plus explicit tool allowlists instead of Docker-in-Docker sandboxing.
- Fixed a stale OpenClaw runtime-state failure on this Windows/Docker host: `runtime-data/openclaw-home` had accumulated `openclaw.json.clobbered.*` artifacts and `config-health.json` was stuck on `missing-meta-vs-last-good`, which led to config-observer stack overflows and blocked gateway startup. Working path: stop the container, move `runtime-data/openclaw-home` to a timestamped backup, create a fresh `runtime-data/openclaw-home`, then recreate the OpenClaw service so it reseeds clean state.
- Fixed additional OpenClaw tool-policy mismatches surfaced by live dispatch: removed unsupported `group:memory` allow entries from the role definitions and bootstrap `TOOLS.md` files, and replaced the built-in `coding` profile with `full` plus explicit allow/deny group lists so built-in file/runtime tools still work without inheriting unavailable `apply_patch` and `image_generate` profile entries.
- Verification so far for the live OpenClaw-runtime fixes: `corepack pnpm build`; `corepack pnpm test -- packages/control-plane/src/index.test.ts`; `corepack pnpm test -- packages/execution-plane/src/index.test.ts packages/contracts/src/index.test.ts packages/control-plane/src/index.test.ts`; `docker stop docker-openclaw-1`; move `runtime-data/openclaw-home` to `runtime-data/openclaw-home.backup-20260328-224805`; `docker compose -f infra/docker/docker-compose.yml --profile openclaw up -d --force-recreate openclaw`; confirmed `docker compose ... ps openclaw` healthy, `runtime-data/openclaw-home/openclaw.json` reseeded with hooks plus sandbox-off config, `curl http://localhost:3578/health` returns `200`, and `POST /hooks/agent` with an empty JSON body now returns `400 message required` instead of `404`.
- Current status: the OpenClaw runtime is now healthy with the corrected hook config, clean runtime state, sandbox-off deployment model, and trimmed tool policy. The last remaining work is to complete a full live E2E run through developer, validation, and SCM without interruption and confirm that it opens a real PR.

- Fixed a host/container workspace-path mismatch in live OpenClaw development runs: the prompt originally told OpenClaw to use /var/lib/reddwarf/workspaces/<workspaceId>, which broke nested E2E workspaces under 
untime-data/workspaces/e2e-*/.... The control-plane now maps the real host workspace path to the correct runtime-visible path using REDDWARF_HOST_WORKSPACE_ROOT plus REDDWARF_WORKSPACE_ROOT.
- Verified feature 85 end to end on Saturday, March 28, 2026: live E2E run created GitHub issue #14, completed OpenClaw development, passed validation, published branch 
eddwarf/derekrivers-firstvoyage-14/83e5475f-b404-436e-867c-5e87784592b6, and opened PR #15 at https://github.com/derekrivers/FirstVoyage/pull/15.

## 2026-03-29

- Completed feature 88 from `FEATURE_BOARD.md` (M14): Restore Holly to the live OpenClaw workflow.
  - Added `createArchitectHandoffAwaiter` to `live-workflow.ts` that polls for `architect-handoff.md` with required headings (Architecture Handoff, Summary, Implementation Approach, Affected Files, Risks and Assumptions, Test Strategy).
  - Added `dispatchHollyArchitectPhase` and `buildOpenClawArchitectPrompt` to `pipeline.ts` that create a lightweight architect workspace, dispatch to `reddwarf-analyst` (Holly) via OpenClaw hooks, await Holly's handoff, and parse it into a `PlanningDraft`.
  - Extended `PlanningPipelineDependencies` with optional `openClawDispatch`, `openClawArchitectAgentId`, `openClawArchitectAwaiter`, and `architectTargetRoot` so the planning pipeline can route through Holly instead of the direct `PlanningAgent`.
  - Holly's raw architect handoff markdown is persisted as evidence and as a task memory record (`architect.handoff`), and returned on `PlanningPipelineResult.hollyHandoffMarkdown`.
  - Extended `DevelopmentPhaseDependencies` with optional `hollyHandoffMarkdown` and updated `buildOpenClawDeveloperPrompt` to include Holly's architecture plan in Lister's prompt when available.
  - Fixed `repositoryHasChanges` in `live-workflow.ts` to also detect committed changes (Lister commits directly rather than leaving unstaged files), by checking `git rev-list --count HEAD > 1`.
  - Fixed `createGitWorkspaceCommitPublisher` to handle pre-committed changes: if `git status --porcelain` is clean, it checks for local commits beyond the base branch instead of erroring.
  - Updated E2E test criteria to request `index.html` with a Red Dwarf cast short story instead of `docs/health-check.md`.
  - Updated E2E script to dispatch Holly for architecture planning when `E2E_USE_OPENCLAW=true`, log Holly handoff size, and pass `hollyHandoffMarkdown` to the developer phase.
- Verified feature 88 end to end: live E2E run created GitHub issue #18, Holly completed architecture planning in 24.9s, Lister implemented `index.html` in 83.5s, validation passed, SCM published branch and opened PR #20 at https://github.com/derekrivers/FirstVoyage/pull/20. Total duration: 111.5s.
- Diagnosed a live intake gap for GitHub issue #22 on Sunday, March 29, 2026: the issue existed upstream and matched the `ai-eligible` poll filter, but RedDwarf had no manifest or approval row because the polling cursor stopped at issue 21 after its last successful cycle.
- Fixed the silent-freeze failure mode in the live stack by adding fail-fast cycle timeouts to `createGitHubIssuePollingDaemon` and `createReadyTaskDispatcher`, so stalled repository reads, planning intake, manifest lookup, or task dispatch work now reject and enter backoff instead of leaving the loop permanently `already running`.
- Added outbound request timeouts to the live adapters so GitHub REST calls, OpenClaw hook dispatches, and Anthropic planning requests all abort explicitly instead of hanging the poller or dispatcher forever on unresolved `fetch(...)` calls.
- Added regression coverage in `packages/control-plane/src/index.test.ts`, `packages/integrations/src/index.test.ts`, and `packages/execution-plane/src/index.test.ts` for hung poll cycles, hung dispatch cycles, and hung outbound HTTP requests.
- Verification for the fail-fast loop fix: `corepack pnpm typecheck`; `corepack pnpm test -- packages/control-plane/src/index.test.ts packages/integrations/src/index.test.ts packages/execution-plane/src/index.test.ts`.
- Completed a read-only pipeline, pooling, process-continuity, security, and observability audit on Sunday, March 29, 2026.

## 2026-03-31

- Fixed the packaged policy-pack verifier after the architecture reviewer role expanded the OpenClaw runtime roster from four roles to five.
- Updated `scripts/verify-packaged-policy-pack.mjs` to assert the current five-role roster (`coordinator`, `analyst`, `reviewer`, `validator`, `developer`) so CI matches the shipped execution-plane definitions again.
- Verification note: this workspace's WSL shell cannot execute the Windows-installed `corepack` shim or `node.exe` (`/mnt/c/Program Files/nodejs/...`), so local verification from this session is blocked until a Linux Node toolchain is available or the command is rerun from the Windows host.
- Reprioritized `FEATURE_BOARD.md` so the next actionable work is feature 90, atomic run claiming, followed by transactional state transitions, allowed-path enforcement, git credential redaction, operator API hardening, timeout and heartbeat alignment, secret-workspace cleanup, prompt-boundary hardening, Postgres-pool hardening, and structured runtime logging.
- Full audit handoff is documented in [docs/pipeline-hardening-audit-2026-03-29.md](/c:/Dev/RedDwarf/docs/pipeline-hardening-audit-2026-03-29.md) - read this before implementing features 90-99.
- Existing pending feature work for OpenAI provider support (feature 86) and GitHub intake allowlisting (feature 87) is intentionally deferred behind the new hardening queue because the audit found production-correctness and security gaps with higher blast radius.

- Completed feature 90 from `FEATURE_BOARD.md`: atomic run claiming for each pipeline phase.
- Added a repository-level `claimPipelineRun(...)` primitive in the evidence layer with an in-memory implementation and a Postgres implementation that takes a transaction-scoped advisory lock on the `concurrencyKey`, retires stale active runs, and persists the claiming active run in the same claim path.
- Replaced the old `detectOverlappingRuns(...)` read-then-write flow in planning, development, validation, and SCM so each phase now claims ownership through the repository before proceeding, while preserving the existing blocked-run evidence and run-event behavior above that seam.
- Added in-memory and Postgres-backed coverage for the new claim primitive, and updated `scripts/verify-concurrency.mjs` to use the current `createPostgresPlanningRepository(...)` factory before verifying stale takeover and fresh-overlap blocking.
- Verification for feature 90: `corepack pnpm typecheck`; `corepack pnpm test -- packages/evidence/src/index.test.ts packages/control-plane/src/index.test.ts tests/postgres.test.ts` (rerun outside the sandbox after the documented Vitest `spawn EPERM` failure); `corepack pnpm verify:concurrency`.
- Likely next board item: feature 91, transactional manifest, approval, phase, evidence, and run-event transitions.


- Completed feature 91 from `FEATURE_BOARD.md`: transactional manifest, approval, phase, evidence, and run-event transitions.
- Added repository-level `runInTransaction(...)` support in the evidence layer with rollback-capable in-memory behavior and Postgres-backed `BEGIN`/`COMMIT`/`ROLLBACK` execution using transaction-scoped write repositories.
- Wrapped approval resolution, concurrency-block persistence, and automated failure-recovery transitions in explicit repository transactions so approval decisions and retry or escalation state now commit atomically instead of leaving partial manifest, evidence, and run-event state behind on mid-transition failures.
- Added rollback-focused regression coverage in `packages/control-plane/src/index.test.ts` for approval decisions and validation recovery persistence, plus a Postgres-backed transaction rollback test in `tests/postgres.test.ts`.
- Updated `scripts/verify-approvals.mjs` and `scripts/verify-recovery.mjs` to use the current `createPostgresPlanningRepository(...)` factory so the live Postgres verifiers still run after the injected-pool repository refactor.
- Verification for feature 91: `corepack pnpm typecheck`; `corepack pnpm test -- packages/control-plane/src/index.test.ts tests/postgres.test.ts` (rerun outside the sandbox after the documented Vitest `spawn EPERM` failure); `corepack pnpm verify:approvals`; `corepack pnpm verify:recovery`.
- Likely next board item: feature 92, enforce allowed-path boundaries before commit and push.

- Completed feature 92 from `FEATURE_BOARD.md`: enforce allowed-path boundaries before commit and push.
- Added SCM-side allowed-path enforcement in `live-workflow.ts` so the real git publisher now checks both uncommitted repo edits and final branch diff contents against the approved path scope before commit and push.
- Added `AllowedPathViolationError` plus reusable changed-file scope matching so SCM can fail closed with explicit violating-file details, and mapped those failures in `runScmPhase(...)` to `policy_violation` pipeline failures with code `ALLOWED_PATHS_VIOLATED`.
- Added regression coverage in `packages/control-plane/src/index.test.ts` for glob-style allowed-path matching and for SCM path-scope violations, proving that out-of-scope repo edits block before branch or PR publication and persist a clear SCM failure.
- Updated `scripts/verify-scm.mjs` to the current repository factory and write-enabled fixture workflow so Postgres-backed SCM verification still runs after the repository constructor refactor and the developer read-only gating change.
- Verification for feature 92: `corepack pnpm typecheck`; `corepack pnpm test -- packages/control-plane/src/index.test.ts`; `corepack pnpm verify:scm`.
- Likely next board item: feature 93, remove tokenized git remotes and redact secret-bearing failures.

- Completed feature 93 from `FEATURE_BOARD.md`: remove tokenized git remotes and redact secret-bearing failures.
- Updated `packages/control-plane/src/live-workflow.ts` so GitHub clone and push operations now use plain `https://github.com/<repo>.git` remotes with env-backed `http.extraHeader` auth, keeping tokens out of argv and remote URLs while still redacting auth headers, bearer tokens, and tokenized remotes from subprocess failures.
- Updated `packages/control-plane/src/pipeline.ts` so normalized pipeline failures, serialized error payloads, persisted phase/evidence failure details, and `dispatchReadyTask(...)` operator-visible error strings all pass through the same secret-bearing text sanitizer before storage or response.
- Added regression coverage in `packages/control-plane/src/index.test.ts` for sanitizer behavior, SCM failure-persistence redaction, and post-approval dispatch error redaction.
- Verification for feature 93: `corepack pnpm typecheck`; `corepack pnpm test -- packages/control-plane/src/index.test.ts`; `corepack pnpm verify:scm`.
- Likely next board item: feature 94, authenticate the operator API and constrain manual dispatch roots.
- Completed feature 94 from `FEATURE_BOARD.md`: authenticate the operator API and constrain manual dispatch roots.
- Updated `packages/control-plane/src/operator-api.ts` so every operator route except `GET /health` now requires a configured bearer token, request bodies are size-bounded, and manual dispatch roots are constrained to configured managed target and evidence roots.
- Updated stack entry points and docs to require `REDDWARF_OPERATOR_TOKEN`, including `scripts/start-stack.mjs`, `scripts/start-operator-api.mjs`, `.env.example`, `README.md`, and `docs/DEMO_RUNBOOK.md`.
- Added operator API regression coverage in `packages/control-plane/src/index.test.ts` for missing auth, oversized JSON bodies, and escaped manual-dispatch roots.
- Updated `scripts/verify-operator-api.mjs` to authenticate requests and to assert stable operator API contracts against a shared Postgres state instead of brittle exact-count assumptions.
- Verification for feature 94: `corepack pnpm typecheck`; `corepack pnpm test -- packages/control-plane/src/index.test.ts`; `corepack pnpm verify:operator-api`.
- No new follow-on feature was added from feature 94; the next board item remains feature 95, align heartbeats, stale windows, and subprocess timeouts.

- Completed feature 95 from `FEATURE_BOARD.md`: align heartbeats, stale windows, and subprocess timeouts.
- Updated `packages/control-plane/src/pipeline.ts` so stale-run detection is phase-aware, long repo-bootstrap and publish waits heartbeat active runs instead of going silent, validation commands enforce explicit timeouts, and timeout-classified failures persist distinct event codes for validation and git subprocess hangs.
- Updated `packages/control-plane/src/live-workflow.ts` so architect and developer OpenClaw waiters can heartbeat while pending, git clone and publish commands enforce bounded timeouts, and command timeouts raise explicit `OpenClawCompletionTimeoutError` / `ExternalCommandTimeoutError` failures instead of hanging indefinitely.
- Added regression coverage in `packages/control-plane/src/index.test.ts` for architect heartbeat waiting, timed-out validation commands, and timed-out SCM publication failures, and fixed `waitWithHeartbeat(...)` so already-settled work returns immediately instead of sleeping for the full heartbeat interval.
- Updated `scripts/verify-validation.mjs` to the current `createPostgresPlanningRepository(...)` factory so the validation verifier still closes cleanly after the repository pool-injection refactor. Feature 100 remains the tracked sweep for the other legacy script call sites.
- Verification for feature 95: `corepack pnpm typecheck`; `corepack pnpm test -- packages/control-plane/src/index.test.ts`; `corepack pnpm verify:validation`; `corepack pnpm verify:scm`.
- No new follow-on feature was added from feature 95; the next board item is feature 96, scrub or destroy secret-bearing workspaces on phase exit.

- Completed feature 96 from `FEATURE_BOARD.md`: scrub or destroy secret-bearing workspaces on phase exit.
- Added `scrubManagedWorkspaceSecrets(...)` in `packages/control-plane/src/workspace.ts` so workspace-local `secret-env.json` leases are deleted after use, the workspace state file is rewritten with `secretEnvFile: null`, and the descriptor records that the lease file was scrubbed after phase exit.
- Updated `packages/control-plane/src/pipeline.ts` so developer and validation phases scrub scoped lease files before returning success and also attempt the same scrub during failure handling before persisting phase-failure state. The control plane now records `SECRET_LEASE_SCRUBBED` run events when credential files are removed.
- Updated `packages/control-plane/src/index.test.ts` so the scoped-secret developer test now asserts the lease file is gone after phase exit, and added validation-failure coverage proving the secret file exists during execution but is scrubbed once the failing phase exits.
- Updated `scripts/verify-secrets.mjs` to the current `createPostgresPlanningRepository(...)` factory and changed the verifier to assert post-phase scrubbing instead of reading the lease file after validation completes. Feature 100 still covers the broader legacy script sweep.
- Verification for feature 96: `corepack pnpm typecheck`; `corepack pnpm test -- packages/control-plane/src/index.test.ts`; `corepack pnpm verify:secrets`.
- No new follow-on feature was added from feature 96; the next board item is feature 97, fence untrusted issue content inside planner and agent prompts.

- Completed feature 97 from `FEATURE_BOARD.md`: fence untrusted issue content inside planner and agent prompts.
- Updated `packages/execution-plane/src/index.ts` so Anthropic planning requests now carry raw GitHub issue fields inside an explicit `## Untrusted GitHub Issue Data` JSON block, separated from trusted instructions and the required output contract.
- Updated `packages/control-plane/src/pipeline.ts` so Holly architect prompts and Lister developer prompts now isolate issue-derived title, summary, acceptance criteria, affected paths, and requested capabilities inside the same untrusted JSON boundary while keeping planning summaries, allowed paths, and handoff contracts in trusted sections.
- Added regression coverage in `packages/execution-plane/src/index.test.ts` and `packages/control-plane/src/index.test.ts` proving adversarial issue text is preserved as data without being promoted into ambient prompt instructions.
- Verification for feature 97: `corepack pnpm typecheck`; `corepack pnpm test -- packages/execution-plane/src/index.test.ts packages/control-plane/src/index.test.ts`.
- No new follow-on feature was added from feature 97; the next board item is feature 98, harden the Postgres pool with timeouts, sizing, and telemetry.

- Completed feature 98 from `FEATURE_BOARD.md`: harden the Postgres pool with timeouts, sizing, and telemetry.
- Updated `packages/evidence/src/postgres-repository.ts` so the shared `pg.Pool` now uses bounded defaults for connection timeout, idle timeout, query timeout, statement timeout, and client lifetime, while exposing live pool counters and recorded pool-error telemetry through `getRepositoryHealth()`.
- Updated `packages/evidence/src/repository.ts` and `packages/control-plane/src/operator-api.ts` so repository health is part of the operator `/health` response; in-memory repositories report a simple healthy in-memory status and Postgres-backed repositories expose live pool saturation signals.
- Updated `scripts/lib/config.mjs`, `scripts/start-stack.mjs`, and `scripts/start-operator-api.mjs` so stack bootstrap reads Postgres pool policy from environment variables instead of leaving the pool hard-coded in the evidence factory.
- Updated `.env.example`, `README.md`, and `scripts/verify-postgres-pipeline.mjs` so the new pool settings are documented and the Postgres verifier now checks that pool telemetry is present. This verifier fix narrows one stale script path, but feature 100 still tracks the broader legacy-script sweep.
- Added regression coverage in `packages/evidence/src/index.test.ts`, `packages/control-plane/src/index.test.ts`, and `tests/postgres.test.ts` for repository health reporting, operator health exposure, and custom Postgres pool configuration.
- Verification for feature 98: `corepack pnpm typecheck`; `corepack pnpm test -- packages/evidence/src/index.test.ts packages/control-plane/src/index.test.ts tests/postgres.test.ts`; `corepack pnpm verify:operator-api`; `corepack pnpm verify:postgres`; `node --check scripts/start-stack.mjs`; `node --check scripts/start-operator-api.mjs`.
- No new follow-on feature was added from feature 98; the next board item is feature 99, wire structured runtime logging and degraded-startup health across poller and dispatcher.


- Completed feature 99 from `FEATURE_BOARD.md`: wire structured runtime logging and degraded-startup health across poller and dispatcher.
- Updated `packages/control-plane/src/polling.ts` so both the GitHub poller and ready-task dispatcher now emit structured cycle logs with component bindings, duration/backoff fields, and explicit startup-degraded warnings while keeping their interval loops alive after a failing immediate startup cycle.
- Updated `packages/control-plane/src/operator-api.ts` and `scripts/start-stack.mjs` so `/health` now exposes live poller and dispatcher runtime health alongside persisted cursor state, and the stack bootstrap now wires a real `createPinoPlanningLogger(...)` runtime logger into the long-running services instead of relying on the noop default.
- Updated `scripts/verify-observability.mjs` and `scripts/verify-operator-api.mjs` to cover the new runtime health and structured loop-log paths, and documented `REDDWARF_LOG_LEVEL` in `.env.example` and `README.md`.
- Added regression coverage in `packages/control-plane/src/index.test.ts` for degraded startup health reporting, non-fatal poller and dispatcher startup failures, and structured cycle logging on both loops.
- Verification for feature 99: `corepack pnpm typecheck`; `corepack pnpm test -- packages/control-plane/src/index.test.ts`; `corepack pnpm verify:operator-api`; `corepack pnpm verify:observability`; `node --check scripts/start-stack.mjs`; `node --check scripts/start-operator-api.mjs`.
- No new follow-on feature was added from feature 99; the next board item remains feature 100, sweep stale script call sites to the current Postgres repository factory.


- Completed feature 100 from `FEATURE_BOARD.md`: sweep stale script call sites to the current Postgres repository factory.
- Updated the remaining Postgres-backed maintenance and verifier scripts to use `createPostgresPlanningRepository(connectionString, postgresPoolConfig)` from `scripts/lib/config.mjs` instead of the legacy `new PostgresPlanningRepository({ connectionString })` or single-argument factory calls.
- Fixed broken drift in `scripts/verify-integrations.mjs` and `scripts/verify-memory.mjs`, which still had malformed import blocks around the repository factory migration, and aligned `scripts/e2e-integration.mjs`, `scripts/teardown.mjs`, and the rest of the Postgres-backed script suite with the shared pool configuration.
- Updated `scripts/verify-evidence.mjs` to the current SCM preconditions by using the same write-enabled OpenClaw fixture path as `verify:scm`, so evidence verification now exercises archival after a code-writing-enabled developer handoff instead of relying on the retired read-only-to-SCM path.
- Verification for feature 100: `corepack pnpm build`; `node --check` across the edited script set; `corepack pnpm verify:approvals`; `corepack pnpm verify:concurrency`; `corepack pnpm verify:development`; `corepack pnpm verify:evidence`; `corepack pnpm verify:integrations`; `corepack pnpm verify:memory`; `corepack pnpm verify:knowledge-ingestion`; `corepack pnpm verify:context`; `corepack pnpm verify:workspace-manager`; `corepack pnpm verify:recovery`; `corepack pnpm verify:scm`; `corepack pnpm verify:secrets`; `corepack pnpm verify:validation`.
- No new follow-on feature was added from feature 100; the next board item is feature 101, add idempotent guards for external side effects during retries and recovery.

- Completed feature 101 from `FEATURE_BOARD.md`: add idempotent guards for external side effects during retries and recovery.
- Updated `packages/integrations/src/index.ts` so GitHub follow-up issue creation now reuses existing open issues for the same task marker, fixture and REST pull-request creation both reuse an existing PR for the same base/head branch, and fixture branch creation now reuses an existing branch summary instead of incrementing side effects on replay.
- Updated `packages/execution-plane/src/index.ts` so deterministic SCM drafts now use a stable task-scoped branch name (`reddwarf/<taskId>/scm`) instead of embedding the SCM run id, which lets reruns push to and reopen the same branch identity after a lost response or transactional replay.
- Added replay-focused regression coverage in `packages/integrations/src/index.test.ts`, `packages/execution-plane/src/index.test.ts`, and `packages/control-plane/src/index.test.ts` for remote issue reuse, stable SCM branch names, follow-up issue reuse after transactional rollback, and PR reuse after a simulated lost SCM create response.
- Verification for feature 101: `corepack pnpm typecheck`; `corepack pnpm test -- packages/integrations/src/index.test.ts packages/execution-plane/src/index.test.ts packages/control-plane/src/index.test.ts` (rerun outside the sandbox after the documented Vitest `spawn EPERM` failure); `corepack pnpm verify:recovery`; `corepack pnpm verify:scm`; `corepack pnpm verify:evidence`.
- Added feature 102 to `FEATURE_BOARD.md`: after approving a failure-escalation request, `dispatchReadyTask(...)` still restarts from developer and validation instead of resuming only the failed phase. The new feature tracks phase-aware retry resume so future retries can avoid re-running already-completed upstream work.

- Completed feature 102 from `FEATURE_BOARD.md`: resume approved retries from the failed phase instead of replaying upstream phases.
- Updated `packages/control-plane/src/pipeline.ts` so `dispatchReadyTask(...)` now inspects approved failure-escalation requests for the manifest's current phase and resumes directly at `development`, `validation`, or `scm` instead of always replaying the full downstream chain. Validation and SCM phase entry now also accept `ready` manifests only when that state comes from an approved failure-recovery retry for the same phase.
- Added regression coverage in `packages/control-plane/src/index.test.ts` proving approved validation retries skip developer replay and approved SCM retries execute only `scm`, and updated `scripts/verify-recovery.mjs` so the Postgres-backed verifier now approves the escalation and asserts the resumed dispatch runs `["validation"]` only.
- Verification for feature 102: `corepack pnpm typecheck`; `corepack pnpm test -- packages/control-plane/src/index.test.ts`; `corepack pnpm verify:recovery`; `corepack pnpm verify:scm`.
- Added feature 103 to `FEATURE_BOARD.md`: retry-eligible automated recovery still marks manifests `blocked` without a dispatcher path that will actually re-enter the queued phase. The current `PHASE_RETRY_SCHEDULED` path records intent correctly, but it still needs a follow-on execution path so those automatic retries happen without manual intervention.

- Completed feature 103 from `FEATURE_BOARD.md`: auto-dispatch retry-eligible blocked phases without manual intervention.
- Updated `packages/control-plane/src/pipeline.ts` so `dispatchReadyTask(...)` now accepts retry-eligible blocked manifests when `failure.recovery` records `action: "retry"` for the manifest's current recoverable phase, resuming directly at that phase without replaying upstream work.
- Updated `packages/control-plane/src/polling.ts` so the ready-task dispatcher now scans blocked manifests for queued automatic retries, prioritizes those blocked retry tasks ahead of unrelated ready work, and dispatches them through the same post-approval path once the retry marker is present.
- Added regression coverage in `packages/control-plane/src/index.test.ts` for direct blocked-retry dispatch, dispatcher pickup of blocked retries, and dispatcher prioritization when both blocked retries and unrelated ready tasks exist. Updated `scripts/verify-recovery.mjs` so the Postgres-backed verifier now exercises the automatic retry through `createReadyTaskDispatcher(...).dispatchOnce()` before the later human-approved retry-resume path.
- Verification for feature 103: `corepack pnpm typecheck`; `corepack pnpm test -- packages/control-plane/src/index.test.ts`; `corepack pnpm verify:recovery`; `corepack pnpm verify:scm`.

- Added `scripts/cleanup-approvals.mjs` plus the `corepack pnpm cleanup:approvals` package script for repeatable approval-row cleanup in Postgres.
- The approvals cleanup script is dry-run by default, targets only resolved approvals for terminal manifests by default, supports `--task-id`, `--statuses`, `--older-than-days`, and `--include-nonterminal-manifests`, and requires `--allow-pending-delete` before it will remove pending approvals because doing so can orphan blocked tasks.

- Reviewed and updated `scripts/e2e-integration.mjs` so the E2E harness now auto-approves the planning request and drives the task through `dispatchReadyTask(...)` instead of manually calling developer, validation, and SCM phases. This keeps E2E aligned with the live post-approval execution path and with failure-recovery / retry semantics added in features 102 and 103.
- Updated `README.md` and `docs/DEMO_RUNBOOK.md` to document the dispatcher-driven E2E flow and the stable SCM branch naming (`reddwarf/<task-id>/scm`) introduced by the idempotent SCM work.

- Completed feature 104 from `FEATURE_BOARD.md`: reconcile orphaned dispatcher state after approval resets.
- Added `sweepOrphanedDispatcherState(repository, options?)` to `packages/control-plane/src/pipeline/sweep.ts` that scans ready manifests for missing approved planning approval rows (marking them `failed` with `ORPHAN_MISSING_APPROVAL` events) and scans blocked manifests for missing failure-escalation approval rows (re-queuing a pending replacement approval with `ORPHAN_ESCALATION_REQUEUED` events). Both repairs are wrapped in repository transactions.
- Updated `findNextDispatchableManifest` in `packages/control-plane/src/polling.ts` to skip orphaned ready manifests (manifests with `approvalMode !== "auto"` that have no approved approval row) and log `DISPATCH_ORPHAN_SKIPPED` warnings, preventing the dispatcher from looping on missing approvals while the operator runs the sweep.
- Added `POST /maintenance/reconcile-orphaned-state` to the operator API in `packages/control-plane/src/operator-api.ts` so operators can trigger the orphan sweep on demand and receive a repair summary.
- Added two new event codes (`ORPHAN_MISSING_APPROVAL`, `ORPHAN_ESCALATION_REQUEUED`) and five new types (`SweepOrphanedStateOptions`, `SweepOrphanedStateResult`, `SweepOrphanedStateRepair`, `OrphanType`, `OrphanRepairAction`) to the pipeline types.
- Added 7 unit tests covering: empty repository, non-orphaned ready manifest, auto-approval mode bypass, orphaned ready manifest marked failed, orphaned blocked escalation re-queued, non-orphaned blocked escalation untouched, and dispatcher orphan-skip behavior.
- Verification for feature 104: `corepack pnpm typecheck`; `corepack pnpm test -- packages/control-plane/src/index.test.ts`; `corepack pnpm verify:operator-api`.

- Completed feature 87 from `FEATURE_BOARD.md`: GitHub user allowlist for issue intake.
- Added `authorAllowlist?: string[]` to `GitHubIssuePollingDaemonConfig` (daemon-level default) and `GitHubPollingRepoConfig` (per-repo override that wins over the daemon setting) in `packages/control-plane/src/polling.ts`.
- Added `parseAuthorAllowlistFromEnv(envValue?)` helper that parses the `GITHUB_ISSUE_AUTHOR_ALLOWLIST` environment variable (comma-separated usernames, whitespace-trimmed) and returns `undefined` when absent so callers can distinguish unconfigured from configured-as-empty.
- Added `"rejected"` action and `"author_not_allowlisted"` reason to `GitHubIssuePollingDecision`, `rejectedIssueCount` to `GitHubIssuePollingCycleResult`, and `INTAKE_AUTHOR_REJECTED` to the `EventCodes` registry in `packages/control-plane/src/pipeline/types.ts`.
- Author filtering is applied per-candidate after the unseen-candidate selection and before the existing-spec check, with a structured `INTAKE_AUTHOR_REJECTED` log record for every rejected issue.
- Allowlist semantics: `undefined` → no filtering (backward compat); empty array → full default-deny; non-empty array → case-insensitive match; author field absent → rejected when list is configured.
- Added 11 new tests in `packages/control-plane/src/polling-daemon.test.ts` covering: listed-author accepted, non-listed-author rejected (with log assertion), no-allowlist backward compat, empty-array default-deny, per-repo override, absent-author rejection, and all five `parseAuthorAllowlistFromEnv` edge cases.
- Verification: `corepack pnpm typecheck` (clean); `corepack pnpm test` (264 tests pass).
- Likely next board item: feature 88, Architecture Reviewer Agent phase.
## 2026-03-30

- Completed feature 88 from `FEATURE_BOARD.md`: Architecture Reviewer Agent phase.
- Added the dedicated `architecture_review` task phase and review report contracts in `packages/contracts/src/enums.ts` and `packages/contracts/src/agents.ts`, plus policy and workspace-tooling support so reviewer runs stay read-only and evidence-focused.
- Added the new `runArchitectureReviewPhase(...)` orchestration path in `packages/control-plane/src/pipeline/architecture-review.ts`, wired it into `dispatchReadyTask(...)`, updated validation entry so `architecture_review -> validation` is legal, and extended OpenClaw completion handling, prompts, workspace policy, dispatcher dependencies, and package exports for the new reviewer agent.
- Added the reviewer runtime surface in `packages/execution-plane/src/index.ts`, `agents/reviewer.md`, `infra/docker/openclaw.json`, and `packages/evidence/drizzle/0007_architecture_review_phase.sql` so the live OpenClaw roster, workspace mounts, and Postgres enum schema all understand the new phase.
- Added regression coverage in `packages/control-plane/src/index.test.ts`, `packages/execution-plane/src/index.test.ts`, `packages/control-plane/src/openclaw-config.test.ts`, `packages/control-plane/src/operator-api.test.ts`, and `packages/policy/src/index.test.ts` covering the passing and failing architecture-review paths, dispatch sequencing, reviewer roster/config generation, and phase capability enforcement.
- Verification for feature 88: `node scripts/apply-sql-migrations.mjs`; `corepack pnpm typecheck`; `corepack pnpm test -- packages/control-plane/src/index.test.ts packages/execution-plane/src/index.test.ts packages/control-plane/src/openclaw-config.test.ts packages/policy/src/index.test.ts packages/control-plane/src/operator-api.test.ts` (rerun outside the sandbox after the documented Vitest `spawn EPERM` failure); `corepack pnpm verify:context`; `corepack pnpm verify:bootstrap-alignment`.
- Follow-up note: `corepack pnpm verify:validation` and direct `node scripts/verify-validation.mjs` both timed out in this environment without producing verifier output, so feature 88 verification relies on the passing phase tests plus context/bootstrap checks rather than that Postgres-backed validation verifier.
- Likely next board item: feature 89, Deterministic eligibility gate.

## 2026-03-31

- Completed feature 89 from `FEATURE_BOARD.md`: deterministic eligibility gate.
- Confirmed `runPlanningPipeline(...)` already performs a no-LLM `assessEligibility(...)` pre-check before planning or workspace/context materialization, short-circuiting ineligible tasks into the `eligibility` phase with blocked run summaries, gate evidence, and no persisted planning spec.
- Updated the active feature board to reflect feature 89 as complete so future passes do not re-triage it as pending work.

- Completed feature 90 from `FEATURE_BOARD.md`: role-scoped context materialization.
- Updated `packages/control-plane/src/workspace.ts` so runtime instruction layers now expose role-specific `.context` files per agent type, only materialize those scoped files into the workspace, and align `SOUL.md` plus the task `SKILL.md` with the actual per-role context slice.
- Updated `packages/control-plane/src/pipeline/prompts.ts` so the OpenClaw developer prompt now points the agent at the role-scoped workspace contract files (`task.json`, `spec.md`, `acceptance_criteria.json`) and uses `TOOLS.md` as the guardrail source of truth instead of inlining the broader planning payload.
- Updated `packages/control-plane/src/index.test.ts` with assertions for per-role `contextFiles` plus a workspace-level check that validation materialization omits developer- and architect-only files.
- Updated `scripts/verify-openclaw-context.mjs` so `corepack pnpm verify:context` now verifies real file presence and absence for architect, developer, and validation role slices instead of assuming every workspace contains the full `.context` bundle.
- Verification for features 89-90: `corepack pnpm typecheck`; `corepack pnpm test -- packages/control-plane/src/index.test.ts`; `corepack pnpm verify:context`.
- Likely next board item: feature 93, per-run project memory cache.

- Completed feature 93 from `FEATURE_BOARD.md`: per-run project memory cache.
- Updated `packages/control-plane/src/pipeline/dispatch.ts` so downstream post-approval dispatch resolves task/project/organization/external memory context once per task run and passes the same snapshot through development, architecture review, validation, and SCM instead of re-querying repository memory per phase.
- Updated `packages/control-plane/src/pipeline/development.ts`, `packages/control-plane/src/pipeline/architecture-review.ts`, `packages/control-plane/src/pipeline/validation.ts`, and `packages/control-plane/src/pipeline/scm.ts` so standalone phase runs still resolve memory context when needed, while dispatch-driven runs reuse the cached snapshot.
- Extended `packages/contracts/src/workspace.ts` and `packages/control-plane/src/workspace.ts` so workspace bundles can carry memory context and architect/developer workspaces now materialize `.context/project_memory.json` as part of the scoped task contract.
- Added regression coverage in `packages/control-plane/src/index.test.ts` proving downstream dispatch resolves memory context only once, updated `tests/context-materialization.test.ts` to assert project-memory materialization for developer workspaces, and updated `scripts/verify-openclaw-context.mjs` so the live context verifier checks the new scoped memory file.
- Verification for feature 93: `corepack pnpm typecheck`; `corepack pnpm test -- packages/control-plane/src/index.test.ts tests/context-materialization.test.ts`; `corepack pnpm verify:context`; `corepack pnpm verify:memory`.
- Likely next board item: feature 95, structured GitHub issue template.

- Completed feature 95 from `FEATURE_BOARD.md`: structured GitHub issue template.
- Added `.github/ISSUE_TEMPLATE/ai-task.yml` with the intake fields RedDwarf can use directly today: summary, priority signal, acceptance criteria, affected areas, constraints, and risk class. The template applies the `ai-eligible` label automatically so remote GitHub intake stays aligned with the polling path.
- Added `.github/ISSUE_TEMPLATE/config.yml` to disable blank issues and point operators at the demo/runbook path instead of encouraging unstructured intake.
- Updated `README.md` with a short GitHub intake section so the structured remote path is documented alongside the existing local operator flow.
- Verification for feature 95: reviewed the checked-in issue-template YAML and config via repository diff plus field-level grep against the expected intake surface.
- Likely next board item: feature 96, direct task injection endpoint.

- Completed feature 96 from `FEATURE_BOARD.md`: direct task injection endpoint.
- Added `directTaskInjectionRequestSchema` to `packages/contracts/src/planning.ts` so programmatic intake has a typed, reusable contract for repo, summary, acceptance criteria, affected paths, constraints, requested capabilities, and optional source issue metadata.
- Updated `packages/control-plane/src/operator-api.ts` to expose `POST /tasks/inject`, translate structured intake payloads into `PlanningTaskInput`, run them through `runPlanningPipeline(...)`, and return the resulting manifest, spec, policy snapshot, and next action without depending on the GitHub polling path.
- Updated `scripts/start-operator-api.mjs` and `scripts/start-stack.mjs` so local operator environments wire in a planner and advertise the new injection route, while `scripts/verify-operator-api.mjs` now exercises the injected planning flow as part of the live operator API verification.
- Added coverage in `packages/contracts/src/index.test.ts` for the new request schema and in `packages/control-plane/src/operator-api.test.ts` for both the successful injected-planning path and the `service_unavailable` response when no planner is configured.
- Verification for feature 96: `corepack pnpm typecheck`; `corepack pnpm test -- packages/control-plane/src/operator-api.test.ts packages/contracts/src/index.test.ts`; `corepack pnpm verify:operator-api`.
- Likely next board item: feature 97, local CLI task submission.

- Completed feature 97 from `FEATURE_BOARD.md`: local CLI task submission.
- Added a repo-root `reddwarf` bin in `scripts/reddwarf.mjs` with a `submit` command that loads the local `.env`, targets the operator API, and POSTs the same structured payload accepted by `POST /tasks/inject`.
- The CLI supports repeatable acceptance criteria, affected paths, constraints, labels, and requested capabilities; reads `REDDWARF_OPERATOR_TOKEN` and `REDDWARF_API_URL` by default; and can print either a concise human summary or the raw JSON response via `--json`.
- Added `scripts/verify-submit-cli.mjs`, registered it in `package.json`, and included it in `scripts/verify-all.mjs` so the CLI wrapper is now covered by an automated local verification path that inspects the emitted request payload.
- Updated `README.md` with a local CLI intake example so developers can submit work directly from the terminal without going through GitHub issue creation.
- Verification for feature 97: `corepack pnpm typecheck`; `corepack pnpm verify:submit-cli`.
- Likely next board item: feature 94, pre-screener agent phase.

- Completed feature 94 from `FEATURE_BOARD.md`: pre-screener agent phase.
- Added a structured pre-screen assessment contract in `packages/contracts/src/planning.ts` and a `PreScreeningAgent` interface in `packages/contracts/src/agents.ts` so the planning pipeline can return explicit under-specified, duplicate, or out-of-scope findings before the Architect consumes a planning pass.
- Added `DeterministicPreScreeningAgent` in `packages/execution-plane/src/index.ts` and wired it into `runPlanningPipeline(...)` so duplicate-source tasks and fallback-only, boundary-free intake payloads are now blocked ahead of planning with durable phase records, gate evidence, and task memory instead of generating a second planning spec.
- Extended `packages/control-plane/src/index.test.ts` with regression coverage for duplicate-task and under-specified-task rejection, and added schema coverage for the new pre-screen assessment in `packages/contracts/src/index.test.ts`.
- Verification for feature 94: `corepack pnpm typecheck`; `corepack pnpm test -- packages/control-plane/src/index.test.ts packages/contracts/src/index.test.ts packages/execution-plane/src/index.test.ts packages/control-plane/src/polling-daemon.test.ts`.
- Likely next board item: feature 98, task grouping and batch intake.

- Completed feature 98 from `FEATURE_BOARD.md`: task grouping and batch intake.
- Added grouped intake contracts in `packages/contracts/src/planning.ts` for named task groups, per-task dependency keys, execution modes, and persisted task-group membership metadata.
- Added `POST /task-groups/inject` to `packages/control-plane/src/operator-api.ts`, which plans a batch of related tasks, auto-chains sequential groups when explicit dependencies are omitted, and persists dependency metadata to task memory for later execution ordering.
- Added `packages/control-plane/src/task-groups.ts` plus dispatch/polling integration so both manual dispatch and the ready-task dispatcher now hold dependent tasks until their prerequisite task ids are completed, while still allowing unrelated ready work to proceed.
- Extended `packages/control-plane/src/operator-api.test.ts`, `packages/control-plane/src/index.test.ts`, and `scripts/verify-operator-api.mjs` to cover grouped intake plus dispatcher dependency ordering.
- Verification for feature 98: `corepack pnpm typecheck`; `corepack pnpm test -- packages/control-plane/src/operator-api.test.ts packages/control-plane/src/index.test.ts packages/contracts/src/index.test.ts`; `corepack pnpm verify:operator-api`.
- Likely next board item: feature 102, CI adapter tool for agents.

- Completed feature 102 from `FEATURE_BOARD.md`: CI adapter tool for agents.
- Added workspace-local CI tooling in `packages/control-plane/src/ci-tool.ts`, including a generated `.workspace/tools/reddwarf-ci.mjs` helper, cached latest-check snapshots, and request/result files under `.workspace/ci/` so developer and validation workspaces can query CI state and queue workflow-trigger requests without exposing broad host credentials directly inside the workspace.
- Extended `packages/control-plane/src/pipeline/development.ts`, `packages/control-plane/src/pipeline/validation.ts`, `packages/control-plane/src/pipeline/dispatch.ts`, and `packages/control-plane/src/pipeline/types.ts` so optional `CiAdapter` dependencies are threaded through phase execution, workspace CI helpers are provisioned when available, and queued workflow-trigger requests are processed after the phase run and persisted as task memory.
- Updated `packages/control-plane/src/workspace.ts` runtime tool notes so developer and validation agents are told where the CI helper lives, and widened `packages/integrations/src/ci.ts` so successful CI workflow triggers now have a concrete result shape instead of a hardcoded `never` return type.
- Extended `packages/control-plane/src/index.test.ts` with coverage for validation-command and OpenClaw-developer use of the workspace CI helper, while `packages/integrations/src/ci.test.ts` and the broader focused control-plane tests continue covering the adapter contract.
- Verification for feature 102: `corepack pnpm typecheck`; `corepack pnpm test -- packages/control-plane/src/index.test.ts packages/integrations/src/ci.test.ts packages/control-plane/src/operator-api.test.ts`.
- Likely next board item: feature 103, OpenAI provider support.

- Completed feature 103 from `FEATURE_BOARD.md`: OpenAI provider support for OpenClaw model bindings.
- Extended `packages/contracts/src/agents.ts` so `openClawModelBindingSchema.provider` is now an enum-backed contract shared by Anthropic and OpenAI role definitions, and added schema coverage in `packages/contracts/src/index.test.ts` for `openai/gpt-5` bindings.
- Updated `packages/execution-plane/src/index.ts` so the default OpenClaw role roster is generated from provider-aware model maps, preserving Anthropic defaults while allowing a full OpenAI-backed roster through `createOpenClawAgentRoleDefinitions("openai")`; added regression coverage in `packages/execution-plane/src/index.test.ts`.
- Updated `packages/control-plane/src/openclaw-config.ts` and `scripts/generate-openclaw-config.mjs` so generated `openclaw.json` files can opt into an OpenAI-backed agent roster via `modelProvider` or `REDDWARF_OPENCLAW_MODEL_PROVIDER`, with focused config-generation coverage in `packages/control-plane/src/openclaw-config.test.ts`.
- Verification for feature 103: `corepack pnpm typecheck`; `corepack pnpm test -- packages/contracts/src/index.test.ts packages/execution-plane/src/index.test.ts packages/control-plane/src/openclaw-config.test.ts`.
- Likely next board item: feature 99, Discord approval bot.

- Completed feature 99 from `FEATURE_BOARD.md`: Discord approval bot via native OpenClaw channel config.
- Extended `packages/control-plane/src/openclaw-config.ts` so RedDwarf can emit a typed `channels.discord` block with conservative DM pairing, server allowlisting, and native command support instead of requiring hand-edited OpenClaw JSON.
- Updated `scripts/generate-openclaw-config.mjs` and `scripts/lib/config.mjs` so the standard `generate`, `setup`, and `start` flows now build the host-mounted OpenClaw runtime config from typed env-driven options, including `REDDWARF_OPENCLAW_DISCORD_ENABLED`, guild allowlists, and `OPENCLAW_DISCORD_BOT_TOKEN`.
- Added a conservative disabled Discord baseline to `infra/docker/openclaw.json`, documented the new env surface in `.env.example`, `README.md`, and `docs/DEMO_RUNBOOK.md`, and added focused config-generation coverage in `packages/control-plane/src/openclaw-config.test.ts`.
- Verification for feature 99: `corepack pnpm typecheck`; `corepack pnpm test -- packages/control-plane/src/openclaw-config.test.ts`.
- Likely next board item: feature 100, Discord notifications for agents.

- Completed feature 100 from `FEATURE_BOARD.md`: Discord notifications for agents via native OpenClaw Discord runtime options.
- Extended the typed `channels.discord` surface in `packages/control-plane/src/openclaw-config.ts` so RedDwarf can emit OpenClaw-native streaming, history retention, auto-presence, exec-approval prompts, and component styling without introducing a custom notification adapter.
- Updated `scripts/generate-openclaw-config.mjs` and `scripts/lib/config.mjs` to accept the notification-focused env surface (`REDDWARF_OPENCLAW_DISCORD_NOTIFICATIONS_ENABLED`, `REDDWARF_OPENCLAW_DISCORD_EXEC_APPROVALS_ENABLED`, approver ids, auto-presence timings, accent color, and streaming mode) and carry those settings into the host-mounted runtime config.
- Updated `infra/docker/openclaw.json`, `.env.example`, `README.md`, and `docs/DEMO_RUNBOOK.md` so the checked-in template, documented defaults, and operator workflows all mention the OpenClaw-native Discord status/approval path; added focused config-generation coverage in `packages/control-plane/src/openclaw-config.test.ts`.
- Verification for feature 100: `corepack pnpm typecheck`; `corepack pnpm test -- packages/control-plane/src/openclaw-config.test.ts`.
- Likely next board item: feature 101, browser / web search for Architect agent.

- Completed feature 101 from `FEATURE_BOARD.md`: browser / web search for the Architect agent.
- Extended `packages/control-plane/src/openclaw-config.ts`, `scripts/generate-openclaw-config.mjs`, `scripts/lib/config.mjs`, `infra/docker/openclaw.json`, and `.env.example` so generated OpenClaw configs now carry an explicit `browser.enabled` block, enabled by default for Holly's research workflow.
- Updated `agents/openclaw/holly/TOOLS.md` and `packages/control-plane/src/pipeline/prompts.ts` so Holly is explicitly told to use the managed OpenClaw browser for current framework docs and API references only when repository evidence is insufficient, keeping the browser as a targeted planning aid instead of a default crutch.
- Added focused coverage in `packages/control-plane/src/openclaw-config.test.ts` for browser enablement and extended the existing architect/developer prompt-boundary regression in `packages/control-plane/src/index.test.ts` to assert the browser guidance is present in Holly's trusted prompt.
- Verification for feature 101: `corepack pnpm typecheck`; `corepack pnpm test -- packages/control-plane/src/openclaw-config.test.ts packages/control-plane/src/index.test.ts`.
- Likely next board item: feature 104, Telegram channel integration.

## 2026-04-01

- Reviewed the proposed feature source file at `docs/REDDWARF_PROPOSED_FEATURES (1).md` against the active `FEATURE_BOARD.md`.
- Added seven new pending M16 board items (features 107-113): dry-run / simulation mode, plan confidence gate, token budget enforcement, pipeline run report export, prompt version tracking, phase retry budget, and structured eligibility rejection reasons.
- Updated `FEATURE_BOARD.md` so the M16 section now includes an explicit source-reference note plus per-feature links back to the proposal file, giving future implementation work a durable context handoff path.
- Evaluation note: the proposal document says "six proposed features" near the top, but it currently defines seven concrete feature sections plus cross-cutting wiring notes; the board now reflects the seven implementable sections.
- Completed feature 107 from `FEATURE_BOARD.md`: dry-run / simulation mode.
- Added a persisted `dryRun` flag to planning intake, manifests, pipeline runs, approval requests, and SQL schema so dry-run work is visible across the control plane instead of living only in transient script configuration.
- Updated planning intake, operator injection defaults, polling intake, stack startup, and SCM execution so `REDDWARF_DRY_RUN=true` or explicit dry-run intake suppresses branch creation, pull request creation, and follow-up failure issue creation while still preserving evidence, reports, approvals, and run telemetry.
- Added focused regression coverage for dry-run planning persistence, dry-run SCM completion without PR publication, and operator API default dry-run injection behavior.
- Verification for feature 107: `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm typecheck"`; `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm test -- packages/control-plane/src/operator-api.test.ts packages/control-plane/src/index.test.ts packages/contracts/src/index.test.ts packages/evidence/src/index.test.ts packages/control-plane/src/polling-daemon.test.ts packages/control-plane/src/phase-run-context.test.ts packages/policy/src/index.test.ts"`.
- Completed feature 108 from `FEATURE_BOARD.md`: plan confidence gate.
- Added structured planning confidence to the architect draft contract, persisted confidence level and reason on planning specs and approval requests, and added a SQL migration so confidence remains queryable in durable evidence rather than only in transient planner output.
- Updated deterministic and Anthropic planning flows to emit confidence, updated Holly handoff parsing to supply a bounded confidence fallback, and changed policy resolution so low-confidence plans always route to human approval even when the underlying task would otherwise auto-complete.
- Added focused regression coverage for deterministic confidence output, policy confidence gating, confidence-bearing planning specs, and low-confidence planning runs that now queue approval requests.
- Verification for feature 108: `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm typecheck"`; `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm test -- packages/execution-plane/src/index.test.ts packages/policy/src/index.test.ts packages/control-plane/src/index.test.ts packages/contracts/src/index.test.ts tests/context-materialization.test.ts packages/evidence/src/index.test.ts"`.
- Completed feature 109 from `FEATURE_BOARD.md`: token budget enforcement.
- Added shared token-budget contracts plus control-plane enforcement helpers that estimate prompt/context size with the char/4 heuristic, honor per-phase `REDDWARF_TOKEN_BUDGET_*` limits, and either warn or block based on `REDDWARF_TOKEN_BUDGET_OVERAGE_ACTION`.
- Wired token-budget telemetry into planning, development, architecture review, validation, and SCM; extended the Anthropic planning path to capture provider usage when available; and exposed summarized run-level token data through `GET /runs/:runId`.
- Adaptation note: the proposal references `phase_evidence`, but this repository persists the same telemetry through existing phase records, evidence metadata, and run events rather than introducing a mismatched table.
- Added focused regression coverage for block-mode planning budgets, warn-mode developer overages, and operator API run-detail token summaries.
- Verification for feature 109: `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm typecheck"`; `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm test -- packages/control-plane/src/index.test.ts packages/control-plane/src/operator-api.test.ts packages/execution-plane/src/index.test.ts"`.
- Completed feature 110 from `FEATURE_BOARD.md`: pipeline run report export.
- Added a shared run-report assembler and markdown renderer in the control plane, backed by existing run, snapshot, event, evidence, and token-usage records so reviewers can inspect a complete run narrative without querying the raw operator surfaces by hand.
- Added `GET /runs/:runId/report` with markdown-by-default and JSON-on-accept behavior, and extended the `reddwarf` CLI with `report --run-id` / `report --last` export support plus a dedicated `verify:report-cli` workflow.
- Adaptation note: the proposal assumed a richer phase-evidence model than this repo currently uses, so the exported report timeline is derived from per-run events and existing artifacts instead of adding a new report-only persistence table.
- Verification for feature 110: `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm typecheck"`; `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm test -- packages/control-plane/src/operator-api.test.ts"`; `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm build && node scripts/verify-report-cli.mjs"`.
- Completed feature 111 from `FEATURE_BOARD.md`: prompt version tracking.
- Added durable `prompt_snapshots` persistence in the evidence layer, plus control-plane prompt snapshot capture that hashes the actual prompt text at dispatch time and records the selected snapshot into evidence and run events for planning, developer OpenClaw handoff, and architecture review.
- Adaptation note: RedDwarf’s prompts mostly live in code rather than standalone `prompts/*.md` files, so the captured `promptPath` values reference the code-based prompt builders that actually emitted the model-facing text for that run.
- Extended run-report export so prompt snapshots now appear automatically once captured, and added focused contract, evidence, planning, and operator API regression coverage around snapshot persistence and report surfacing.
- Verification for feature 111: `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm typecheck"`; `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm test -- packages/contracts/src/index.test.ts packages/evidence/src/index.test.ts packages/control-plane/src/index.test.ts packages/control-plane/src/operator-api.test.ts packages/execution-plane/src/index.test.ts"`.
- Likely next board item: feature 112, phase retry budget.

## 2026-04-02

- Fixed GitHub issue intake so the parser now accepts both `Affected Paths` and `Affected Areas` headings when converting issue bodies into planning input, matching the checked-in `.github/ISSUE_TEMPLATE/ai-task.yml` wording instead of rejecting otherwise valid issues as under-specified.
- Fixed a second GitHub intake parsing bug where blank lines after markdown headings caused the parser to drop section context before it reached the bullet items. This was the real reason valid GitHub issue bodies like issue `#26` and `#27` still fell back to generic acceptance criteria and empty affected paths after the heading alias fix.
- Added focused regression coverage in `packages/integrations/src/github.test.ts` for both the template's `Affected Areas` heading and real GitHub markdown sections that include blank lines after headings.
- Verification: `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm test -- packages/integrations/src/github.test.ts"`.
- Tightened GitHub issue parsing again so section-scoped lists stop at the next markdown heading and manifest summaries are composed only from `Summary`, `Why`, and `Desired Outcome` narrative sections. This prevents `allowedPaths` from swallowing `Constraints` / `Risk Class` content and stops summaries from ending with stray values like `low`.
- Added focused regression coverage in `packages/integrations/src/github.test.ts` for both behaviors: `Affected Paths` terminating at the next heading and section-based summary extraction from a GitHub issue body.
- Fixed OpenClaw runtime config generation so the live `openclaw.json` now uses the container-visible `REDDWARF_WORKSPACE_ROOT` for every agent `workspace` and `agentDir` instead of baking in the host-only `REDDWARF_OPENCLAW_WORKSPACE_ROOT`. This unblocked developer runs that were timing out with `EACCES: permission denied, mkdir '/home/derek'` inside the container.
- Updated `scripts/lib/config.mjs` and `scripts/generate-openclaw-config.mjs`, regenerated `runtime-data/openclaw-home/openclaw.json`, and recreated the OpenClaw container. Verified the live config now points at `/var/lib/reddwarf/workspaces` for all five RedDwarf agents.
- Fixed approved OpenClaw development runs so `enableWorkspaceCodeWriting()` now promotes the workspace contract from `development_readonly` to `development_readwrite`, adds `can_write_code`, and refreshes the live runtime instruction files (`TOOLS.md`, `SOUL.md`, and the task skill) instead of only mutating the workspace state JSON. This keeps the agent-visible contract aligned with the approved development phase.
- Extended the workspace tool-mode enum with `development_readwrite`, updated the OpenClaw development regression in `packages/control-plane/src/index.test.ts`, and verified the change with `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm test -- packages/contracts/src/index.test.ts packages/control-plane/src/index.test.ts"`.
- Added env-driven OpenClaw trusted automation support so the standard `setup` / `start` flows now also seed `runtime-data/openclaw-home/exec-approvals.json` alongside `openclaw.json`. When `REDDWARF_OPENCLAW_TRUSTED_AUTOMATION=true`, the generated exec approvals defaults are `security: "full"` and `ask: "off"` while preserving any existing gateway `socket` metadata that OpenClaw writes itself.
- Tightened the planning-to-execution contract after reviewing issue 31's stuck architecture-review run. Planning policy snapshots and workspace bundles now carry the union of approved `allowedPaths` and planning-spec `affectedAreas`, so downstream developer/reviewer workspaces can inspect spec-adjacent files like `vite.config.ts`, `tsconfig.json`, or `index.html` without drifting outside the trusted scope.
- Gated OpenClaw code writing on an explicitly approved `can_write_code` capability instead of auto-enabling it for every development dispatch. GitHub AI Task issue intake now defaults to `can_plan`, `can_write_code`, and `can_archive_evidence` when the issue body does not specify requested capabilities, which keeps normal execution-oriented issues aligned with the stricter gate.
- Tightened OpenClaw developer handoff validation so readonly runs must keep `Code writing enabled: no`, write-enabled runs must show repo changes within the approved path scope, and handoffs cannot claim tests ran unless the workspace actually allowed `can_run_tests`. Run summaries now stay `active` until a terminal pipeline event is recorded instead of defaulting to `completed`.
- Added focused regression coverage for effective allowed paths, readonly OpenClaw development, unverified test-claim rejection, GitHub intake defaults, active run summaries, and context materialization. Verification for this fix set: `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm test -- packages/control-plane/src/index.test.ts packages/evidence/src/index.test.ts packages/integrations/src/github.test.ts packages/contracts/src/index.test.ts tests/context-materialization.test.ts"`; `docker run --rm -v /home/derek/code/RedDwarf:/work -w /work node:22 bash -lc "corepack pnpm typecheck"`.
