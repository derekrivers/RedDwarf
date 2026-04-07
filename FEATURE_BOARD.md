# RedDwarf Feature Board

The board is ordered by implementation priority.

This active board only lists pending work. Completed items are archived in [features_archive/COMPLETED_FEATURES.md](/home/derek/code/RedDwarf/features_archive/COMPLETED_FEATURES.md).

---

## M20 — Project Mode

Source reference: [`docs/reddwarf_project_mode_spec.md`](/home/derek/code/RedDwarf/docs/reddwarf_project_mode_spec.md). **Read the full spec before implementing any feature in this milestone.** It is the authoritative specification for the planning corridor, data model, ticket lifecycle, and acceptance criteria.

Key design decisions applied to this milestone:

- **Rimmer** is implemented as a coordinator module in `packages/control-plane`. He classifies complexity, routes to project mode or the existing single-issue path, and orchestrates the planning lifecycle. He is not a separate execution-plane agent.
- **Holly** remains the Architect agent. In project mode she produces a `ProjectSpec` with ordered `TicketSpec[]` children instead of a single planning spec.
- **Clarification loop** uses the operator API (not Discord). When Holly flags missing context, the operator submits answers via API endpoints. OD-02 in the spec is resolved in favour of operator API.
- **`project_specs` replaces/extends `planning_specs`**. The existing `planning_specs` table is migrated into the new `project_specs` schema. Single-issue plans continue to work through the same table with `project_size: 'small'`.
- **GitHub Issues** is the execution backlog (OD-01 resolved). No Trello integration.
- **GitHub Actions** replaces inbound webhooks (OD-03 resolved). Tailscale Funnel provides external reachability for the operator API.
- **Tickets are serial** in v1. No parallel ticket execution.

Column legend: `Depends On` captures explicit delivery sequencing.

### Phase 1 — Foundation (no dependencies, can be worked in parallel)

| # | Feature | Status | Depends On | Spec Reference |
| - | ------- | ------ | ---------- | -------------- |
| 140 | **Rimmer coordinator: complexity classifier + project mode routing** — Add a `classifyComplexity` function to `packages/control-plane` within a new `rimmer/` module. Accepts a raw request string and optional repo context; returns `{ size: 'small'\|'medium'\|'large', reasoning: string, signals: string[] }`. Integrate into the intake pipeline so medium/large requests enter project mode and small requests continue through the existing single-issue path unchanged. Persist classification result to the project spec record. | complete | — | [Spec T-01](docs/reddwarf_project_mode_spec.md) §6 T-01 |
| 141 | **ProjectSpec + TicketSpec schema, migration, contracts, and repositories** — Replace/extend `planning_specs` with `project_specs` and add `ticket_specs` table. All fields per spec §4.3. Export `ProjectSpec` and `TicketSpec` TypeScript types from `packages/contracts`. Implement `ProjectSpecRepository` (`create`, `findById`, `updateStatus`, `listByRepo`) and `TicketSpecRepository` (`create`, `findByProject`, `updateStatus`, `resolveNextReady`). `resolveNextReady` returns the first ticket whose all `depends_on` entries are in `merged` status. Existing evidence schema tests must pass without modification. | complete | — | [Spec T-02](docs/reddwarf_project_mode_spec.md) §6 T-02 |
| 147 | **Tailscale Funnel: operator API external reachability** — Configure Tailscale Funnel so the operator API is reachable from GitHub Actions runners. Document setup in `.env.example` and add a `REDDWARF_OPERATOR_API_URL` config entry used by the GitHub Actions workflow. Verify connectivity from an external network. | complete | — | Prerequisite for 148; see [Spec §4.1 step 11](docs/reddwarf_project_mode_spec.md) |

### Phase 2 — Planning corridor (unblocked by Phase 1)

