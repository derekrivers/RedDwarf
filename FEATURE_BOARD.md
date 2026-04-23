# RedDwarf Feature Board

The board is ordered by implementation priority.

This active board only lists pending work. Completed items are archived in [features_archive/COMPLETED_FEATURES.md](/home/derek/code/RedDwarf/features_archive/COMPLETED_FEATURES.md).

---

## No pending work

All milestones through **M24 — Measurement, Safety Nets, and Operator Triage** are complete and archived. The most recent sweep on 2026-04-19 closed:

- **M23 — Dashboard & Operator UX** (Features 174–178)
- **M24 — Measurement, Safety Nets, and Operator Triage** (Features 179–188)

To pick the next milestone, draft new entries here and reference the source spec or research note. Recent inputs that have been mined for backlog items:

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
