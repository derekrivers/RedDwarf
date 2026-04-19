# RedDwarf Feature Board

The board is ordered by implementation priority.

This active board only lists pending work. Completed items are archived in [features_archive/COMPLETED_FEATURES.md](/home/derek/code/RedDwarf/features_archive/COMPLETED_FEATURES.md).

---

## M23 — Dashboard & Operator UX

### Phase 1 — Discord Issue Submission

| # | Feature | Status | Depends On | Notes |
| - | ------- | ------ | ---------- | ----- |
| 174 | **Discord `/rdsubmit` command with modal form for issue creation** — Add a `/rdsubmit` slash command to the Discord operator plugin. The command first presents a `StringSelectMenu` populated from `GET /repos` for repo selection. On repo selection, open a Discord Modal form with fields: title (short text, required), summary (paragraph, required), acceptance criteria (paragraph, required, one per line). On modal submit, call the existing `POST /issues/submit` operator API endpoint with the collected fields and sensible defaults for capabilities and risk class. Reply with a confirmation embed containing the created issue number, link, and repo. Handle validation errors (missing fields, API failures) with user-friendly error messages. Requires `REDDWARF_OPENCLAW_DISCORD_ENABLED=true`. | pending | — | Uses existing `POST /issues/submit` and `GET /repos` operator API endpoints; no new backend work required. Discord Modals support up to 5 `TextInput` components but no native dropdowns, so the repo selector uses a `StringSelectMenu` message before opening the modal. |

### Phase 3 — CI-driven VPS deploys

| # | Feature | Status | Depends On | Notes |
| - | ------- | ------ | ---------- | ----- |
| 178 | **Manual-trigger GitHub Actions workflow for VPS deploys** — Add `.github/workflows/deploy-vps.yml` (a `workflow_dispatch`-only job) plus `scripts/vps-update.sh`, an idempotent driver that wraps the manual steps in [docs/VPS_OPERATIONS.md §3](docs/VPS_OPERATIONS.md). Workflow inputs: `ref` (branch, tag, or SHA). Required secrets: `VPS_SSH_HOST`, `VPS_SSH_USER`, `VPS_SSH_PRIVATE_KEY`. Optional repo variables: `VPS_SSH_PORT` (default 22), `VPS_REPO_PATH` (default `/root/RedDwarf`), `VPS_SERVICE_NAME` (default `reddwarf`). Must: (1) never auto-trigger on push — only manual dispatch; (2) concurrency-group the job so parallel deploys cannot race; (3) pin the host key via `ssh-keyscan` rather than disabling `StrictHostKeyChecking`; (4) remove the ephemeral private key from the runner on every exit path; (5) run the script non-interactively (`BatchMode=yes`) so a missing sudo password fails fast instead of hanging; (6) assert the systemd unit is `active` after restart and surface the last 50 journal lines on failure. The shell script is also safe to run by hand on the VPS for testing branches. | pending | — | Follows VPS_OPERATIONS §3 conventions: `/root/RedDwarf` checkout, `reddwarf` systemd unit, `corepack pnpm install && build`, dashboard filtered build, `chmod -R o+rX packages/dashboard/dist` for Caddy, `systemctl restart`. Auto-deploy on `push: master` is explicitly out of scope — promote only after the manual flow has proven reliable in real use. |

### Non-functional requirements (apply to all M23 features)

- All new Discord commands must respect the existing `REDDWARF_OPENCLAW_DISCORD_ENABLED` gate and approver ID allowlist.
- No new required env vars added without a corresponding entry in `.env.example` with a comment.
- TypeScript strict mode must pass across all modified packages after each feature merge.
- `verify:all` must pass after every feature.

---

## M24 — Measurement, Safety Nets, and Operator Triage

Source reference: [`RedDwarf_Research.md`](/home/derek/code/RedDwarf/RedDwarf_Research.md). **Read §5 Bucket B, §6 Bucket C, and §7 Bucket D of that document before implementing any feature in this milestone.** The priority order below tracks the research doc's Wave 1 → Wave 4 sequencing, with items the research doc claimed as missing that were later shipped (Reviewer agent, failure taxonomy, dashboard, direct injection, Discord bot, idempotency guards) already archived. These features are the measurement and safety-net gaps that remain.

### Phase 1 — Measurement (highest leverage)

