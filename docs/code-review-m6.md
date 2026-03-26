# Code Review — M6 Refactor Candidates

**Date:** 2026-03-26
**Scope:** Full codebase audit across all 6 packages
**Codebase totals:** ~14,800 source lines. Largest files: `packages/control-plane/src/index.ts` (7,029 lines), `packages/evidence/src/index.ts` (1,519 lines).

---

## Code Smells

---

**Title:** Duplicated concurrency detection block repeated across all four phase functions
**Category:** Code Smell
**Feature Board:** Item 26
**Files Affected:**
- `packages/control-plane/src/index.ts` — lines ~1633, ~2603, and two further copies inside `runValidationPhase` / `runScmPhase`

**Problem:** The stale-run detection and concurrency-gate logic — roughly 80 lines that query overlapping runs, mark stale ones, decide to block, persist the block evidence record, emit two run events, and return early — is copy-pasted verbatim four times across `runPlanningPipeline`, `runDeveloperPhase`, `runValidationPhase`, and `runScmPhase`. The `nextEventId` and `persistTrackedRun` closures are also independently re-declared inside each function.

**Suggested Fix:** Extract a `runConcurrencyGate(input)` helper that accepts the repository, concurrencyKey, runId, runStartedAt, staleAfterMs, strategy, and the two closures. Each phase function calls the helper and returns early if the result action is `"block"`.

**Priority:** High

---

**Title:** control-plane/src/index.ts is a 7,029-line god file
**Category:** Code Smell
**Feature Board:** Item 27
**Files Affected:**
- `packages/control-plane/src/index.ts`

**Problem:** A single module handles planning pipeline orchestration, developer/validation/SCM phase orchestration, workspace provisioning and destruction, evidence archival, the HTTP operator API server, knowledge ingestion, failure recovery/escalation, lifecycle transition assertions, markdown rendering for four different artifact types, and four deterministic agent class implementations. It cannot be read or maintained incrementally.

**Suggested Fix:** Split into at least five focused modules:
- `pipeline.ts` — `runPlanningPipeline` + phase functions
- `workspace.ts` — materialize/provision/destroy
- `evidence-archival.ts` — `archiveEvidenceArtifact` + helpers
- `operator-api.ts` — `createOperatorApiServer`
- `knowledge.ts` — `ingestKnowledgeSources`

Keep the existing `index.ts` as a barrel that re-exports all public symbols.

**Priority:** High

---

**Title:** evidence/src/index.ts conflates repository interface, two implementations, factories, computation, and row-mapping
**Category:** Code Smell
**Feature Board:** Item 28
**Files Affected:**
- `packages/evidence/src/index.ts`

**Problem:** A 1,519-line file contains the `PlanningRepository` interface, `InMemoryPlanningRepository`, the full `PostgresPlanningRepository` with raw SQL for nine tables, eight `mapXxxRow` functions, five factory functions (`createEvidenceRecord`, `createRunEvent`, etc.), `summarizeRunEvents`, `buildMemoryContextForRepository`, and three comparison helpers. Adding a new query or changing a row mapper means scrolling through unrelated code.

**Suggested Fix:** Split into:
- `repository.ts` — interface + InMemory impl
- `postgres-repository.ts` — `PostgresPlanningRepository` + row mappers
- `factories.ts` — `create*` functions
- `summarize.ts` — `summarizeRunEvents`, `buildMemoryContextForRepository`

**Priority:** High

---

**Title:** Phase capability constants are defined independently in policy and control-plane
**Category:** Code Smell
**Feature Board:** Item 29
**Files Affected:**
- `packages/policy/src/index.ts` — lines 22–32 (`planningCapabilities`, `developmentCapabilities`, `validationCapabilities`, `scmCapabilities`)
- `packages/control-plane/src/index.ts` — lines 572–588 (`planningWorkspaceCapabilities`, `developmentWorkspaceCapabilities`, `validationWorkspaceCapabilities`, `scmWorkspaceCapabilities`)

