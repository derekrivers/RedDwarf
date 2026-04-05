# Code Quality Audit — QUAL Series (2026-03-29)

**Date:** 2026-03-29
**Scope:** Full codebase audit — code quality, SOLID principles, test coverage, and technical debt
**Packages audited:** `@reddwarf/contracts`, `@reddwarf/policy`, `@reddwarf/integrations`, `@reddwarf/evidence`, `@reddwarf/execution-plane`, `@reddwarf/control-plane`
**Codebase totals at audit time:** `pipeline.ts` 6,524 lines; `control-plane/src/index.test.ts` 5,602 lines; `integrations/src/index.ts` 1,740 lines; `evidence/src/postgres-repository.ts` 1,205 lines.
**Feature board items:** F105–F115 (QUAL-001 through QUAL-011)

Read [docs/archive/audits/code-review-m6.md](/c:/Dev/RedDwarf/docs/archive/audits/code-review-m6.md) and [docs/archive/audits/code-review-m11.md](/c:/Dev/RedDwarf/docs/archive/audits/code-review-m11.md) for earlier review passes (M6 and M11). This audit follows on from those and focuses on what remained after the M6/M7 refactor delivered features 26–42.

---

## Investigation Summary

The codebase has a logically sound layered dependency graph:

```
@reddwarf/contracts          (types, schemas — no deps)
@reddwarf/policy             (eligibility, risk, capabilities)
@reddwarf/integrations       (adapters: GitHub, CI, secrets, OpenClaw, knowledge)
@reddwarf/evidence           (repository interfaces + InMemory and Postgres implementations)
@reddwarf/execution-plane    (deterministic + Anthropic agents)
@reddwarf/control-plane      (pipeline orchestration, operator API, polling, workspace lifecycle)
```

The M7 refactor resolved the circular dependency between `control-plane` and `execution-plane` by moving agent interfaces, draft types, and `MaterializedManagedWorkspace` into `@reddwarf/contracts`. That work is complete and correct.

**Where the codebase is struggling:**

`control-plane/src/pipeline.ts` (6,524 lines) contains four major exported orchestration functions — `runPlanningPipeline` (~991 lines), `runValidationPhase` (~844 lines), `runDeveloperPhase` (~694 lines), and `runScmPhase` (~700 lines) — each independently rebuilding the same ~50-line phase context boilerplate: event sequencing, heartbeat persistence closures, run logging, and concurrency resolution. A `persistConcurrencyBlock` helper was extracted in the M11 pass, but the surrounding context construction was not. The file also owns: failure normalisation, OpenClaw prompt construction for two agent roles, handoff markdown parsing, workspace runtime-path resolution, and `resolveApprovalRequest`.

`integrations/src/index.ts` (1,740 lines) is a mixed bag — GitHub interfaces, CI adapters, secrets interfaces and three implementations, OpenClaw dispatch adapters, and knowledge ingestion all in a single flat file.

`evidence/src/postgres-repository.ts` (1,205 lines) exposes `*WithExecutor` methods as `public` to serve an internal `PostgresTransactionRepository` delegate.

`control-plane/src/index.test.ts` (5,602 lines) mirrors the growth problem of the file it tests. Three locations in `pipeline.ts` and `workspace.ts` read `process.env` directly inside orchestration logic.

---

## Findings by Priority

### Critical

| ID | Finding | Location |
|----|---------|----------|
| QUAL-001 / F105 | Phase run context boilerplate duplicated four times | `pipeline.ts` lines 635, 1634, 2341, 4539 |
| QUAL-002 / F106 | `pipeline.ts` owns six distinct concerns in 6,524 lines | `packages/control-plane/src/pipeline.ts` |
| QUAL-003 / F107 | `process.env` read directly inside orchestration functions | `pipeline.ts:3646,3702`; `workspace.ts:840` |

### High

