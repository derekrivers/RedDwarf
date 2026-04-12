# Chaos Engineering Audit & Resilience Plan

Audit date: 2026-04-12

This document records the findings of a comprehensive resilience audit of the RedDwarf codebase, maps failure scenarios to current handling, and proposes a robustness feature board.

---

## 1. System Topology Summary

RedDwarf is a multi-process, multi-container system:

| Component | Runtime | Role |
|-----------|---------|------|
| Operator API | Host Node.js (`:8080`) | HTTP API, approval queue, config, evidence |
| Polling Daemon | Host Node.js (in-process) | GitHub issue intake on timer |
| Ready-Task Dispatcher | Host Node.js (in-process) | Phase-based pipeline execution |
| Operator Dashboard | Host Vite dev server (`:5173`) | SPA for operators |
| Postgres | Docker container (`:55532`) | Durable state, evidence, config |
| OpenClaw Gateway | Docker container (`:3578`) | Agent runtime, Discord, MCP, webhooks |
| OpenClaw Agents | Inside OpenClaw container | Holly, Lister, Kryten, Rimmer sessions |
| GitHub API | External SaaS | Issue intake, branch/PR creation |
| OpenAI / Anthropic API | External SaaS | LLM inference for agents |

Entrypoint: `scripts/start-stack.mjs` boots all host-side components sequentially (Postgres wait, migrations, stale sweep, workspace cleanup, API, polling daemon, dispatcher, dashboard).

---

## 2. Existing Resilience Mechanisms

### 2.1 Graceful Shutdown

`scripts/start-stack.mjs:686-743` registers `SIGINT`/`SIGTERM` handlers. Shutdown order:

1. Polling daemon `.stop()`
2. Dispatcher `.stop()`
3. Operator API `.stop()`
4. Dashboard subprocess `SIGTERM`
5. DB pool `.close()`
6. `process.exit()`

**Assessment:** Present and ordered correctly. No timeout on any step -- a hung daemon/dispatcher `.stop()` blocks shutdown indefinitely. Dashboard SIGTERM has no kill escalation.

### 2.2 Database Transaction Safety

`packages/evidence/src/postgres-repository.ts` uses explicit `BEGIN`/`COMMIT`/`ROLLBACK` for multi-row mutations. Advisory locks (`pg_advisory_xact_lock`) prevent concurrent pipeline-run claims. Project approval (`packages/control-plane/src/pipeline/project-approval.ts`) wraps multi-table ticket/project mutations in a single transaction.

**Assessment:** Strong. DB-level atomicity is comprehensive.

### 2.3 Connection Pool Management

`packages/evidence/src/postgres-repository.ts:93-100` configures:
- `max: 10` connections (configurable via `REDDWARF_DB_POOL_MAX`)
- `connectionTimeoutMillis: 5_000`
- `idleTimeoutMillis: 30_000`
- `queryTimeoutMillis: 15_000`
- `statementTimeoutMillis: 15_000`
- `maxLifetimeSeconds: 300`

Pool error events are tracked (error count, last error message). Health endpoint exposes pool saturation.

**Assessment:** Excellent configuration and observability.

### 2.4 HTTP Request Timeouts

- GitHub adapter: `AbortSignal.timeout(this.requestTimeoutMs)` on all fetch calls (`packages/integrations/src/github.ts`)
- OpenClaw dispatch: 15s timeout on HTTP and ACPX dispatch (`packages/integrations/src/openclaw.ts`)
- Planning agent: `AbortSignal.timeout()` on Anthropic/OpenAI calls (`packages/execution-plane/src/index.ts`)
- Git commands: configurable timeout with SIGTERM -> SIGKILL escalation (`packages/control-plane/src/live-workflow.ts:1343-1429`)
- DB queries: `queryTimeoutMillis` and `statementTimeoutMillis` at pool level

**Assessment:** Comprehensive. All external calls have timeouts.

### 2.5 Retry Logic

- `fetchWithRetry()` in `packages/execution-plane/src/index.ts:736-759`: retries on 429/529/5xx with linear backoff
- OpenClaw HTTP dispatch: 3 retries with linear backoff on 429/529 (`packages/integrations/src/openclaw.ts:181-249`)
- ACPX dispatch: same retry pattern, plus 404 fallback to HTTP dispatch
- GitHub adapter: idempotent create patterns -- checks for existing issue/branch/PR before creating, re-checks on failure
- Pipeline phases: configurable retry budgets per phase (`REDDWARF_MAX_RETRIES_*`)