**Problem:** Both packages define the same four sets of capabilities for planning, development, validation, and SCM phases under different variable names. Adding a new phase capability requires two edits in separate files with no compiler warning if they fall out of sync.

**Suggested Fix:** Export the four capability sets from `@reddwarf/contracts` (or `@reddwarf/policy`), and import them in both packages.

**Priority:** High

---

**Title:** Disabled phases list duplicated between policy and execution-plane
**Category:** Code Smell
**Feature Board:** Item 36
**Files Affected:**
- `packages/policy/src/index.ts` — line 21: `const disabledPhases: TaskPhase[] = ["review"]`
- `packages/execution-plane/src/index.ts` — line 55: `const disabledPhases = new Set<TaskPhase>(["review"])`

**Problem:** Two separate declarations of the same list with no shared source of truth. Enabling or adding a phase requires edits in both packages, with no type-level guarantee they stay aligned.

**Suggested Fix:** Export a single `v1DisabledPhases` constant from `@reddwarf/contracts` and import it in both packages.

**Priority:** Medium

---

**Title:** isCapability guard manually duplicates the contracts capabilities array
**Category:** Code Smell
**Feature Board:** Item 35
**Files Affected:**
- `packages/integrations/src/index.ts` — lines ~774–786

**Problem:** The `isCapability` function lists all nine capability strings inline as a literal array rather than importing the `capabilities` tuple from `@reddwarf/contracts`. A new capability added to contracts will silently not be recognized by the integration layer's issue-body parser.

**Suggested Fix:** Replace the string literal array with `(capabilities as readonly string[]).includes(value)` using the imported `capabilities` tuple, and assert the result type.

**Priority:** Medium

---

**Title:** SecretLeaseRequest uses inline string literal unions instead of imported contract types
**Category:** Code Smell
**Feature Board:** Item 34
**Files Affected:**
- `packages/integrations/src/index.ts` — lines 152–153

**Problem:** `SecretLeaseRequest.riskClass` is typed `"low" | "medium" | "high"` and `approvalMode` as a four-string literal union, rather than importing `RiskClass` and `ApprovalMode` from `@reddwarf/contracts`. These shadow the canonical types and will silently drift if the contract enums change.

**Suggested Fix:** Import and use `RiskClass` and `ApprovalMode` from `@reddwarf/contracts`.

**Priority:** Medium

---

**Title:** Archive phase measures zero duration because both clock calls are consecutive
**Category:** Code Smell
**Feature Board:** Item 37
**Files Affected:**
- `packages/control-plane/src/index.ts` — lines ~2255–2257 inside `runPlanningPipeline`

**Problem:**
```ts
const archiveStartedAt = clock();
const archiveCompletedAt = clock();
```
Called back-to-back with no work between them. `getDurationMs(archiveStartedAt, archiveCompletedAt)` always reports 0 ms, making archive durations meaningless in run summaries.

**Suggested Fix:** Move `archiveStartedAt` to before the archive persistence calls, and `archiveCompletedAt` to after them.

**Priority:** Low

---

## Optimisations

---

**Title:** InMemoryPlanningRepository.getTaskSnapshot issues 9 serial awaits instead of using Promise.all
**Category:** Optimisation
**Feature Board:** Item 30
**Files Affected:**
- `packages/evidence/src/index.ts` — lines ~234–250

**Problem:** The in-memory `getTaskSnapshot` method awaits each of nine sub-queries sequentially: `await this.getManifest`, then `await this.getPlanningSpec`, and so on. The Postgres implementation correctly uses `Promise.all`. In test runs this adds unnecessary serial microtask overhead and risks future divergence if any sub-query becomes genuinely async.

**Suggested Fix:** Wrap all nine calls in `Promise.all([...])` matching the Postgres implementation.

**Priority:** High

---

**Title:** Workspace materialization path re-validates the same Zod schema up to four times
**Category:** Optimisation
**Feature Board:** Item 31
**Files Affected:**
- `packages/control-plane/src/index.ts` — lines ~1019–1108 (`materializeManagedWorkspace` and callees: `materializeWorkspaceContext`, `createWorkspaceContextArtifacts`, `createWorkspaceDescriptor`)