| # | Feature | Status | Depends On | Spec Reference |
| - | ------- | ------ | ---------- | -------------- |
| 142 | **Holly planning phase: project mode** — Extend Holly's planning phase to accept a mode flag (`single` or `project`). In project mode, Holly produces a `ProjectSpec` with >=2 ordered `TicketSpec[]` children, each with title, description, acceptance_criteria, depends_on, and complexity_class. When context is insufficient, Holly returns a `ClarificationRequest` with specific questions rather than a partial spec. After receiving clarification answers, Holly resumes planning from the same session context with no context loss. Existing single-issue planning path must produce identical output to pre-refactor baseline. Persist `ProjectSpec` to Postgres before submission for approval. | complete | 140, 141 | [Spec T-03](docs/reddwarf_project_mode_spec.md) §6 T-03 |
| 144 | **GitHub Issues adapter** — Add `GitHubIssuesAdapter` to `packages/integrations` implementing `createSubIssue(parentIssueNumber, ticketSpec)`, `closeIssue(issueNumber)`, and `getIssue(issueNumber)`. Sub-issue bodies include a structured markdown block with the full `acceptance_criteria` array rendered as a checklist. Adapter throws `V1MutationDisabledError` when `REDDWARF_GITHUB_ISSUES_ENABLED` is not set to true. `GITHUB_TOKEN` and `GITHUB_REPO` are required env vars; update `.env.example`. `createSubIssue` returns the GitHub issue number, stored as `github_sub_issue_number` on the TicketSpec record. | complete | 141 | [Spec T-05](docs/reddwarf_project_mode_spec.md) §6 T-05 |

### Phase 3 — Approval and clarification (unblocked by Phase 2)

| # | Feature | Status | Depends On | Spec Reference |
| - | ------- | ------ | ---------- | -------------- |
| 143 | **Operator API: clarification endpoints** — Add endpoints for the clarification loop. `GET /projects/:id/clarifications` returns pending `ClarificationRequest` questions. `POST /projects/:id/clarify` accepts `{ answers: Record<string, string> }` and feeds them back to Holly's planning context for re-run. Add a configurable timeout (`REDDWARF_CLARIFICATION_TIMEOUT_MS`); on expiry, planning session moves to operator API for manual resolution. All endpoints require `REDDWARF_OPERATOR_TOKEN`. | complete | 142 | [Spec T-03 AC-3/4](docs/reddwarf_project_mode_spec.md) §6 T-03; replaces T-04 (Discord) per OD-02 resolution |
| 145 | **Operator API: project listing + approval flow** — Add `GET /projects` (list with status, pending/merged/failed ticket counts), `GET /projects/:id` (full ProjectSpec with TicketSpec children), and `POST /projects/:id/approve` (accepts `{ decision: 'approve'\|'amend', decidedBy, decisionSummary, amendments? }`). Approve transitions project to sub-issue creation. Amend returns project to draft; amendments text appended to Holly's planning context for re-run. All routes require `REDDWARF_OPERATOR_TOKEN`; unauthenticated requests return 401. | complete | 142 | [Spec T-08](docs/reddwarf_project_mode_spec.md) §6 T-08 |

### Phase 4 — Execution kickoff (unblocked by Phase 3)

| # | Feature | Status | Depends On | Spec Reference |
| - | ------- | ------ | ---------- | -------------- |
| 146 | **Sub-issue writer on plan approval + first ticket dispatch** — On plan approval, create GitHub sub-issues against the original parent issue for each approved TicketSpec in dependency order. Issue titles prefixed with priority index (e.g. `[1/5]`). Each TicketSpec updated with its `github_sub_issue_number`. Call `resolveNextReady()` and dispatch the first unblocked ticket to the dev squad pipeline. If GitHub Issues adapter is disabled, fall back to Postgres-only state with a warning; dispatch still proceeds. Update project status to `executing`. | complete | 142, 144 | [Spec T-06](docs/reddwarf_project_mode_spec.md) §6 T-06 |

### Phase 5 — Merge-driven execution (unblocked by Phase 4)

