# RedDwarf — Architectural Review v2

*Second-pass review, grounded in the current state of `master` as of this inspection.*

---

## 0. Mea culpa, and what's actually changed

My previous review was based on a stale README landing page; much of what I recommended has since landed. A proper accounting is owed before any new critique. Here is what I can see has moved:

| Previous gap I raised | Current state |
|---|---|
| **Operator Web UI (A1)** | Landed. `packages/dashboard`, React SPA on `:5173`, full routes (Dashboard, Projects, Approvals, Pipeline, Evidence, Agents, Repositories, Submit Issue, OpenClaw Settings). Screenshots in the README. |
| **Approval spec/diff rendering (A2)** | Landed — "Approval detail view" is a dedicated screen. |
| **OpenAI provider support** *(Feature 103)* | Landed. `REDDWARF_MODEL_PROVIDER` toggle, `gpt-5`/`gpt-5.4` per role. |
| **Issue template** *(Feature 95)* | Landed. `.github/ISSUE_TEMPLATE/ai-task.yml`. |
| **Direct injection endpoint + CLI** *(Features 96, 97)* | Landed. `POST /tasks/inject`, `reddwarf submit`, `reddwarf report`. |
| **Web search for the Architect** *(Feature 101)* | Landed via OpenClaw's browser for Holly. |
| **Reviewer/Architecture-reviewer agent (my C1)** | Landed. `reddwarf-arch-reviewer` (Kryten) is a distinct phase between Development and Validation. |
| **Webhook intake** | Landed, gated by `REDDWARF_WEBHOOK_SECRET`. Polling remains default; dedup guard across both. |
| **VPS deployment story** | Landed. `docs/VPS_DEPLOYMENT.md` + day-2 ops. |
| **MCP bridge** | Landed. OpenClaw agents can query RedDwarf state in-context without direct DB access. |
| **Project Mode** | New since last review. Complexity classifier in Rimmer → ProjectSpec → TicketSpec graph → sub-issues → GitHub Actions advance loop. This is the single biggest conceptual addition. |

That's not incremental polish. That's most of a milestone shipped cleanly, plus a genuinely novel abstraction (Project Mode) that didn't exist before. The project is in noticeably better shape.

What *hasn't* moved, and is itself a finding: **`FEATURE_BOARD.md` is out of sync with reality.** Items 89–103 are all still marked `pending`, but from the README and architecture doc we can see at least 95, 96, 97, 101, 103 have clearly landed, and the architecture-reviewer phase implies 94/pre-screener work is at least partially underway. A board that lags reality is a small but corrosive thing on a project this principled — fixable in one pass, worth fixing this week. I'll come back to this in §5.

---

## 1. What RedDwarf is now (restated)

The framing in the new README is better than before — sharper, product-shaped, one honest sentence at the top:

> *"RedDwarf turns a GitHub issue into a reviewed, tested pull request using an AI dev squad running on OpenClaw."*

The mental model has also crystallised:

- **RedDwarf owns domain logic** (intake, eligibility, planning, policy, approvals, orchestration, evidence).
- **OpenClaw owns runtime substrate** (agent sessions, gateway, browser, Discord, MCP hosting, webhook dispatch).
- **Postgres is the system of record.**

That "what belongs where" decision, stated plainly at the top of `ARCHITECTURE.md`, is the single most valuable architectural move made since the last review. Every ambiguous question about "should this live in RedDwarf or in OpenClaw?" now has a deterministic answer. Keep defending that line — it will be tempted all the time.

The Red Dwarf cast mapping is also, finally, doing work:

| Agent | Persona | Role |
|---|---|---|
| `reddwarf-coordinator` | Rimmer | coordination, bounded handoff, **Project Mode orchestration** |
| `reddwarf-analyst` | Holly | planning and analysis |
| `reddwarf-arch-reviewer` | Kryten | implementation-vs-plan review |
| `reddwarf-validator` | Kryten | validation and evidence-oriented checking |
| `reddwarf-developer` | Lister | development-phase execution |

Kryten wearing two hats (reviewer and validator) is fine for now but worth flagging — §4 picks this up.

---

## 2. The honest strengths (what to protect)

These are things the new code does well that I would fight to preserve as the project grows.