**Assessment:** Good coverage. Backoff is linear rather than exponential (less aggressive, but functional). No jitter on retries.

### 2.6 Idempotency

- Postgres: extensive `ON CONFLICT ... DO UPDATE` upsert patterns throughout `postgres-repository.ts`
- GitHub: `findExistingIssueForDraft()`, `findExistingBranch()`, `findExistingPullRequest()` before mutations
- Polling: deduplication by GitHub source key prevents re-planning already-known issues
- Memory deduplication: SHA256 content hashing for dreaming memory (`packages/control-plane/src/openclaw-session.ts:621-632`)
- Merge workflow: idempotent -- re-running on already-merged ticket logs warning without mutating state

**Assessment:** Strong. Core mutation paths are idempotent.

### 2.7 Stale State Recovery

- `packages/control-plane/src/pipeline/sweep.ts`: marks active runs as stale past deadline, reconciles orphaned manifests (ready with no approval, blocked with no escalation)
- Startup sweep: `start-stack.mjs` runs stale-run sweep and workspace cleanup (>24h) on every boot
- `POST /maintenance/reconcile-orphaned-state` operator endpoint for on-demand recovery

**Assessment:** Present but manual. No automated periodic sweep during runtime -- relies on startup or operator action.

### 2.8 Rate Limiting

- Operator API: sliding-window rate limiter (120 req/60s per IP) at `packages/control-plane/src/operator-api.ts:118-146`

**Assessment:** Adequate for operator API. No rate limiting on outbound calls to GitHub/OpenClaw.

### 2.9 Health Checks

- `GET /health` (unauthenticated): returns DB pool health, polling cursor health, repo status, dispatcher status
- Docker Compose: `pg_isready` for Postgres (5s interval, 10 retries), `curl /health` for OpenClaw (10s interval, 6 retries)
- Polling daemon: exponential backoff on consecutive failures, health reported in `/health` response

**Assessment:** Present but liveness-only. No readiness probe. Health endpoint does not verify OpenClaw or GitHub reachability.

---

## 3. Identified Failure Scenarios

### 3.1 Process Crash & Restart

| Scenario | Current Handling | Risk |
|----------|------------------|------|
| Host process killed mid-pipeline | Startup sweep marks stale runs; orphan reconciliation available | **Medium** -- in-flight OpenClaw sessions become orphans; no automatic cancellation of remote sessions |
| Host process killed mid-DB-write | Postgres transactions roll back automatically | **Low** -- transactional writes are safe |
| Host process killed mid-GitHub-write | PR/branch may be created but not recorded in Postgres | **High** -- orphaned GitHub resources with no RedDwarf audit trail |
| OpenClaw container restart mid-session | Agent session lost; RedDwarf awaiter times out | **Medium** -- timeout fires, run marked failed, retryable |
| Postgres container restart | All in-flight queries fail; pool reconnects on next attempt | **Medium** -- pool reconnection is automatic but in-flight pipeline steps fail without retry |

### 3.2 Dependency Outages

| Scenario | Current Handling | Risk |
|----------|------------------|------|
| Postgres down for >5s | Connection attempts timeout at 5s; all API/polling/dispatch fails | **Critical** -- entire control plane halts, no queuing or degraded mode |
| OpenClaw down | Dispatch timeout at 15s, 3 retries; task marked failed | **Medium** -- retryable with budget |
| GitHub API down | No retry on GitHub fetch errors; polling cycle fails | **High** -- single transient error blocks entire polling cycle |
| GitHub API rate limited (429) | No 429 detection on GitHub adapter | **High** -- polling hammers rate-limited endpoint until cycle timeout |
| LLM provider down (OpenAI/Anthropic) | Agent session fails; awaiter detects terminal stop reason | **Medium** -- failover profiles exist (Feature 153) but disabled by default |
| Docker daemon down | Both Postgres and OpenClaw unavailable | **Critical** -- total system failure, no mitigation possible |

### 3.3 Resource Exhaustion

| Scenario | Current Handling | Risk |
|----------|------------------|------|
| Postgres connection pool exhausted | Monitored via health endpoint; waiting queries block | **High** -- no shedding; requests queue indefinitely until `connectionTimeoutMillis` |
| Disk full on evidence root | No ENOSPC handling; partial JSON files written | **High** -- corrupted evidence records, downstream queries fail |
| Disk full on workspace root | Workspace materialization fails; pipeline step fails | **Medium** -- retryable once disk freed |
| Memory pressure on host | No memory limits on Node.js process | **Medium** -- OOM kill possible during large evidence processing |
| Too many concurrent agent sessions | OpenClaw gateway manages internally | **Low** -- RedDwarf dispatch is serialized |