| # | Feature | Status | Depends On | Spec Reference |
| - | ------- | ------ | ---------- | -------------- |
| 148 | **GitHub Actions merge workflow + ticket advance endpoint** — Add `.github/workflows/reddwarf-advance.yml` triggering on `pull_request` closed + merged. Workflow extracts `ticket_id` from PR branch name (`reddwarf/ticket/{ticket_id}`) or PR body. Calls `POST /projects/advance` with `{ ticket_id, github_pr_number }` authenticated via `REDDWARF_OPERATOR_TOKEN` Actions secret against `REDDWARF_OPERATOR_API_URL`. Operator API endpoint sets TicketSpec status to `merged`, closes the linked GitHub sub-issue, and calls `resolveNextReady()`. If next ticket exists, dispatch and label sub-issue `in-progress`; if none remain, set project status to `complete`. On dev squad failure, set project to `blocked`. Workflow is idempotent: re-running on an already-merged ticket logs a warning and exits without mutating state. `REDDWARF_OPERATOR_TOKEN` is the only required secret. | complete | 145, 146, 147 | [Spec T-07](docs/reddwarf_project_mode_spec.md) §6 T-07 |

---

### Dependency graph

```
140 (Classifier) ──┐
                   ├──► 142 (Holly planning) ──┬──► 143 (Clarification API)
141 (Schema)    ──┬┘                            ├──► 145 (Approval API)
                  │                             └──┬─► 146 (Sub-issue writer) ──► 148 (GH Actions workflow)
                  └──► 144 (GH Issues adapter) ──┘                                      ▲
                                                                                         │
147 (Tailscale) ─────────────────────────────────────────────────────────────────────────┘
```

### Recommended execution order

1. **140, 141, 147** — all independent. Start in parallel. 140 + 141 unblock the planning corridor; 147 unblocks the final workflow.
2. **142** — unblocked once 140 + 141 merge. Core planning refactor.
3. **144** — unblocked by 141 alone. Can be worked alongside or after 142.
4. **143, 145** — unblocked by 142. Independent of each other; can be worked in parallel.
5. **146** — unblocked by 142 + 144. Approval-triggered orchestration.
6. **148** — final ticket. Requires 145, 146, 147. Merging 148 completes Project Mode.

### Non-functional requirements (apply to all features)

- All new Postgres operations must respect the existing `REDDWARF_DB_POOL_*` connection pool configuration.
- No new required environment variables added without a corresponding entry in `.env.example` with a comment.
- All new integration adapters follow the existing `V1MutationDisabledError` guard pattern and are disabled by default.
- TypeScript strict mode must pass across all modified packages after each feature merge.
- `verify:all` must pass after every feature. No feature may leave the test suite in a failing state.
- The existing single-issue pipeline must remain fully operational throughout all features.

---

## M21 — OpenClaw Platform Integration

Source reference: [`docs/openclaw/openclaw-integration-features-spec.md`](/home/derek/code/RedDwarf/docs/openclaw/openclaw-integration-features-spec.md). **Read the full spec before implementing any feature in this milestone.** It contains the architectural context, migration paths, and design decisions for each feature.

Based on analysis of OpenClaw releases v2026.3.28 through v2026.4.5. All features are gated behind feature flags and disabled by default. The existing HTTP hook dispatch, polling-based completion, and static skill bootstrap must continue to work when the new features are disabled.

### Phase 1 — Resilience and Observability (no dependencies, can be worked in parallel)