**Problem:** `materializeManagedWorkspace` parses `workspaceContextBundleSchema` twice before calling `materializeWorkspaceContext`, which parses it a third time, which calls `createWorkspaceContextArtifacts` which parses it a fourth time. Each parse is a full deep-validation pass over the same data object that was already typed by the caller.

**Suggested Fix:** Parse once at the entry-point of `materializeManagedWorkspace` and pass the already-validated value to all internal helpers. Remove the defensive re-parse calls inside `createWorkspaceContextArtifacts`, `createRuntimeInstructionLayer`, and `createWorkspaceDescriptor` since they already receive typed inputs.

**Priority:** Medium

---

**Title:** buildMemoryContextForRepository makes unnecessary duplicate external-memory queries
**Category:** Optimisation
**Feature Board:** Item 38 (grouped)
**Files Affected:**
- `packages/evidence/src/index.ts` — lines ~1244–1257

**Problem:** Two parallel queries are issued for external memory — one filtered by `repo` and one by `organizationId` — and the results are concatenated then deduped. When the same records match both filters (common when `organizationId` is derived from `repo`), both queries return the same rows and deduplication discards the duplicates. This doubles DB I/O for the common case.

**Suggested Fix:** Use a single SQL query with an `OR` condition (`repo = $1 OR organization_id = $2`) for the Postgres path, and a single combined filter for the in-memory path.

**Priority:** Medium

---

**Title:** InMemoryPlanningRepository.listMemoryRecords allocates 6 intermediate arrays via chained filters; redactSecretValues uses split/join
**Category:** Optimisation
**Feature Board:** Item 38
**Files Affected:**
- `packages/evidence/src/index.ts` — lines ~168–192
- `packages/integrations/src/index.ts` — lines ~554–562

**Problem (filter chain):** Seven `.filter()` calls are chained on the `memoryRecords` array, each creating a new intermediate array copy before the next predicate is applied. For large in-memory stores this unnecessarily allocates memory.

**Problem (redact):** `redacted.split(secretValue).join("***REDACTED***")` allocates an intermediate array for every secret value in the lease. `String.prototype.replaceAll()` is available in Node ≥ 15 and more idiomatic.

**Suggested Fix:**
- Combine all predicates into a single `.filter()` call with a composed predicate.
- Replace the split/join with `redacted = redacted.replaceAll(secretValue, "***REDACTED***")`.

**Priority:** Low

---

## SOLID Violations

---

**Title:** Deterministic agent classes belong in execution-plane, not control-plane
**Category:** SOLID — Single Responsibility
**Feature Board:** Item 32
**Files Affected:**
- `packages/control-plane/src/index.ts` — lines ~1420–1536 (`DeterministicPlanningAgent`, `DeterministicDeveloperAgent`, `DeterministicValidationAgent`, `DeterministicScmAgent`)

**Problem:** The four `Deterministic*Agent` classes implement the agent interfaces defined in control-plane but are bundled inside the same module as the pipeline orchestration code that instantiates them. The `execution-plane` package exists precisely to hold agent definitions. This is a single-responsibility violation and a tight-coupling problem between agent behaviour and pipeline coordination.

**Suggested Fix:** Move all four `Deterministic*Agent` classes into `packages/execution-plane/src/index.ts`, which already exports `agentDefinitions` and phase-executable checks.

**Priority:** High

---

**Title:** capabilitiesAllowedForPhase and resolveApprovalMode use open-coded if/else phase chains — OCP
**Category:** SOLID — Open/Closed
**Feature Board:** Item 33
**Files Affected:**
- `packages/policy/src/index.ts` — lines ~134–163 (`capabilitiesAllowedForPhase`) and ~96–132 (`resolveApprovalMode`)

**Problem:** Both functions use chains of `if (phase === "planning") { ... } if (phase === "development") { ... }` etc. Adding a new executable phase requires modifying both functions. The fallthrough `return true` in `capabilitiesAllowedForPhase` also means any unmapped phase silently allows all capabilities.

