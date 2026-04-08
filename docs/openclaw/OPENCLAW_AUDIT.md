# OpenClaw Integration Audit

**Date:** 2026-04-07  
**Scope:** All RedDwarf integrations with the OpenClaw execution plane  
**Status:** Findings captured; remediation tracked in [FEATURE_BOARD.md](/home/derek/code/RedDwarf/FEATURE_BOARD.md) M22

---

## Integration Map

The OpenClaw integration spans seven distinct surfaces:

| Surface | Location |
|---|---|
| HTTP Hook Dispatch (primary) | `packages/integrations/src/openclaw.ts` — `HttpOpenClawDispatchAdapter` |
| ACPX Session Dispatch (Feature 154) | `packages/integrations/src/openclaw.ts` — `AcpxOpenClawDispatchAdapter` |
| Task Flow Adapter (Feature 150) | `packages/integrations/src/openclaw-task-flow.ts` |
| Completion Awaiters (transcript polling) | `packages/control-plane/src/live-workflow.ts` |
| reddwarf-operator Plugin (reverse callbacks + before_tool_call hook) | `agents/openclaw/plugins/reddwarf-operator/index.ts` |
| OpenClaw Config Generator | `packages/control-plane/src/openclaw-config.ts` |
| Docker / Infrastructure wiring | `infra/docker/docker-compose.yml`, `infra/docker/openclaw.json` |

Handover sequences exist for four pipeline phases: **Holly (Architect)**, **Lister (Developer)**, **Kryten (Architecture Reviewer)**, and **Kryten (Validator)**. All dispatch is post-approval. All features are feature-flagged and off by default.

---

## Findings & Priority Matrix