| ID | Finding | Location |
|----|---------|----------|
| QUAL-004 / F108 | `integrations/src/index.ts` is a 1,740-line multi-concern barrel | `packages/integrations/src/index.ts` |
| QUAL-005 / F109 | `RestGitHubAdapter` read paths have no unit test coverage | `integrations/src/index.ts:923` |
| QUAL-006 / F110 | `PostgresPlanningRepository.*WithExecutor` methods are publicly exposed | `evidence/src/postgres-repository.ts:206` |
| QUAL-007 / F111 | `InMemoryPlanningRepository` in the same file as interface definitions | `evidence/src/repository.ts:132` |
| QUAL-008 / F112 | `EnvVarSecretsAdapter` and `HttpOpenClawDispatchAdapter` have thin failure-path coverage | `integrations/src/index.ts:1323,1600` |

### Medium

| ID | Finding | Location |
|----|---------|----------|
| QUAL-009 / F113 | `normalizePipelineFailure` uses `instanceof` chains (OCP violation) | `pipeline.ts:5774` |
| QUAL-010 / F114 | `waitWithHeartbeat` heartbeat errors mask work errors | `pipeline.ts:3372` |
| QUAL-011 / F115 | `control-plane/src/index.test.ts` is 5,602 lines and growing | `packages/control-plane/src/index.test.ts` |

---

## Detailed Findings

---

### QUAL-001 / F105 — Phase run context boilerplate duplicated four times

**SOLID principle:** SRP
**Debt type:** Inadvertent (emerged from sequential phase additions)

**Problem**
Every phase function (`runPlanningPipeline`, `runDeveloperPhase`, `runValidationPhase`, `runScmPhase`) independently declares the following ~50-line context block:

```
let eventSequence = 0;
const nextEventId = (phase: TaskPhase, code: string): string => { ... };
const persistTrackedRun = async (patch, runRepository = repository) => { ... };
const runLogger = bindPlanningLogger(logger, { runId, taskId, ... });
```

Lines where this appears: `635`, `1634`, `2341`, `4539`.

The `persistConcurrencyBlock` helper was extracted in M11, but the surrounding context construction that feeds it was not. Any fix to event-ID format or heartbeat persistence shape must be applied in four places simultaneously.

**Proposed solution**
- Introduce a `PhaseRunContext` interface holding `{ runId, taskId, concurrencyKey, trackedRun, runLogger, nextEventId, persistTrackedRun, clock, repository }`.
- Extract a `createPhaseRunContext(input)` factory that initialises all shared fields.
- Refactor each phase function to call `createPhaseRunContext(...)` after pre-flight snapshot checks, then pass the context to sub-functions.
- Pattern: **Extract Parameter Object** + **Extract Method**.

**Acceptance criteria**
- [ ] All four phase functions delegate shared run-context initialisation to `createPhaseRunContext`.
- [ ] `let eventSequence`, `const nextEventId`, `const persistTrackedRun`, `const runLogger` appear exactly once each in `pipeline.ts` (inside `createPhaseRunContext`).
- [ ] All existing tests pass.
- [ ] A unit test asserts that `nextEventId` produces correctly sequenced IDs across two calls.

---

### QUAL-002 / F106 — `pipeline.ts` owns six distinct concerns in 6,524 lines

**SOLID principle:** SRP, OCP
**Debt type:** Inadvertent (incremental feature additions without partitioning)

**Problem**
`packages/control-plane/src/pipeline.ts` (6,524 lines) contains:
1. Planning phase orchestration (`runPlanningPipeline`, lines 563–1554)
2. Development phase orchestration (`runDeveloperPhase`, lines 1555–2249)
3. Validation phase orchestration (`runValidationPhase`, lines 2250–3094)
4. SCM phase orchestration (`runScmPhase`, starts line 4410)
5. OpenClaw prompt construction and handoff parsing (`buildOpenClawArchitectPrompt`, `buildOpenClawDeveloperPrompt`, `parseArchitectHandoffMarkdown`, `parseDevelopmentHandoffMarkdown`, lines 3811–3999+)
6. Failure normalisation and approval resolution (`normalizePipelineFailure`, `resolveApprovalRequest`, lines 5774+)