**Suggested Fix:** Replace with a `phaseCapabilityMap: Partial<Record<TaskPhase, Capability[]>>` lookup table. Return `phaseCapabilityMap[phase]?.every(cap => allowed.includes(cap)) ?? true` for the lookup. Similarly, replace the auto-approval phase list in `resolveApprovalMode` with a named constant set.

**Priority:** Medium

---

**Title:** PlanningRepository interface conflates read and write contracts — ISP
**Category:** SOLID — Interface Segregation
**Feature Board:** Item 39
**Files Affected:**
- `packages/evidence/src/index.ts` — lines ~32–50

**Problem:** The `PlanningRepository` interface mixes write methods (`saveManifest`, `updateManifest`, `savePhaseRecord`, etc.) with read methods (`getManifest`, `listApprovalRequests`, `getTaskSnapshot`). The operator API only needs reads; the pipeline phases only write. Any component depending on the full interface for either purpose carries unnecessary surface area.

**Suggested Fix:** Split into `PlanningCommandRepository` (write methods) and `PlanningQueryRepository` (read/list methods). The operator API accepts `PlanningQueryRepository`; pipeline functions accept both separately where needed.

**Priority:** Low

---

**Title:** InMemoryPlanningRepository exposes public methods not declared on PlanningRepository — LSP / ISP
**Category:** SOLID — Liskov / Interface Segregation
**Feature Board:** Item 39 (grouped)
**Files Affected:**
- `packages/evidence/src/index.ts` — lines ~135–270

**Problem:** `InMemoryPlanningRepository` exposes `getPlanningSpec`, `getPolicySnapshot`, `getPipelineRun`, `listPhaseRecords`, `listEvidenceRecords`, `listRunEvents`, `getRunSummary`, and `getMemoryContext` as public methods — none of which appear on the `PlanningRepository` interface. Code that imports the concrete class type gains hidden capabilities invisible to the interface, making the abstraction leaky. Tests and scripts that type-bind to `InMemoryPlanningRepository` rather than `PlanningRepository` will break if the implementation is swapped.

**Suggested Fix:** Add the missing read methods to the interface (or a `PlanningQueryRepository` sub-interface), ensuring the contract is complete and substitutable.

**Priority:** Low

---

**Title:** PostgresPlanningRepository constructs pg.Pool internally — DIP
**Category:** SOLID — Dependency Inversion
**Feature Board:** Item 40
**Files Affected:**
- `packages/evidence/src/index.ts` — lines ~276–281

**Problem:** The constructor `new pg.Pool({ connectionString, max })` hard-wires the class to the pg pool implementation. This prevents injecting a mock pool in tests, forces all pool configuration to happen inside the constructor, and couples the repository to a specific Node.js driver version.

**Suggested Fix:** Accept a `pg.Pool` (or a minimal `QueryExecutor` abstraction) as a constructor argument instead of a connection string. Move pool creation to a factory function or the application entry point.

**Priority:** Low

---

## Summary

| Category       | Items |
|----------------|-------|
| Code Smells    | 8     |
| Optimisations  | 5     |
| SOLID          | 5     |
| **Total**      | **18**|

### Recommended Order of Attack

| Order | Board Items | Rationale |
|-------|-------------|-----------|
| 1st   | 26–29       | High-impact code smell fixes. Split the god files and consolidate duplicated constants first — all later work is easier once the modules are navigable. |
| 2nd   | 30–32       | Fix the serial-await correctness risk in the in-memory repo, eliminate redundant Zod parsing, and move deterministic agents to execution-plane. |
| 3rd   | 33–35       | Replace open-coded phase chains with maps; fix the two type-drift issues in integrations. |
| 4th   | 36–38       | Fix archive duration measurement; consolidate disabled-phases constant; optimise filter chain and string replace. |
| 5th   | 39–40       | Interface segregation and dependency injection for the repository layer — good hygiene, lowest risk. |
