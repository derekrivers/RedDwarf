# Code Review — M11 (2026-03-27)

Full codebase review covering all 6 packages, scripts, and configuration.
18 grouped findings recorded as feature board items F64–F81.

---

## Code Smells

### F64 — Fix SQL injection vector and ReDoS vulnerability in evidence and integrations

**Category:** Code Smell (Security)
**Files Affected:**
- `packages/evidence/src/postgres-repository.ts` (line ~574)
- `packages/integrations/src/index.ts` (line ~562)

**Problem:**
1. `hasPlanningSpecForSource` interpolates `issueKey` directly into a SQL string via template literal (`task_manifests.source ->> '${issueKey}' = $3`). While values are parameterized, the column path is not — a crafted source object could inject SQL.
2. `redactSecretValues` builds a dynamic RegExp from user-controlled secret values. If a secret contains regex metacharacters (e.g. `.*`), this is a ReDoS vector.

**Suggested Fix:**
1. Whitelist expected issue keys (`issueNumber`, `issueId`) and reject anything else.
2. Replace dynamic regex with a simple `split(secret).join("***REDACTED***")` loop.

**Priority:** High

---

### F65 — Extract shared script configuration (connection string, workspace root, error formatting)

**Category:** Code Smell
**Files Affected:**
- 22 scripts under `scripts/` duplicating the PostgreSQL connection string fallback chain
- 5+ scripts duplicating workspace root resolution
- Inconsistent error formatting across scripts

**Problem:** The connection string `process.env.HOST_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://..."` is copy-pasted across 22 files. Workspace root resolution and error formatting are similarly duplicated. Changing the env var name or default requires editing every file.

**Suggested Fix:** Create `scripts/lib/config.mjs` exporting `getConnectionString()`, `resolveWorkspaceRoot()`, and `formatError()`. Update all scripts to import from the shared module.

**Priority:** High

---

### F66 — Split contracts/src/index.ts into focused modules

**Category:** Code Smell
**Files Affected:**
- `packages/contracts/src/index.ts` (772 lines)

**Problem:** Single file contains 40+ enum definitions, 30+ Zod schemas, 10+ type exports, and multiple interfaces. Violates SRP and makes navigation difficult.

**Suggested Fix:** Split into `enums.ts`, `schemas.ts`, `types.ts`, `interfaces.ts` (or by domain: `task.ts`, `memory.ts`, `approval.ts`, `workspace.ts`). Re-export from `index.ts` as barrel.

**Priority:** High

---

### F67 — Extract duplicate pipeline phase helpers (snapshot validation, approval lookup, phase init)

**Category:** Code Smell
**Files Affected:**
- `packages/control-plane/src/pipeline.ts` (lines ~1344, ~2038, ~3636 for validation; ~1356, ~2050 for approval; ~437, ~1399, ~2111, ~3719 for init)

**Problem:**
- Identical snapshot validation block (manifest + spec + policySnapshot null checks) repeated 3 times.
- Identical approved-request lookup + guard repeated 2 times.
- Nearly identical concurrency decision + tracked run + currentManifest initialization repeated 4 times.

**Suggested Fix:** Extract `validateTaskSnapshot(snapshot, taskId)`, `findApprovedRequest(snapshot, taskId, phase)`, and `initializePhaseRun(...)` helper functions.

**Priority:** High

---

### F68 — Decompose monolithic pipeline phase functions into orchestrated sub-steps

**Category:** Code Smell
**Files Affected:**
- `packages/control-plane/src/pipeline.ts`
  - `runPlanningPipeline` (~910 lines)
  - `runDeveloperPhase` (~690 lines)
  - `runValidationPhase` (~910 lines)
  - `runScmPhase` (~1080 lines)

**Problem:** Each phase function handles input validation, concurrency detection, agent invocation, evidence archival, error recovery, and database persistence in a single function body. Extremely difficult to test, review, or extend.

**Suggested Fix:** Extract each responsibility into focused functions (`runPlanningIntake`, `runPlanningEligibility`, `runPlanningSpecGeneration`, `runPlanningPolicyGate`, `runPlanningArchive`). The top-level phase function becomes a thin orchestrator.

**Priority:** High

---

### F69 — Deduplicate dedupeMemoryRecords and consolidate magic event-code constants

**Category:** Code Smell
**Files Affected:**
- `packages/evidence/src/repository.ts` (lines ~356–370)
- `packages/evidence/src/summarize.ts` (lines ~162–176, ~45–48, ~68, ~81)