The companion `index.test.ts` (5,602 lines) mirrors the same structure. Every new phase or agent type requires editing a file already too large to navigate safely.

**Proposed solution**
Split into a `pipeline/` subdirectory:
- `pipeline/planning.ts` — `runPlanningPipeline` and planning-specific helpers
- `pipeline/development.ts` — `runDeveloperPhase` and development-specific helpers
- `pipeline/validation.ts` — `runValidationPhase` and validation-specific helpers
- `pipeline/scm.ts` — `runScmPhase` and SCM-specific helpers
- `pipeline/prompts.ts` — both prompt-builder functions, both handoff parsers, `renderUntrustedIssueDataBlock`
- `pipeline/failure.ts` — `normalizePipelineFailure`, `serializeError`, `sanitizeSerializedErrorDetails`
- `pipeline/approval.ts` — `resolveApprovalRequest`
- `pipeline/context.ts` — `PhaseRunContext`, `createPhaseRunContext` (from QUAL-001)
- `pipeline/index.ts` — barrel re-exporting the public API unchanged

Split the test file in parallel (see QUAL-011).
Pattern: **Extract Module**.

**Acceptance criteria**
- [ ] No single file in `packages/control-plane/src/pipeline/` exceeds 800 lines.
- [ ] The public API surface of `@reddwarf/control-plane` is unchanged.
- [ ] `corepack pnpm typecheck` and `corepack pnpm test` pass.
- [ ] Each module has at least one directly focused test file.

**Dependencies:** QUAL-001 (extract context first; simplifies the split).

---

### QUAL-003 / F107 — `process.env` read directly inside orchestration functions

**SOLID principle:** DIP
**Debt type:** Inadvertent

**Problem**
Three locations read `process.env` directly inside business logic with no injectable seam:

- `pipeline.ts:3646–3647` (`buildRuntimeWorkspacePath`) reads `REDDWARF_WORKSPACE_ROOT` and `REDDWARF_HOST_WORKSPACE_ROOT`.
- `pipeline.ts:3702–3703` (`dispatchHollyArchitectPhase`) reads the same two env vars — a direct duplication of the logic from line 3643.
- `workspace.ts:840` (`resolveEvidenceRoot`) reads `REDDWARF_HOST_EVIDENCE_ROOT`.

Tests that exercise workspace path resolution must mutate `process.env` globally — a race condition risk in parallel test runs. The duplication at lines 3646 and 3702 means path-derivation logic diverges silently if one copy is updated and the other is not.

**Proposed solution**
- Add a `WorkspaceRuntimeConfig` interface to `@reddwarf/contracts`: `{ workspaceRoot?: string; hostWorkspaceRoot?: string; hostEvidenceRoot?: string }`.
- Add `runtimeConfig?: WorkspaceRuntimeConfig` to the four phase `*Dependencies` interfaces.
- Inside each function, resolve: `const cfg = { workspaceRoot: deps.runtimeConfig?.workspaceRoot ?? process.env.REDDWARF_WORKSPACE_ROOT ?? "/var/lib/reddwarf/workspaces", ... }`.
- Pass `cfg` to both `buildRuntimeWorkspacePath` and `dispatchHollyArchitectPhase` — eliminating the duplicated read.
- Pattern: **Introduce Parameter Object**.

**Acceptance criteria**
- [ ] `buildRuntimeWorkspacePath` and `dispatchHollyArchitectPhase` both consume from an injected config rather than calling `process.env` directly.
- [ ] `process.env.REDDWARF_WORKSPACE_ROOT` appears at most once in all of `pipeline.ts`.
- [ ] A new unit test asserts workspace path derivation without mutating `process.env`.
- [ ] `corepack pnpm typecheck` and `corepack pnpm test` pass.

---

### QUAL-004 / F108 — `integrations/src/index.ts` is a 1,740-line multi-concern barrel

**SOLID principle:** SRP
**Debt type:** Inadvertent (file preceded the knowledge and secrets additions)