### 3.4 Network Degradation

| Scenario | Current Handling | Risk |
|----------|------------------|------|
| High latency to GitHub API | 15s timeout; no adaptive timeout | **Medium** -- legitimate slow responses rejected |
| Packet loss to Postgres | Pool query timeout fires; in-flight transaction lost | **Medium** -- transaction-safe but no retry |
| DNS resolution failure | fetch() fails immediately; no retry with backoff | **Medium** -- transient DNS failures kill entire polling/dispatch cycle |
| host.docker.internal unreachable | OpenClaw plugin/MCP bridge cannot reach operator API | **High** -- agents lose MCP context and approval routing |

### 3.5 Data Integrity

| Scenario | Current Handling | Risk |
|----------|------------------|------|
| Partial cursor update (poll timeout mid-batch) | Cursor saved after all processing; failed cycle does not advance cursor | **Medium** -- some issues may be re-planned if planning succeeded but cursor save failed |
| Double-dispatch race | Pipeline run advisory lock prevents concurrent claims | **Low** -- lock-based protection present |
| GitHub webhook replay | `/projects/advance` is idempotent for already-merged tickets | **Low** -- safe |
| Malformed OpenClaw JSONL transcript | Zod schema validation per line; invalid lines logged and skipped (Feature 171) | **Low** -- hardened |

---

## 4. Gap Analysis Summary

### Critical Gaps

| # | Gap | Impact | Current State |
|---|-----|--------|---------------|
| G-01 | **No `unhandledRejection` / `uncaughtException` handler** | Background async errors crash the process silently | No global error boundary |
| G-02 | **No circuit breaker on external APIs** | Sustained GitHub/OpenClaw outage causes thundering herd on recovery | Retries without circuit state |
| G-03 | **GitHub adapter has no retry on transient errors** | Single 5xx or timeout kills entire polling cycle | Fails immediately |
| G-04 | **GitHub adapter has no 429 rate-limit handling** | Polling hammers rate-limited endpoint | No `X-RateLimit-*` header inspection |
| G-05 | **No periodic runtime sweep** | Orphaned/stale runs linger until operator action or restart | Sweep only at startup or manual trigger |
| G-06 | **Shutdown has no step timeouts** | Hung `.stop()` blocks shutdown indefinitely | `await` without deadline |
| G-07 | **Health endpoint does not verify downstream connectivity** | OpenClaw or GitHub can be down without health degradation | DB-only health check |
| G-08 | **No disk space monitoring** | Evidence/workspace writes can corrupt on ENOSPC | No pre-write space check |

### Medium Gaps

| # | Gap | Impact | Current State |
|---|-----|--------|---------------|
| G-09 | **No jitter on retry backoff** | Synchronized retries from multiple callers spike load | Linear backoff without jitter |
| G-10 | **External side effects outside DB transactions** | GitHub PR created but Postgres record not saved on crash | Design trade-off, documented |
| G-11 | **No connection retry on transient Postgres errors** | Single connection timeout fails the query permanently | Pool reconnects, but in-flight query lost |
| G-12 | **Dashboard subprocess has no kill escalation** | Vite process can hang on SIGTERM | SIGTERM only, no SIGKILL timeout |
| G-13 | **Polling cycle timeout covers all repos** | Slow repo starves later repos of their cycle budget | Single 120s timeout for entire cycle |
| G-14 | **No automatic OpenClaw session cancellation on crash** | Orphaned sessions consume resources in OpenClaw | Timeout-based cleanup only |

---

## 5. Recommended Tools

### Fault Injection

| Tool | Use Case | Fit for RedDwarf |
|------|----------|------------------|
| **Toxiproxy** | TCP proxy between host and Docker services; simulate Postgres latency, OpenClaw packet loss, GitHub connection reset | **High** -- can sit between host Node.js and Docker containers |
| **Pumba** | Docker container chaos (kill, pause, network emulation) | **High** -- can kill/pause Postgres and OpenClaw containers |
| **tc (Linux traffic control)** | Network degradation on Docker bridge | **Medium** -- lower-level alternative to Toxiproxy |

