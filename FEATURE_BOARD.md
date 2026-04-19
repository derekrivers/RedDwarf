# RedDwarf Feature Board

The board is ordered by implementation priority.

This active board only lists pending work. Completed items are archived in [features_archive/COMPLETED_FEATURES.md](/home/derek/code/RedDwarf/features_archive/COMPLETED_FEATURES.md).

---

## M25 — Project Mode robustness, evidence integrity, observability polish

Source reference: [`RedDwarf_Research_v2.md`](/home/derek/code/RedDwarf/RedDwarf_Research_v2.md). **Read §3.1 (Correctness gaps), §3.3 (Polish gaps), and §3.4 (Strategic gaps) before implementing any feature in this milestone.** This milestone picks up the v2 research items that remain after M24 — items the v2 doc raised that have not already been delivered by M23/M24. Items the doc raised that *are* already done (G5 cost attribution, G6 quality telemetry, G7 policy-pack correlation, P1 board drift, S2 playbooks, S3 shadow-run, S6 daily autonomy budget) are deliberately omitted.

### Phase 1 — Correctness (highest priority)

| # | Feature | Status | Depends On | Notes |
| - | ------- | ------ | ---------- | ----- |
| 189 | **Project Mode drift auditor** — Add a periodic background job that reconciles RedDwarf's view of every executing `ProjectSpec` against GitHub's view. For each project: compare local `TicketSpec.status` to the linked GitHub sub-issue's open/closed state and to the linked PR's merged state. Discrepancies (e.g. ticket marked `dispatched` but the GitHub sub-issue is closed; ticket marked `pr_open` but the PR has been merged for >24h without an `advance_ticket` callback firing) emit a `PROJECT_DRIFT_DETECTED` run event with a structured payload describing the divergence and surface on the dashboard's Triage page alongside quarantined tasks. Cheap, deterministic, no LLM call. Configurable via `REDDWARF_PROJECT_DRIFT_AUDIT_INTERVAL_MS` (default 600000 = 10 min) and `REDDWARF_PROJECT_DRIFT_AUDIT_ENABLED` (default `true`). | pending | — | v2 §3.1 G1. The most important correctness item — Project Mode state machines wedge silently in production and you only miss this until the first incident. |
| 190 | **Evidence integrity: tamper-detection on read + per-project retention** — `ArchivedEvidenceArtifact` already records a SHA-256 (see [workspace.ts:199, 1006](packages/control-plane/src/workspace.ts)). Two missing pieces: (1) a `verifyArchivedArtifact(record)` helper that re-hashes the file on disk and asserts equality, called from `GET /runs/:id/evidence` and the dashboard evidence viewer; mismatches surface a 500 with `error: "evidence_integrity_failed"` and emit an `EVIDENCE_TAMPER_DETECTED` warn-level run event. (2) Schema-driven retention: a new `evidence_retention_policies` table keyed on `repo` (or `project_id`) with `retain_days` and `applied_at`. The boot-time evidence cleanup honours per-repo policies before falling back to `REDDWARF_EVIDENCE_MAX_AGE_DAYS`. | pending | — | v2 §3.1 G4. Half done — content-addressable storage exists; the verification + per-project retention layers are the gap. Cheap to add before there is 10 GB of evidence pre-dating any integrity scheme. |
| 191 | **Single-issue path snapshot-diff regression test** — Lock the legacy single-issue planning path to a committed fixture so Project Mode work cannot quietly regress it. Add a fixture at `tests/fixtures/single-issue-snapshot/` containing a deterministic input issue payload and a captured baseline of: persisted PlanningSpec JSON, ordered phase records, run-event codes (in order). New regression test in `tests/regression/single-issue-snapshot.test.ts` runs the planning pipeline against the fixture (with the deterministic agents already used elsewhere) and asserts the produced shape is structurally equal to the baseline. The baseline can be re-captured intentionally via `pnpm test:regenerate-snapshots`; an unintentional drift fails CI. | pending | — | v2 §3.1 G3. The only practical way to stop bigger Project Mode work from quietly regressing the smaller-but-still-primary path. |

### Phase 2 — Operator-visible safety surfaces

| # | Feature | Status | Depends On | Notes |
| - | ------- | ------ | ---------- | ----- |
| 192 | **Sandbox status as first-class operator state** — Today `OpenClaw agent sandboxing: mode='off'` is documented in `ARCHITECTURE.md` §14 but invisible at runtime. Two changes: (1) Surface the sandbox mode on the dashboard via a new `GET /security/sandbox` endpoint (`{ mode: "off"\|"workspace_write"\|"read_only", source: "openclaw_config" }`), rendered as a banner on the dashboard home page when `mode !== "workspace_write"`, with copy "Agent sandboxing: OFF — outer container + tool allow/deny active." (2) Add a `sandboxRequired` field to risk-class metadata (default `false` for low/medium, default `true` for high) that short-circuits dispatch with a `SANDBOX_REQUIRED_BUT_DISABLED` failure when the runtime sandbox mode does not satisfy the requirement. Operators deciding what risk class to auto-approve no longer have to remember to read the docs. | pending | — | v2 §3.1 G2. |

### Phase 3 — Institutional memory & docs