**Problem**
`packages/integrations/src/index.ts` (1,740 lines) co-locates without internal separation:
- GitHub data interfaces (lines 1–138): `GitHubIssueCandidate`, `GitHubAdapter`, etc.
- GitHub fixture adapter (`FixtureGitHubAdapter`, line 219, ~200 lines)
- `RestGitHubAdapter` (line 923, ~375 lines)
- CI adapter interfaces and `FixtureCiAdapter` (lines 145+, 419+)
- Secrets interfaces and three implementations: `FixtureSecretsAdapter` (line 461), `DenyAllSecretsAdapter` (line 554), `EnvVarSecretsAdapter` (line 1323)
- OpenClaw dispatch interfaces and adapters: `FixtureOpenClawDispatchAdapter` (line 1568), `HttpOpenClawDispatchAdapter` (line 1600)
- Knowledge ingestion: `KnowledgeIngestionAdapter` (line 683), `FixtureKnowledgeIngestionAdapter` (line 688)

Any change to GitHub rate limiting logic risks merge conflicts with secrets changes.

**Proposed solution**
Partition into domain-scoped files:
- `integrations/src/github.ts` — all GitHub interfaces, `RestGitHubAdapter`, `FixtureGitHubAdapter`, `createRestGitHubAdapter`
- `integrations/src/secrets.ts` — `SecretsAdapter`, all three implementations, `createEnvVarSecretsAdapter`
- `integrations/src/openclaw.ts` — `OpenClawDispatchAdapter`, `FixtureOpenClawDispatchAdapter`, `HttpOpenClawDispatchAdapter`, `createOpenClawSecretsAdapter`, constants
- `integrations/src/knowledge.ts` — `KnowledgeIngestionAdapter`, `FixtureKnowledgeIngestionAdapter`, types
- `integrations/src/ci.ts` — `CiAdapter`, `FixtureCiAdapter`, CI types
- `integrations/src/index.ts` — barrel re-exporting all public names unchanged

Pattern: **Extract Module**.

**Acceptance criteria**
- [ ] No single file in `packages/integrations/src/` (excluding `index.ts`) exceeds 600 lines.
- [ ] The public API surface of `@reddwarf/integrations` is unchanged.
- [ ] `corepack pnpm typecheck` and `corepack pnpm test` pass.
- [ ] Each new module has its own test file.

---

### QUAL-005 / F109 — `RestGitHubAdapter` read paths have no unit test coverage

**Debt type:** Inadvertent

**Problem**
`RestGitHubAdapter` (`integrations/src/index.ts:923`, ~375 lines) implements `getIssueStatusSnapshot`, `listIssues`, `getCiCheckSuite`, and `addIssueComment`. These are the read methods used by the polling daemon every production cycle. Only the write paths (`createFollowUpIssue` reuse, `createPullRequest` reuse) have tests. No test covers: 404 not-found, 401 token expiry, 429 rate limit, 422 validation error, network timeout, or malformed JSON. These failure modes are common in production and are the primary source of silent polling failures.

**Proposed solution**
- Use `vi.stubGlobal("fetch", vi.fn())` (same pattern as existing `HttpOpenClawDispatchAdapter` tests at `index.test.ts:538`) to mock `fetch` at the HTTP boundary.
- Add: `getIssueStatusSnapshot` success and 404, `listIssues` success and 401, `getCiCheckSuite` success and 429 with `Retry-After`, `addIssueComment` success and 422.
- Add `fetchWithRetry` exhaustion test: three consecutive 5xx responses → throws.
- Do not mock `fetchWithRetry` internals.

**Acceptance criteria**
- [ ] At least 6 new test cases covering the read methods.
- [ ] At least 2 test cases covering 4xx/5xx/timeout failure paths.
- [ ] `fetchWithRetry` retry exhaustion covered by at least one test.
- [ ] No new test infrastructure needed; uses existing `vi.stubGlobal` pattern.

**Dependencies:** QUAL-004 (module split makes co-location natural, but not a hard blocker).

---

### QUAL-006 / F110 — `PostgresPlanningRepository.*WithExecutor` methods publicly exposed

**SOLID principle:** ISP (encapsulation)
**Debt type:** Prudent, deliberate (pragmatic at the time; the cost is a leaky surface)