### Load & Stress Testing

| Tool | Use Case | Fit for RedDwarf |
|------|----------|------------------|
| **k6** | Sustained load on operator API during chaos experiments | **High** -- scriptable, CI-friendly |
| **Artillery** | YAML-based load testing for API endpoints | **Medium** -- lighter alternative |

### Observability During Tests

| Tool | Use Case | Fit for RedDwarf |
|------|----------|------------------|
| **pino** (already in use) | Structured logging with level filtering | **Already present** |
| **Postgres `pg_stat_activity`** | Query and connection monitoring during chaos | **Already available** |
| **Docker stats** | Container resource monitoring | **Already available** |

---

## 6. Robustness Feature Board

This board is separate from `FEATURE_BOARD.md` and focuses exclusively on system resilience. Items are ordered by risk reduction value (likelihood x impact) divided by effort.

### Phase 1 -- Critical Resilience (highest impact, lowest effort) -- COMPLETE

| # | Feature | Priority | Gaps Addressed | Status |
|---|---------|----------|----------------|--------|
| R-01 | **Global unhandled rejection / uncaught exception handler** -- `process.on('unhandledRejection')` and `process.on('uncaughtException')` in `start-stack.mjs`. Logs full stack trace, attempts graceful shutdown, exits non-zero. | P1 | G-01 | **Done** |
| R-02 | **Shutdown step timeouts** -- Each shutdown step wrapped in `withDeadline()` (10s default). Dashboard subprocess gets SIGKILL escalation after 5s if SIGTERM doesn't work. Periodic sweep timer cleared on shutdown. | P1 | G-06, G-12 | **Done** |
| R-03 | **GitHub adapter retry with backoff on transient errors** -- `githubFetchWithRetry()` in `packages/integrations/src/github.ts`. 3 attempts, exponential backoff with jitter (0.5x-1.5x), retries on 429/500/502/503/504 and network errors. Respects `Retry-After` header. Fresh `AbortSignal.timeout()` per attempt. Both `RestGitHubAdapter` and `RestGitHubIssuesAdapter` refactored. 7 new tests covering retry-then-success, exhaustion, non-retryable pass-through, and network error recovery. | P1 | G-03, G-04 | **Done** |
| R-04 | **Periodic runtime sweep** -- `setInterval`-based sweep in `start-stack.mjs`, configurable via `REDDWARF_PERIODIC_SWEEP_INTERVAL_MS` (default 300s) and `REDDWARF_PERIODIC_SWEEP_ENABLED` (default true). Timer is `.unref()`'d and cleared on shutdown. | P1 | G-05 | **Done** |

### Phase 2 -- High-Value Hardening -- COMPLETE

| # | Feature | Priority | Gaps Addressed | Status |
|---|---------|----------|----------------|--------|
| R-05 | **Circuit breaker for GitHub API** -- Reusable `CircuitBreaker` class (closed/open/half-open) in `packages/integrations/src/circuit-breaker.ts`. Integrated into `RestGitHubAdapter` — wraps all `apiGet`/`apiPost`/`apiPut` calls. Configurable failure threshold (default 5) and cooldown (default 60s). Circuit state reported in `/health` via `circuitBreakers` field. 12 unit tests. | P2 | G-02 | **Done** |
| R-06 | **Circuit breaker for OpenClaw dispatch** -- Same `CircuitBreaker` class integrated into `HttpOpenClawDispatchAdapter` and `AcpxOpenClawDispatchAdapter`. Wraps the entire dispatch retry loop. Circuit state reported in `/health`. Configurable via adapter options. | P2 | G-02 | **Done** |
| R-07 | **Downstream connectivity in health endpoint** -- `GET /health` extended with `downstream` array (OpenClaw `GET /health`, GitHub `GET /rate_limit`), each reporting `ok`/`degraded`/`unreachable` with latency. Results cached 15s via `createCachedProbe()`. Composite `readiness` field. Circuit breaker snapshots in `circuitBreakers` field. Postgres health was already present via `repository.getRepositoryHealth()`. | P2 | G-07 | **Done** |
| R-08 | **Per-repo polling timeout** -- `GitHubPollingRepoConfig.repoTimeoutMs` and `GitHubIssuePollingDaemonConfig.perRepoTimeoutMs` (default 60s, falls back to `min(cycleTimeoutMs, 60s)` for backward compatibility). Each `pollRepository` call uses its own timeout. Structured `POLLING_REPO_COMPLETED` log event with `durationMs`, `timeoutMs`, `issuesProcessed`. Env var `REDDWARF_POLL_PER_REPO_TIMEOUT_MS`. | P2 | G-13 | **Done** |

