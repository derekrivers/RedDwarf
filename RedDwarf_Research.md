# RedDwarf — Deep Research, Gap Analysis & Feature Proposals

*An outside read of the repo, the architecture spec, and the current feature board — with concrete recommendations for improvements and net-new features.*

---

## 1. What RedDwarf actually is (in plain terms)

Stripped of the terminology, RedDwarf is:

> **A governed, human-gated, multi-agent software development pipeline** that takes GitHub issues, runs them through a chain of specialised agents (Architect → Developer → Validator → SCM), and produces real pull requests — with durable evidence, policy snapshots, approval queues, and isolated workspaces at every step.

It sits on top of OpenClaw as the agent runtime, uses Postgres as the system of record, and treats the policy pack (agents/prompts/schemas/standards) as a versioned, releasable artifact. Conservative-by-default, planning-first, auditable.

That is a strong, coherent thesis. The V2 architecture document is well-reasoned — five planes (Control / Execution / Knowledge & Policy / Integration / Evidence), capability-based routing, three-level memory (task/project/org), risk-classed approval modes. The Feature Board shows a team that has already done the hardening audit and is now prioritising **correctness over features** (items 89–93 are all about token economy, eligibility gating, and memory compression before any new providers or intake paths).

In short: the **architectural bones are excellent**. The gaps are not in the design — they are in the surfaces that sit around the pipeline and in the economics of running it.

---

## 2. The honest strengths

Before suggesting changes, it's worth naming what's genuinely good, because several of my recommendations assume these stay intact.

1. **Plane separation is real, not cosmetic.** Control, Execution, Knowledge, Integration, and Evidence are actually separate packages. That's rare. Most "multi-agent frameworks" collapse three of those into one blob of orchestration code.
2. **Evidence-first mindset.** Durable archival of planning specs, diffs, validation logs, SCM reports to an evidence root — this is the thing most agentic systems skip and then regret in their first incident review.
3. **V1 mutation guards.** The fact that `V1MutationDisabledError` exists as an explicit, typed guard rather than a commented-out code path is very mature. It says "we decided not to do this yet, and we want the compiler to enforce that."
4. **Capability model over role names.** `can_open_pr`, `can_touch_sensitive_paths`, `can_use_secrets` — routing by capabilities rather than by agent name is exactly the right abstraction for this to not rot as you add more agents.
5. **Concurrency primitives are already there.** Stale-run retirement, heartbeat ages, overlap blocking, durable pipeline-run records. Most hobby-grade agent stacks get this wrong.
6. **The roadmap is self-aware.** Features 89–93 are explicitly about token economy and eligibility gating rather than adding provider N+1. That's a team that has internalised "ops beats features."

Anything I suggest below is meant to extend that posture, not replace it.

---

## 3. Where I think the real gaps are

I've grouped gaps into four buckets, roughly ordered by leverage. Each one ends with concrete feature proposals.

### Bucket A — Operator experience (the biggest missing surface)

### Bucket B — Observability, cost, and learning loop

### Bucket C — Agent quality and pipeline robustness

### Bucket D — Extension ecosystem and meta-features

---

## 4. Bucket A — Operator experience

**The gap:** The operator-facing surface is a curl-able HTTP API plus an environment variable for polling repos. That is fine for a one-person proof-of-concept. It does not scale to a team that has to live with this system 9-to-5.

Your own Feature Board acknowledges this partially (99: Discord bot, 100: Discord notifications, 96: direct task injection, 97: CLI). Good. But I'd argue a few things are missing even from that list.

### A1 — A real Operator Web UI (not just curl)

**Why:** Approvals, triage, and failure diagnosis are the three activities operators do most, and all three are terrible over curl. Every one of the existing endpoints (`/blocked`, `/approvals/:id/resolve`, health) is a candidate for a panel.

**What "real" means here:**

- A single-page app (Vite + React, already in the TS ecosystem) served by the operator API or as a static bundle.
- Three primary views: **Pipeline** (runs by phase with live status), **Approvals Queue** (pending approval requests with the planning spec rendered inline — markdown, diff viewer, policy snapshot), and **Evidence Browser** (task manifest, phase outputs, archived logs).
- Auth via the existing `REDDWARF_OPERATOR_TOKEN` bearer, upgraded to proper sessions later.
- Realtime updates via SSE or WebSockets from the existing observability hooks.

**Where it lands in the architecture:** a new `packages/operator-ui` + minor additions to the operator API (read models, SSE endpoint). No changes to the Control Plane internals.

**Why this beats the Discord bot on priority:** Discord is great for "approve from my phone" but useless for "why did phase 4 of run 1872 fail, show me the diff." The web UI is the workbench; Discord is the pager.

### A2 — Approval request diff & spec rendering