**Problem**
`PostgresPlanningRepository` (`evidence/src/postgres-repository.ts:206`) exposes ~10 `public *WithExecutor(executor, ...)` methods solely to serve the internal `PostgresTransactionRepository` delegate (line 167):

```typescript
// PostgresTransactionRepository calls:
await this.owner.saveManifestWithExecutor(this.executor, manifest);
await this.owner.savePhaseRecordWithExecutor(this.executor, record);
// ... eight more
```

All `*WithExecutor` methods must be `public` for this delegation to compile, but they are implementation details. Any consumer of `PostgresPlanningRepository` can call them with an arbitrary `pg.Pool | pg.PoolClient`, bypassing the intended transaction boundary.

**Proposed solution**
- Introduce a package-internal `ExecutorRepository` interface with only the `*WithExecutor` signatures.
- Change `PostgresTransactionRepository` to hold a reference typed as `ExecutorRepository` rather than the full `PostgresPlanningRepository`.
- Make the `*WithExecutor` methods `private` on the class and expose them to `PostgresTransactionRepository` via a factory method that `PostgresPlanningRepository` creates when entering a transaction.
- If a simpler fix is preferred: prefix the methods with `_` and add a JSDoc `@internal` tag as an interim measure.
- Pattern: **Extract Interface**.

**Acceptance criteria**
- [ ] No `*WithExecutor` method is callable from outside `packages/evidence/src/postgres-repository.ts` through the `PlanningRepository` interface.
- [ ] `PostgresTransactionRepository` continues to function correctly.
- [ ] `corepack pnpm typecheck` and `corepack pnpm test` pass.

---

### QUAL-007 / F111 — `InMemoryPlanningRepository` mixed with interface definitions

**SOLID principle:** SRP
**Debt type:** Inadvertent

**Problem**
`evidence/src/repository.ts` (591 lines) defines the `PlanningRepository` interface family (lines 55–130) and then contains the full `InMemoryPlanningRepository` implementation (~400 lines, starting at line 132). The in-memory implementation is the primary test double for the entire test suite. Its correctness cannot be verified in isolation from its interface definition because they share a file. Reviewing the interface requires scrolling past ~400 lines of implementation.

**Proposed solution**
- Move `InMemoryPlanningRepository` and its helpers (`normalizeMemoryQuery`, `normalizePipelineRunQuery`, `normalizeApprovalRequestQuery`, `dedupeMemoryRecords`, `compareMemoryRecords`, comparator functions) into `evidence/src/in-memory-repository.ts`.
- Keep `repository.ts` for interface and type definitions only.
- Update `evidence/src/index.ts` barrel to re-export from both modules.
- Pattern: **Extract Module**.

**Acceptance criteria**
- [ ] `repository.ts` contains only interface and type definitions; no class implementations.
- [ ] `InMemoryPlanningRepository` lives in `in-memory-repository.ts`.
- [ ] All existing imports resolve through the `@reddwarf/evidence` barrel unchanged.
- [ ] `corepack pnpm typecheck` and `corepack pnpm test` pass.

---

### QUAL-008 / F112 — Thin failure-path coverage for `EnvVarSecretsAdapter` and `HttpOpenClawDispatchAdapter`

**Debt type:** Inadvertent

**Problem**
`EnvVarSecretsAdapter` (`integrations/src/index.ts:1323`, ~100 lines) tests cover only the happy path. No test for: missing env var, scope with no matching variable, `null` lease return (fail-closed), or `DenyAllSecretsAdapter` consistency.

`HttpOpenClawDispatchAdapter` (`integrations/src/index.ts:1600`) tests cover construction and timeout but not: 4xx responses, non-JSON bodies, `accepted: false`, or missing auth header.

These are security-adjacent adapter paths. A misconfigured secrets adapter that returns a partial lease or swallows an auth error can expose credential state silently.

