# RedDwarf — Project Mode

*Autonomous planning, ticket decomposition, and merge-driven execution*

| Field | Value |
|---|---|
| **Project ID** | REDDWARF-PROJ-001 |
| **Status** | Pending Approval |
| **Requested by** | Derek Rivers |
| **Coordinated by** | Rimmer (coordination agent) |
| **Architect** | Architect agent |
| **Project size** | Large — 8 tickets across 4 phases |
| **Risk class** | Medium — new integrations, no destructive DB changes |
| **Date** | April 2026 |

---

## 1. Problem statement

The current RedDwarf pipeline routes directly from GitHub issue intake to a single Architect planning spec, then to the Developer agent in one continuous run. This works reliably for small, well-scoped tasks. For anything broader — a feature touching multiple packages, a new integration, a cross-cutting change — the pipeline produces timeouts, oversized code changes, and underdefined handoffs.

Three specific failure modes have been observed:

- Developer agent timeouts on tasks requiring changes across more than two or three packages in a single pass.
- Token over-consumption: the agent attempts to write all code in one run rather than working incrementally.
- Rimmer has been written out of the workflow. His role as coordination agent is dormant — he receives issues and passes them through without meaningful involvement.

The root cause is architectural: the system has no planning corridor. A real engineering team would size a request, break it down, agree on a plan, and work ticket by ticket. RedDwarf currently skips all of that.

---

## 2. Objective

Introduce a Project Mode that adds a dedicated planning phase between intake and development. When a request is classified as medium or large complexity, the system enters Project Mode. Rimmer orchestrates the planning corridor. The Architect produces a full ProjectSpec with ordered tickets. The customer approves the plan before any code is written. The dev squad works ticket by ticket, and each merged PR automatically triggers the next ticket.

Small tasks continue through the existing single-issue path unchanged. Project Mode is additive.

---

## 3. Scope and boundaries

### 3.1 In scope

- Complexity classifier embedded in Rimmer's intake phase
- ProjectSpec and TicketSpec data model with Postgres persistence
- Architect planning phase refactor — produces ordered `TicketSpec[]` in project mode
- Clarification loop: Architect flags missing context → Rimmer requests via Discord → answers fed back into planning
- Human plan approval gate via operator API
- GitHub Issues adapter: sub-issue creation per TicketSpec, linked to the original parent issue, with acceptance criteria as structured body content
- GitHub Actions workflow: triggers on PR merge, calls the operator API to advance the ticket queue
- Operator API: new project listing, approval, and ticket-advance endpoints

### 3.2 Out of scope

- Parallel ticket execution (tickets remain serial in v1 of Project Mode)
- Automated GitHub Projects board creation per project (sub-issues on the parent issue suffice for v1 tracking)
- Full Discord bot with slash commands (v1 uses outbound messages and thread replies only)
- Trello integration (replaced by GitHub Issues; see OD-01)
- Public webhook endpoint / VPS hosting requirement (replaced by GitHub Actions; see OD-03)
- Deployment or infrastructure changes

---

## 4. Proposed architecture

### 4.1 Project Mode flow

When Rimmer classifies a request as medium or large, the following sequence applies:

1. Customer request arrives via Discord or GitHub issue labelled `ai-eligible`.
2. Rimmer runs the complexity classifier. Small → existing path unchanged. Medium or Large → Project Mode.
3. Architect enters planning phase. Produces a draft ProjectSpec with ordered `TicketSpec[]` children and acceptance criteria. If context is insufficient, Architect returns a ClarificationRequest with specific questions rather than a partial spec.
4. Rimmer sends a Discord message to the configured channel with the Architect's questions. Customer replies in the thread. Rimmer feeds answers back to the Architect. Loop repeats until the Architect is satisfied.
5. Architect finalises the ProjectSpec and submits it for human approval via the operator API.
6. Customer reviews and approves (or requests amendments) at `POST /projects/:id/approve`.
7. On approval, Architect creates sub-issues against the original GitHub issue for each TicketSpec, in dependency order. Each sub-issue carries full acceptance criteria in its body.
8. First ticket with no unresolved dependencies is automatically dispatched to the dev squad.
9. Developer → Validation → SCM runs as normal. PR opened and linked to the GitHub sub-issue.
10. Customer reviews and merges the PR on GitHub.
11. GitHub Actions workflow fires on PR merge. The workflow calls `POST /projects/advance` on the operator API (authenticated with `REDDWARF_OPERATOR_TOKEN`). RedDwarf closes the sub-issue, resolves the dependency graph, and dispatches the next ready ticket.
12. Repeat from step 9 until all tickets are merged. Project is marked complete; evidence archived.