**Why:** Approving a planning spec as raw JSON over curl is guessable but not *reviewable*. A human reviewer's job is to look at the proposed plan and the proposed code impact and form an opinion in seconds.

**Concrete:**

- For planning-phase approvals: render the spec as markdown with acceptance criteria, affected paths, and risk-class highlighted.
- For pre-PR approvals (eventually): render the generated diff with syntax highlighting and per-file comments.
- Attach the policy snapshot that was active at the moment of the request, clearly labelled, so reviewers can see *which* rules applied.

This is cheap to build once A1 exists and massively raises the quality of approval decisions.

### A3 — Task triage & re-routing tools

**Why:** Right now a task is either `ready`, `blocked`, `active`, or `failed`. When something goes wrong the operator's only tool is to cancel and re-open the issue. They should be able to:

- Nudge a stuck run (heartbeat kick).
- Re-dispatch a failed phase with an explicit override and a reason attached to evidence.
- Mark a task `quarantined` with a reason, surface a quarantine queue.
- Attach an operator note to a task that becomes part of its manifest.

All of this already exists conceptually in the failure-recovery section of the V2 arch doc (§11: retry / rollback / quarantine / escalate). It just needs the operator-facing verbs.

### A4 — Audit-log export

**Why:** For any serious compliance story ("show me every autonomous change that touched `packages/billing` in Q2"), the evidence is there but the query is bespoke. Ship a `GET /audit/export` that takes a time range + optional filters and returns CSV/JSON with run IDs, tasks, decisions, decider, policy version, evidence links.

---

## 5. Bucket B — Observability, cost, and learning loop

**The gap:** The V2 architecture doc (§12) lists great metrics — time per phase, success rate, retry count, PR acceptance rate, cost per completed task, token usage by agent type. None of these are visibly wired up. The feature board jumps from hardening to provider support without touching the measurement layer.

This is the single highest-leverage bucket for the project long-term. You can't improve what you don't measure, and an AI dev team that doesn't measure itself will drift silently.

### B1 — First-class cost attribution per run and per phase

**Why:** Token cost is the operational variable that matters most, and it has to be attributable to a task, a phase, and an agent role — not just a monthly invoice.

**Concrete:**

- Add a `token_usage` table (or extend `pipeline_runs`) with: run_id, phase, agent, provider, input_tokens, output_tokens, cached_tokens, cost_usd, model_id.
- Instrument the OpenClaw binding at the point where the HTTP response comes back — that's where the token counts live.
- Expose `/runs/:id/cost` and `/runs?since=...&group_by=phase` endpoints.
- Add a "cost budget" field to task manifests with an enforced cap that short-circuits the run with a durable evidence entry if exceeded.

Feature 89 (deterministic eligibility gate) is the *entry-side* version of this — don't waste tokens on tasks that fail cheap checks. B1 is the *exit-side* version — measure what was actually spent so you can tell which tasks are overspending.

### B2 — Agent quality telemetry

**Why:** "The Architect is producing bad specs" is a thing you can only know if you're measuring. Without instrumentation you'll rely on the vibes of whoever last approved something.

**Concrete metrics to capture, keyed by agent and task type:**

- **Plan → validation pass rate.** Of specs the Architect produced, what fraction led to a developer run that passed validation on first try?
- **Review rejection rate.** Of developer diffs, what fraction were rejected by the Reviewer (once that agent exists)?
- **Spec revision count.** How many times did a plan have to be re-planned?
- **Mean phase latency** vs. p50/p95.
- **Retry reason distribution** — categorical breakdown of *why* retries happened.

These roll up into a single-screen "How is the Dev Team doing this week?" dashboard that tells you whether changes to prompts, schemas, or standards are helping or hurting.

### B3 — Prompt / policy versioning dashboard

**Why:** You already version policy packs. The natural next move is to be able to answer: "After we changed the Architect's SOUL.md on policy-pack v14, did validation pass rate go up or down?"

**Concrete:** a page that plots B2 metrics against policy-pack version boundaries. Tag each pipeline run with the exact policy-pack version it used (you likely already do); surface this as a ribbon on the metrics timeline.

This turns the Agent Policy Repo from a configuration artifact into an *experimental surface* where changes are measurable.

### B4 — Structured failure taxonomy

**Why:** "Failed" is not a diagnosis. §11 of the arch doc lists classes (planning failure, validation failure, review failure, integration failure, merge failure, policy violation, execution loop). Make those enum values in the schema, require every failure to carry one, and surface the distribution.

**Cheapest possible implementation:** `failure_class` column on phase records + a validator that blocks marking anything failed without one.

---

## 6. Bucket C — Agent quality and pipeline robustness