**Problem:**
1. `dedupeMemoryRecords` is duplicated identically across `repository.ts` and `summarize.ts`.
2. Run-event codes (`PHASE_PASSED`, `PHASE_FAILED`, `PHASE_ESCALATED`, `PIPELINE_COMPLETED`, etc.) appear as magic strings scattered throughout `summarize.ts`.

**Suggested Fix:** Export `dedupeMemoryRecords` from `repository.ts` and import in `summarize.ts`. Extract event-code groups into named constants (e.g. `PHASE_TERMINAL_CODES`, `PIPELINE_TERMINAL_CODES`).

**Priority:** Medium

---

### F70 — Extract tool-policy mode and validation-schema magic values into named constants

**Category:** Code Smell
**Files Affected:**
- `packages/control-plane/src/workspace.ts` (lines ~854, ~872, ~890, ~899)
- `packages/contracts/src/index.ts` (lines ~188–190, ~341, ~423, ~530)
- `packages/execution-plane/src/index.ts` (lines ~434–454, ~649, ~655)

**Problem:** String literals like `"planning_only"`, `"validation_only"`, `"development_readonly"`, `"scm_only"` are used in multiple comparison sites without constants. Contracts schemas use unexplained numeric limits (`.min(5)`, `.min(20)`, `.max(100)`, `.length(5)`) with no documentation. Retry delays `attempt * 2000` and `maxAttempts = 3` are hardcoded.

**Suggested Fix:** Define `TOOL_POLICY_MODES` constant object, extract `VALIDATION_RULES` for schema bounds, and extract retry config into a named constant or config parameter.

**Priority:** Medium

---

### F71 — Fix silent exception swallowing in cleanup-evidence and polling scripts

**Category:** Code Smell
**Files Affected:**
- `scripts/cleanup-evidence.mjs` (lines ~149–155)
- `packages/control-plane/src/polling.ts` (unbounded decisions array)

**Problem:**
1. Empty `catch {}` blocks in evidence cleanup silently swallow all errors including permission failures.
2. Polling decisions array grows unbounded during a cycle — large repos with many issues could cause memory pressure.

**Suggested Fix:** Log suppressed errors at debug level. Cap polling batch size or stream decisions.

**Priority:** Low

---

## Optimisations

### F72 — Parallelize verify-all.mjs script execution

**Category:** Optimisation
**Files Affected:**
- `scripts/verify-all.mjs`

**Problem:** All 17+ verification scripts run sequentially via `execFileSync`. Total runtime is the sum of all individual scripts (potentially minutes in CI).

**Suggested Fix:** Replace sequential loop with concurrent execution using configurable concurrency (e.g. `Promise.all` with a pool of 4). Report pass/fail summary at end.

**Priority:** High

---

### F73 — Optimize PostgresPlanningRepository.getTaskSnapshot to reduce query count

**Category:** Optimisation
**Files Affected:**
- `packages/evidence/src/postgres-repository.ts` (lines ~788–822)
- `packages/evidence/src/repository.ts` (lines ~282–316)

**Problem:** `getTaskSnapshot` issues 9 separate database queries (manifest, spec, policy, phases, events, approvals, memory × 3 scopes) even with `Promise.all`. Each is a network round trip.

**Suggested Fix:** Create a single optimized SQL query using JOINs and array aggregation (`json_agg`) to fetch the full snapshot in 1–2 round trips. Keep in-memory implementation as-is.

**Priority:** Medium

---

### F74 — Reduce repeated taskManifestSchema.parse calls in pipeline.ts

**Category:** Optimisation
**Files Affected:**
- `packages/control-plane/src/pipeline.ts` (~25 call sites)

**Problem:** `taskManifestSchema.parse()` is called 25+ times throughout the pipeline. Each invocation re-validates the entire manifest object even when the input was just constructed or already validated.

**Suggested Fix:** Parse once at phase entry, then pass the validated object through. Use type assertions for intermediate mutations of already-validated objects instead of re-parsing.

**Priority:** Medium

---

### F75 — Stream file hashing in archiveEvidenceArtifact instead of buffering

**Category:** Optimisation
**Files Affected:**
- `packages/control-plane/src/workspace.ts` (lines ~805–814)

**Problem:** `archiveEvidenceArtifact` reads the entire file into memory to compute SHA256. Large artifacts (diffs, logs) could cause memory spikes.

**Suggested Fix:** Use `createReadStream` piped into `createHash("sha256")` for streaming hash computation.

**Priority:** Low

---

## SOLID Violations

### F76 — Extract AnthropicPlanningAgent retry logic and response parsing into separate concerns

**Category:** SOLID
**Files Affected:**
- `packages/execution-plane/src/index.ts` (lines ~400–468)