| # | Feature | Finding | Category | Severity | Effort | Priority |
|---|---------|---------|----------|----------|--------|----------|
| 157 | [F-157](#f-157-env-secrets-exposure-in-docker-container) | Full `.env` injected verbatim into OpenClaw Docker container, exposing all secrets to the agent process and every plugin | Security | Critical | Medium | P1 |
| 158 | [F-158](#f-158-runtime-sandboxing-disabled-for-all-agents) | Runtime sandboxing disabled for all agents (`mode: "off"`); `sandboxMode` declarations are not enforced at runtime | Security | Critical | Large | P1 |
| 159 | [F-159](#f-159-policy-lookup-fails-open) | Plugin policy lookup fails open — when `GET /sessions/policy` errors, before-tool-call hook allows all paths silently | Security / Handover | Critical | Small | P1 |
| 160 | [F-160](#f-160-hook-token-exposed-via-openclaw-secret-scope) | `OPENCLAW_HOOK_TOKEN` exposed via the `openclaw` secret scope, giving any task with that scope direct gateway write access | Security | High | Small | P1 |
| 161 | [F-161](#f-161-acpx-adapter-has-no-retry-logic) | `AcpxOpenClawDispatchAdapter` has no retry on 429/529 or version-mismatch 404, unlike the HTTP hook adapter | Resilience | High | Small | P2 |
| 162 | [F-162](#f-162-agent-to-agent-messaging-enabled-by-default) | Agent-to-agent messaging (`sessions_send`) enabled by default for all agents; any agent can message any roster peer | Security | High | Small | P2 |
| 163 | [F-163](#f-163-secret-lease-cleanup-is-best-effort-only) | Secret lease cleanup (`scrubWorkspaceSecretLeaseOnPhaseExit`) is a `finally`-block best-effort — SIGKILL leaves plaintext secrets in workspace | Security | High | Small | P2 |
| 164 | [F-164](#f-164-tool-approval-polling-no-jitter-and-no-pending-check) | Tool approval polling has no `status=pending` check, no jitter, and hardcoded 2 s interval — 120 s wait before deny on race; polling storm risk | Resilience | Medium | Small | P2 |
| 165 | [F-165](#f-165-no-prompt-sanitization-before-dispatch) | No sanitization or length cap on assembled prompt text before dispatch; arbitrary GitHub issue body content flows in unescaped | Security | Medium | Medium | P2 |
| 166 | [F-166](#f-166-session-key-normalization-coverage) | Session key normalization (`normalizeOpenClawSessionKey`) applied in 4 explicit call sites — new call sites added without it silently cause session-lookup misses | Handover | Medium | Small | P2 |
| 167 | [F-167](#f-167-task-flow-not-cancelled-on-abnormal-pipeline-failure) | `cancelFlow` only called on project `failed` state — timeout and stall errors leave active Task Flows orphaned in OpenClaw | Resilience | Medium | Small | P2 |
| 168 | [F-168](#f-168-tool-approval-polling-issues-two-http-calls-per-tick) | Tool approval polling issues two separate HTTP calls per 2 s tick (one approved, one denied) instead of a single status query | Resilience | Low | Medium | P3 |
| 169 | [F-169](#f-169-deliver-false-hardcoded-no-runtime-override) | `deliver: false` hardcoded in `HttpOpenClawDispatchAdapter`; absent from ACPX schema — no runtime path to enable chat delivery | Gap | Low | Small | P3 |
| 170 | [F-170](#f-170-clawhub-allowlist-hardcoded-no-operator-override) | ClawHub publisher allow-list hardcoded (`reddwarf/*`, `anthropic/*`) with no operator override mechanism or audit log of installed skills | Security | Low | Medium | P3 |
| 171 | [F-171](#f-171-no-integrity-check-on-session-transcript-files) | Completion awaiters read JSONL transcripts directly from the container-mounted filesystem with no integrity check — a compromised agent could craft JSONL to influence stall/termination detection | Security | Low | Large | P3 |
| 172 | [F-172](#f-172-openclaw-health-check-blocks-dashboard-bootstrap) | `resolveOpenClawUiStatus()` fetches `GET /health` on every bootstrap response with no caching and no timeout | Resilience | Low | Small | P3 |
| 173 | [F-173](#f-173-dispatch-adapter-integration-test-coverage-gap) | `HttpOpenClawDispatchAdapter` and `AcpxOpenClawDispatchAdapter` lack integration tests; retry and timeout paths are untested | Gap | Low | Medium | P3 |

---

## Detailed Findings

### F-157: Env secrets exposure in Docker container

**Category:** Security | **Severity:** Critical | **Priority:** P1

**Location:** `infra/docker/docker-compose.yml` (env_file block)

The `.env` file is injected verbatim into the OpenClaw Docker container via `env_file`. This includes `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, `DATABASE_URL`, `REDDWARF_OPERATOR_TOKEN`, and all `OPENCLAW_*` credentials. Any code running inside the OpenClaw process — including plugins, MCP servers, and agent-side tool calls — can read these values from the process environment.

**Recommendation:** Replace the verbatim `env_file` injection with an explicit, minimal env block passing only the four vars the OpenClaw process actually needs: `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_HOOK_TOKEN`, `OPENCLAW_BASE_URL`, and the active model API key. Treat this as a container escape scenario.

---

### F-158: Runtime sandboxing disabled for all agents

**Category:** Security | **Severity:** Critical | **Priority:** P1

**Location:** `packages/control-plane/src/openclaw-config.ts` lines 587–608

All agents run with `sandboxMode: { mode: "off" }`. The `sandboxMode` declarations per role (`read_only`, `workspace_write`) express security intent but are not enforced at runtime by OpenClaw. Enforcement relies entirely on the Docker container boundary and per-agent tool allow/deny groups. Feature 105 (Docker sandboxing) is referenced but has no active timeline.

**Recommendation:** Until Feature 105 is delivered, audit tool allow/deny groups for completeness and document the container boundary as the sole enforcement layer. Any agent with `bash` or file-write tools can escape the intended `read_only` policy today.

---

### F-159: Policy lookup fails open

**Category:** Security / Handover | **Severity:** Critical | **Priority:** P1

**Location:** `agents/openclaw/plugins/reddwarf-operator/index.ts` lines 143–149

When `GET /sessions/policy` fails (network error, session not yet registered), the before-tool-call hook returns a permissive fallback `{ allowedPaths: [], deniedPaths: [] }`, which means path restrictions cannot be enforced. The failure is not logged, so this condition is invisible in operator audit trails.

**Recommendation:** Change the fallback to fail-closed: deny the tool call (or hold for explicit operator approval) when policy cannot be fetched. Log the failure reason. Add a short retry (2–3 attempts) before denying to tolerate transient session registration lag.

---

### F-160: Hook token exposed via openclaw secret scope

**Category:** Security | **Severity:** High | **Priority:** P1

**Location:** `packages/integrations/src/openclaw.ts` lines 258–272 (`createOpenClawSecretsAdapter`)

`OPENCLAW_HOOK_TOKEN` is registered under the `openclaw` secret scope. Any task granted `allowedSecretScopes: ["openclaw"]` can receive the hook token as an env variable in its agent workspace, giving that agent direct write access to the OpenClaw gateway (i.e., the ability to dispatch arbitrary work).

**Recommendation:** Remove `HOOK_TOKEN` from the `openclaw` secret scope unless there is a documented, intentional use case. If the use case exists, gate it behind its own named scope so it cannot be reached via a generic `openclaw` grant.

---

### F-161: ACPX adapter has no retry logic

**Category:** Resilience | **Severity:** High | **Priority:** P2

**Location:** `packages/integrations/src/openclaw.ts` — `AcpxOpenClawDispatchAdapter`

`AcpxOpenClawDispatchAdapter` makes a single attempt with a 15 s timeout. Any transient 429/529 causes immediate hard failure. `HttpOpenClawDispatchAdapter` retries up to 3× with linear backoff on 429/529. A live incident is documented in `docs/agent/TROUBLESHOOTING.md`: a 404 from an incompatible gateway version caused planning to fail in under one second with no recovery.

**Recommendation:** Add the same retry-on-429/529 logic as `HttpOpenClawDispatchAdapter`. Separately add a version-check pre-flight or a fallback to HTTP hook dispatch when ACPX returns 404.

---

### F-162: Agent-to-agent messaging enabled by default

**Category:** Security | **Severity:** High | **Priority:** P2

**Location:** `packages/control-plane/src/openclaw-config.ts` line 352 (`enableAgentToAgent ?? true`)

`sessions_send` is enabled for all agents by default. Any agent session can initiate unsolicited cross-agent messages to any other roster agent. The architecture reviewer config denies `sessions_spawn`, `sessions_yield`, and `subagents` but not `sessions_send`, leaving an unsolicited-message channel open.

**Recommendation:** Default `enableAgentToAgent` to `false` and require explicit opt-in. If agent-to-agent is needed for specific pairs, model it as an explicit directed allow-list rather than roster-wide.

---

### F-163: Secret lease cleanup is best-effort only

**Category:** Security | **Severity:** High | **Priority:** P2

**Location:** `packages/control-plane/src/pipeline/development.ts` — `scrubWorkspaceSecretLeaseOnPhaseExit()`

Secret leases inject env variables into workspace context files. Cleanup runs in a `finally` block, which is skipped if the Node process is SIGKILL'd or the container is forcibly stopped mid-session. Plaintext secrets remain in the workspace directory indefinitely after such an event.

**Recommendation:** Implement a startup-time lease audit that scrubs stale workspace secret files for any run that is not currently active. Add a periodic cleanup cron for the workspace root.

---

### F-164: Tool approval polling — no jitter, no pending check

**Category:** Resilience | **Severity:** Medium | **Priority:** P2

**Location:** `agents/openclaw/plugins/reddwarf-operator/index.ts` — approval polling loop

The polling loop checks `status=approved` and `status=denied` separately every 2 s with no jitter. If both queries return empty (DB write not yet visible), the loop runs for the full 120 s before denying. Under concurrent tool approvals, the fixed-interval polling from multiple sessions creates a polling storm.

**Recommendation:** Add exponential backoff with jitter to the poll interval. Combine into a single `GET /tool-approvals/:id` call returning current status. Add a `status=pending` check to distinguish "not yet decided" from "not found".

---

### F-165: No prompt sanitization before dispatch

**Category:** Security | **Severity:** Medium | **Priority:** P2

**Location:** `packages/control-plane/src/pipeline/prompts.ts` — `buildOpenClawDeveloperPrompt`, `buildOpenClawArchitectPrompt`

Arbitrary user-controlled content from GitHub issue bodies flows into the dispatch payload without sanitization, escaping, or length capping. A maliciously crafted issue body could attempt prompt injection into the agent session.

**Recommendation:** Define and enforce a maximum prompt length. Strip or escape control characters and potential injection patterns from user-supplied content before it is embedded in the prompt. Consider a structured prompt format that clearly delimitates user content from system instructions.

---

### F-166: Session key normalization coverage

**Category:** Handover | **Severity:** Medium | **Priority:** P2

**Location:** `packages/control-plane/src/openclaw-session-key.ts`

`normalizeOpenClawSessionKey()` is applied in 4 explicit call sites after a retroactive fix for a live production failure. There is no type-level or lint-level enforcement preventing new call sites from using raw (un-normalized) session keys.

**Recommendation:** Introduce a branded/opaque `NormalizedSessionKey` type so un-normalized strings cannot be passed to dispatch, awaiter, or registry functions at compile time. Add a lint rule or grep-based CI check to catch raw session key construction.

---

### F-167: Task Flow not cancelled on abnormal pipeline failure

**Category:** Resilience | **Severity:** Medium | **Priority:** P2

**Location:** `packages/control-plane/src/pipeline/project-approval.ts` — `executeProjectApproval`

`cancelFlow` is only called when the project enters the `failed` state via normal pipeline failure handling. `OpenClawCompletionTimeoutError` and `OpenClawSessionStalledError` paths do not call `cancelFlow`, leaving active Task Flows orphaned in OpenClaw.

**Recommendation:** Call `cancelFlow` in all abnormal termination paths — timeout, stall, and unhandled exceptions — in addition to the existing `failed` state handler. Wrap in a best-effort try/catch so cancel failure does not mask the original error.

---

### F-168: Tool approval polling issues two HTTP calls per tick

**Category:** Resilience | **Severity:** Low | **Priority:** P3

**Location:** `agents/openclaw/plugins/reddwarf-operator/index.ts` — approval polling loop

Two separate HTTP calls per 2 s loop tick (one for `status=approved`, one for `status=denied`) doubles the request load and creates a race window between the two checks where the state could change.

**Recommendation:** Replace with a single `GET /tool-approvals/:id` endpoint that returns the current status in one call. This eliminates the race and halves polling overhead.

---

### F-169: `deliver: false` hardcoded, no runtime override

**Category:** Gap | **Severity:** Low | **Priority:** P3

**Location:** `packages/integrations/src/openclaw.ts` — `HttpOpenClawDispatchAdapter` dispatch payload

`deliver: false` is hardcoded, suppressing chat delivery for all orchestration runs with no runtime override path. The ACPX adapter does not include this field at all.

**Recommendation:** Expose `deliver` as an optional `OpenClawDispatchOptions` field (defaulting to `false`) so operators can enable chat delivery for specific task types without a code change.

---

### F-170: ClawHub allow-list hardcoded, no operator override

**Category:** Security | **Severity:** Low | **Priority:** P3

**Location:** `clawhub/README.md`, skill discovery implementation

The publisher allow-list (`reddwarf/*`, `anthropic/*`) is hardcoded with no mechanism for operator override, addition of trusted third-party publishers, or audit log of skills installed during a session.

**Recommendation:** Move the allow-list to operator configuration (`REDDWARF_CLAWHUB_ALLOWED_PUBLISHERS`). Add a `clawhub_skill_installed` evidence event type so operators can audit which skills were loaded in each session.

---

### F-171: No integrity check on session transcript files

**Category:** Security | **Severity:** Low | **Priority:** P3

**Location:** `packages/control-plane/src/openclaw-session.ts` — `parseSessionJsonl()`

Completion awaiters read JSONL transcripts directly from the container-mounted filesystem path with no integrity verification. A compromised agent process could write crafted JSONL entries to influence stall detection, termination detection, or execution item parsing.

**Recommendation:** As a near-term mitigation, validate that JSONL entries conform strictly to the expected schema (reject unknown event types and malformed entries). Longer-term, consider an HMAC or signature scheme on transcript entries, or read transcripts via the OpenClaw API rather than the raw filesystem.

---

### F-172: OpenClaw health check blocks dashboard bootstrap

**Category:** Resilience | **Severity:** Low | **Priority:** P3

**Location:** `packages/control-plane/src/operator-api.ts` — `resolveOpenClawUiStatus()`

`GET ${OPENCLAW_BASE_URL}/health` is fetched on every bootstrap response with no caching and no timeout override. If OpenClaw is slow to respond, this synchronously blocks the operator dashboard bootstrap for every connected client.

**Recommendation:** Add a short timeout (e.g., 2 s) to the health check fetch. Cache the result for 10–30 s so repeated bootstrap calls do not each block on OpenClaw reachability.

---

### F-173: Dispatch adapter integration test coverage gap

**Category:** Gap | **Severity:** Low | **Priority:** P3

**Location:** `packages/integrations/src/adapter-failure-paths.test.ts`

`FixtureOpenClawDispatchAdapter` is the only dispatch adapter with test coverage. `HttpOpenClawDispatchAdapter` and `AcpxOpenClawDispatchAdapter` are not covered by tests against a real or mocked HTTP server. Retry logic, timeout handling, and non-2xx error paths are untested.

**Recommendation:** Add integration tests using `msw` or equivalent to cover: 429→retry→success, 429→retry→exhausted, 504 timeout, non-JSON success response, and ACPX 404 version mismatch paths.