**The gap:** This is where your own Feature Board already lives (89–95). I'll not re-propose features you have. I'll add the adjacent ones that I think are missing.

### C1 — A true Reviewer agent phase

The V2 architecture explicitly names the Reviewer Agent (§2.2) — *"reviewing correctness and alignment to the spec, checking code quality, spotting risky or unrelated changes"* — but it isn't present in the current execution plane. The Validator covers lint and tests; that is not the same thing.

**Why this matters:** the failure mode of LLM-generated code is not usually "it fails tests." It's "it passes tests but solves the wrong problem, or solves it with a pattern that doesn't match the repo." Lint and tests don't catch that. A Reviewer does.

**Concrete:** add a `reviewer` agent phase between validation and SCM, with capabilities `can_read_diff`, `can_read_spec`, and no write access. Output is a structured review verdict (`pass`, `request_changes`, `escalate`) plus a rationale. The SCM phase only runs on `pass`; `request_changes` loops back to Developer with the review as input; `escalate` creates an approval queue entry.

### C2 — Repo-aware context retrieval

**Why:** Feature 90 (role-scoped context) and feature 91 (spec distillation) are both about narrowing what each agent sees. The other half of that problem is *widening* it intelligently — retrieving the right subset of the project repo for the task at hand, not just the files the Architect named.

**Concrete:** a lightweight embedding index over the project repo (scoped, indexed on every pipeline run against the target SHA), surfaced to the Architect as a `retrieve_code_context(query)` tool. The output is a set of candidate files with short rationales. This is not full RAG — it is "given the issue, what files should the Architect probably read before planning?"

Pair this with the existing canonical-docs retrieval story the arch doc proposes (§2.3), and you get an Architect that grounds itself in both the standards and the codebase before producing a spec.

### C3 — Deterministic pre-flight contract checks

**Why:** Between the Developer and the Validator there is a gap where the diff may technically lint/test-pass but violate obvious policy invariants (touched forbidden paths, changed package.json dependencies, bumped a schema version). These checks are deterministic and should run *before* the Validator agent does, both because they're faster and because they produce clearer errors.

**Concrete:** a `contract_check` phase between developer and validation that runs:

- Path allowlist enforcement (is every changed path in the task's declared affected areas?).
- Dependency mutation rules (was `package.json` or `pnpm-lock.yaml` changed and does the task declare `can_modify_dependencies`?).
- Schema-file drift detection.
- Large-file / binary-introduction checks.

All cheap, deterministic, non-LLM — the classic "catch bad things with the filesystem before spending tokens explaining why they're bad."

### C4 — Idempotency keys on every mutation

**Why:** The conservative mutation posture is good, but the remaining mutations (branch creation, PR creation, secret lease issuance) are network calls that can and will fail mid-flight. Without idempotency keys you risk duplicate PRs on retries.

**Concrete:** every external mutation call carries a deterministic idempotency key derived from (run_id, phase, action). The GitHub adapter, secrets adapter, and CI adapter each accept and honour those keys; retries within a TTL are silently deduped.

### C5 — Dry-run / shadow mode for new policy packs

**Why:** Today a new policy pack gets promoted via artifact. There's no "run this pack against the last 50 real tasks and tell me what would have been different" mode.

**Concrete:** `reddwarf shadow-run --pack v15 --replay-last 50`. Takes archived task manifests + evidence, re-runs the planning phase against the candidate pack, diffs the resulting spec, eligibility decision, and risk class, reports delta. Does not execute downstream phases. This turns policy-pack releases from "hope" into "regression-tested."

---

## 7. Bucket D — Extension ecosystem and meta-features

These are the *expansive* gaps — things that don't exist yet but would fit naturally into the architecture.

### D1 — Multi-project support as a first-class concept

**Why:** The system is built as if there's one Project Repo at a time. The org-memory layer hints at multi-project but nothing in the operator surface or routing treats it as routine. As soon as this system is useful it will be pointed at a portfolio of repos, and concurrency/priority across projects becomes real.

**Concrete:**

- A `projects` table with quota, priority, risk profile, allowed capabilities.
- Project-scoped policy overrides layered on top of the org-level policy pack.
- Operator UI filters by project.
- Cross-project concurrency caps (e.g. "max 2 active high-risk tasks across all projects").

### D2 — Non-GitHub intake adapters as plugins, not code

**Why:** Features 95–98 cover structured issue template, direct injection endpoint, CLI. Feature 99 adds Discord. The architecture doc (§13) names Jira, Linear, Discord, Slack, scheduled maintenance queues.

If each intake source is a bespoke adapter, the integration plane sprawls. Better: define an **Intake Adapter Contract** (a typed interface — `discoverCandidates()`, `fetchCanonicalTask(id)`, `markProcessed(id, outcome)`, `attachEvidence(id, ref)`) and make GitHub just the first implementation. Third-party sources plug in by implementing that interface.

This is a small refactor now, a huge accelerant later.

### D3 — Task templates / "playbooks"

**Why:** In practice, most autonomous work in a mature repo falls into a dozen recurring shapes — "bump dependency and fix breaks," "add a new endpoint to X module," "update docs for feature Y," "add a feature flag for Z." Each shape has its own typical risk class, allowed paths, test expectations, and review rubric.

**Concrete:** a `playbooks/` directory in the policy pack, each playbook being a YAML bundle of `risk_class`, `allowed_paths`, `required_capabilities`, `architect_hints`, `validator_rules`, `reviewer_rubric`. Intake assigns a playbook based on issue labels or the structured template (feature 95); downstream phases consume the playbook as additional context.

This compresses the Architect's work dramatically for the common case and gives operators a cleaner mental model: *"this is a standard-shape task, this is a bespoke one."*

### D4 — Policy-pack marketplace / public standards library

**Why:** The Agent Policy Repo concept is genuinely novel. The architecture argues engineering knowledge should be versioned artifacts, not runtime prompt-plumbing. That's a strong open-source story on its own.

**Concrete (long-horizon):** publish a small public library of policy-pack modules — SOLID principles standards, OWASP rules, common language-specific coding conventions, a baseline test-hygiene rubric — as importable fragments. Packs in the wild assemble from a base of published standards + their own overrides.

This is the kind of move that could give RedDwarf an actual ecosystem rather than staying a solo tool.

### D5 — Time-boxed autonomy budgets

**Why:** Cost caps (B1) protect against a single runaway task. Autonomy budgets protect against *system-level* runaway — the scenario where the pipeline is happily consuming tokens on twenty low-value tasks at 3 AM.

**Concrete:** an org-level daily token / dollar budget, enforced by the dispatcher. Once the budget is hit, new task dispatches are queued rather than started and a notification fires. Operator UI shows budget burn-down.

### D6 — Human-in-the-loop pairing mode

**Why:** Today's modes are "autonomous" and "approval-gated." A third mode is interesting: *interactive pairing*, where a human operator drives the task conversationally and the agent executes under policy. Same isolation, same evidence, same guards — but the orchestrator is a human, not the Architect.

This is a natural extension of the workspace and capability model and gives RedDwarf a posture on the Cursor/Claude Code spectrum: "the same policy pack governs autonomous runs *and* human-driven runs in the same repo." That is a rare and compelling story.

---

## 8. Lower-priority hygiene items worth noting

These are real but small; batch them.

- **Discoverability.** The repo README is good but long. A one-page "what is RedDwarf, look at this diagram" at the top, with the deep runbook moved behind a link, would help new contributors a lot.
- **Release discipline.** Zero tagged releases, zero published packages. Even internal releases deserve tags — it makes the evidence trail reference-able.
- **Public changelog.** With policy-pack versioning already in the design, a CHANGELOG.md per pack (separate from repo CHANGELOG) would be a small act of kindness to future-you.
- **Benchmark harness.** A small, committed benchmark suite — 10–20 reference tasks with known expected outcomes — against which every policy-pack version runs. Ties directly to C5 (shadow-run) and B2 (quality telemetry).
- **Contributor guide for the policy pack itself.** Right now it reads like you have to know the whole architecture to contribute a single standard. A small `CONTRIBUTING_STANDARDS.md` that explains "here is how you add a new coding standard and how it gets tested" lowers the bar.

---

## 9. A suggested sequencing (if I had to pick)

This is not a replacement for your hardening-first ordering on 89–93 — that's correct and should ship first. After that:

**Wave 1 — measurement.** B1 (cost attribution), B4 (failure taxonomy), B2 (quality telemetry basics). Without these, every future change is a guess.

**Wave 2 — operator surface.** A1 (web UI), A2 (approval rendering), A3 (triage verbs). This is where you stop living in curl.

**Wave 3 — robustness.** C3 (contract checks), C4 (idempotency), C1 (reviewer agent).

**Wave 4 — leverage.** D3 (playbooks), D1 (multi-project), C5 (shadow mode).

**Wave 5 — expansion.** D2 (intake contract), D5 (autonomy budgets), D6 (pairing mode), D4 (marketplace).

The first two waves turn RedDwarf from a working pipeline into a *livable* one. The latter three turn it into a platform.

---

## 10. The one-sentence version

You have an unusually principled architecture and a mature hardening posture; the biggest unrealised value is a proper operator surface and a measurement layer, and the biggest long-term bet is treating the Agent Policy Repo as a versioned, testable, shareable artifact rather than configuration.

---

*— End of research.*