**Proposed solution**
- `EnvVarSecretsAdapter`: use `vi.stubEnv` to test missing env var (→ `null`), partial scopes, and fail-closed behaviour. Test `DenyAllSecretsAdapter` returns `null` for all inputs.
- `HttpOpenClawDispatchAdapter`: use `vi.stubGlobal("fetch", ...)` to test 401, 500, `accepted: false` response shape, and non-JSON body.
- All stubs must be restored in `afterEach`.

**Acceptance criteria**
- [ ] At least 3 new tests for `EnvVarSecretsAdapter` covering missing env var, partial scopes, fail-closed `null` return.
- [ ] At least 3 new tests for `HttpOpenClawDispatchAdapter` covering 401, 500, and `accepted: false` dispatch response.
- [ ] No `process.env` mutations left unrestored after test execution.

**Dependencies:** QUAL-004 (module split makes co-location cleaner; not a hard blocker).

---

### QUAL-009 / F113 — `normalizePipelineFailure` uses `instanceof` chains (OCP violation)

**SOLID principle:** OCP
**Debt type:** Deliberate (pragmatic when the error set was small)

**Problem**
`normalizePipelineFailure` (`pipeline.ts:5774`) dispatches on three concrete error types via sequential `instanceof` checks:

```typescript
if (error instanceof PlanningPipelineFailure) { ... }
if (error instanceof OpenClawCompletionTimeoutError) { ... }
if (error instanceof ExternalCommandTimeoutError) { ... }
// generic fallback
```

`AllowedPathViolationError` (defined in `live-workflow.ts:120`) is used in SCM path-scope enforcement but is not handled here — it falls through to the generic branch, losing its structured `violatingPaths` field. Adding any new error type requires editing this function.

**Proposed solution**
- Introduce a `PipelineErrorMapper` registry: `Array<{ test(e: unknown): boolean; map(e: unknown, phase, taskId, runId): PlanningPipelineFailure }>`.
- Populate the registry at module load, alongside each error class definition.
- `normalizePipelineFailure` iterates the registry and calls the first matching mapper.
- Add an `AllowedPathViolationError` mapper that preserves `violatingPaths` in `details`.
- Pattern: **Replace Conditional with Polymorphism** (registry variant).

**Acceptance criteria**
- [ ] `normalizePipelineFailure` contains no `instanceof` checks.
- [ ] `AllowedPathViolationError` is correctly mapped to a `PlanningPipelineFailure` with `violatingPaths` in `details`.
- [ ] Adding a new error type requires only a new registry entry.
- [ ] A unit test asserts `AllowedPathViolationError` is correctly translated.

**Dependencies:** QUAL-002 (the function moves to `pipeline/failure.ts`; easier to add the registry there, but can be done independently).

---

### QUAL-010 / F114 — `waitWithHeartbeat` heartbeat errors mask work errors

**Debt type:** Inadvertent

**Problem**
`waitWithHeartbeat` (`pipeline.ts:3372`) calls `await input.onHeartbeat()` inside its `while (true)` loop without a catch:

```typescript
await input.onHeartbeat(); // throws on transient Postgres failure
```

If the heartbeat persistence fails (e.g. transient Postgres connection drop during a long-running validation), the exception propagates out of `waitWithHeartbeat` and appears to be the phase failure. An operator reading run events would see `"Postgres connection lost"` instead of the actual validation error.

**Proposed solution**
- Wrap `await input.onHeartbeat()` in `try/catch`.
- On heartbeat failure: call an optional `onHeartbeatError?: (error: unknown) => void` callback (for test observability), log at `warn` level if a logger is available, then `continue` the loop.
- Do not suppress silently — emit a structured warning.
- The original `work` error must still be the thrown exception when `work` rejects.

**Acceptance criteria**
- [ ] A heartbeat failure does not propagate as the phase failure.
- [ ] The original `work` error is still thrown when `work` rejects.
- [ ] A unit test: throwing `onHeartbeat` does not prevent the `work` result from being returned.
- [ ] A unit test: repeated heartbeat failures are reported via `onHeartbeatError` callback.

---

### QUAL-011 / F115 — `control-plane/src/index.test.ts` is 5,602 lines