| # | Feature | Status | Depends On | Notes |
| - | ------- | ------ | ---------- | ----- |
| 193 | **`docs/adr/` scaffold + ADR-0001** — Add a `docs/adr/` directory with a one-page `README.md` describing the ADR conventions (numbered, dated, one-page, status: `accepted`/`superseded`, structure: Context → Decision → Consequences). Ship `docs/adr/0001-reddwarf-domain-openclaw-runtime.md` capturing the split that already exists in `ARCHITECTURE.md` §1 — this is the most-referenced architectural decision in the codebase and deserves a canonical home. Every future major decision (the GitHub-Actions-vs-webhook pivot for project advance, the MCP bridge design, the Project Mode introduction) gets its own numbered ADR. | pending | — | v2 §3.3 P3. The OD-01/OD-03 decision log at the end of `reddwarf_project_mode_spec.md` is the format to standardise on. |
| 194 | **`docs/INDEX.md` discoverability map** — `docs/` now has 15+ files across narrative, operator, reference, and spec buckets with no map. Add `docs/INDEX.md` (or an `Index` section in a new `docs/README.md`) grouped into four buckets: (1) Narrative — README → GETTING_STARTED → ARCHITECTURE; (2) Operator — DEMO_RUNBOOK, VPS_DEPLOYMENT, VPS_OPERATIONS, WEBHOOK_SETUP; (3) Reference — `reference/*`, `.env.example`, COMMANDS.md; (4) Specs — `reddwarf_project_mode_spec.md` (move under `docs/specs/`), `openclaw/*`, future ADRs. Link to `docs/INDEX.md` from the top of the README. | pending | — | v2 §3.3 P2. Trivial doc PR; high payoff for new-contributor onboarding. |
| 195 | **Release tagging discipline + first `v0.x.0` tag** — Zero git tags exist today. Document a tagging policy in `docs/adr/0002-release-tagging.md` (or in `docs/CONTRIBUTING.md`): bump `0.x.0` on each meaningful jump (new milestone, schema migration, API surface change). Tag `v0.1.0` retroactively at the current `master` HEAD. Update `docs/VPS_OPERATIONS.md §3` so the deploy script can be invoked with a tag (`bash scripts/vps-update.sh --ref v0.1.0`) and the deploy log records which tag was deployed. Ties to evidence retention (190) — knowing which version produced which evidence becomes useful as the archive grows. | pending | 193 | v2 §3.3 P6. |

### Phase 4 — Strategic

| # | Feature | Status | Depends On | Notes |
| - | ------- | ------ | ---------- | ----- |
| 196 | **Per-project budgets, priorities, and policy overrides** — F-183 added an org-level daily budget. The next layer is per-project: extend the `projects` table with `daily_token_budget`, `daily_cost_budget_usd`, `priority` (1-10), and `policy_overrides` (JSONB layered on top of the base policy pack). The dispatcher's daily-budget gate already reads a per-task accumulated cost; extend it to compute per-project rollups and refuse dispatch when a project's quota is exhausted. The `priority` value affects ready-queue ordering (highest first within the same lifecycle status). `policy_overrides` is consulted before falling back to the global pack — the high-risk fintech repo gets stricter defaults than the docs repo. New endpoints `GET /projects/:id/budget`, `PUT /projects/:id/limits`. | pending | — | v2 §3.4 S1. Real once a portfolio of repos is in active use. |

### Out of scope (research doc proposals explicitly deferred)

- **v2 §3.4 S4 — Parallel ticket execution in Project Mode.** Out of scope for v1 of Project Mode by design. Worth capturing the contract invariants (path-level conflict detection, branch isolation, evidence isolation) in an ADR before someone tries it, but no implementation work yet. Track via ADR-0003 once F-193 lands.
- **v2 §3.4 S5 — Human-in-the-loop pairing mode.** Speculative and would cut across all five planes. Revisit only after M25 ships and the operator surfaces have settled.
- **v2 §4 P5 — Kryten plays two roles (arch reviewer + validator).** Cosmetic; addressing it requires renaming live agents. Skip unless logs become genuinely confusing in operation.
- **v1 D4 Policy-pack marketplace** — half-delivered by ClawHub skill publishing (F-155). Hold until there is genuine third-party pack demand.

### Non-functional requirements (apply to all M25 features)

- All new endpoints require `REDDWARF_OPERATOR_TOKEN` and respect the existing operator-API rate limits.
- No new required env vars added without a corresponding entry in `.env.example` with a comment.
- TypeScript strict mode must pass across all modified packages after each feature merge.
- Full vitest suite must pass after every feature.
- Schema migrations follow the existing `packages/evidence/drizzle/NNNN_*.sql` numbering and use `ALTER TYPE ... ADD VALUE IF NOT EXISTS` for enum extensions.
- Each feature should land with a brief entry in the relevant follow-up section of `docs/agent/Documentation.md` so future agent sessions have context.

---

### Known follow-ups (deferred from completed features)

These are explicitly scoped out of the v1 features that shipped them; promote to a board item when there is concrete demand.

- **F-187 follow-up** — direct-injection (`POST /tasks/inject`) does not yet apply playbook routing; only polling and webhook intake do today. Small change in `operator-api.ts:buildPlanningTaskInputFromInjection`.
- **F-187 follow-up** — dashboard playbook badge on task detail; needs `PlanningTaskInput.metadata.playbook` plumbed onto the persisted `TaskManifest` first.
- **F-188 follow-up** — thread the `IntakeAdapter` interface through the polling daemon and webhook receiver. The contract exists; the daemon still calls `GitHubAdapter.listIssueCandidates` directly.
- **F-186 follow-up** — dashboard surface for `notes` and `heartbeat-kick` verbs. The endpoints work via curl today.
- **F-184 follow-up** — relocate the contract-check phase from SCM-time to between Developer and Validator. Blocked on persisting the developer's diff into the validator workspace.
- **F-182 follow-up** — extend the shadow-run harness to re-execute the LLM architect pass against a candidate pack. Needs provider credits and real OpenClaw dispatch.
