# Agent Documentation

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