**Debt type:** Inadvertent

**Problem**
`control-plane/src/index.test.ts` (5,602 lines) is a monolithic test file covering: pipeline orchestration, operator API, polling daemon, knowledge ingestion, and OpenClaw config generation — all in one file. It is a structural echo of `pipeline.ts`. Any change to polling logic requires reviewing a 5,600-line diff. Concurrent feature work on the operator API and polling tests causes routine merge conflicts.

The describes present in the file:
- `describe("control-plane", ...)` — pipeline orchestration tests (lines 166–2621)
- `describe("operator API server", ...)` — lines 2622–3163
- `describe("GitHub issue polling daemon", ...)` — lines 3164–3369
- `describe("knowledge ingestion pipeline", ...)` — lines 3370–3568
- `describe("generateOpenClawConfig", ...)` — lines 3569–end

**Proposed solution**
Split alongside QUAL-002 to match the production module structure:
- `pipeline/planning.test.ts`
- `pipeline/development.test.ts`
- `pipeline/validation.test.ts`
- `pipeline/scm.test.ts`
- `pipeline/failure.test.ts`
- `pipeline/approval.test.ts`
- `operator-api.test.ts`
- `polling.test.ts`
- `knowledge.test.ts`
- `openclaw-config.test.ts`
- Shared fixtures extracted to `test-helpers.ts`

All existing test cases are preserved — this is a move, not a rewrite.

**Acceptance criteria**
- [ ] No single test file in `packages/control-plane/src/` exceeds 800 lines.
- [ ] All existing test cases are preserved without logic changes.
- [ ] `corepack pnpm test` passes with no changes to test logic.
- [ ] New test files are co-located with their production module counterparts.

**Dependencies:** QUAL-002 (production module split drives the test split structure).

---

## Test Coverage Plan

### 1 — Planning pipeline concurrency and failure paths

**Risk level:** High
**Current coverage:** Partial — happy path and `claimPipelineRun` block cases tested; `waitWithHeartbeat` heartbeat-error suppression and `normalizePipelineFailure` dispatch for `AllowedPathViolationError` untested.

**Scenarios to cover**
- Happy path: `waitWithHeartbeat` returns the work result when no heartbeat fires
- Edge case: `waitWithHeartbeat` swallows a heartbeat error and still returns the work result
- Edge case: `waitWithHeartbeat` re-throws when `work` rejects while a heartbeat is pending
- Error path: `normalizePipelineFailure` maps `AllowedPathViolationError` to structured failure with `violatingPaths` in `details`
- Error path: `normalizePipelineFailure` falls back to generic branch for unknown error types
- Boundary: `buildRuntimeWorkspacePath` with and without `REDDWARF_HOST_WORKSPACE_ROOT` (after QUAL-003 injection)
- Boundary: workspace root whose path escapes the host root does not produce `../` in output

**Recommended test type:** Unit
**Suggested approach:** Test `waitWithHeartbeat`, `normalizePipelineFailure`, and `buildRuntimeWorkspacePath` in isolation by importing from their post-QUAL-002 module files. Pass minimal mock objects via `vi.fn()`. Do not use `InMemoryPlanningRepository`. Assert return value shapes, not which sub-functions were called.

---

### 2 — `RestGitHubAdapter` read and error paths

**Risk level:** Critical
**Current coverage:** None for read methods; partial for write methods (reuse paths only).

**Scenarios to cover**
- Happy path: `getIssueStatusSnapshot` returns correctly shaped snapshot for valid issue
- Happy path: `listIssues` returns filtered results for a given label set
- Happy path: `getCiCheckSuite` returns check run summaries
- Error path: `getIssueStatusSnapshot` throws recognisable error on 404
- Error path: `listIssues` throws or returns empty on 401 token expiry
- Error path: `fetchWithRetry` exhausts budget on three consecutive 5xx responses and throws
- Error path: 429 with `Retry-After` header causes delay before retry
- Boundary: empty `labels` array matches all issues
- Boundary: malformed JSON response body causes clean parse error

