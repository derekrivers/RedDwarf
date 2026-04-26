# RedDwarf Feature Board

The board is ordered by implementation priority.

This active board only lists pending work. Completed items are archived in [features_archive/COMPLETED_FEATURES.md](/home/derek/code/RedDwarf/features_archive/COMPLETED_FEATURES.md).

---

## M25 — Project Mode Auto-Merge (hidden, opt-in)

**Goal.** From the moment a Project Mode issue is intaken, allow approved projects to auto-merge their sub-ticket PRs once the build is green — without a human clicking Merge — while *guaranteeing* that "green" actually means something. The feature is hidden behind a global flag (`REDDWARF_PROJECT_AUTOMERGE_ENABLED`, default `false`) and a per-project opt-in (`projects.auto_merge_enabled`), and force-falls-back to human review whenever the verification contract is not satisfied.

**Why this is a milestone, not a single feature.** The naive version ("on `check_suite.completed`, if conclusion = success, call PUT `/repos/:o/:r/pulls/:n/merge`") is the easy part. The hard part is making sure the planner *plants* meaningful checks, the gate *refuses to merge* when those checks don't exist, and the dashboard makes the auto-merge decision auditable so we don't silently ship broken code.

**Source.** Operator request 2026-04-26. No spec file yet — this milestone defines the contract.

**Sequencing.** F-189 → F-190 → F-191 → F-192 → F-193 → F-194 → F-195 → F-196 → F-197 → F-198. Most have hard upstream dependencies — do not skip ahead.

---

### F-189 — Auto-merge feature flag and per-project opt-in

**Scope.**

- Add `REDDWARF_PROJECT_AUTOMERGE_ENABLED: z.boolean()` to `packages/contracts/src/operator-config.ts` (default `false`), following the existing `REDDWARF_*_ENABLED` pattern at [operator-config.ts:22](packages/contracts/src/operator-config.ts#L22).
- Add migration `0020_project_auto_merge.sql` adding `projects.auto_merge_enabled BOOLEAN NOT NULL DEFAULT FALSE` and `projects.auto_merge_policy JSONB NOT NULL DEFAULT '{}'::jsonb`. The `auto_merge_policy` blob holds the resolved `RequiredCheckContract` (see F-190) so historic runs remain reproducible even if the global policy changes.
- Surface both fields on `ProjectSpec` in `@reddwarf/contracts` (`autoMergeEnabled: boolean`, `autoMergePolicy: AutoMergePolicy | null`).
- `POST /projects/:id/approve` accepts an optional `auto_merge: { enabled: boolean }` payload. When `enabled: true` and the global flag is `false`, return `409 auto_merge_globally_disabled`.
- `POST /projects/inject` accepts the same opt-in so Context-driven projects can ship with auto-merge pre-armed.

**Acceptance criteria.** AC-1 Migration applies clean and is idempotent. AC-2 Existing projects load with `autoMergeEnabled = false`. AC-3 Approving a project with `auto_merge.enabled = true` while the global flag is off returns 409 and does not mutate state. AC-4 New unit test in `operator-api.test.ts` for both the happy and the 409 path.

**Architecture trace.** Contracts, Control Plane, Evidence Plane.

---

### F-190 — `RequiredCheckContract` on `ProjectSpec` and `TicketSpec`

**Scope.** This is the "make 'green' mean something" half of the feature. Without it, F-194 will happily merge PRs whose CI does nothing.

- Add a new `requiredCheckContract` field to both `ProjectSpec` and `TicketSpec` in `@reddwarf/contracts`:
  ```ts
  type RequiredCheckContract = {
    requiredCheckNames: string[];        // e.g. ["build", "test", "lint"]
    minimumCheckCount: number;            // refuse merge if fewer checks ran
    forbidSkipCi: boolean;                // refuse merge if any commit on the branch contains [skip ci]
    forbidEmptyTestDiff: boolean;         // refuse merge if PR diff has zero test-file changes (unless ticket.kind === "docs")
    rationale: string;                    // human-readable explanation persisted as evidence
  };
  ```
- Migration `0020` (same migration as F-189) adds `required_check_contract JSONB NOT NULL DEFAULT '{}'::jsonb` to both `projects` and `tickets`.
- Update `ticket_specs` Drizzle schema, repository row mappers, and `executeProjectApproval` so existing projects read back as a no-op contract (`{requiredCheckNames: [], minimumCheckCount: 0, ...}`) — auto-merge gate (F-194) treats an empty contract as "ineligible for auto-merge" and falls back to human review.

**Acceptance criteria.** AC-1 Round-trip test: persist a project with a non-empty contract, reload, assert deep-equal. AC-2 Repository tests cover both `projects` and `tickets` paths. AC-3 No regression in [project-planning.test.ts](packages/control-plane/src/pipeline/project-planning.test.ts).

**Architecture trace.** Contracts, Evidence Plane, Approval and Risk Model.

---

### F-191 — Holly planner emits `RequiredCheckContract` per ticket

**Scope.** Holly already produces `ProjectSpec` + `TicketSpec[]` during project-mode planning ([pipeline/project-planning.ts](packages/control-plane/src/pipeline/project-planning.ts)). Extend the planner so each ticket *and* the project carry a `requiredCheckContract`:

- Augment the project-planning prompt in `pipeline/prompts.ts` to require Holly to declare, per ticket, a list of required CI check names, drawn from a deterministic survey of the target repo's `.github/workflows/*.yml` job names performed *before* the LLM call. Pass that survey into the prompt as authoritative ground truth — Holly is forbidden to invent check names.
- If the target repo has no workflows that produce checks (greenfield), Holly must emit `requiredCheckNames: []` *and* a planning constraint flagging "CI scaffold required" so F-192 knows to install one.
- Persist contract via the F-190 schema during `holly:project-planning` phase commit.

**Acceptance criteria.** AC-1 Snapshot test: given a fixture repo with `build` + `test` jobs, planner emits `requiredCheckNames: ["build","test"]` for every ticket. AC-2 Given a fixture repo with no workflows, planner emits empty contract + constraint. AC-3 Required-check names that don't exist in the surveyed workflow list are rejected at parse-time with a typed error (don't trust the model).