### 4.2 Rimmer's new role

Rimmer is elevated from a pass-through router to project coordinator. His responsibilities in Project Mode:

- Run the complexity classifier on incoming requests and decide routing.
- Initiate and manage the planning session lifecycle.
- Broker the clarification loop between the Architect and the customer via Discord.
- Hold the plan at `pending_approval` until the customer approves.
- Monitor project health throughout execution: notify on ticket failure, board stall, and project completion.

### 4.3 New data model

**ProjectSpec** — one per project. Key fields: `project_id`, `source_issue_id`, `status` (draft | clarification_pending | pending_approval | approved | executing | complete | failed), `tickets[]`, `approval_decision`, `decided_by`, `created_at`, `updated_at`.

**TicketSpec** — one per ticket. Key fields: `ticket_id`, `project_id` (FK), `title`, `description`, `acceptance_criteria` (JSON), `depends_on[]` (ticket_id refs), `status` (pending | dispatched | in_progress | pr_open | merged | failed), `complexity_class`, `risk_class`, `github_sub_issue_number`, `github_pr_number`.

---

## 5. Ticket breakdown

Eight tickets constitute the full delivery of Project Mode, in dependency order:

| # | Title | Scope | Depends on | Risk |
|---|---|---|---|---|
| T-01 | Complexity classifier in Rimmer | control-plane, rimmer agent | — | Low |
| T-02 | ProjectSpec schema + Postgres persistence | evidence, contracts | T-01 | Low |
| T-03 | Architect planning phase refactor | control-plane, architect agent | T-02 | Medium |
| T-04 | Discord adapter | integrations | T-02 | Low |
| T-05 | GitHub Issues adapter | integrations | T-02 | Low |
| T-06 | Architect → GitHub sub-issue writer | control-plane | T-03, T-05 | Medium |
| T-07 | GitHub Actions workflow + ticket advance endpoint | integrations, control-plane | T-06 | Medium |
| T-08 | Operator API: project approval flow | control-plane (API) | T-03, T-04 | Low |

> **Note:** T-07 risk is revised from High to Medium. The webhook signature validation complexity is eliminated; the operator token pattern used throughout the rest of the system applies directly.

---

## 6. Ticket detail and acceptance criteria

### T-01 — Complexity classifier in Rimmer

Introduce a complexity sizing function within Rimmer's intake pipeline. Evaluates the incoming request against a rubric and returns a `project_size` classification with supporting reasoning.

| # | Acceptance criterion | Validation |
|---|---|---|
| AC-1 | Function accepts a raw request string and optional repo context; returns `{ size: 'small'\|'medium'\|'large', reasoning: string, signals: string[] }` | Unit test |
| AC-2 | Requests touching ≤1 package with no schema or API surface changes are classified small | Unit test fixtures |
| AC-3 | Requests spanning 2–4 packages or requiring a new integration are classified medium | Unit test fixtures |
| AC-4 | Requests spanning 5+ packages or requiring a new DB migration are classified large | Unit test fixtures |
| AC-5 | Classification result is persisted to the planning_spec record before routing proceeds | Integration test |
| AC-6 | Small classifications route through the existing single-issue path without entering Project Mode | Integration test (routing) |

---

### T-02 — ProjectSpec schema and Postgres persistence

Add `project_specs` and `ticket_specs` tables to the evidence schema. Extend contracts with new domain types. Write Postgres-backed repository implementations for both entities.