**Recommended test type:** Unit
**Suggested approach:** `vi.stubGlobal("fetch", vi.fn())` — same pattern as `HttpOpenClawDispatchAdapter` tests (`integrations/src/index.test.ts:538`). Do not mock `fetchWithRetry` itself. Assert final return values or thrown errors. Create a `makeHttpResponse(status, body)` test helper to reduce boilerplate.

---

### 3 — `EnvVarSecretsAdapter` failure modes

**Risk level:** High
**Current coverage:** Happy path only (valid env var → populated lease).

**Scenarios to cover**
- Happy path: adapter returns populated `SecretLease` when all scoped env vars present
- Error path: `issueTaskSecrets` returns `null` when the requested scope has no matching env var
- Error path: adapter configured with empty env returns `null` (fail-closed)
- Error path: `DenyAllSecretsAdapter` consistently returns `null` for all inputs
- Boundary: scope names with special characters handled without throwing
- Boundary: `allowedSecretScopes = []` → no lease regardless of env content

**Recommended test type:** Unit
**Suggested approach:** `vi.stubEnv` (Vitest built-in) to control env state without global mutation risk. `afterEach` restores. Assert on `SecretLease` shape or `null`. Do not mock the adapter constructor — test the full public `issueTaskSecrets` method.

---

## Implementation Roadmap

### Dependency graph

```
QUAL-003 (F107) ──────────────────────────────────► unblocks QUAL-002 workspace path extraction
QUAL-001 (F105) ──────────────────────────────────► QUAL-002 (F106)
QUAL-002 (F106) ──────────────────────────────────► QUAL-009 (F113), QUAL-011 (F115)
QUAL-004 (F108) ──────────────────────────────────► QUAL-005 (F109), QUAL-008 (F112)
QUAL-006 (F110), QUAL-007 (F111) ─────────────────► independent
QUAL-010 (F114) ──────────────────────────────────► independent
```

### Sprint 1 — Foundations

Work in parallel: one engineer on QUAL-001 + QUAL-003, one on QUAL-006 + QUAL-007 + QUAL-010.

| Card / Feature | Task |
|----------------|------|
| QUAL-003 / F107 | Inject `WorkspaceRuntimeConfig` — removes `process.env` from orchestration |
| QUAL-001 / F105 | Extract `PhaseRunContext` — reduces duplication, prerequisite for QUAL-002 split |
| QUAL-006 / F110 | Encapsulate `*WithExecutor` — small, self-contained |
| QUAL-007 / F111 | Split `InMemoryPlanningRepository` — small, self-contained |
| QUAL-010 / F114 | Guard heartbeat errors — small fix, high safety value |

### Sprint 2 — Module splits and coverage

QUAL-002 and QUAL-004 touch high-churn files. Stagger by 1–2 days or assign explicit merge ownership.

| Card / Feature | Task |
|----------------|------|
| QUAL-002 / F106 | Split `pipeline.ts` — depends on QUAL-001 |
| QUAL-004 / F108 | Split `integrations/src/index.ts` — independent |
| QUAL-005 / F109 | `RestGitHubAdapter` read tests — pair with QUAL-004 |
| QUAL-008 / F112 | Adapter failure-path tests — pair with QUAL-004 |

### Sprint 3 — Cleanup

| Card / Feature | Task |
|----------------|------|
| QUAL-009 / F113 | Replace `instanceof` chain — depends on QUAL-002 |
| QUAL-011 / F115 | Split `index.test.ts` — depends on QUAL-002; dedicated PR, no logic changes |

### Merge-conflict risk areas

- `packages/control-plane/src/pipeline.ts` — QUAL-001, QUAL-002, QUAL-003, QUAL-009, QUAL-010 all touch it. Complete QUAL-001 and QUAL-003 before opening the QUAL-002 split PR.
- `packages/integrations/src/index.ts` — QUAL-004 rewrites it. Land QUAL-004 before QUAL-005/QUAL-008.
- `packages/control-plane/src/index.test.ts` — QUAL-011 replaces it. No other cards should touch it while QUAL-011 is in progress.