1. **The "RedDwarf vs OpenClaw" split is now load-bearing.** It's not a diagram; it's a principle that has clearly guided recent decisions (Discord via OpenClaw's native channel rather than a bespoke bot; browser as an OpenClaw capability; MCP bridge serving RedDwarf state rather than exposing the DB). Every one of those is the right call.

2. **Multi-surface operator access, really multi-surface.** Dashboard SPA, REST API, legacy `/ui` panel, CLI, WebChat commands, Discord, MCP bridge — and they all reconverge on one operator token model. That is unusually disciplined. Most systems end up with two-and-a-half UIs and three different auth stories.

3. **Config layering is mature.** `.env` → `.secrets` → `operator_config` in Postgres, with each value classified as boot-time / runtime-configurable / secret / dev-E2E. Provider switch is runtime-configurable, keys are secret. That is the boring correctness work that prevents three quarters of future footguns.

4. **Project Mode is a real design, not a gesture.** The spec is specific (8 tickets, named risks, dependency graph, explicit out-of-scope), uses GitHub sub-issues instead of inventing a new backlog format, replaces an inbound webhook with a GitHub Action to remove the "you need a public host" requirement. The self-referential bit — *"this document is the first formal ProjectSpec produced for RedDwarf and is intended to be fed back into the system"* — is a good dogfooding discipline, not a gimmick.

5. **Mermaid diagrams throughout the architecture doc.** Not decoration — they match the code structure and save a thousand words per `flowchart`. Keep them; treat breaking a diagram as equivalent to breaking a type.

6. **Trust boundaries are drawn once, explicitly.** §13 of `ARCHITECTURE.md` lists which token protects which surface. Zero ambiguity. Many security bugs happen in the gap where a trust boundary exists in somebody's head but nowhere in the docs; that gap is closed here.

7. **Honest "Current Limitations" section.** Sandboxing disabled for a specific, named reason. Command-name collision with OpenClaw's native `/status`, `/approve`, `/reject` acknowledged with the `/rd...` alias workaround. Polling is default; webhook is live but gated; double-processing risk called out. That kind of "here is what doesn't work yet" discipline is rare and very good.

---

## 3. Current gaps, in priority order

I'm going to be strict with myself here — every gap must be (a) not already on the board, (b) not already mitigated by something I can see, and (c) something I'd actually escalate in an architecture review.

### 3.1 Correctness gaps

These are the ones I'd pin to the top. They are not features. They are load-bearing properties the system either has or doesn't.

#### G1 — The ticket dispatcher for Project Mode is, as written, fragile.

The Project Mode spec (T-07) has GitHub Actions firing on PR-merge → calling `POST /projects/advance`. That's elegant, but the failure modes deserve explicit design:

- **Action fires, but the operator API is unreachable** (laptop off, VPS down, tunnel broken). The action fails, the PR is merged, the project is stuck silently. The spec's AC-6 says "non-zero exit code" but a failed workflow run is easy to miss.
- **Action fires twice** (GitHub retries, rerun by operator). T-07 AC-8 handles it, but the idempotency key is implicit. Make `(project_id, ticket_id, github_pr_number)` the explicit key and persist it in an `advance_log` table.
- **PR is merged on a ticket the project no longer considers active** (amended, superseded). Needs an explicit "stale ticket" outcome rather than silent advance.
- **A human merges a ticket PR out of dependency order.** Possible to do by accident. The spec assumes the dispatcher chooses the next ticket, but doesn't cover "human merges T-03 before T-02 is done." Either the system tolerates this (and has to rebuild the dep graph) or it rejects it (and has to surface why). Pick one, document it.

**Proposal — a Project Mode drift auditor.** A background check that periodically reconciles RedDwarf's view of the project (which tickets are executing, merged, blocked) against GitHub's view (which sub-issues are open/closed, which PRs are merged). Discrepancies raise a drift event. Deterministic, cheap, no LLM call. This is the kind of thing you only miss until the first time a project state machine wedges in production; then you always wish you'd had it.

#### G2 — OpenClaw sandboxing is off, and this is a load-bearing caveat.

From `ARCHITECTURE.md` §14:

> *"OpenClaw agent sandboxing is set to `mode: 'off'` and RedDwarf relies on the outer container boundary plus tool allow/deny rules."*

That's the right, honest posture for now. But it's also the single sentence that will most change what you can safely automate. Recommendations:

- **Make the sandboxing state a first-class surfaced status** in the operator dashboard, not just a doc limitation. A banner on Agents / Settings that says "Agent sandboxing: OFF — outer container + tool allow/deny active." Operators deciding what risk class to auto-approve should not have to remember to read the docs.
- **Add a `sandbox_required` flag at the risk-class level** so that High-risk tasks can *require* sandbox=on to proceed, and therefore short-circuit if it isn't. Today the risk class is a routing hint; it should also be a precondition.
- **Track which OpenClaw topologies have supported inner-Docker backends** so when sandboxing becomes available, it's a config change rather than an architecture change.

#### G3 — The single-issue path and Project Mode share code but not contract-level parity.

Every Project Mode ticket (T-02, T-03, T-06) carries "existing single-issue path must remain fully operational" as an AC. That's correct, but it's an assertion without a mechanism. You need:

- **A snapshot-diff test.** One fixture issue → run through the single-issue path → capture the resulting planning spec, phase transitions, evidence set → assert byte-equal or structurally-equal to a committed snapshot. Any ticket that breaks it fails CI. This is the only practical way to stop the bigger, flashier Project Mode work from quietly regressing the smaller-but-still-primary path.
- **The same pattern for Project Mode itself** once T-08 lands. One fixture project → deterministic decomposition (stub the LLM calls for reproducibility) → assert spec shape + ticket ordering.

Regression tests against fixtures are not glamorous. They're what makes the architecture doc's confident claims ("single-issue path remains operational") real.

#### G4 — Evidence archive has no integrity story yet.

Evidence is currently: files written into `runtime-data/evidence`, referenced from Postgres. That's the right shape. What's missing:

- **Content-addressable storage** — every archived evidence file gets a SHA-256 stored with the metadata. An auditor — or just a curious operator six months later — can verify that the diff they're looking at is the diff that was archived.
- **Tamper detection** on reads. If the file on disk doesn't match the stored hash, the read surfaces that loudly rather than silently returning modified content.
- **Retention policy in schema, not in code.** Today `teardown --clean-evidence 14` is a CLI flag. Tomorrow a compliance person will want a per-project retention policy that is enforced rather than invoked.

Not urgent, but cheap to add *before* there's 10GB of evidence that pre-dates the integrity scheme.

### 3.2 Observability gaps

I raised these last time. The dashboard is a huge step forward, but the measurement layer is still thin.

#### G5 — Cost attribution per run and per phase is not yet first-class.

The OpenClaw integration gives you per-dispatch session metadata. Token counts are available on the return path. What I don't see in the architecture or operator-config layer is a schema commitment to storing them.

**Concrete:** a `token_usage` table keyed on `(run_id, phase, agent, provider)` with `input_tokens`, `output_tokens`, `cached_tokens`, `model_id`, and a computed `cost_usd`. Surface `GET /runs/:id/cost` and a **"Cost" column on the Pipeline view** of the dashboard. A `cost_usd_cap` on task manifests that short-circuits the run when exceeded, with a durable evidence record of the overrun.

Right now, on a machine running Project Mode, the operator has no cheap way to answer "what did this project cost?" — and projects are specifically the high-spend case.

#### G6 — Agent quality telemetry has no home yet.

You already have `pipeline_runs`, `run_events`, and `phase_records`. Fantastic. What's missing is the **rollup view** — the thing you actually look at weekly:

- Architect plan → validation pass rate
- Arch reviewer pass / request-changes / escalate rate
- Validator pass rate vs. later-discovered failures
- Mean phase latency (p50/p95) by phase and by agent
- Retry reason distribution
- Cost per completed task, weekly

These are computable from existing tables. They need to be computed, stored in a daily rollup, and rendered as a single page. Without it, the team ships prompt and policy-pack changes and has no objective signal on whether quality went up or down.

#### G7 — Policy-pack version → metric correlation.

You version policy packs. You (will) have metrics. The natural next move is to plot one against the other. A chart where policy-pack version boundaries are marked on the timeline of "validation pass rate," "plan-to-merge latency," etc. turns the Agent Policy Repo into a measurable experimental surface rather than just a versioned config.

This is a small amount of work on top of G6 and is the **single highest-leverage feature the project could build in the next quarter**. Everything else is optimisation; this is how you know if you're optimising the right thing.

### 3.3 Polish gaps

Smaller but genuinely worth fixing.

#### P1 — `FEATURE_BOARD.md` drift.

As flagged at the top. The board lists 89–103 as pending; the README advertises screenshots of features that are clearly 95/97 (issue template, CLI) and the ARCHITECTURE doc explicitly describes 103 (OpenAI provider) landed. This is confusing to new contributors and to your future self. Add a `status` column that distinguishes `done` / `in-progress` / `pending` / `deferred`, and do a five-minute reconciliation pass. Add a `completed-on` date for landed items. Consider a separate `ROADMAP.md` for forward-looking items so the board can be a source of truth rather than aspirational.

#### P2 — Docs discovery.

`/docs` is growing: ARCHITECTURE, GETTING_STARTED, DEMO_RUNBOOK, VPS_DEPLOYMENT, VPS_OPERATIONS, WEBHOOK_SETUP, DEPLOY_CHECKLIST (implied), reference/*, openclaw/*, agent/*, plus `reddwarf_project_mode_spec.md` floating at the top level of `docs/`. This is already more than a new contributor can navigate without a map.

**Proposal:** `docs/INDEX.md` (or README at `docs/`) with four buckets:

- **Narrative** (start here): README → GETTING_STARTED → ARCHITECTURE.
- **Operator** (running it): DEMO_RUNBOOK, VPS_DEPLOYMENT, VPS_OPERATIONS, WEBHOOK_SETUP.
- **Reference** (looking things up): reference/*, .env.example, COMMANDS.
- **Specs** (design record): `reddwarf_project_mode_spec.md`, `openclaw/*`, future ADRs.

Also — move `reddwarf_project_mode_spec.md` under `docs/specs/` to match the implicit bucketing already used in the recommended-reading list.

#### P3 — ADRs instead of floating spec docs.

Project Mode is effectively ADR-0001 without being called that. Future major decisions (the OpenClaw split, the MCP bridge design, the GitHub-Actions-vs-webhook pivot) have no canonical home. A `docs/adr/` folder with numbered, dated, one-page ADRs would capture *why* decisions were made for operators debugging a design question in 2028. The OD-01 / OD-03 decision log at the end of the project mode spec is the exact format to standardise on.

#### P4 — The sneaky Windows paths in the README.

Two of the rendered links in the README still go through `c:/Dev/RedDwarf/...`:

- `features_archive/COMPLETED_FEATURES.md`
- `infra/docker/openclaw.json` (twice)

GitHub silently tolerates those, but they will break for anyone clicking them (they hit the GitHub 404 page with the `c:/Dev/...` segment stuck on). One-line fix. Worth doing.

#### P5 — Kryten plays two roles.

`reddwarf-arch-reviewer` and `reddwarf-validator` share the Kryten persona. Functionally fine; cosmetically confusing in logs and Discord messages ("Kryten approved" — which Kryten?). The Red Dwarf universe has plenty of options. Holly wouldn't wear two hats. Low priority; high whimsy.

#### P6 — No release tags yet.

Still no tagged releases. You now have VPS deployment docs, which means someone is or will be deploying versions of this; the difference between "the version that ran in May" and "the version that ran in June" needs to be something they can name. Tag `v0.x.0` on each meaningful jump, even privately. Ties directly to the evidence-retention story in G4.

### 3.4 Strategic gaps (6–12 months out)

These are the ones I'd surface in a roadmap conversation, not a ticket.

#### S1 — Multi-project isolation is still implicit.

Project Mode handles a single project at a time. What about running Project Mode across *multiple* repos (`acme/platform` + `acme/api`) simultaneously? Current concurrency primitives serialise on `sessionKey = github:issue:<repo>:<issue>`, which means across-repo parallelism works, but there is no per-project quota or priority.

As soon as the system is useful, it will be pointed at a portfolio of repos, and you'll want:

- Per-project daily token/$ budgets (complementing the per-task cap from G5).
- Per-project priority so one noisy repo can't starve a quieter but important one.
- Project-scoped policy overrides layered on top of the base policy pack — the high-risk fintech repo gets stricter defaults than the docs repo.

#### S2 — Playbooks (task templates).

Still not built. Most real automation in a mature repo is a handful of recurring shapes: "bump dep and fix breaks," "add endpoint to module X," "doc update for feature Y." Each has its own typical risk class, allowed paths, test expectations, and acceptance rubric.

A `playbooks/` directory in the policy pack — each playbook a YAML bundle of (risk class, allowed paths, required capabilities, architect hints, validator rules) — compresses the Architect's work for the common case and gives operators a cleaner mental model. Also makes Project Mode's ticket decomposition more tractable by picking a playbook per ticket.

#### S3 — Shadow-run / replay for policy-pack promotion.

The V2 architecture doc hinted at this ("versioned agent instructions → immutable policy-pack artifacts"). What's missing is the regression tool: `reddwarf shadow-run --pack v15 --replay-last 50`, which takes archived task manifests + evidence, re-runs only the planning phase against the candidate pack (no downstream execution, no mutations), and reports deltas in eligibility decisions, risk classifications, and spec shape.

Without this, policy-pack promotion is "hope." With it, it's regression-tested.

#### S4 — Parallel ticket execution in Project Mode.

Explicitly out of scope for Project Mode v1, but worth thinking about the contract now, not later. The moment two tickets can run concurrently, the contract needs:

- Path-level conflict detection (both tickets touch `packages/policy`).
- Branch isolation (each ticket gets its own feature branch; merge-queue semantics).
- Evidence isolation (no cross-ticket evidence leakage).

Doing it wrong later is much harder than documenting the invariants now.

#### S5 — Human-in-the-loop pairing mode.

Still on my list. Today RedDwarf has "autonomous" (with gates) and "approval-gated." A third mode — **interactive pairing**, where a human drives and the agent executes under policy — would reuse every piece of the current architecture (workspaces, capabilities, evidence, tool allowlists) and give RedDwarf a real posture vs. Cursor / Claude Code: "the same policy pack governs autonomous runs *and* paired runs." That is a distinctive story, not a me-too one.

#### S6 — Autonomy budget at the org level.

Cost caps (G5) protect against a single runaway task. Autonomy budgets protect against the 3-AM scenario where 20 low-value tasks quietly consume the monthly budget. A daily org-level token/$ cap enforced by the dispatcher, with graceful degradation (new tasks queued, not dropped, operator notified), is the equivalent of a circuit breaker.

---

## 4. A note on the Red Dwarf cast

Kryten doing two jobs (arch reviewer + validator) is a minor smell. The reviewer looks at "does this match the plan and the repo's conventions?" — a judgment role. The validator looks at "does this lint and pass tests?" — a deterministic role. Different character of work.

Plenty of Red Dwarf characters are unclaimed:

- **Cat** for a UX/polish-focused agent once one exists (vain, style-conscious — fits).
- **Mr Flibble** for the quarantine / kill-switch path. (When Mr Flibble is cross, tasks are cancelled.)
- **Talkie Toaster** for the notification adapter. ("Would you like some toast?" → "Would you like an approval?")

I would not refactor existing agents for this. But as new roles appear, picking distinct personas keeps the metaphor load-bearing.

---

## 5. What I would do this week

If I were on the team, with a single week of focus time, I'd do — in order:

1. **Reconcile `FEATURE_BOARD.md` with reality.** 30 minutes. High embarrassment-risk payoff.
2. **Fix the Windows path URLs** in README/FEATURE_BOARD. 5 minutes. They're a paper cut every new contributor hits.
3. **Ship the cost-attribution schema (G5).** Just the table and the instrumentation — don't wait for the dashboard panel. Once the data is being written, the panel is a weekend.
4. **Write the snapshot-diff regression test for the single-issue path (G3).** Before T-03/T-06 are merged. This is the cheapest insurance against Project Mode breaking the existing flow.
5. **Draft ADR-0001: "RedDwarf domain, OpenClaw runtime"** (P3). Capture the split that already exists in `ARCHITECTURE.md` §1 in a canonical, dated decision. Every future architectural conversation will reference it.

Everything else in §3 is multi-week work. That short list is the cheapest possible set of moves that lock in the gains made since my last review and set up the next quarter.

---

## 6. The one-sentence version

You shipped an unusually clean layer of operator surfaces and a genuinely original abstraction (Project Mode) since the last review; the next round of value is in **measurement, regression-proofing, and making the Project Mode state machine robust to the real-world merge and drift paths** — not in more features.

---

*— End of v2 review.*