| # | Feature | Status | Depends On | Spec Reference |
| - | ------- | ------ | ---------- | -------------- |
| 153 | **Model failover profiles** — Configure OpenClaw model failover chains in the generated `openclaw.json` so agent sessions automatically rotate to a fallback provider (Anthropic -> OpenAI or vice versa) on transient errors (429, 500, 503). Both `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` must be configured for failover to activate. `REDDWARF_MODEL_PROVIDER` becomes the primary preference, not the exclusive choice. Record which model served each session in run event metadata. Gate behind `REDDWARF_MODEL_FAILOVER_ENABLED`. | complete | — | [Spec §153](docs/openclaw/openclaw-integration-features-spec.md) |
| 151 | **Structured execution items on dashboard** — Extend `openclaw-session.ts` to recognise structured execution item events from OpenClaw v2026.4.5 session transcripts. Map items to `run_events` with code `AGENT_PROGRESS_ITEM`. Surface as a live timeline on the dashboard task detail view showing what the agent is working on (pending/active/done). Update Holly, Lister, and Kryten bootstrap files to encourage emitting structured plan updates at natural milestones. Falls back to heartbeat-only display when agents do not emit items. Gate behind `REDDWARF_EXECUTION_ITEMS_ENABLED`. | complete | — | [Spec §151](docs/openclaw/openclaw-integration-features-spec.md) |

### Phase 2 — Safety and Approval (unblocked by Phase 1)

| # | Feature | Status | Depends On | Spec Reference |
| - | ------- | ------ | ---------- | -------------- |
| 152 | **Plugin approval hook for agent-side safety rails** — Add a `before_tool_call` hook in the `reddwarf-operator` plugin that intercepts file write operations against the task's policy snapshot allowed/denied paths and sensitive operations (database mutations, external network requests, large deletions). Route approval through the RedDwarf operator API so all approvals flow through the same dashboard and audit trail. Record denied tool calls as evidence records. Auto-approve operations within policy; only pause for violations. Hook must complete in < 100ms for non-approval checks. Gate behind `REDDWARF_PLUGIN_APPROVAL_HOOK_ENABLED`. | complete | 153 | [Spec §152](docs/openclaw/openclaw-integration-features-spec.md) |

### Phase 3 — Orchestration Upgrade (unblocked by Phase 1)

| # | Feature | Status | Depends On | Spec Reference |
| - | ------- | ------ | ---------- | -------------- |
| 150 | **Task Flow mirrored mode for project ticket pipeline** — Replace the serial ticket dispatch loop with an OpenClaw Task Flow in mirrored mode. On project approval, create a Task Flow via `api.runtime.taskFlow` with one child task per ticket in dependency order. RedDwarf stays the source of truth; OpenClaw manages child task lifecycle, heartbeats, and durable state. `advanceProjectTicket` becomes a flow state transition instead of a fresh dispatch. Cancellation via sticky cancel intent. Gateway restart recovery via durable flow state. Existing dispatch mechanism continues as fallback. Gate behind `REDDWARF_TASKFLOW_ENABLED`. Requires OpenClaw >= v2026.4.2. | complete | 151 | [Spec §150](docs/openclaw/openclaw-integration-features-spec.md) |
| 154 | **ACPX embedded dispatch** — Replace HTTP hook dispatch (`POST /hooks/agent`) with ACPX session binding for tighter bidirectional communication. ACPX sessions provide streaming progress events, mid-session MCP tool queries with lower latency, and explicit session cancellation (replacing stale-run-sweep). The `OpenClawDispatchAdapter` interface stays the same; only the implementation changes. Coexists with HTTP dispatch via `REDDWARF_ACPX_DISPATCH_ENABLED`. Requires OpenClaw >= v2026.4.5. | complete | 151 | [Spec §154](docs/openclaw/openclaw-integration-features-spec.md) |

### Phase 4 — Community and Intelligence (unblocked by Phase 2 or 3)