| # | Acceptance criterion | Validation |
|---|---|---|
| AC-1 | SQL migration creates `project_specs` and `ticket_specs` with all required columns and FK constraints | db:migrate; verify:postgres |
| AC-2 | ProjectSpecRepository implements `create`, `findById`, `updateStatus`, `listByRepo` | Unit tests, test DB |
| AC-3 | TicketSpecRepository implements `create`, `findByProject`, `updateStatus`, and `resolveNextReady` (returns first ticket whose all depends_on are merged) | Unit tests, test DB |
| AC-4 | TypeScript types for ProjectSpec and TicketSpec exported from `packages/contracts` | typecheck passes |
| AC-5 | Existing evidence schema tests continue to pass without modification | pnpm test |

---

### T-03 — Architect planning phase refactor

Extend the Architect agent to support a project mode planning run that produces a full ProjectSpec with ordered `TicketSpec[]`. The existing single-spec path must remain fully operational.

| # | Acceptance criterion | Validation |
|---|---|---|
| AC-1 | Architect planning phase accepts a mode flag: `single` (existing) or `project` (new) | Unit test |
| AC-2 | In project mode, Architect produces a ProjectSpec with ≥2 TicketSpec children, each with title, description, acceptance_criteria, depends_on, and complexity_class populated | Integration test with fixture request |
| AC-3 | When context is insufficient, Architect returns a ClarificationRequest with ≥1 specific questions rather than a partial spec | Unit test with ambiguous fixture |
| AC-4 | After receiving clarification answers, Architect resumes planning from the same session context with no context loss | Integration test: clarification round-trip |
| AC-5 | Existing single-issue planning path produces identical output to pre-refactor baseline | Regression test vs fixture |
| AC-6 | ProjectSpec is persisted to Postgres before submission for human approval | Integration test |

---

### T-04 — Discord adapter

Add a Discord integration to `packages/integrations` supporting outbound messages and thread reply reads. Used by Rimmer for the clarification loop. Disabled by default behind `V1MutationDisabledError`.

| # | Acceptance criterion | Validation |
|---|---|---|
| AC-1 | DiscordAdapter implements `sendMessage(channelId, content)` and `readThreadReplies(messageId): Promise<string[]>` | Unit test, mock API |
| AC-2 | Adapter throws `V1MutationDisabledError` when `REDDWARF_DISCORD_ENABLED` is not set to true | Unit test |
| AC-3 | `DISCORD_BOT_TOKEN` and `DISCORD_CHANNEL_ID` are required env vars; startup fails with descriptive error if absent when adapter is enabled | Unit test; .env.example updated |
| AC-4 | Messages include `project_id` and ticket context for reply correlation | Integration test |
| AC-5 | readThreadReplies returns an empty array (not an error) if no replies have been posted | Unit test |
| AC-6 | Clarification loop has a configurable timeout (`REDDWARF_CLARIFICATION_TIMEOUT_MS`); on expiry, planning session moves to operator API for resolution | Unit test |

---

### T-05 — GitHub Issues adapter

Add a GitHub Issues integration to `packages/integrations` supporting sub-issue creation, status updates (open/closed), and issue reads. Each sub-issue is created against the original parent issue and carries acceptance criteria as a structured markdown body block. Disabled by default.

| # | Acceptance criterion | Validation |
|---|---|---|
| AC-1 | GitHubIssuesAdapter implements `createSubIssue(parentIssueNumber, ticketSpec)`, `closeIssue(issueNumber)`, `getIssue(issueNumber)` | Unit test, mock API |
| AC-2 | Sub-issue bodies include a structured markdown block with the full `acceptance_criteria` array from the TicketSpec, rendered as a checklist | Unit test: deserialise description, assert criteria present |
| AC-3 | Adapter throws `V1MutationDisabledError` when `REDDWARF_GITHUB_ISSUES_ENABLED` is not set to true | Unit test |
| AC-4 | `GITHUB_TOKEN` and `GITHUB_REPO` are required env vars (`GITHUB_REPO` already used by existing workflow); .env.example updated | Unit test |
| AC-5 | createSubIssue returns the GitHub issue number, stored in the TicketSpec record in Postgres as `github_sub_issue_number` | Integration test |