**Architecture trace.** Knowledge & Policy Plane, Execution Plane, Integration Plane.

**Depends on:** F-190.

---

### F-192 — CI scaffold installer when target repo has no checks

**Scope.** When F-191 reports an empty workflow survey on an auto-merge-opted-in project, install a minimal `reddwarf-required-checks.yml` GitHub Actions workflow into the target repo at project-approval time, alongside the existing `reddwarf-advance.yml` install in [project-approval.ts:699](packages/control-plane/src/pipeline/project-approval.ts#L699).

- Workflow runs `lint`, `build`, and `test` jobs detected from the repo's `package.json` / `pyproject.toml` / `Cargo.toml` using a small language-detection helper.
- If detection fails (no recognized manifest), the installer skips, logs a warning, and the project's `auto_merge_enabled` is auto-flipped to `false` with an evidence record explaining why.
- Idempotent on file path; never overwrites an existing workflow with the same name.

**Acceptance criteria.** AC-1 Unit test for each detected stack (Node, Python, Rust). AC-2 Integration test with a fixture repo using `nock`/`msw` for the `PUT /repos/.../contents/.github/workflows/reddwarf-required-checks.yml` call. AC-3 Auto-disable path emits a `policy_gate` evidence record and a Discord notification when the Discord notifier is enabled.

**Architecture trace.** Integration Plane, Control Plane, Knowledge & Policy Plane.

**Depends on:** F-189, F-191.

---

### F-193 — GitHub `check_suite`/`check_run`/`status` webhook ingestion

**Scope.** The webhook receiver ([packages/integrations/src/github.ts](packages/integrations/src/github.ts) — see existing `pull_request: closed` handling) currently only listens for `pull_request` events. Add three more:

- `check_suite` (action `completed`)
- `check_run` (action `completed`)
- `status` (commit-status API, for repos that haven't migrated to Checks)

For each event:

1. Resolve the head SHA → most-recent open PR via the existing GitHub adapter.
2. Look up `tickets` by `github_pr_number` to confirm this is a RedDwarf-authored PR; ignore otherwise.
3. Persist a new `ci_check_observations` row (see migration `0020`) with `(ticket_id, pr_number, head_sha, check_name, conclusion, completed_at, raw_payload_evidence_id)`.
4. Enqueue a `project.auto_merge.evaluate` job (in-process, via the existing dispatcher loop) keyed by `(ticket_id, head_sha)` — debounced so a flurry of check completions on the same SHA only triggers one evaluation.

Webhook signature verification reuses the existing `X-Hub-Signature-256` HMAC path.

**Acceptance criteria.** AC-1 Unit tests for each of the three event types using fixture payloads from `tests/fixtures/github/`. AC-2 PR/SHA correlation correctly ignores PRs not in the `tickets` table. AC-3 Debounce test: 5 `check_run.completed` events for the same SHA within 1s produce exactly one queued evaluation. AC-4 Raw payloads land in evidence so the dashboard can replay them.

**Architecture trace.** Integration Plane, Control Plane, Evidence Plane.

**Depends on:** F-190 (needs the contract to know what to look for, even if the gate isn't wired yet).

---

### F-194 — Auto-merge evaluator and gate

**Scope.** Core decision logic. New module `packages/control-plane/src/pipeline/project-auto-merge.ts` exporting `evaluateAutoMerge(input, deps): AutoMergeDecision`. Called by the dispatcher when a `project.auto_merge.evaluate` job (F-193) is dequeued. Decision result is one of:

- `merge` — all gates pass, perform merge.
- `wait` — checks still in-flight or contract not yet satisfiable; do nothing, evaluator will be re-triggered by the next webhook.
- `block_human_review` — verification contract violated; mark ticket `awaiting_human_merge` and notify operator.
- `skip` — project not opted into auto-merge, or PR is not RedDwarf-authored.

**Gates evaluated, in order, all must pass for `merge`:**

1. Global flag `REDDWARF_PROJECT_AUTOMERGE_ENABLED` is `true`.
2. `project.autoMergeEnabled` is `true`.
3. `ticket.requiredCheckContract` is non-empty (F-190).
4. PR has no label `needs-human-merge` (operator escape hatch).
5. PR head SHA matches the most recent observation set; we never merge a SHA we haven't fully evaluated.
6. Every `requiredCheckNames` entry has a `check_run` observation with `conclusion === "success"` for the current head SHA.
7. Total observed check count ≥ `minimumCheckCount`.
8. `forbidSkipCi`: no commit on the PR branch contains `[skip ci]` in its message.
9. `forbidEmptyTestDiff`: PR diff (via `GET /repos/:o/:r/pulls/:n/files`) includes at least one file matching `**/*.{test,spec}.*` or `tests/**` — unless ticket carries label `docs-only`.
10. Ticket `riskClass !== "high"`. High-risk tickets always require human merge regardless of contract; this is non-overridable in v1.
11. PR has no unresolved review comments left by RedDwarf's own architecture-reviewer agent (re-use F-105's review verdict from evidence).

When `merge`: call `PUT /repos/:o/:r/pulls/:n/merge` with `merge_method: "squash"` (matches existing manual flow), record an evidence record `auto_merge_decision`, and emit a `project.auto_merge.merged` run event. The `pull_request: closed && merged` webhook then drives `reddwarf-advance.yml` → `advanceProjectTicket` exactly as today — no change to the merged-PR pathway.

When `block_human_review`: stamp PR with label `reddwarf:auto-merge-blocked`, post a single PR comment listing the failing gates (deduped — never spam), persist the decision as evidence, and notify Discord if the notifier is enabled.

**Acceptance criteria.** AC-1 Decision-table unit tests covering each of the 11 gates failing in isolation. AC-2 Idempotency: re-evaluating an already-merged PR is a no-op. AC-3 Concurrency: two evaluators racing on the same `(ticket, sha)` produce exactly one merge call (DB advisory lock keyed on `ticket_id`). AC-4 The merge call is *never* attempted with a tokenized URL — reuse the credential redaction path from F-93. AC-5 Block-human-review path produces exactly one PR comment even across 10 webhook re-fires.

**Architecture trace.** Control Plane, Integration Plane, SCM Agent, Approval and Risk Model.

**Depends on:** F-189, F-190, F-193.

---

### F-195 — Deterministic pre-flight contract check at PR open

**Scope.** The auto-merge evaluator runs *after* checks complete. Add a complementary deterministic check that runs *at the moment Lister/Kryten opens the PR*, so we fail loudly the second a ticket is on a path that can never auto-merge — instead of silently waiting forever for checks that will never run.

- Extend the deterministic pre-flight contract suite (introduced in F-184) with a new `auto_merge_eligibility` check, executed during the SCM phase right after PR creation.
- Asserts: required check names are present in the repo's workflow list; PR diff contains test changes if `forbidEmptyTestDiff`; no `[skip ci]` in any commit message; PR is targeted at the project's expected base branch.
- On failure, the ticket is moved to `awaiting_human_merge` *immediately*, with `failureClass = "auto_merge_contract_violation"`, and a PR comment is posted explaining the violation.

**Acceptance criteria.** AC-1 Each check has its own test in `tests/contract-checks/`. AC-2 The pre-flight check runs only when the project is auto-merge-opted-in (no overhead for opt-out projects). AC-3 Failure produces the same operator artifacts (label, comment, evidence) as F-194's `block_human_review` so the dashboard treatment is uniform.

**Architecture trace.** Control Plane, SCM Agent, Failure Recovery Model.

**Depends on:** F-189, F-190, F-194.

---

### F-196 — Operator dashboard surfaces

**Scope.** Without UI, this feature is unauditable.

- New project-detail card "Auto-merge" showing: opt-in state, resolved `RequiredCheckContract`, latest evaluator decision per open ticket, count of merges performed, count of blocked-for-human merges.
- Per-ticket timeline entry for each `auto_merge_decision` evidence record, expandable to show which gates passed and which failed.
- One-click "Disable auto-merge for this project" button → `PATCH /projects/:id` flipping `auto_merge_enabled` to `false`. Reversible by the same control.
- Global "Auto-merge" toggle on the operator config panel ([dashboard /config](packages/dashboard/src/api/client.ts)) writing `REDDWARF_PROJECT_AUTOMERGE_ENABLED`.

**Acceptance criteria.** AC-1 Disabling auto-merge mid-flight does not interrupt a merge already in progress (the evaluator re-checks the flag before the merge call, but does not abort an in-flight HTTP request). AC-2 Card shows "—" cleanly when contract is empty. AC-3 Dashboard test with mocked API.

**Architecture trace.** Operator Dashboard, Control Plane.

**Depends on:** F-189, F-194.

---

### F-197 — Discord and audit-log surfacing

**Scope.** Non-trivial extensions to the existing notifier ([F-177](features_archive/COMPLETED_FEATURES.md)) and audit export ([F-185](features_archive/COMPLETED_FEATURES.md)):

- Discord notification on every `block_human_review` (high-signal, low-volume).
- Discord notification on first auto-merge per project (so operator sees the system actually started auto-merging), and on every Nth auto-merge thereafter (`REDDWARF_AUTOMERGE_DISCORD_HEARTBEAT_EVERY`, default 10).
- All `auto_merge_decision` evidence records flow into the existing CSV audit export so compliance has a paper trail.

**Acceptance criteria.** AC-1 Notification rate-limit test: 50 merges produce notifications at indices 1, 11, 21, 31, 41. AC-2 CSV export includes new `decision`, `gate_failures`, `head_sha` columns when the row is an auto-merge.

**Architecture trace.** Integration Plane, Operator Surface, Evidence Plane.

**Depends on:** F-194.

---

### F-198 — Kill-switch and panic operator verbs

**Scope.** Ship the off-button before declaring this milestone done.

- New operator-API verb `POST /projects/:id/auto-merge/halt` — sets `auto_merge_enabled = false` for one project and labels every open RedDwarf PR on it with `needs-human-merge`. Idempotent.
- New operator-API verb `POST /admin/auto-merge/halt-all` — flips the global flag *and* halts every project. Logged as an audit event with the operator identity. Permission required: `operator_admin`.
- Dashboard wiring on the existing /triage page (delivered in [F-186](features_archive/COMPLETED_FEATURES.md)).
- Stop condition documented in [docs/agent/Documentation.md](docs/agent/Documentation.md): if any auto-merged PR ever has to be reverted, the agent must call `halt-all` before resuming.

**Acceptance criteria.** AC-1 `halt` is safe to call repeatedly. AC-2 `halt-all` requires `operator_admin`; without it, returns 403 and does not mutate. AC-3 Both verbs produce audit-log rows visible in `/audit`. AC-4 Document the verb in [docs/VPS_OPERATIONS.md](docs/VPS_OPERATIONS.md).

**Architecture trace.** Control Plane, Operator Surface, Failure Recovery Model.

**Depends on:** F-189, F-194, F-196.

---

### Milestone exit checklist

Before archiving M25:

- [ ] F-189 through F-198 all flipped to completed.
- [ ] End-to-end demo on a sandbox repo: opt in a fresh project, watch one ticket auto-merge with green checks, watch a second ticket get blocked because `forbidEmptyTestDiff` triggered, watch a third get rescued by `halt`.
- [ ] Soak test: leave auto-merge enabled on the demo repo for 48h with a synthetic ticket producer; verify no spurious merges, no missed merges, no notification storms.
- [ ] Operator runbook entry in [docs/VPS_OPERATIONS.md](docs/VPS_OPERATIONS.md) covering: how to enable, how to halt, how to read a blocked decision, what triggers the rate-limited Discord heartbeat.

---

To pick the next milestone after M25, draft new entries here and reference the source spec or research note. Recent inputs that have been mined for backlog items:

- [`RedDwarf_Research.md`](/home/derek/code/RedDwarf/RedDwarf_Research.md) — external review (Wave 1–5 features were the basis for M24)
- [`docs/openclaw/OPENCLAW_AUDIT.md`](docs/openclaw/OPENCLAW_AUDIT.md) — security/resilience audit (basis for M22)
- [`docs/openclaw/openclaw-integration-features-spec.md`](docs/openclaw/openclaw-integration-features-spec.md) — integration spec (basis for M21)
- [`docs/reddwarf_project_mode_spec.md`](docs/reddwarf_project_mode_spec.md) — project-mode spec (basis for M20)

### Recently landed (not yet archived)

- **POST /projects/inject** — operator API route that accepts a pre-built `ProjectSpec` from Context (github.com/derekrivers/context) along with `{ context_spec_id, context_version, adapter_version, target_schema_version, translation_notes }` and deposits the project into the same `pending_approval` state a Project Mode planning run reaches. Idempotent on `(context_spec_id, context_version)` via a `project_spec_provenance` table constraint. Gated by `REDDWARF_PROJECTS_INJECT_ENABLED` (default `true`). Migration 0019. Pairs with Context ticket T-10.

### Known follow-ups (deferred from completed features)

These are explicitly scoped out of the v1 features that shipped them; promote to a board item when there is concrete demand.

- **F-187 follow-up** — direct-injection (`POST /tasks/inject`) does not yet apply playbook routing; only polling and webhook intake do today. Small change in `operator-api.ts:buildPlanningTaskInputFromInjection`.
- **F-187 follow-up** — dashboard playbook badge on task detail; needs `PlanningTaskInput.metadata.playbook` plumbed onto the persisted `TaskManifest` first.
- **F-188 follow-up** — thread the `IntakeAdapter` interface through the polling daemon and webhook receiver. The contract exists; the daemon still calls `GitHubAdapter.listIssueCandidates` directly.
- **F-186 follow-up** — dashboard surface for `notes` and `heartbeat-kick` verbs. The endpoints work via curl today.
- **F-184 follow-up** — relocate the contract-check phase from SCM-time to between Developer and Validator. Blocked on persisting the developer's diff into the validator workspace.
- **F-182 follow-up** — extend the shadow-run harness to re-execute the LLM architect pass against a candidate pack. Needs provider credits and real OpenClaw dispatch.

### Out of scope (research doc proposals explicitly deferred)

- **D4 Policy-pack marketplace** — half-delivered by ClawHub skill publishing (F-155). Hold until there is genuine third-party pack demand.
- **D6 Human-in-the-loop pairing mode** — speculative and would cut across all five planes.
- **D1 Multi-project tenancy extensions** (quotas, project-scoped policy overrides, cross-project concurrency caps) — M20 Project Mode delivered `projects` as a planning concept. Tenancy-level extensions are real but not urgent while there is a single primary repo in use.
