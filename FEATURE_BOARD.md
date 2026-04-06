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