---

### T-06 — Architect → GitHub sub-issue writer

On project plan approval, create GitHub sub-issues against the original parent issue for each approved TicketSpec, update project status to executing, and dispatch the first ready ticket to the dev squad.

| # | Acceptance criterion | Validation |
|---|---|---|
| AC-1 | On plan approval, sub-issues are created on GitHub for all TicketSpec records in dependency order; each TicketSpec updated with its `github_sub_issue_number` | Integration test |
| AC-2 | Sub-issues created in dependency order; issue titles prefixed with priority index (e.g. [1/5]) for visibility in the GitHub issue list | Integration test: assert issue order |
| AC-3 | resolveNextReady() called after sub-issue creation; first unblocked ticket dispatched to dev squad pipeline | Integration test: assert dispatch with correct ticket_id |
| AC-4 | If GitHub Issues adapter is disabled, system falls back to Postgres-only state and logs a warning; dispatch still proceeds | Integration test, adapter disabled |
| AC-5 | Project status updated to `executing` in Postgres after dispatch | Integration test |

---

### T-07 — GitHub Actions workflow + ticket advance endpoint

Replace the inbound webhook approach with a GitHub Actions workflow that fires on PR merge and calls the RedDwarf operator API to advance the ticket queue. This eliminates the requirement for a publicly hosted endpoint. The workflow runs on GitHub's infrastructure; RedDwarf only needs to expose a local API endpoint reachable from wherever it runs (localhost, LAN, or private network).

The workflow file is committed to the repo and authenticated via `REDDWARF_OPERATOR_TOKEN` stored as a GitHub Actions secret.

| # | Acceptance criterion | Validation |
|---|---|---|
| AC-1 | `.github/workflows/reddwarf-advance.yml` triggers on `pull_request` → `closed` where `merged: true` | Workflow run log |
| AC-2 | Workflow extracts `ticket_id` from PR branch name (format: `reddwarf/ticket/{ticket_id}`) or PR body | Unit test: parse logic; workflow run log |
| AC-3 | Workflow calls `POST /projects/advance` with `{ ticket_id, github_pr_number }` authenticated via `REDDWARF_OPERATOR_TOKEN` Actions secret | Integration test; mock server |
| AC-4 | Operator API endpoint `POST /projects/advance` accepts the payload, sets TicketSpec.status to `merged`, closes the linked GitHub sub-issue, and calls resolveNextReady() | Integration test |
| AC-5 | resolveNextReady() result: if a next ticket exists it is dispatched and its sub-issue labelled `in-progress`; if none remain, project status set to `complete` | Integration test |
| AC-6 | If a dev squad run fails, project status set to `blocked`; Discord notification sent with failure details if adapter enabled | Integration test, simulated failure |
| AC-7 | `REDDWARF_OPERATOR_TOKEN` is the only new secret required; documented in `.github/workflows/reddwarf-advance.yml` header comment and `.env.example` | Review |
| AC-8 | Workflow is idempotent: re-running on an already-merged ticket logs a warning and exits without mutating state | Unit test |

---

### T-08 — Operator API: project approval flow

Add project management endpoints to the operator API. Allows review and approval of a ProjectSpec before execution begins. Extends the existing approval queue pattern.

| # | Acceptance criterion | Validation |
|---|---|---|
| AC-1 | `GET /projects` returns list of projects with current status, pending/merged/failed ticket counts | Integration test |
| AC-2 | `GET /projects/:id` returns full ProjectSpec including all TicketSpec children with current status | Integration test |
| AC-3 | `POST /projects/:id/approve` accepts `{ decision: 'approve'\|'amend', decidedBy, decisionSummary, amendments? }` and transitions status correctly | Integration test |
| AC-4 | Amend decision returns project to draft status; amendments text appended to Architect's planning context for re-run | Integration test: re-run produces updated spec |
| AC-5 | `POST /projects/advance` endpoint added (consumed by T-07 GitHub Actions workflow); accepts `{ ticket_id, github_pr_number }` and requires `REDDWARF_OPERATOR_TOKEN` | Integration test |
| AC-6 | All new routes require `REDDWARF_OPERATOR_TOKEN`; unauthenticated requests return 401 | Unit test |