### Phase 3 -- Defensive Depth

| # | Feature | Priority | Gaps Addressed | Effort |
|---|---------|----------|----------------|--------|
| R-09 | **Retry jitter on all backoff paths** -- Add random jitter (0.5x to 1.5x of computed delay) to `fetchWithRetry()`, OpenClaw dispatch retry, and the new GitHub retry (R-03). Prevents synchronized retry storms. | P3 | G-09 | Small |
| R-10 | **Disk space pre-check before evidence/workspace writes** -- Before writing evidence archives or materializing workspaces, check available disk space via `fs.statfs()`. If below a configurable threshold (`REDDWARF_MIN_DISK_FREE_MB`, default 500), skip the write and log a structured error. Report disk health in `/health`. | P3 | G-08 | Small |
| R-11 | **Postgres query retry for transient connection errors** -- Wrap critical single-query paths (cursor save, health check, evidence write) with a single retry on `ECONNRESET`, `ECONNREFUSED`, or `57P01` (admin shutdown). Do not retry inside transactions (already handled by rollback). | P3 | G-11 | Medium |
| R-12 | **OpenClaw session cancellation on crash recovery** -- During startup stale-run sweep, if a stale run has an associated OpenClaw session key, attempt `DELETE /hooks/sessions/:key` (or Task Flow `cancelFlow`) to release the orphaned agent session. Best-effort with try-catch. | P3 | G-14 | Medium |

### Phase 4 -- Chaos Testing Infrastructure

| # | Feature | Priority | Gaps Addressed | Effort |
|---|---------|----------|----------------|--------|
| R-13 | **Toxiproxy integration for integration tests** -- Add a `docker-compose.chaos.yml` overlay that inserts Toxiproxy between the host process and both Postgres and OpenClaw containers. Provide helper scripts to enable/disable toxics (latency, timeout, reset_peer) during test runs. Document usage in `docs/chaos-engineering.md`. | P4 | Testing infra | Large |
| R-14 | **Kill-and-recover integration test** -- Script that: (1) starts the full stack, (2) submits a test issue, (3) waits for planning to begin, (4) `kill -9` the host process, (5) restarts, (6) asserts the startup sweep marks the stale run and the re-dispatched task succeeds. Run as part of `pnpm e2e:chaos`. | P4 | Testing infra | Medium |
| R-15 | **Postgres restart integration test** -- Script that: (1) starts the full stack, (2) submits a test issue, (3) waits for development phase, (4) `docker restart postgres`, (5) asserts the pool reconnects and the pipeline either retries or fails gracefully with a clear error. | P4 | Testing infra | Medium |
| R-16 | **OpenClaw container kill test** -- Script that: (1) starts the full stack with a test issue in development, (2) `docker kill openclaw`, (3) asserts the awaiter detects the stalled session, marks the run failed, and the task is retryable after OpenClaw comes back. | P4 | Testing infra | Medium |
| R-17 | **Load test suite for operator API** -- k6 script that: (1) sustains 50 req/s to `GET /health`, `GET /runs`, `GET /tasks` during normal operation, (2) repeats with Toxiproxy injecting 200ms Postgres latency, (3) asserts p99 latency stays under 2s and no 5xx responses during degraded mode. | P4 | Testing infra | Medium |

### Phase 5 -- Advanced Resilience (future)

| # | Feature | Priority | Gaps Addressed | Effort |
|---|---------|----------|----------------|--------|
| R-18 | **Write-ahead intent log for external side effects** -- Before creating a GitHub PR or OpenClaw dispatch, write an intent record to Postgres. On crash recovery, replay or compensate incomplete intents. Addresses the fundamental gap where external mutations happen outside DB transactions. | P5 | G-10 | Large |
| R-19 | **Process manager integration (PM2 / systemd)** -- Document and provide PM2 ecosystem config or systemd unit file for host-side process management with automatic restart, log rotation, and memory limits. | P5 | Production readiness | Medium |
| R-20 | **Structured chaos experiment runner** -- CLI tool (`pnpm chaos:run <scenario>`) that combines Toxiproxy toxics, container manipulation, and assertions into named reproducible experiments. Scenarios map to the failure matrix in this document. | P5 | Testing infra | Large |