| # | Feature | Status | Depends On | Spec Reference |
| - | ------- | ------ | ---------- | -------------- |
| 155 | **ClawHub skill publishing and dynamic discovery** — (A) Publish RedDwarf's governance skills (`reddwarf-architect-planning`, `reddwarf-developer-implementation`, `reddwarf-code-review`, `reddwarf-validation`) to ClawHub with standalone SOUL/IDENTITY/AGENTS context. (B) Enable Holly to search ClawHub for framework-specific skills during planning and install them into the session workspace for the current task only. Only skills from verified publishers or a curated allowlist. Record discovered skills as evidence metadata. Gate behind `REDDWARF_CLAWHUB_ENABLED`. Requires OpenClaw >= v2026.4.5. | complete | 152 | [Spec §155](docs/openclaw/openclaw-integration-features-spec.md) |
| 156 | **Dreaming memory integration** — After each agent session, capture OpenClaw dreaming output (`dreams.md`) and map structured learnings to `memory_records` with `scope: "repo"`, `provenance: "agent_observed"`, and `source: "dreaming"` tag. Deduplicate across sessions. Holly sees what Lister learned about test patterns; Lister benefits from Holly's architectural observations. Operators can view and prune dreaming memories via the operator API. Gate behind `REDDWARF_DREAMING_MEMORY_ENABLED`. Requires OpenClaw >= v2026.4.5. | complete | 150, 154 | [Spec §156](docs/openclaw/openclaw-integration-features-spec.md) |

### Dependency graph

```
153 (Failover) ──┬──► 152 (Plugin Approval) ──► 155 (ClawHub)
                 │
151 (Exec Items) ┼──► 150 (Task Flow) ──┐
                 │                       ├──► 156 (Dreaming Memory)
                 └──► 154 (ACPX) ───────┘
```

### Recommended execution order

1. **153, 151** — independent. Start in parallel. 153 is the quickest win (config-only). 151 unlocks observability for all later features.
2. **152** — plugin approval hook. Unblocked by 153. Adds agent-side safety before orchestration changes.
3. **150, 154** — unblocked by 151. Can be worked in parallel. 150 is the largest change (Task Flow integration). 154 is the dispatch upgrade.
4. **155** — unblocked by 152. Community publishing + dynamic skill discovery.
5. **156** — unblocked by 150 + 154. Dreaming memory benefits from the improved session infrastructure.

### Non-functional requirements (apply to all M21 features)

- All features gated behind environment variables, disabled by default.
- Features 150, 152, 154 require OpenClaw >= v2026.4.2. Features 151, 155, 156 require >= v2026.4.5.
- Docker Compose config uses `latest`; the registry does not publish semver tags so pinning is not currently possible.
- Existing HTTP hook dispatch, polling-based completion, and static skill bootstrap must continue to work when new features are disabled.
- No feature may break the existing single-issue or project mode pipelines.

---

## M22 — OpenClaw Security & Resilience Hardening

Source reference: [`docs/openclaw/OPENCLAW_AUDIT.md`](/home/derek/code/RedDwarf/docs/openclaw/OPENCLAW_AUDIT.md). **Read the full audit before implementing any feature in this milestone.** It contains the root cause analysis, affected file locations, and detailed recommendations for each finding.

Findings originate from a comprehensive integration audit conducted 2026-04-07 covering all seven OpenClaw integration surfaces. Items are ordered by priority (P1 first), then severity.

### Phase 1 — Critical Security (no dependencies, highest urgency)