**Problem:** `AnthropicPlanningAgent` handles HTTP communication, retry/backoff logic, response parsing, and JSON extraction in a single class. Violates SRP. Retry logic is not reusable for future Anthropic-backed agents.

**Suggested Fix:** Extract `RetryHandler` (or a `withRetry(fn, config)` utility) and `parsePlanningResponse(text)` into separate functions. Agent class becomes a thin orchestrator.

**Priority:** Medium

---

### F77 — Segment GitHubAdapter interface into read and write contracts

**Category:** SOLID
**Files Affected:**
- `packages/integrations/src/index.ts` (lines ~117–132)

**Problem:** `GitHubAdapter` bundles 9 methods mixing reads (`fetchIssueCandidate`, `listIssueCandidates`, `readIssueStatus`), writes (`createIssue`, `createBranch`, `createPullRequest`), and mutations (`addLabels`, `removeLabels`, `commentOnIssue`). Fixture adapters throw `V1MutationDisabledError` for write methods, violating LSP.

**Suggested Fix:** Split into `GitHubIssueReader`, `GitHubIssueWriter`, and `GitHubScmWriter`. Consumers depend only on the interface they need.

**Priority:** Medium

---

### F78 — Replace hardcoded phase failure maps and approval rules with registry pattern

**Category:** SOLID
**Files Affected:**
- `packages/control-plane/src/pipeline.ts` (lines ~108–148)
- `packages/policy/src/index.ts` (lines ~100–132)

**Problem:**
1. `phaseFailureClassMap`, `phaseFailureCodeMap`, and `failureRecoveryPolicies` are closed Record objects — adding a phase requires editing each map.
2. `resolveApprovalMode` uses 6 if/else branches with hardcoded capability arrays.
Both violate OCP.

**Suggested Fix:** Define a `PhaseDefinition` registry that bundles failure class, code, recovery policy, and approval rules per phase. `resolveApprovalMode` becomes a table lookup. New phases only add an entry.

**Priority:** Medium

---

### F79 — Split PostgresPlanningRepository data mapping from persistence

**Category:** SOLID
**Files Affected:**
- `packages/evidence/src/postgres-repository.ts` (lines ~846–1034)

**Problem:** 10+ row-mapper functions are private module-level functions tightly coupled to the repository class. They cannot be tested independently or reused. Class handles both SQL execution and result mapping — SRP violation.

**Suggested Fix:** Extract mappers into an exported `RepositoryRowMapper` object or standalone functions in a `mappers.ts` file. Repository delegates to mapper for result transformation.

**Priority:** Medium

---

### F80 — Fix defaultLogger.child() returning same instance (LSP violation)

**Category:** SOLID
**Files Affected:**
- `packages/control-plane/src/logger.ts` (lines ~29–36)

**Problem:** `defaultLogger.child()` returns `defaultLogger` itself. Callers expecting a child logger with merged bindings get the same no-op instance. Violates LSP — substituting `defaultLogger` where a real structured logger is expected silently drops binding context.

**Suggested Fix:** Return a new no-op logger instance from `child()`, or accept the contract that child bindings are discarded and document it explicitly.

**Priority:** Low

---

### F81 — Enable no-floating-promises ESLint rule and fix violations

**Category:** SOLID
**Files Affected:**
- `eslint.config.js` (line ~30)
- All packages (potential unawaited promises)

**Problem:** `@typescript-eslint/no-floating-promises` is disabled. Unawaited promises (e.g. `repository.close()`) silently drop errors. This is especially dangerous in cleanup paths and the operator API server.

**Suggested Fix:** Enable the rule as `"error"`. Fix all flagged call sites by adding `await` or explicit `void` annotations where fire-and-forget is intentional.

**Priority:** Medium

---

## Summary

| Category       | Count | High | Medium | Low |
|----------------|-------|------|--------|-----|
| Code Smells    | 8     | 4    | 2      | 2   |
| Optimisations  | 4     | 1    | 2      | 1   |
| SOLID          | 6     | 0    | 5      | 1   |
| **Total**      | **18**| **5**| **9**  | **4**|

### Recommended order of attack

1. **F64** — Security fixes (SQL injection + ReDoS) — highest urgency
2. **F67** — Extract duplicate pipeline helpers — high duplication count, low risk
3. **F65** — Shared script configuration — 22-file duplication
4. **F68** — Decompose monolithic phase functions — foundation for future maintainability
5. **F66** — Split contracts index.ts — improves navigation across all packages
6. **F72** — Parallelize verify-all — immediate CI speedup
7. **F69–F81** — Remaining medium/low items in board order