---

## 7. Dependency Graph

```
R-01 (Unhandled rejection)  ────────────────────────��────────┐
R-02 (Shutdown timeouts)    ─────────────────────────────────┤ Phase 1 (independent)
R-03 (GitHub retry)         ─────────────────────────────────┤
R-04 (Periodic sweep)       ─────────────────────────────────┘

R-05 (GitHub circuit breaker) ──── requires R-03 ────────────┐
R-06 (OpenClaw circuit breaker) ─────────────────────────────┤ Phase 2
R-07 (Downstream health)      ─────────────────────────���────┤
R-08 (Per-repo poll timeout)   ──────────────────────────────┘

R-09 (Retry jitter) ──── requires R-03 ─────────────────────┐
R-10 (Disk space check)  ───────────────────────────────────┤ Phase 3
R-11 (Postgres query retry) ────────────────────────────────┤
R-12 (Session cancellation) ── requires R-04 ───────────────┘

R-13 (Toxiproxy infra) ──────────────────────────────��─────┐
R-14 (Kill-and-recover test) ── requires R-01, R-04 ───────┤ Phase 4
R-15 (Postgres restart test) ── requires R-13 ─────────────┤
R-16 (OpenClaw kill test)    ── requires R-13 ─────────────┤
R-17 (Load test suite)       ── requires R-13 ─────────────┘

R-18 (Intent log)         ──────────────────────────────────┐
R-19 (Process manager)    ──────────────────────────────────┤ Phase 5
R-20 (Chaos runner)       ── requires R-13 ────────────────┘
```

---

## 8. Quick Wins (Code Fixes)

These can be implemented immediately alongside the feature board work:

### 8.1 Add `unhandledRejection` handler (5 lines)

In `scripts/start-stack.mjs`, before the SIGINT/SIGTERM handlers:

```js
process.on("unhandledRejection", (reason) => {
  logError(`Unhandled rejection: ${reason instanceof Error ? reason.stack : reason}`);
  void shutdown(1);
});
```

### 8.2 Add shutdown step deadline (wrap pattern)

```js
async function withDeadline(promise, label, ms = 10_000) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  );
  try { await Promise.race([promise, timeout]); }
  catch (e) { logError(String(e)); }
}
```

### 8.3 Dashboard kill escalation

```js
if (dashboardProcess && dashboardProcess.exitCode === null) {
  dashboardProcess.kill("SIGTERM");
  setTimeout(() => {
    if (dashboardProcess.exitCode === null) dashboardProcess.kill("SIGKILL");
  }, 5000);
}
```

---

## 9. Testing Strategy

### What a passing result looks like

For each chaos scenario, the system should:
1. Detect the failure within its configured timeout
2. Log a structured error with enough context to diagnose
3. Mark affected pipeline runs as `failed` or `stale` (not silently dropped)
4. Recover automatically on next cycle/restart or surface a clear operator action
5. Not corrupt Postgres state, evidence archives, or GitHub resources
6. Not leave orphaned external resources (OpenClaw sessions, GitHub branches) permanently

### What a failing result looks like

- Silent process death with no log output
- Stuck/hung pipeline runs that never resolve
- Duplicate GitHub PRs or issues from replay
- Partial evidence JSON files that break downstream queries
- Pool exhaustion causing cascading timeouts across unrelated operations
- Operator API returning 500s during a dependency outage instead of degraded status

---

## 10. Strengths to Preserve

The following mechanisms are already strong and should not be regressed:

1. **Database transaction safety** -- `BEGIN`/`COMMIT`/`ROLLBACK` with advisory locks
2. **Idempotent mutation patterns** -- `ON CONFLICT` upserts, pre-check-before-create
3. **Configurable pool with observability** -- timeouts, lifetime, error tracking, health exposure
4. **Comprehensive HTTP timeouts** -- `AbortSignal.timeout()` on every external fetch
5. **Phase-based retry budgets** -- configurable per-phase with escalation to operator
6. **Stale-run sweep** -- startup recovery for crashed-mid-pipeline scenarios
7. **Subprocess kill escalation** -- SIGTERM with SIGKILL timeout for git commands
8. **JSONL transcript hardening** -- Zod validation per line, skip-on-invalid (Feature 171)
9. **Merge workflow idempotency** -- duplicate callbacks are no-ops
10. **Shutdown ordering** -- daemon -> dispatcher -> API -> dashboard -> pool