---

## 7. Non-functional requirements

- All new Postgres operations must respect the existing `REDDWARF_DB_POOL_*` connection pool configuration.
- No new required environment variables added without a corresponding entry in `.env.example` with a comment.
- All new integration adapters follow the existing `V1MutationDisabledError` guard pattern and are disabled by default.
- TypeScript strict mode must pass across all modified packages after each ticket merge.
- `verify:all` must pass after every ticket. No ticket may leave the test suite in a failing state.
- The existing single-issue pipeline must remain fully operational throughout all 8 tickets. No ticket may break the current end-to-end flow.

---

## 8. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| GitHub API rate limits block batch sub-issue creation for large projects | Medium — slows T-06 for projects with 10+ tickets | Add exponential backoff; create sub-issues sequentially with a short delay. GitHub's authenticated rate limit (5,000 req/hr) is generous enough for any realistic project size. |
| Discord replies not received (customer doesn't reply in thread) | Medium — planning session stalls | Add configurable timeout (`REDDWARF_CLARIFICATION_TIMEOUT_MS`). On expiry, escalate to operator API for resolution. |
| GitHub Actions workflow fails silently on merge | Low — ticket stuck in pr_open | Workflow must exit with a non-zero code on API call failure. GitHub will surface the failed run on the PR. |
| Architect produces too many tickets (>15) for one project | Low — parent GitHub issue becomes unwieldy | Add a `max_tickets` guard in the complexity classifier. Projects classified very large flagged for manual decomposition first. |

---

## 9. Open decisions

### OD-01 — GitHub Issues selected ✓ Resolved

Trello has been removed from the plan. GitHub Issues is the execution backlog for Project Mode. The Architect creates sub-issues directly against the original parent issue on approval, keeping all project state inside GitHub and eliminating an external integration dependency. T-05 implements the GitHubIssuesAdapter. The `trello_card_id` field on TicketSpec is replaced by `github_sub_issue_number`.

### OD-02 — Discord vs operator API as primary clarification surface

The clarification loop currently routes through Discord. If you prefer all approvals and clarifications inside the operator API (avoiding the need to monitor a Discord channel during planning), that is feasible but changes T-04 scope significantly. Decision required before T-04 begins.

### OD-03 — Inbound webhook replaced by GitHub Actions ✓ Resolved

The original spec required a public webhook endpoint and `GITHUB_WEBHOOK_SECRET`, which in turn required a VPS or public host. This has been replaced by a GitHub Actions workflow that calls the operator API on merge. No public endpoint is required. `GITHUB_WEBHOOK_SECRET` is removed. The only new secret is `REDDWARF_OPERATOR_TOKEN` stored in GitHub Actions, consistent with the auth pattern used throughout the rest of the system.

---

## 10. Recommended execution order

Given the dependency graph, the recommended merge sequence is:

1. **T-01** (Complexity classifier) — no dependencies. Safe to start immediately.
2. **T-02** (Schema + persistence) — no dependencies. Start in parallel with T-01. Unblocks T-03, T-04, T-05.
3. **T-03, T-04, T-05** — all unblocked by T-02. Can be worked in any order or in parallel.
4. **T-06** (Sub-issue writer) — requires T-03 and T-05.
5. **T-08** (Operator API) — requires T-03 and T-04. Must include the `/projects/advance` endpoint before T-07 can be completed.
6. **T-07** (GitHub Actions workflow) — requires T-06 and T-08. Final ticket. Merging T-07 completes Project Mode.

---

*This document is the first formal ProjectSpec produced for RedDwarf and is intended to be fed back into the system as the seed request for its own Project Mode planning phase once T-08 is live. — April 2026*