| # | Feature | Status | Depends On | Notes |
| - | ------- | ------ | ---------- | ----- |
| 179 | **Agent quality telemetry aggregates** — Add a read-model + dashboard page that rolls up per-agent / per-task-type outcome metrics from existing `run_events` and `phase_records`: plan → validation pass rate (fraction of Holly specs that led to a first-try passing Lister run), architecture-review rejection rate, spec revision count (re-plans per task), mean phase latency (p50/p95), and retry-reason distribution keyed by `failureClass`. Expose `GET /metrics/agents?since=...&group_by=phase\|agent\|policy_pack_version`. Add an "Agent health" page to the dashboard that plots these over time. No new events captured — all aggregates derive from data already persisted. | pending | — | The individual events already exist; the missing layer is aggregation + visualisation. Research doc §5 B2. |
| 180 | **USD cost attribution and per-task cost budget** — Extend the existing token tracking in [`token-budget.ts`](packages/control-plane/src/pipeline/token-budget.ts) and [`run-report.ts`](packages/control-plane/src/pipeline/run-report.ts) with per-provider / per-model USD pricing. Persist `cost_usd` alongside `input_tokens` / `output_tokens` / `cached_tokens` on phase records. Add a `cost_budget_usd` field to task manifests with an enforced cap that short-circuits the run with a durable `COST_BUDGET_EXCEEDED` evidence entry and surfaces the task for operator triage. Expose `GET /runs/:id/cost` and `GET /runs?since=...&group_by=phase\|model`. Pricing table configurable via env (`REDDWARF_MODEL_PRICING_JSON`) with sensible defaults for Anthropic + OpenAI current lists. | pending | 179 | The byte-counting half already works; this adds the $ layer. Research doc §5 B1. |
| 181 | **Policy-pack outcome dashboard** — Tag every `pipeline_run` with the exact policy-pack version it used (likely already captured; confirm and surface). Add a dashboard ribbon that plots the 179 metrics against policy-pack version boundaries, so operators can answer "after we changed Holly's SOUL.md on pack v14, did validation pass rate go up or down?" Pairs with 182. | pending | 179 | Turns the policy pack from configuration into an experimental surface. Research doc §5 B3. |
| 182 | **Shadow-run replay harness for policy-pack regression** — Add `reddwarf shadow-run --pack <version> --replay-last <N>` CLI. Takes archived task manifests + planning evidence, re-runs the planning phase only against a candidate policy pack, diffs the resulting `PlanningSpec` / eligibility decision / risk class / ticket decomposition against the recorded outcome, and emits a replay report (markdown + JSON). Does **not** execute downstream phases, dispatch OpenClaw sessions, or touch GitHub. Lands as `scripts/shadow-run.mjs` plus a new `packages/control-plane/src/shadow-replay/` module that reuses the existing planning pipeline with mutation adapters stubbed. | pending | 181 | Promotes policy-pack releases from "hope" to "regression-tested." Research doc §6 C5. |

### Phase 2 — Safety nets

| # | Feature | Status | Depends On | Notes |
| - | ------- | ------ | ---------- | ----- |
| 183 | **Org-level daily autonomy budget** — Add a dispatcher-enforced daily org budget (both a token cap and a USD cap from 180). Once either is hit, new task dispatches are queued rather than started, a `BUDGET_EXHAUSTED` run event fires, and the Discord notifier (177) sends an alert. Budget burn-down surfaces on the dashboard home page. Config: `REDDWARF_DAILY_TOKEN_BUDGET`, `REDDWARF_DAILY_COST_BUDGET_USD`, `REDDWARF_BUDGET_RESET_TZ` (default UTC). Queued tasks auto-release when the next reset boundary is crossed. | pending | 180 | Protects against 3 AM runaway across many tasks — per-task budget (180) handles the single-task case. Research doc §7 D5. |
| 184 | **Deterministic pre-flight contract checks** — Add a `contract_check` phase between Developer and Validator that runs purely deterministic checks on the proposed diff before spending tokens on the Validator agent: (1) path allowlist / denylist enforcement already implemented for SCM, extended to fail earlier; (2) dependency mutation rules (`package.json` / `pnpm-lock.yaml` modified without `can_modify_dependencies` capability); (3) schema-file drift detection (any `*.sql`, `drizzle/*.ts` changed); (4) large-file / binary-introduction checks (configurable threshold). All failures produce structured evidence with a clear `contract_violation` failureClass and skip directly to operator triage. | pending | — | Cheap checks that catch bad diffs before the agent explains them. Research doc §6 C3. |