| # | Feature | Status | Depends On | Audit Ref |
| - | ------- | ------ | ---------- | --------- |
| 157 | **Scope Docker env injection to minimal required secrets** — Replace the verbatim `env_file` injection of `.env` into the OpenClaw container with an explicit, minimal env block. Only pass `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_HOOK_TOKEN`, `OPENCLAW_BASE_URL`, and the active model API key. All other secrets (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, `DATABASE_URL`, `REDDWARF_OPERATOR_TOKEN`) must be absent from the OpenClaw process environment. Verify by inspecting `docker inspect` output after change. | complete | — | [F-157](docs/openclaw/OPENCLAW_AUDIT.md#f-157-env-secrets-exposure-in-docker-container) |
| 158 | **Document and audit agent tool allow/deny groups as sole sandbox enforcement** — Runtime sandboxing is `mode: "off"` for all agents (Feature 105 has no active timeline). Audit every agent role's tool allow/deny groups to verify they match the declared `sandboxMode` intent. Produce a written summary in `docs/openclaw/AGENT_TOOL_PERMISSIONS.md` listing each agent, its declared mode, its tool grants, and any gaps. Flag gaps as follow-on issues. Update `openclaw-config.ts` comments to explicitly document that the container boundary is the only runtime enforcement. | complete | — | [F-158](docs/openclaw/OPENCLAW_AUDIT.md#f-158-runtime-sandboxing-disabled-for-all-agents) |
| 159 | **Fail-closed on policy lookup failure in before-tool-call hook** — Change the plugin's `handleBeforeToolCall()` fallback from fail-open (`{ allowedPaths: [], deniedPaths: [] }`) to fail-closed: deny the tool call when `GET /sessions/policy` fails after 2–3 retries. Log the failure reason as a structured warning that appears in operator audit trails. Add a test fixture that simulates policy endpoint failure and asserts the tool call is denied. | complete | — | [F-159](docs/openclaw/OPENCLAW_AUDIT.md#f-159-policy-lookup-fails-open) |
| 160 | **Remove HOOK_TOKEN from openclaw secret scope** — Remove `OPENCLAW_HOOK_TOKEN` from the `openclaw` secret scope in `createOpenClawSecretsAdapter()`. If a legitimate internal use case exists for agents needing gateway write access, document it and gate it behind a dedicated named scope (e.g., `openclaw_dispatch`). Add a test asserting the `openclaw` scope does not expose the hook token. | complete | — | [F-160](docs/openclaw/OPENCLAW_AUDIT.md#f-160-hook-token-exposed-via-openclaw-secret-scope) |

### Phase 2 — High Severity (unblocked by Phase 1 or independent)

| # | Feature | Status | Depends On | Audit Ref |
| - | ------- | ------ | ---------- | --------- |
| 161 | **Add retry logic to AcpxOpenClawDispatchAdapter** — Implement the same 429/529 retry-with-linear-backoff behaviour as `HttpOpenClawDispatchAdapter` (default: 3 attempts, 2 s base delay). Additionally, when the ACPX endpoint returns 404 (version mismatch), fall back to `HttpOpenClawDispatchAdapter` and emit a warning run event. Add tests covering 429→retry→success and 404→fallback paths. | complete | — | [F-161](docs/openclaw/OPENCLAW_AUDIT.md#f-161-acpx-adapter-has-no-retry-logic) |
| 162 | **Default agent-to-agent messaging to opt-in** — Change `enableAgentToAgent` default from `true` to `false` in `generateOpenClawConfig()`. Update `openclaw.json` generation to require explicit opt-in per agent pair rather than roster-wide. Add the architecture reviewer and validator roles to the deny list for `sessions_send`. Document the change in `docs/openclaw/OPENCLAW_AUDIT.md`. | complete | — | [F-162](docs/openclaw/OPENCLAW_AUDIT.md#f-162-agent-to-agent-messaging-enabled-by-default) |
| 163 | **Startup-time stale secret lease audit and cleanup** — Add a startup routine that scans workspace directories for secret lease files belonging to runs that are not currently active and scrubs them. Add a periodic cleanup (every 15 min) targeting workspace secret files older than the maximum run duration. Ensure SIGTERM handling in the developer phase runs scrub before exit even when the Node process is terminated by the container runtime. | complete | — | [F-163](docs/openclaw/OPENCLAW_AUDIT.md#f-163-secret-lease-cleanup-is-best-effort-only) |
| 164 | **Fix tool approval polling — jitter, single endpoint, pending state** — Refactor the plugin approval polling loop to: (1) use a single `GET /tool-approvals/:id` endpoint returning current status instead of two separate status-filtered queries; (2) add exponential backoff with jitter (initial 1 s, max 8 s); (3) distinguish `status=pending` (keep polling) from not-found (deny immediately). Add corresponding operator API endpoint `GET /tool-approvals/:id` if not already present. | complete | — | [F-164](docs/openclaw/OPENCLAW_AUDIT.md#f-164-tool-approval-polling-no-jitter-and-no-pending-check) |
| 165 | **Prompt sanitization and length cap before OpenClaw dispatch** — Define a `sanitizeUserContent(text: string): string` utility in `packages/integrations` that strips null bytes and control characters from user-supplied content. Apply it to all GitHub issue body content embedded in `buildOpenClawDeveloperPrompt` and `buildOpenClawArchitectPrompt`. Enforce a maximum assembled prompt length (configurable via `REDDWARF_MAX_PROMPT_CHARS`, default 128 000); truncate with a visible marker if exceeded. Add tests for the sanitizer and the length cap. | complete | — | [F-165](docs/openclaw/OPENCLAW_AUDIT.md#f-165-no-prompt-sanitization-before-dispatch) |
| 166 | **Enforce session key normalization at the type level** — Introduce a branded `NormalizedSessionKey` type in `packages/contracts`. Update `normalizeOpenClawSessionKey()` to return this type. Update all dispatch, awaiter, and registry function signatures to require `NormalizedSessionKey` instead of `string`. TypeScript will then prevent un-normalized keys at compile time. Add a CI grep-based check that flags direct `github:issue:` string literals outside of `openclaw-session-key.ts`. | complete | — | [F-166](docs/openclaw/OPENCLAW_AUDIT.md#f-166-session-key-normalization-coverage) |
| 167 | **Cancel Task Flow on all abnormal pipeline termination paths** — Call `cancelFlow` in the `OpenClawCompletionTimeoutError`, `OpenClawSessionStalledError`, and unhandled exception paths in `executeProjectApproval` and `advanceProjectTicket`, in addition to the existing `failed` state handler. Wrap each `cancelFlow` call in a best-effort try/catch that logs but does not re-throw, so cancel failure does not mask the original error. Add tests for timeout and stall paths asserting `cancelFlow` is called. | complete | 150 | [F-167](docs/openclaw/OPENCLAW_AUDIT.md#f-167-task-flow-not-cancelled-on-abnormal-pipeline-failure) |

### Phase 3 — Low Severity / Quality Improvements

| # | Feature | Status | Depends On | Audit Ref |
| - | ------- | ------ | ---------- | --------- |
| 168 | **Consolidate tool approval polling to single HTTP call** — Add `GET /tool-approvals/:id` to the operator API returning `{ id, status, decidedBy?, decisionSummary? }`. Update the plugin polling loop to use this single endpoint instead of two separate status-filtered queries. Remove the two-call pattern once the new endpoint is verified. | complete | 164 | [F-168](docs/openclaw/OPENCLAW_AUDIT.md#f-168-tool-approval-polling-issues-two-http-calls-per-tick) |
| 169 | **Expose `deliver` as a configurable dispatch option** — Add `deliver?: boolean` to `OpenClawDispatchOptions` (defaulting to `false`). Pass it through in `HttpOpenClawDispatchAdapter`. Document in `.env.example` as a per-task-type override. No change to default behaviour. | complete | — | [F-169](docs/openclaw/OPENCLAW_AUDIT.md#f-169-deliver-false-hardcoded-no-runtime-override) |
| 170 | **Move ClawHub publisher allow-list to operator configuration** — Replace the hardcoded `["reddwarf/*", "anthropic/*"]` with a `REDDWARF_CLAWHUB_ALLOWED_PUBLISHERS` env var (comma-separated, defaults to the same two values). Add a `clawhub_skill_installed` evidence event type recording publisher, skill name, and version for each skill loaded in a session. Update `.env.example` with documentation. | complete | 155 | [F-170](docs/openclaw/OPENCLAW_AUDIT.md#f-170-clawhub-allowlist-hardcoded-no-operator-override) |
| 171 | **Harden session transcript parsing against malformed/crafted input** — In `parseSessionJsonl()`, add strict schema validation (Zod) for each JSONL line before processing. Unknown event types and structurally invalid entries must be logged and skipped, not processed. This prevents a compromised agent from crafting JSONL entries that influence stall/termination detection or inject false execution items. Add fuzz-style tests with malformed JSONL inputs. | complete | — | [F-171](docs/openclaw/OPENCLAW_AUDIT.md#f-171-no-integrity-check-on-session-transcript-files) |
| 172 | **Cache and timeout OpenClaw health check in dashboard bootstrap** — In `resolveOpenClawUiStatus()`, add a 2 s `AbortSignal.timeout` to the health check fetch. Cache the result for 15 s (module-level `Map<string, { status, cachedAt }>`) so repeated bootstrap calls share a single in-flight check. Serve the cached value if OpenClaw is unreachable, with a `stale: true` flag in the response. | complete | — | [F-172](docs/openclaw/OPENCLAW_AUDIT.md#f-172-openclaw-health-check-blocks-dashboard-bootstrap) |
| 173 | **Integration test coverage for HTTP hook and ACPX dispatch adapters** — Add tests in `packages/integrations` using `msw` (or equivalent HTTP mocking) covering: 429→retry→success, 429→retry exhausted (throws), 504 timeout, non-JSON success response, ACPX 404 version mismatch→fallback, and ACPX 429 (currently unhandled). Tests must run in CI without a live OpenClaw instance. | complete | 161 | [F-173](docs/openclaw/OPENCLAW_AUDIT.md#f-173-dispatch-adapter-integration-test-coverage-gap) |

### Dependency graph

```
157 (Env scoping) ─────────────────────────────────────────────────────────────┐
158 (Tool audit) ──────────────────────────────────────────────────────────────┤ independent
159 (Fail-closed policy) ──────────────────────────────────────────────────────┤
160 (Hook token scope) ────────────────────────────────────────────────────────┘

161 (ACPX retry) ──────────────────────────────────────────► 173 (Adapter tests)
162 (A2A opt-in) ──────────────────────────────────────────┐ independent
163 (Secret lease cleanup) ─────────────────────────────────┤
164 (Approval polling) ─────────────────────────────────────┼──► 168 (Single endpoint)
165 (Prompt sanitization) ──────────────────────────────────┤
166 (Session key type) ─────────────────────────────────────┤
167 (Task Flow cancel) [needs 150] ─────────────────────────┘

155 (ClawHub) ──► 170 (Allowlist config)
```

### Recommended execution order

1. **157, 158, 159, 160** — P1 critical security. All independent. Work in parallel. 157 and 160 are the highest blast-radius items and should be delivered first.
2. **161, 162, 163, 165, 166, 171, 172** — independent P2/P3 items. Work in parallel after P1 is clear.
3. **164** — approval polling refactor. Independent but best done alongside 168 planning.
4. **167** — requires M21 Feature 150 to be merged and stable.
5. **168** — consolidation follow-on to 164.
6. **169, 170** — low-priority configuration improvements. 170 requires M21 Feature 155.
7. **173** — test coverage. Requires 161 (ACPX retry) to be merged so tests cover the fixed behaviour.

### Non-functional requirements (apply to all M22 features)

- P1 items (157–160) must not introduce regressions to the existing HTTP hook dispatch, ACPX dispatch, or completion awaiter paths.
- All changes to `openclaw-config.ts`, dispatch adapters, or the plugin must be verified with the existing integration test suite (`verify:all`) before commit.
- No new required env vars added without a corresponding entry in `.env.example` with a comment.
- Changes to the plugin (`reddwarf-operator`) must be verified against a local OpenClaw instance before commit.
- TypeScript strict mode must pass across all modified packages after each feature merge.
