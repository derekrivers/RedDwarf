# Pipeline Hardening Audit - 2026-03-29

**Date:** 2026-03-29  
**Scope:** Pipeline lifecycle, pooling, process continuity, security surface, and observability  
**Related board items:** Features 90-99 in `FEATURE_BOARD.md`

---

## Purpose

This document is the durable handoff for the March 29, 2026 read-only hardening audit.

Read this before picking up features 90-99. The findings below are the reason the board was reprioritized ahead of feature 86 (OpenAI provider support) and feature 87 (GitHub user allowlist).

Priority is based on production blast radius:

1. duplicate ownership and conflicting execution
2. partial durable state corruption
3. policy and secret boundary failures
4. unauthenticated operator mutation surfaces
5. hidden stalls and weak runtime visibility

---

## Pipeline walkthrough

### Entry points

- Automatic intake starts in [start-stack.mjs](/c:/Dev/RedDwarf/scripts/start-stack.mjs#L361) by creating the GitHub issue polling daemon and calling `daemon.start()`.
- Manual progression starts in [operator-api.ts](/c:/Dev/RedDwarf/packages/control-plane/src/operator-api.ts#L342) through `POST /tasks/:taskId/dispatch`.
- The planning lifecycle begins in [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts#L489) inside `runPlanningPipeline(...)`.
- Post-approval execution begins in [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts#L5527) inside `dispatchReadyTask(...)`.

### End-to-end lifecycle

1. GitHub issue polling discovers an issue candidate and converts it into `PlanningTaskInput` in [index.ts](/c:/Dev/RedDwarf/packages/integrations/src/index.ts#L578).
2. `runPlanningPipeline(...)` parses input, derives risk and approval mode, creates a manifest, and persists planning state in [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts#L489).
3. Planning uses either the direct planner or Holly/OpenClaw planning path and persists a planning spec, policy snapshot, approval request, evidence records, and run events in [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts).
4. An operator resolves approval in [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts#L2821), which moves the manifest to `ready`.
5. The ready-task dispatcher in [polling.ts](/c:/Dev/RedDwarf/packages/control-plane/src/polling.ts#L415) loads one ready manifest and calls `dispatchReadyTask(...)`.
6. Developer, validation, and SCM phases run in sequence through [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts), materializing workspaces, invoking OpenClaw, running validation subprocesses, publishing git changes, and creating a PR.

### Main hand-off boundaries

- Network:
  - GitHub REST calls in [index.ts](/c:/Dev/RedDwarf/packages/integrations/src/index.ts#L879)
  - Anthropic planning calls in [index.ts](/c:/Dev/RedDwarf/packages/execution-plane/src/index.ts#L455)
  - OpenClaw dispatch and await flows in [live-workflow.ts](/c:/Dev/RedDwarf/packages/control-plane/src/live-workflow.ts)
- Database:
  - all manifest, approval, run, evidence, and memory persistence through [postgres-repository.ts](/c:/Dev/RedDwarf/packages/evidence/src/postgres-repository.ts)
- Filesystem:
  - workspace materialization in [workspace.ts](/c:/Dev/RedDwarf/packages/control-plane/src/workspace.ts#L529)
  - evidence archival in [workspace.ts](/c:/Dev/RedDwarf/packages/control-plane/src/workspace.ts#L788)
- Child processes:
  - git subprocesses in [live-workflow.ts](/c:/Dev/RedDwarf/packages/control-plane/src/live-workflow.ts#L356)
  - validation subprocesses in [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts#L3940)

### Key architectural observation

The pipeline is asynchronous in a reasonable way, but its durable state model is not atomic. Most phase transitions are multi-write sequences spread across manifest rows, approval rows, phase records, evidence records, and run events. Failures between those writes can leave the database in contradictory states that later code paths do not reconcile automatically.

---

## Resource pools and continuity model

### Pools found

- The only real shared resource pool is `pg.Pool` in [postgres-repository.ts](/c:/Dev/RedDwarf/packages/evidence/src/postgres-repository.ts#L49).
- It is created with `new pg.Pool({ connectionString, max: max ?? 10 })`.
- No acquisition timeout, idle timeout, statement timeout, or pool telemetry was found in the repository implementation.

### Acquisition and release

- The code mostly uses `pool.query(...)`, so explicit client release leaks are unlikely.
- No `pool.connect()` or manual checkout/release flow was found in the main repository path.

### Continuity mechanisms

- Poller and dispatcher loops run on intervals in [polling.ts](/c:/Dev/RedDwarf/packages/control-plane/src/polling.ts).
- Both loops now include cycle-level timeouts and backoff, but downstream phase work still contains longer waits and some unbounded subprocesses.
- Stale-run detection uses `lastHeartbeatAt` and a default `staleAfterMs` of 5 minutes in [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts#L499).

### Continuity mismatch

- OpenClaw architect and developer awaiters allow 10 minutes in [live-workflow.ts](/c:/Dev/RedDwarf/packages/control-plane/src/live-workflow.ts#L143) and [live-workflow.ts](/c:/Dev/RedDwarf/packages/control-plane/src/live-workflow.ts#L187).
- Validation subprocesses have no timeout in [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts#L3940).
- Git subprocesses have no timeout in [live-workflow.ts](/c:/Dev/RedDwarf/packages/control-plane/src/live-workflow.ts#L356).
- Developer heartbeats are updated at phase start, but not continuously during long waits in [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts#L1639).

---

## Findings by feature

### Feature 90 - Atomic run claiming for each pipeline phase

**Problem**  
Run ownership is decided with a read-then-write overlap check. Each phase creates an active `PipelineRun`, calls `detectOverlappingRuns(...)`, and only persists its own active run afterward.

**Primary references**
- Planning: [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts#L524), [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts#L584), [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts#L689)
- Development: [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts#L1511), [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts#L1553), [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts#L1588)
- Validation: [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts#L2126), [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts#L2169), [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts#L2204)
- Overlap helper: [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts#L3104)

**Failure mode**  
Two workers can both observe no active overlapping run and both continue into the same source issue lifecycle.

**Blast radius**  
Highest. Duplicate approvals, duplicate developer or validation execution, conflicting manifest updates, and multiple PR attempts are all possible.

**Implementation note**  
Do not patch this with more in-memory flags. Fix it in the repository layer with an atomic claim or lease primitive.

### Feature 91 - Transactional manifest, approval, phase, evidence, and run-event transitions

**Problem**  
Logical state transitions are persisted as independent SQL statements with no transaction boundary.

**Primary references**
- Planning intake persistence: [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts#L716)
- Approval resolution: [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts#L2902)
- Phase failure persistence: [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts#L5339)
- Repository pool construction: [postgres-repository.ts](/c:/Dev/RedDwarf/packages/evidence/src/postgres-repository.ts#L49)

**Failure mode**  
A process crash or transient repository failure can commit only half of a transition, leaving approval state, manifest state, evidence, and run events disagreeing.

**Blast radius**  
Highest. Durable state corruption causes later operators and automation to make decisions on contradictory data.

**Implementation note**  
This should likely introduce an explicit transaction API in the evidence layer rather than sprinkling raw `BEGIN` and `COMMIT` calls throughout `pipeline.ts`.

### Feature 92 - Enforce allowed-path boundaries before commit and push

**Problem**  
`allowedPaths` is computed and shown to the agent, but there is no runtime enforcement before commit or push.

**Primary references**
- Policy generation: [index.ts](/c:/Dev/RedDwarf/packages/policy/src/index.ts#L157)
- Prompt guidance only: [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts#L3609)
- SCM publisher stages everything: [live-workflow.ts](/c:/Dev/RedDwarf/packages/control-plane/src/live-workflow.ts#L252)

**Failure mode**  
Out-of-scope files can be committed and pushed even when policy intended a narrower file boundary.

**Blast radius**  
Highest from a policy-enforcement perspective. This is a direct integrity failure, not just a quality issue.

**Implementation note**  
Enforce against the actual git change set before `git add --all`, and fail closed if any changed path escapes the approved scope.

### Feature 93 - Remove tokenized git remotes and redact secret-bearing failures

**Problem**  
GitHub tokens are embedded in remote URLs, and raw subprocess failures are later serialized and sometimes returned.

**Primary references**
- Tokenized remote URL: [live-workflow.ts](/c:/Dev/RedDwarf/packages/control-plane/src/live-workflow.ts#L397)
- Command failure includes argv and stderr: [live-workflow.ts](/c:/Dev/RedDwarf/packages/control-plane/src/live-workflow.ts#L382)
- Generic error serialization: [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts#L5192)
- Dispatch failure response surface: [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts#L5638)

**Failure mode**  
A failed clone or push can leak the GitHub token into persisted evidence, logs, API responses, or process-inspection surfaces.

**Blast radius**  
Highest. This is a direct credential exposure risk.

**Implementation note**  
Fix both the auth transport and the error-redaction path. Redaction without removing tokenized remotes is not enough.

### Feature 94 - Authenticate the operator API and constrain manual dispatch roots

**Problem**  
The operator API is localhost-only by default but has no authentication, no request size limit, and accepts caller-selected roots for manual dispatch.

**Primary references**
- Host binding and error path: [operator-api.ts](/c:/Dev/RedDwarf/packages/control-plane/src/operator-api.ts#L73)
- Unbounded JSON body: [operator-api.ts](/c:/Dev/RedDwarf/packages/control-plane/src/operator-api.ts#L137)
- Approval mutation route: [operator-api.ts](/c:/Dev/RedDwarf/packages/control-plane/src/operator-api.ts#L252)
- Manual dispatch with caller roots: [operator-api.ts](/c:/Dev/RedDwarf/packages/control-plane/src/operator-api.ts#L342)
- Workspace and evidence root usage: [workspace.ts](/c:/Dev/RedDwarf/packages/control-plane/src/workspace.ts#L529), [workspace.ts](/c:/Dev/RedDwarf/packages/control-plane/src/workspace.ts#L788)

**Failure mode**  
Any local process with loopback access can approve work, dispatch execution, inspect internal state, and direct the control plane to write to arbitrary roots accessible to the process.

**Blast radius**  
High. On a shared host or compromised desktop, this is effectively control-plane takeover.

**Implementation note**  
Auth and root validation should ship together. Do not harden only one side of this surface.

### Feature 95 - Align heartbeats, stale windows, and subprocess timeouts

**Problem**  
The current continuity model has conflicting timeout assumptions, and some important subprocess paths are unbounded.

**Primary references**
- Default stale timeout: [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts#L499)
- Startup stale sweep: [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts#L3174)
- OpenClaw architect and developer wait timeouts: [live-workflow.ts](/c:/Dev/RedDwarf/packages/control-plane/src/live-workflow.ts#L143), [live-workflow.ts](/c:/Dev/RedDwarf/packages/control-plane/src/live-workflow.ts#L187)
- Validation subprocess execution: [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts#L3940)
- Git subprocess execution: [live-workflow.ts](/c:/Dev/RedDwarf/packages/control-plane/src/live-workflow.ts#L356)

**Failure mode**  
Healthy work can be marked stale, or unhealthy work can hang forever. Both paths disrupt the queue and overlap logic.

**Blast radius**  
High. This is a correctness and availability problem rather than a pure observability issue.

**Implementation note**  
Heartbeat cadence, stale windows, and subprocess timeouts need one coherent model. Do not tune only one of the three.

### Feature 96 - Scrub or destroy secret-bearing workspaces on phase exit

**Problem**  
Scoped secrets are written to plaintext disk and normal runtime phase flows do not destroy the workspace afterward.

**Primary references**
- Secret file write: [workspace.ts](/c:/Dev/RedDwarf/packages/control-plane/src/workspace.ts#L580)
- Workspace materialization call sites: [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts#L1663), [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts#L2281), [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts#L4270)
- Teardown helper exists but is not used in runtime phase flow: [workspace.ts](/c:/Dev/RedDwarf/packages/control-plane/src/workspace.ts#L704)

**Failure mode**  
Secrets remain on disk longer than the phase that required them and may survive until later cleanup or host inspection.

**Blast radius**  
High. Exposure is local to the host, but the contents are credentials.

**Implementation note**  
Consider separating `scrub credentials immediately` from `destroy workspace later` so evidence and SCM flow do not regress.

### Feature 97 - Fence untrusted issue content inside planner and agent prompts

**Problem**  
GitHub issue text becomes planner and OpenClaw prompt content with minimal isolation from trusted instructions.

**Primary references**
- Issue-derived planning input: [index.ts](/c:/Dev/RedDwarf/packages/integrations/src/index.ts#L578)
- Planner user message: [index.ts](/c:/Dev/RedDwarf/packages/execution-plane/src/index.ts#L655)
- Developer prompt construction: [pipeline.ts](/c:/Dev/RedDwarf/packages/control-plane/src/pipeline.ts#L3588)

**Failure mode**  
Issue authors can shape autonomous planning and code-writing behavior by embedding instruction-like content in the issue body.

**Blast radius**  
High. This is a security boundary around autonomous behavior. Live exploitability depends on model behavior and should be tested, but the surface is real.

**Implementation note**  
The right fix is prompt-boundary design and tests with adversarial issue bodies, not simplistic character stripping.

### Feature 98 - Harden the Postgres pool with timeouts, sizing, and telemetry

**Problem**  
The only shared resource pool is minimally configured and largely invisible operationally.

**Primary references**
- Pool creation: [postgres-repository.ts](/c:/Dev/RedDwarf/packages/evidence/src/postgres-repository.ts#L49)
- Stack bootstrap creates the repository without surfacing pool policy: [start-stack.mjs](/c:/Dev/RedDwarf/scripts/start-stack.mjs)

**Failure mode**  
DB stalls or saturation can cause the entire control plane to queue or wedge without clear, bounded failure behavior.

**Blast radius**  
Medium to high. This affects all persistence paths.

**Implementation note**  
This is lower priority than the correctness and security items above, but it should land before any scale-up effort.

### Feature 99 - Wire structured runtime logging and degraded-startup health across poller and dispatcher

**Problem**  
The default logger is noop and the live stack does not pass a real logger into core control-plane services.

**Primary references**
- Noop default logger: [logger.ts](/c:/Dev/RedDwarf/packages/control-plane/src/logger.ts#L29)
- Dispatcher bootstrap without logger: [start-stack.mjs](/c:/Dev/RedDwarf/scripts/start-stack.mjs#L325)
- Poller bootstrap without logger: [start-stack.mjs](/c:/Dev/RedDwarf/scripts/start-stack.mjs#L364)
- Poller start can reject startup on first-cycle failure: [polling.ts](/c:/Dev/RedDwarf/packages/control-plane/src/polling.ts#L334)

**Failure mode**  
Operators lack live visibility into retries, backoff, dispatch failures, and degraded startup behavior.

**Blast radius**  
Medium to high operationally. This slows incident response and makes the other fixes harder to trust in production.

**Implementation note**  
Pair this with the startup-resilience work so degraded service is both survivable and visible.

---

## Cross-feature sequencing

### Must land first

- Feature 90 before any throughput or parallel-dispatch expansion
- Feature 91 before any complex retry or cleanup semantics are deepened
- Feature 92 and feature 93 before any broader autonomous code-writing expansion

### Can run in parallel with careful file ownership

- Feature 93 and feature 94
- Feature 97 and feature 99
- Feature 98 alongside almost any other hardening item

### Likely to cause rework if done too early

- Feature 98 before feature 99: telemetry without a real runtime logger gives weak operational value
- Feature 95 before feature 90: timeout tuning without atomic ownership still leaves duplicate-start races
- Feature 96 before feature 91: cleanup semantics are easier to reason about after transactional outcome boundaries exist

---

## Suggested implementation order

1. Feature 90
2. Feature 91
3. Feature 92
4. Feature 93
5. Feature 94
6. Feature 95
7. Feature 96
8. Feature 97
9. Feature 99
10. Feature 98

---

## Verification guidance for the next agent

- Prefer narrow tests first around the touched phase or repository path.
- After repository schema or persistence changes, run `node scripts/apply-sql-migrations.mjs` before Postgres-backed verification.
- For Vitest or validation-runner commands that hit the documented Windows sandbox `spawn EPERM`, use the established workaround in [TROUBLESHOOTING.md](/c:/Dev/RedDwarf/docs/agent/TROUBLESHOOTING.md).
- Reuse the board order. Do not jump back to features 86 or 87 unless a human reprioritizes the queue.