### Phase 3 — Operator triage

| # | Feature | Status | Depends On | Notes |
| - | ------- | ------ | ---------- | ----- |
| 185 | **Audit-log export endpoint** — Add `GET /audit/export?since=...&until=...&repo=...&format=csv\|json` returning a flat export of run IDs, task IDs, decisions (`approve`/`reject`/`rework`), deciders, policy-pack version, risk class, cost (from 180), evidence archive refs, and PR URLs. Supports streaming CSV for large ranges. Dashboard "Audit" page exposes a simple form over this endpoint. Requires `REDDWARF_OPERATOR_TOKEN`. | pending | — | Compliance table-stakes. All the fields already exist — just ship the aggregation + CSV writer. Research doc §4 A4. |
| 186 | **Operator triage verbs: quarantine, notes, nudge** — Extend the operator API and dashboard with three manifest-level verbs that already have conceptual homes in the V2 arch doc §11 but no operator-facing surface: (1) `POST /tasks/:id/quarantine` marks a manifest `lifecycleStatus: "quarantined"` with a required reason, surfaces a dashboard "Quarantined" queue; (2) `POST /tasks/:id/notes` appends an operator note to a task's `memory_records` with `provenance: "operator_provided"`; (3) `POST /runs/:id/heartbeat-kick` resets the heartbeat-age for a run stuck in a phase so the dispatcher re-considers it without a full cancel-and-retry. Each verb emits a distinct audit-trail run event. | pending | — | Gives operators tools other than "cancel and re-open the issue." Research doc §4 A3. |

### Phase 4 — Platform extensions

| # | Feature | Status | Depends On | Notes |
| - | ------- | ------ | ---------- | ----- |
| 187 | **Task playbooks** — Add a `playbooks/` directory to the policy pack, each playbook being a YAML bundle: `risk_class`, `allowed_paths`, `required_capabilities`, `architect_hints`, `validator_rules`, `reviewer_rubric`. Intake (both GitHub polling and direct-inject) assigns a playbook based on issue labels or structured-template hints (Feature 95), and downstream phases consume it as additional context. First playbooks to ship: `dependency-bump`, `new-endpoint`, `docs-update`, `feature-flag-add`. Compresses Holly's work dramatically for the common case and gives operators a cleaner "standard vs. bespoke" mental model. | pending | — | Research doc §7 D3. |
| 188 | **Intake Adapter Contract** — Extract the current GitHub-specific intake code into a typed `IntakeAdapter` interface (`discoverCandidates()`, `fetchCanonicalTask(id)`, `markProcessed(id, outcome)`, `attachEvidence(id, ref)`) in `packages/integrations`. Refactor `RestGitHubAdapter` to become the first implementation. Add one additional implementation on landing to prove the seam works — either `WebhookIntakeAdapter` (already partially built for Feature 176) or a minimal `LinearIntakeAdapter` behind a feature flag. | pending | — | Small refactor now, big accelerant when Slack / Linear / Jira intake lands. Research doc §7 D2. |

### Out of scope (research doc proposals explicitly deferred)

- **D4 Policy-pack marketplace** — half-delivered by ClawHub skill publishing (F-155). Hold until there is genuine third-party pack demand.
- **D6 Human-in-the-loop pairing mode** — speculative and would cut across all five planes. Revisit after M24 ships.
- **D1 Multi-project tenancy extensions** (quotas, project-scoped policy overrides, cross-project concurrency caps) — M20 Project Mode already delivered `projects` as a planning concept. The tenancy-level extensions are real but not urgent while there is a single primary repo in use.

### Non-functional requirements (apply to all M24 features)

- All new metrics endpoints require `REDDWARF_OPERATOR_TOKEN` and respect the existing operator-API rate limits.
- No new required env vars added without a corresponding entry in `.env.example` with a comment.
- TypeScript strict mode must pass across all modified packages after each feature merge.
- `verify:all` must pass after every feature.
- Features 179–182 must not introduce new per-run runtime overhead beyond existing event emission — aggregation happens at read time.
