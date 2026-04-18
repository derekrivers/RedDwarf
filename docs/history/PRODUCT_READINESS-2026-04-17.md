# RedDwarf — Product Readiness Review

Prepared: 2026-04-17
Reviewer: automated readiness audit
Scope: full repository at `/home/derek/code/RedDwarf`, branch `build-feature-pr-merge-webhook`.

---

## SECTION 6 — Executive Readiness Summary

- **App purpose in one sentence.** RedDwarf is a TypeScript policy-pack control plane that orchestrates an OpenClaw-powered AI dev squad — intaking GitHub issues (or locally-submitted tasks), planning with an LLM architect persona, running them through gated approvals, dispatching development and validation to OpenClaw agents, and publishing real branches and pull requests — with full auditability in Postgres and a browser operator dashboard.
- **MVP status.** **Effectively YES.** The canonical MVP promise (GitHub issue → plan → approve → develop → validate → PR, with evidence and operator control) is demonstrably implemented end-to-end, verified by an automated E2E script against a real repo, and exercised in production-shape deploys. A richer Project Mode (multi-ticket plans) ships in M20, and OpenClaw platform features ship in M21/M22. Remaining gaps are operational polish, not missing core loops.
- **Boot readiness.** **YES for local.** `cp .env.example .env`, populate tokens, `corepack pnpm install`, `corepack pnpm start`. A fully documented one-command setup exists and is idempotent. **Not yet fully YES for production/VPS.** Tailscale Funnel and webhook path work, but there is no turnkey production deploy artifact (no systemd unit, no Helm chart, no hosted image recipe beyond the local Docker Compose topology).
- **Secrets required.** **5 mandatory** for a minimum working stack (`GITHUB_TOKEN`, one of `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`, `OPENCLAW_HOOK_TOKEN`, `OPENCLAW_GATEWAY_TOKEN`, `REDDWARF_OPERATOR_TOKEN`) + **2 optional** (`OPENCLAW_DISCORD_BOT_TOKEN`, `REDDWARF_WEBHOOK_SECRET`).
- **Top 3 actions before sharing/shipping.**
  1. **Rotate & scrub committed `.env`.** The working tree contains a populated `.env` at repo root. Before any external share, verify it contains no live secrets and add stronger guardrails (the file is gitignored but exists in this checkout — risk of accidental copy).
  2. **Harden the OpenClaw sandbox story.** Current Docker topology runs with `sandbox: off` per `docs/ARCHITECTURE.md §14`; the only enforcement is the container boundary and tool allow/deny lists. Ship [docs/openclaw/AGENT_TOOL_PERMISSIONS.md](openclaw/AGENT_TOOL_PERMISSIONS.md) as an operator-facing doc and plan an inner-sandbox milestone before multi-tenant exposure.
  3. **Publish a real production-deploy path.** Today's prod story is "copy the repo to a VM and run `pnpm start` behind Tailscale Funnel." Ship a supported deploy artifact (image + compose or systemd unit) plus a write-up of backup/restore for the Postgres volume, and document operator-token rotation in operational terms.

---

## SECTION 1 — Codebase Discovery

### 1.1 Repository shape

- **Type.** TypeScript pnpm monorepo (Node ≥ 22), with a Vite/React dashboard SPA.
- **Runtime topology.** Host-side Node.js control plane + Vite dev server + Docker Compose stack (Postgres 17 + OpenClaw gateway container).
- **Primary entrypoint.** `corepack pnpm start` → `scripts/start-stack.mjs` boots Docker Compose, applies migrations, sweeps stale runs, starts the operator API (`:8080`), the dashboard dev server (`:5173`), and the polling daemon.

### 1.2 Packages

| Package | Responsibility |
|---------|----------------|
| `packages/contracts` | Zod schemas, enums, lifecycle/workspace/evidence/operator/planning types. Shared vocabulary. |
| `packages/policy` | Deterministic eligibility, risk, approval, and guardrail rules. |
| `packages/control-plane` | Pipeline orchestration, operator API (`operator-api.ts` ≈ 4.6k LoC), polling, dispatch, workspace materialization, OpenClaw config generation, MCP bridge, webhook receiver. |
| `packages/execution-plane` | Agent identities, role definitions, OpenClaw model bindings, deterministic fallbacks. |
| `packages/evidence` | Postgres schema (18 SQL migrations under `drizzle/`), repository layer, in-memory test double, row mappers, run-summary queries. |
| `packages/integrations` | GitHub REST adapter, GitHub Issues sub-issue adapter, CI adapter, OpenClaw HTTP hook dispatch adapter, OpenClaw ACPX dispatch adapter, OpenClaw Task Flow adapter, secrets adapter, circuit breaker. |
| `packages/dashboard` | React 18 + Tabler SPA: Dashboard / Projects / Approvals / Pipeline / Evidence / Agents / Repositories / Submit Issue / OpenClaw Settings. |
| `packages/reddwarf-hooks` | Hook utility package. |

### 1.3 Runtime assets (mounted into OpenClaw)

- `agents/openclaw/{holly,rimmer,kryten,lister,plugins}` — agent bootstrap (IDENTITY.md, SOUL.md, AGENTS.md, TOOLS.md, SKILL.md) and the `reddwarf-operator` plugin exposing WebChat commands.
- `prompts/`, `schemas/`, `standards/`, `clawhub/skills/` — policy-pack assets.
- `infra/docker/docker-compose.yml` + `infra/docker/openclaw.json` — template runtime config; live config is generated at `runtime-data/openclaw-home/openclaw.json` per run.

### 1.4 Data flow (steady-state)

```
GitHub Issue (ai-eligible label)  ──┐
Local /submit CLI  ─────────────────┤
GitHub webhook (when configured) ───┘
            │
            ▼
Intake (polling or webhook) → Eligibility → Rimmer complexity classifier
            │
            ├── size=small ──► single-issue planning (Holly, Anthropic or OpenAI)
            └── size=medium|large ──► Project Mode planning (ProjectSpec + TicketSpec[])
            │
            ▼
Approval queue (operator API / dashboard / WebChat / Discord)
            │
            ▼
Post-approval dispatcher ──► OpenClaw agent session (Lister developer)
            │                        │
            │                        └─► OpenClaw Task Flow (when enabled)
            ▼
Architecture review (Kryten) → Validation (Kryten: workspace lint/test)
            │
            ▼
SCM adapter → branch + real PR against target repo
            │
            ▼
On PR merge → .github/workflows/reddwarf-advance.yml → POST /projects/advance
            │
            ▼
Next ticket dispatch (Project Mode) or project complete
            │
            ▼
Evidence (diffs, logs, session transcript, dreams) archived to Postgres + runtime-data/evidence
```

### 1.5 Surface inventory

- **Operator HTTP API** (`:8080`): ~45 routes including `/health`, `/config`, `/config/schema`, `/repos`, `/runs`, `/runs/:id`, `/tasks`, `/tasks/:id`, `/approvals`, `/projects`, `/projects/:id/approve`, `/projects/advance`, `/issues/submit`, `/tasks/inject`, `/secrets/:key/rotate`, `/tool-approvals`, `/sessions/policy`, `/openclaw/*`, `/webhooks/github`, `/ui`, `/ui/bootstrap`.
- **Dashboard SPA** (`:5173`): 11 routes via React Router (see table above).
- **OpenClaw Control UI** (`:3578`): gateway-provided UI, bearer-protected.
- **OpenClaw WebChat commands**: `/runs`, `/submit`, `/rdstatus`, `/rdapprove`, `/rdreject` via `agents/openclaw/plugins/reddwarf-operator`.
- **OpenClaw MCP bridge**: 6 read-only tools (`reddwarf_find_task_history`, `reddwarf_get_task_history`, `reddwarf_get_task_evidence`, `reddwarf_list_runs`, `reddwarf_get_run`, `reddwarf_get_run_evidence`).
- **CLI**: `bin/reddwarf` — `submit`, `report`.
- **Discord**: optional, via OpenClaw's native channel support.

---

## SECTION 2 — Comprehensive User Guide

### 2.1 What This App Does

- **Purpose.** RedDwarf turns a GitHub issue (or a locally-submitted task) into a reviewed, tested, auditable pull request, using an AI dev team running inside OpenClaw. Every meaningful decision (eligibility, plan, risk class, approval) is persisted; operators stay in the loop through an API, a browser dashboard, Discord, or WebChat.
- **Who it is for.** Solo developers and small teams who want supervised AI automation on their own repos, with an emphasis on auditability and explicit approval gates rather than black-box autonomy.
- **Core problem it solves.** "Give AI autonomy without losing visibility or control." Instead of a chat-driven agent that edits your repo unsupervised, RedDwarf adds durable state, policy, risk classification, approval queues, and evidence capture around the agent loop.

### 2.2 Key Features

**Intake**
- GitHub issue polling with per-repo cursors, configurable interval, and timeout isolation.
- Optional GitHub webhook receiver with HMAC-SHA256 verification.
- Local CLI intake: `reddwarf submit --repo ... --title ... --summary ...`.
- Dashboard "Submit Issue" page for API-mediated submission.

**Planning**
- Rimmer coordinator module classifies complexity (small/medium/large).
- Holly architect persona runs via OpenClaw (`reddwarf-analyst`) or as a deterministic fallback.
- Planning emits a `PlanningSpec` or (Project Mode) a `ProjectSpec` + ordered `TicketSpec[]`.
- Clarification loop: Holly can request missing context via operator API.
- Token budgets per phase; plan confidence gate; prompt version tracking.

**Policy & Approval**
- Deterministic eligibility + risk classification.
- Durable approval queue with decisions logged to Postgres.
- Plan amendments re-feed Holly's planning context.
- Tool-approval hook (optional) routes OpenClaw file-write/tool calls through operator API approval.

**Development / Review / Validation**
- Dave Lister developer agent (`reddwarf-developer`) runs in an isolated managed workspace.
- Kryten architecture reviewer and validator phases.
- Validation runs workspace-local lint/test, bounded by subprocess timeouts.
- Retry budgets per phase; escalation to operator on exhaustion.

**SCM**
- Real branch publish and PR creation against a target GitHub repo (after approval).
- Enforces allowed-path boundaries before commit.
- Redacts secrets from argv, errors, and operator-visible responses.
- PR body markers tie back to the originating ticket (Project Mode).

**Project Mode (M20)**
- Multi-ticket plans with explicit dependency graph.
- Serial ticket execution (v1 — no parallel tickets).
- GitHub sub-issue creation against the parent issue on approval.
- `reddwarf-advance.yml` GitHub Actions workflow advances the project on PR merge.

**OpenClaw Platform Integration (M21, feature-flagged)**
- Model failover chains (Anthropic ↔ OpenAI).
- Structured execution items + live agent progress timeline on dashboard.
- Plugin before-tool-call approval hook.
- Task Flow mirrored mode for project tickets.
- ACPX embedded dispatch.
- ClawHub skill publishing + dynamic discovery.
- Dreaming memory capture from agent sessions.

**Security hardening (M22, all complete)**
- Scoped Docker env injection (minimal secrets into OpenClaw container).
- Fail-closed policy lookup in before-tool-call hook.
- Hook-token scope separation.
- ACPX adapter retry + HTTP fallback on 404.
- Agent-to-agent messaging default: opt-in.
- Startup stale-secret-lease audit + periodic cleanup.
- Session transcript Zod validation + malformed-input hardening.
- Cached & timeout-bounded OpenClaw health probe.

**Operator surfaces**
- REST Operator API (bearer auth).
- React Tabler SPA dashboard.
- Legacy single-file operator panel at `GET /ui`.
- OpenClaw WebChat commands.
- Discord (optional, native via OpenClaw).
- OpenClaw MCP bridge for agent-side read-only queries.

**Observability & evidence**
- Postgres tables: `task_manifests`, `phase_records`, `planning_specs`, `project_specs`, `ticket_specs`, `policy_snapshots`, `approval_requests`, `pipeline_runs`, `run_events`, `evidence_records`, `memory_records`, `github_issue_polling_cursors`, `operator_config`, `prompt_snapshots`, `eligibility_rejections`, `intent_log`.
- Evidence archive on disk at `runtime-data/evidence` (host) / `/var/lib/reddwarf/evidence` (runtime).
- `pnpm reddwarf:report` — run-report markdown export.
- 31 `*.test.ts` suites + 22 `verify-*.mjs` integration scripts (aggregated by `pnpm verify:all`).
- Chaos scripts: `e2e:chaos:kill-recover`, `e2e:chaos:pg-restart`, `e2e:chaos:openclaw-kill`, plus a `chaos:run` harness with a toxiproxy profile.
- k6 load test for the operator API (`tests/k6-operator-api.js`).

**Partially built / non-functional notes**
- `docs/ARCHITECTURE.md §14` notes OpenClaw inner sandboxing is `off` in the current Docker topology; the container boundary + tool allow/deny is the enforcement surface (intentional limitation).
- Webhook-driven intake is complete and wired, but polling remains the default per `.env.example` (`REDDWARF_POLL_MODE=auto`).
- A "Logs" dashboard link is rendered as "Coming soon" in `packages/dashboard/src/app.tsx:258-266`.
- Many M21 features are complete but gated behind flags (all default `false`).
- The `/home/derek/code/RedDwarf/.codex` file and `.pnpm-store/` are present — expected local artifacts, not shippable state.

### 2.3 How To Use It — Step by Step

**Prerequisites**

- Docker Desktop (or Docker Engine + Compose plugin).
- Node.js ≥ 22 (`node --version`).
- Corepack (`corepack enable`).
- Git.
- A GitHub Personal Access Token (`repo` scope).
- Either an Anthropic API key **or** an OpenAI API key.

**First launch**

```bash
git clone <repo-url>
cd RedDwarf
corepack enable
corepack pnpm install
cp .env.example .env                       # edit .env — see §4.2
corepack pnpm run setup                    # idempotent: compose up + migrate + health
corepack pnpm start                        # boots the full stack
```

`pnpm start` brings up Docker Compose (Postgres + OpenClaw), applies migrations, sweeps stale runs, cleans old workspaces (>24h), starts the operator API on `:8080`, the dashboard on `:5173`, and the polling daemon (if configured).

**Primary workflow — file an AI-eligible issue**

1. Open a GitHub issue in a polled repo using the `.github/ISSUE_TEMPLATE/ai-task.yml` template. The template auto-applies the `ai-eligible` label.
2. RedDwarf's poller (or webhook) picks up the issue within `REDDWARF_POLL_INTERVAL_MS` (default 30s).
3. Rimmer classifies complexity. Holly plans.
4. The plan surfaces in the dashboard under `/approvals` (or `/projects` for Project Mode).
5. Operator approves via dashboard button, `POST /approvals/:id/resolve`, WebChat `/rdapprove`, or Discord (optional).
6. Post-approval dispatcher sends the task to Lister for development, then Kryten for review & validation.
7. SCM phase publishes a branch and opens a real PR. The PR body contains a `<!-- reddwarf:ticket_id:... -->` marker for Project Mode.
8. When the PR is merged, `reddwarf-advance.yml` posts to `/projects/advance`. Next ticket dispatches or the project completes.

**Alternate intake — local CLI**

```bash
export REDDWARF_OPERATOR_TOKEN=<token>
corepack pnpm exec reddwarf submit \
  --repo owner/repo \
  --title "Tighten operator retries" \
  --summary "Surface poll failures faster in the operator dashboard." \
  --acceptance "Polling failures appear in /health within one cycle." \
  --path packages/control-plane/src/polling.ts
```

**Alternate intake — dashboard**

- Visit `http://127.0.0.1:5173/submit` and fill the form.

**Alternate intake — webhook (when configured)**

- Set `REDDWARF_WEBHOOK_SECRET=<hex>` in `.env`.
- Point your GitHub webhook at `https://<public-host>/webhooks/github`.
- Events with the `ai-eligible` label bypass polling latency.

**Approvals**

```bash
export REDDWARF_OPERATOR_TOKEN=<token>
curl http://localhost:8080/blocked -H "Authorization: Bearer ${REDDWARF_OPERATOR_TOKEN}"
curl -X POST http://localhost:8080/approvals/<id>/resolve \
  -H "Authorization: Bearer ${REDDWARF_OPERATOR_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"decision":"approve","decidedBy":"you","decisionSummary":"ok"}'
```

**Approving a Project Mode plan**

```bash
curl -X POST http://localhost:8080/projects/<id>/approve \
  -H "Authorization: Bearer ${REDDWARF_OPERATOR_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"decision":"approve","decidedBy":"you","decisionSummary":"go"}'
```

**Clarification loop**

```bash
curl http://localhost:8080/projects/<id>/clarifications \
  -H "Authorization: Bearer ${REDDWARF_OPERATOR_TOKEN}"
curl -X POST http://localhost:8080/projects/<id>/clarify \
  -H "Authorization: Bearer ${REDDWARF_OPERATOR_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"answers":{"question-id":"answer text"}}'
```

**Manage polled repos without restart**

```bash
curl -X POST http://localhost:8080/repos \
  -H "Authorization: Bearer ${REDDWARF_OPERATOR_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"owner":"myorg","repo":"myrepo"}'
curl http://localhost:8080/repos -H "Authorization: Bearer ${REDDWARF_OPERATOR_TOKEN}"
```

**Switch model provider**

```bash
# Edit .env
REDDWARF_MODEL_PROVIDER=openai
OPENAI_API_KEY=sk-...
# Regenerate OpenClaw config
corepack pnpm generate:openclaw-config
# Restart the stack
```

**Rotate a secret**

```bash
curl -X POST http://localhost:8080/secrets/ANTHROPIC_API_KEY/rotate \
  -H "Authorization: Bearer ${REDDWARF_OPERATOR_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"value":"sk-ant-..."}'
```

Rotated values are persisted to `.secrets` (write-only, not echoed back) and require a stack restart to propagate to OpenClaw.

**Verify end-to-end against a real repo**

```bash
E2E_TARGET_REPO=owner/repo E2E_USE_OPENCLAW=true E2E_CLEANUP=true corepack pnpm e2e
```

This creates a real GitHub issue, runs the full pipeline, drives approvals, and opens a real PR. Expect to burn LLM tokens.

**Teardown**

```bash
corepack pnpm teardown                    # stop stack, preserve DB
corepack pnpm teardown -- --dry-run       # preview
corepack pnpm teardown -- --clean-evidence 14
corepack pnpm teardown -- --destroy-volumes  # full reset
```

**Important UI / state behaviors**

- The dashboard stores `REDDWARF_OPERATOR_TOKEN` in `sessionStorage` for the tab only; closing the tab requires re-auth.
- Approvals badge polls every 10s; health badge polls every 15s.
- "Coming soon" items in the sidebar (`Logs`) are intentionally disabled.
- The operator API enforces an IP-based rate limit (default 120 req / 60s).
- `REDDWARF_DRY_RUN=true` suppresses SCM mutations while still exercising the pipeline.
- OpenClaw sandboxing is `off` in the shipped Docker topology — file-write and tool allow/deny lists are the enforcement surface (see `docs/openclaw/AGENT_TOOL_PERMISSIONS.md`).

### 2.4 Known Limitations

- **No production deploy artifact.** No official image, no systemd unit, no Helm chart, no Terraform. Operator must copy the repo to a host, install Docker+Node 22+pnpm, and run `pnpm start`.
- **OpenClaw inner sandbox is `off`** by design in the current Docker topology. Container boundary + allow/deny lists are the only runtime enforcement.
- **Polling is still the default intake path.** Webhook-driven intake works (M21+M22 hardened), but setup requires external reachability (Tailscale Funnel configured) and is operator-initiated.
- **Project Mode tickets are serial in v1.** No parallel ticket execution. Mentioned explicitly in M20.
- **Dashboard "Logs" page is not implemented.** Placeholder "Coming soon" link in the sidebar.
- **Some adapters disabled by default** behind `V1MutationDisabledError` (GitHub Issues adapter requires `REDDWARF_GITHUB_ISSUES_ENABLED=true`).
- **OpenClaw image is pinned to `ghcr.io/openclaw/openclaw:latest`** in Docker Compose; docs note v2026.4.5 is required for several M21 features. The image may drift unexpectedly.
- **WebChat cannot override OpenClaw's native `/status`, `/approve`, `/reject`** — intentional `rd*` aliases.
- **E2E test is not part of `pnpm test`.** It burns real LLM tokens; CI does not cover it.
- **Windows/WSL2 only tested one way.** Use `127.0.0.1`, not `localhost`, for host-side scripts. Postgres is on non-standard port `55532`.

---

## SECTION 3 — MVP Assessment

### 3.1 Core Value Proposition

The MVP promise is: **file a GitHub issue → get an AI-authored PR reviewed, validated, and opened against your repo, with durable evidence and explicit human gates at the right points.**

**Does the current build deliver that promise end-to-end?** Yes — and verifiably so. `corepack pnpm e2e` scripts and `corepack pnpm verify:all` exercise the full path (real GitHub issue → plan → approval → dispatch to Lister → validation → SCM → real PR). The completed features archive lists 134+ shipped features spanning M0 through M22, including SCM, approval queue, evidence archive, operator API, and dashboard. Multiple features are gated behind flags but the default path works.

### 3.2 Feature Completeness Scorecard

| Feature | Status | Notes |
|---------|--------|-------|
| GitHub issue polling + cursor persistence | ✅ Complete | Per-repo cursors, timeout isolation, backoff on GitHub unreachable. |
| GitHub webhook intake | ✅ Complete | HMAC-SHA256 verification, configurable path, auto-mode disables polling when secret set. |
| Local CLI intake | ✅ Complete | `reddwarf submit` → operator API → normal pipeline. |
| Rimmer complexity classifier | ✅ Complete | Small vs medium/large routing; signals persisted. |
| Single-issue planning (Holly) | ✅ Complete | Anthropic + OpenAI providers; deterministic fallback. |
| Project Mode planning | ✅ Complete | ProjectSpec + TicketSpec[]; dependency graph validated (cycles, duplicates, self-refs rejected). |
| Clarification loop | ✅ Complete | Operator API endpoints + timeout + Postgres persistence. |
| Token budget + plan confidence gates | ✅ Complete | Per-phase budgets, overage warn/block. |
| Prompt version tracking | ✅ Complete | `prompt_snapshots` table. |
| Approval queue | ✅ Complete | Durable in Postgres, surfaced on dashboard, operator API, WebChat, Discord. |
| Developer phase (Lister via OpenClaw) | ✅ Complete | Workspace materialization, HTTP hook dispatch + ACPX (flagged). |
| Architecture review phase (Kryten) | ✅ Complete | Retry budget. |
| Validation phase | ✅ Complete | Workspace-local lint/test with bounded subprocess timeouts. |
| SCM publishing (branch + PR) | ✅ Complete | Real GitHub PRs; allowed-path enforcement; secret redaction. |
| PR merge → next-ticket advance | ✅ Complete | `reddwarf-advance.yml` + `/projects/advance` idempotency. |
| Evidence capture | ✅ Complete | Postgres metadata + disk archive of diffs/logs/handoffs/reports. |
| Dreaming memory capture | ✅ Complete | Flagged behind `REDDWARF_DREAMING_MEMORY_ENABLED`. |
| OpenClaw runtime config generation | ✅ Complete | Provider-aware agent roster; generated from typed config. |
| OpenClaw MCP bridge | ✅ Complete | 6 read-only tools. |
| OpenClaw WebChat commands | ✅ Complete | `rd*` aliases for status/approve/reject; `/runs`; `/submit`. |
| OpenClaw plugin approval hook | ✅ Complete | Flagged behind `REDDWARF_PLUGIN_APPROVAL_HOOK_ENABLED`; fail-closed on policy lookup. |
| OpenClaw Task Flow (mirrored) | ✅ Complete | Flagged behind `REDDWARF_TASKFLOW_ENABLED`. |
| ACPX dispatch | ✅ Complete | Flagged behind `REDDWARF_ACPX_DISPATCH_ENABLED`; HTTP fallback on 404. |
| Model failover chains | ✅ Complete | Flagged behind `REDDWARF_MODEL_FAILOVER_ENABLED`. |
| ClawHub skill discovery | ✅ Complete | Flagged; allowlist moved to operator config. |
| Operator HTTP API (auth, rate-limit, full CRUD for runs/tasks/approvals/projects/repos/config/secrets) | ✅ Complete | ~45 routes. |
| Operator dashboard SPA | ✅ Complete | 10 functional pages; "Logs" placeholder. |
| Legacy operator panel at `/ui` | ✅ Complete | Grouped controls. |
| Discord integration | ✅ Complete | Native OpenClaw channel; approver IDs; streaming; presence. |
| Secret rotation API | ✅ Complete | Write-only; persists to `.secrets`; OpenClaw restart required. |
| Tailscale Funnel external reachability | ✅ Complete | Documented in `docs/tailscale-funnel-setup.md`. |
| Knowledge ingestion pipeline | ✅ Complete | ADRs, standards, curated external context. |
| Chaos tests (kill-recover, PG restart, OpenClaw kill) | ✅ Complete | k6 load test included. |
| Structured eligibility rejections | ✅ Complete | Reason codes persisted. |
| Dry-run mode | ✅ Complete | `REDDWARF_DRY_RUN=true` suppresses mutations. |
| Automated run-report markdown export | ✅ Complete | `pnpm reddwarf:report`. |
| Security hardening (M22 F-157..F-173) | ✅ Complete | All 17 audit items. |
| Production deploy artifact (image/compose for prod, systemd unit, backup strategy) | ⚠️ Partial | Local Docker Compose only; no hosted-image path; no backup runbook. |
| Inner OpenClaw sandbox (runtime isolation beyond container) | ❌ Missing | Intentional — `mode: "off"` per current topology, deferred. |
| Dashboard Logs view | ❌ Missing | "Coming soon" link. |
| Multi-tenancy / user accounts | ❌ Missing | Single operator token model; no per-user auth. |
| Parallel ticket execution in Project Mode | ❌ Missing | Serial-only in v1, per spec. |
| Billing / usage metering surface | ❌ Missing | No UI for per-task token spend roll-up (data exists in evidence). |
| PR re-review loop (Kryten reviewing reviewer feedback) | ❌ Missing | PR comments are not consumed as a feedback loop. |
| Automated CI-gate integration (wait for CI green before PR) | ❌ Missing | CI adapter contract exists; live gating not wired. |

### 3.3 MVP Verdict

**YES — MVP achieved** for the advertised loop (issue → plan → approve → code → validate → PR). The system is substantially more complete than MVP-table-stakes: it has a real dashboard, durable state, multi-surface control, webhook intake, Project Mode, and shipped security hardening.

**What should come next, in priority order:**

1. **Production deploy story** — publish a supported image + compose file + backup/restore runbook; turn the local-first setup into a "deploy on a $10 VPS" path. This is the #1 gap between "works for the author" and "shareable to a friend."
2. **Fill the Dashboard Logs view** — the only "Coming soon" surface on the shipped dashboard.
3. **CI-gate wiring** — before opening a PR, run the target repo's CI and block publish on red. The contract exists; the wire-up does not.
4. **Inner sandbox plan** — scope and ship an actual inner-container sandbox (or Firecracker/gVisor alternative) for OpenClaw. Today's "container boundary + allow/deny" is fine for single-operator self-hosted use; it is not enough for multi-tenant or hosted offerings.
5. **Operator observability polish** — per-task token spend rollup + per-repo cost dashboards.

---

## SECTION 4 — Boot & Environment Verification

### 4.1 Boot Scripts

All scripts live in `package.json` → `scripts`, backed by files in `scripts/*.mjs`. Corepack is required (`corepack enable`).

| Script | Command | Purpose |
|--------|---------|---------|
| `setup` | `corepack pnpm run setup` | Idempotent bootstrap: compose up → Postgres ready → migrations → health check → OpenClaw config generation → workspace cleanup. |
| `start` | `corepack pnpm start` | Full stack boot: infra + migrations + stale-run sweep + operator API (`:8080`) + dashboard (`:5173`) + polling daemon. Ctrl-C shuts down gracefully. |
| `teardown` | `corepack pnpm teardown` | Sweep runs, stop Docker, clean workspaces, remove stale OpenClaw config. DB volume preserved by default. Flags: `--dry-run`, `--clean-evidence N`, `--destroy-volumes`. |
| `compose:up` | `corepack pnpm compose:up` | Docker Compose up for Postgres only. |
| `compose:up:openclaw` | `corepack pnpm compose:up:openclaw` | Add OpenClaw profile. |
| `compose:down` | `corepack pnpm compose:down` | Docker Compose down. |
| `build` | `corepack pnpm build` | `tsc -b` across all packages. |
| `typecheck` | `corepack pnpm typecheck` | TypeScript check without emit. |
| `test` | `corepack pnpm test` | Vitest unit + integration tests (does not include E2E). |
| `lint` | `corepack pnpm lint` | ESLint. |
| `format:check` | `corepack pnpm format:check` | Prettier check. |
| `db:generate` | `corepack pnpm db:generate` | Drizzle-kit generate. |
| `db:migrate` | `corepack pnpm db:migrate` | Apply SQL migrations from `packages/evidence/drizzle/`. |
| `operator:api` | `corepack pnpm operator:api` | Start the operator API standalone. |
| `generate:openclaw-config` | `corepack pnpm generate:openclaw-config` | Regenerate `runtime-data/openclaw-home/openclaw.json`. |
| `workspace:materialize` | `corepack pnpm workspace:materialize` | Materialize an OpenClaw workspace for manual inspection. |
| `workspace:destroy` | `corepack pnpm workspace:destroy` | Destroy a managed workspace. |
| `package:policy-pack` | `corepack pnpm package:policy-pack` | Build versioned policy-pack artifact under `artifacts/policy-packs/`. |
| `verify:all` | `corepack pnpm verify:all` | Run all 22 verify scripts in parallel (configurable concurrency). |
| `verify:postgres` | `corepack pnpm verify:postgres` | Planning pipeline + Postgres integration. |
| `verify:package` | `corepack pnpm verify:package` | Packaged policy-pack integrity. |
| `verify:observability` / `:integrations` / `:memory` / `:concurrency` / `:workspace-manager` / `:approvals` / `:development` / `:validation` / `:secrets` / `:scm` / `:evidence` / `:recovery` / `:operator-api` / `:operator-mcp` / `:report-cli` / `:submit-cli` / `:knowledge-ingestion` / `:bootstrap-alignment` | — | Targeted integration scripts. |
| `e2e` | `E2E_TARGET_REPO=owner/repo corepack pnpm e2e` | Live E2E: real GitHub issue → PR. Burns LLM tokens. |
| `e2e:chaos:kill-recover` / `:pg-restart` / `:openclaw-kill` | — | Chaos scripts. |
| `e2e:chaos` | `corepack pnpm e2e:chaos` | Run all three chaos scripts sequentially. |
| `loadtest` | `corepack pnpm loadtest` | k6 load test for the operator API. |
| `chaos:run` | `corepack pnpm chaos:run` | Multi-fault chaos harness with toxiproxy profile. |
| `cleanup:evidence` | `corepack pnpm cleanup:evidence` | Delete old evidence records + files. |
| `cleanup:approvals` | `corepack pnpm cleanup:approvals` | Clean stale approval rows. |
| `query:evidence` | `corepack pnpm query:evidence` | Ad-hoc evidence query. |
| `reddwarf:report` | `corepack pnpm reddwarf:report` | Run-report markdown export. |
| `reddwarf` CLI | `corepack pnpm exec reddwarf <cmd>` | `submit` and `report` subcommands. |

**Full local boot sequence?** Yes — `corepack pnpm install && cp .env.example .env && corepack pnpm start`.

**Full production boot sequence?** Partial. The same `pnpm start` works on a VPS behind Tailscale Funnel (per `docs/tailscale-funnel-setup.md`), but there is no official systemd unit, no hosted image, and no backup/restore runbook. The local topology is the production topology today.

**Missing scripts / gaps.**
- No `pnpm start:prod` variant that skips the Vite dev server and serves a prebuilt dashboard.
- No `pnpm backup:db` / `pnpm restore:db` scripts.
- No turnkey deploy script (Docker image push, health probe endpoint for a load balancer, etc.).

### 4.2 Environment Setup

- **Env files found.**
  - `.env` (populated, gitignored — present in the local working tree).
  - `.env.example` (canonical, checked in, 183 lines).
  - `.secrets` (empty, created by setup with restricted perms).
  - Docker Compose reads `env_file: ../../.env` and `env_file: ../../.secrets`.
- **Loading order.** `.env` → `.secrets` → Postgres `operator_config` overlay (runtime-configurable keys only).

**Environment variable inventory** (91 entries in `.env.example`, grouped by the repo's own classification):

| Variable | Required | Purpose | Where To Get It |
|----------|----------|---------|-----------------|
| `OPENCLAW_IMAGE` | No | OpenClaw container image | Defaults to `ghcr.io/openclaw/openclaw:latest`. |
| `OPENCLAW_HOST_PORT` | No | OpenClaw Control UI host port | Default `3578`. |
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | No | Local Postgres creds | Default `reddwarf`. |
| `POSTGRES_HOST_PORT` | No | Host port for Docker Postgres | Default `55532`. |
| `DATABASE_URL` | Yes | In-container Postgres URL | Auto from defaults. |
| `HOST_DATABASE_URL` | Yes | Host-side Postgres URL | Auto; WSL2 use `127.0.0.1`. |
| `REDDWARF_POLICY_SOURCE_ROOT` / `_ROOT` / `_WORKSPACE_ROOT` / `_EVIDENCE_ROOT` / `_HOST_WORKSPACE_ROOT` / `_HOST_EVIDENCE_ROOT` / `_POLICY_PACKAGE_OUTPUT_ROOT` / `_OPENCLAW_WORKSPACE_ROOT` / `_OPENCLAW_CONFIG_PATH` / `_OPENCLAW_OPERATOR_API_URL` / `_OPENCLAW_TRUSTED_AUTOMATION` | No | Filesystem + container paths | Defaults fine for local. |
| `REDDWARF_MODEL_PROVIDER` | Yes | `anthropic` or `openai` | User choice. |
| `REDDWARF_MODEL_FAILOVER_ENABLED` | No | Cross-provider failover | `false` default. |
| `REDDWARF_OPENCLAW_BROWSER_ENABLED` | No | Enable Holly's browser | `true` default. |
| `REDDWARF_EXECUTION_ITEMS_ENABLED` / `REDDWARF_PLUGIN_APPROVAL_HOOK_ENABLED` / `REDDWARF_OPENCLAW_AGENT_TO_AGENT_ENABLED` / `REDDWARF_TASKFLOW_ENABLED` / `REDDWARF_ACPX_DISPATCH_ENABLED` / `REDDWARF_CLAWHUB_ENABLED` / `REDDWARF_CLAWHUB_ALLOWED_PUBLISHERS` / `REDDWARF_DREAMING_MEMORY_ENABLED` | No | M21 feature flags | `false` defaults. |
| `REDDWARF_OPENCLAW_DISCORD_*` (19 vars) | No | Native OpenClaw Discord config | Only when Discord enabled. |
| `REDDWARF_WEBHOOK_SECRET` | No (optional) | Enables webhook receiver | `openssl rand -hex 32`. |
| `REDDWARF_WEBHOOK_PATH` | No | Webhook route | Default `/webhooks/github`. |
| `REDDWARF_POLL_MODE` | No | `auto`/`always`/`never` | Default `auto`. |
| `REDDWARF_POLL_REPOS` | No (deprecated seed) | Initial polled repo list | Prefer `POST /repos`. |
| `REDDWARF_POLL_INTERVAL_MS` / `REDDWARF_POLL_PER_REPO_TIMEOUT_MS` / `REDDWARF_DISPATCH_INTERVAL_MS` / `REDDWARF_PERIODIC_SWEEP_INTERVAL_MS` / `REDDWARF_PERIODIC_SWEEP_ENABLED` | No | Timing tuning | Defaults sensible. |
| `REDDWARF_API_PORT` | No | Operator API port | Default `8080`. |
| `REDDWARF_DASHBOARD_PORT` | No | Dashboard dev server port | Default `5173`. |
| `REDDWARF_API_URL` | No | Operator API URL override | Default `http://127.0.0.1:8080`. |
| `REDDWARF_DASHBOARD_ORIGIN` | No | CORS origin | Default derived. |
| `REDDWARF_LOG_LEVEL` | No | Pino log level | Default `info`. |
| `REDDWARF_SKIP_DASHBOARD` / `REDDWARF_SKIP_OPENCLAW` | No | Boot toggles | Defaults `false`. |
| `REDDWARF_DRY_RUN` | No | Suppress SCM mutations | Default `false`. |
| `REDDWARF_MIN_DISK_FREE_MB` | No | Disk guardrail | Default 500. |
| `REDDWARF_DB_POOL_*` (6 vars) | No | Postgres pool tuning | Defaults fine. |
| `REDDWARF_MAX_RETRIES_*` / `REDDWARF_TOKEN_BUDGET_*` / `REDDWARF_TOKEN_BUDGET_OVERAGE_ACTION` | No | Per-phase retry + token budgets | Defaults fine. |
| `GITHUB_TOKEN` | **Yes** | GitHub PAT for intake + PR creation | https://github.com/settings/tokens → Fine-grained token with `repo` scope on target repos. |
| `ANTHROPIC_API_KEY` | **Yes** (when `REDDWARF_MODEL_PROVIDER=anthropic`) | Planning + agent LLM calls | https://console.anthropic.com/settings/keys |
| `OPENAI_API_KEY` | **Yes** (when `REDDWARF_MODEL_PROVIDER=openai`) | Planning + agent LLM calls | https://platform.openai.com/api-keys |
| `OPENCLAW_HOOK_TOKEN` | **Yes** | Privileged hook-ingress token | Generate locally: `openssl rand -hex 32`. |
| `OPENCLAW_BASE_URL` | No | Gateway HTTP base URL | Default `http://localhost:3578`. |
| `OPENCLAW_GATEWAY_TOKEN` | **Yes** (for Control UI) | Browser auth for `:3578` | `openssl rand -hex 32`. |
| `OPENCLAW_DISCORD_BOT_TOKEN` | No (required when Discord on) | Discord bot token | https://discord.com/developers/applications |
| `REDDWARF_OPERATOR_TOKEN` | **Yes** | Bearer token for all operator routes except `/health` | `openssl rand -hex 32`. |
| `REDDWARF_GITHUB_ISSUES_ENABLED` | No | Enable GitHub sub-issue adapter | Default `false`. |
| `GITHUB_REPO` | No | Legacy fallback for sub-issue adapter | `owner/repo`. |
| `REDDWARF_OPERATOR_API_URL` | No | Public URL for GH Actions callbacks | Tailscale Funnel URL. |
| `REDDWARF_CLARIFICATION_TIMEOUT_MS` | No | Clarification expiry | Default 30 min. |
| `E2E_TARGET_REPO` / `E2E_USE_OPENCLAW` / `E2E_CLEANUP` | No | E2E controls | Only for `pnpm e2e`. |
| `GITHUB_ISSUE_AUTHOR_ALLOWLIST` | No | Restrict intake to specific authors | Comma-separated logins. |

### 4.3 Boot Sequence Verdict

**Can someone clone this repo and boot it with the instructions provided?** **YES for local dev.**

- `README.md` is detailed and accurate; `docs/DEMO_RUNBOOK.md` walks the full loop.
- `pnpm install && cp .env.example .env && pnpm start` works out of the box with Docker Desktop.

**Gaps that should be addressed before external sharing:**

- No production-shape deploy recipe. Docs repeatedly say "local-first" (ARCHITECTURE.md §14).
- `.env.example` has 91 entries; the README covers the critical subset but a reader could easily feel overwhelmed. A "minimum required" section at the top of `.env.example` would help first-run ergonomics.
- `REDDWARF_OPERATOR_TOKEN` is required by `pnpm start` — a missing value causes a boot failure with an error message, but there is no auto-generation path; the user must read the README (it is documented, but easy to miss).
- No automated check that `GITHUB_TOKEN` has sufficient scopes before the polling daemon starts pulling; scope errors surface later via `/health`.
- Windows/WSL2 notes are correct but scattered — a single "First run on Windows" section would cut onboarding time.

---

## SECTION 5 — Secret Keys & Credentials

| Secret | Purpose | Where To Get It | Free Tier Available | Required For |
|--------|---------|-----------------|---------------------|--------------|
| `GITHUB_TOKEN` | GitHub REST API: issue polling, branch publish, PR creation, cleanup | https://github.com/settings/personal-access-tokens/new (fine-grained, `repo` contents R/W on target repos + issues R/W) | Yes | Local + Prod |
| `ANTHROPIC_API_KEY` | Planning + Holly/Lister/Kryten agent runs (Anthropic mode) | https://console.anthropic.com/settings/keys | Trial credit, then paid | Local + Prod (if `REDDWARF_MODEL_PROVIDER=anthropic`) |
| `OPENAI_API_KEY` | Planning + agent runs (OpenAI mode) | https://platform.openai.com/api-keys | Trial credit, then paid | Local + Prod (if `REDDWARF_MODEL_PROVIDER=openai`) |
| `OPENCLAW_HOOK_TOKEN` | Privileged hook-ingress token for RedDwarf → OpenClaw `/hooks/agent` dispatch | Generate locally: `openssl rand -hex 32` | Yes (self-generated) | Local + Prod |
| `OPENCLAW_GATEWAY_TOKEN` | Browser auth for the OpenClaw Control UI at `:3578` | Generate locally: `openssl rand -hex 32` | Yes (self-generated) | Local + Prod |
| `REDDWARF_OPERATOR_TOKEN` | Bearer token for operator API, dashboard, OpenClaw plugin, MCP bridge | Generate locally: `openssl rand -hex 32` | Yes (self-generated) | Local + Prod |
| `OPENCLAW_DISCORD_BOT_TOKEN` | Native OpenClaw Discord bot | https://discord.com/developers/applications → Bot → Token | Yes | Local + Prod (only when Discord enabled) |
| `REDDWARF_WEBHOOK_SECRET` | HMAC-SHA256 verification for GitHub webhook receiver | Generate locally: `openssl rand -hex 32` | Yes (self-generated) | Local + Prod (only when webhook intake enabled) |

### Hardcoded-secret audit

Searched for `sk-ant-`, `ghp_`, and long `sk-` patterns across `.{ts,mjs,js,md,json,yml,yaml}`:

- `packages/contracts/src/index.test.ts` — **placeholder** (test fixture).
- `packages/control-plane/src/operator-api.test.ts` — **placeholder** (test fixture).
- `packages/integrations/src/github.test.ts` — **placeholder** (test fixture).
- `scripts/verify-operator-api.mjs` — **placeholder** (verify script).
- `docs/DEMO_RUNBOOK.md` — **placeholder** (`sk-ant-your_real_key`, documentation example).

**No live secrets are hardcoded in tracked source.** `.env` is gitignored.

**Risk flag.** The populated `.env` file exists in this working tree (7.3k bytes). Verify before any external share (tarball, demo, PR) that the file is excluded and that `git ls-files .env` returns empty.

### Secrets referenced in code but missing from `.env.example`

Cross-check of `process.env.*` usage vs `.env.example` entries:

- `GITHUB_ISSUE_AUTHOR_ALLOWLIST` — referenced in `packages/control-plane/src/polling.ts:707` but not present in `.env.example`. **Gap.** Add it with a comment under the "Webhook and Polling" group.
- `DISCORD_BOT_TOKEN` — fallback alias in `scripts/generate-openclaw-config.mjs` (the canonical key is `OPENCLAW_DISCORD_BOT_TOKEN`). Fine as-is.
- All other referenced keys are present in `.env.example`.

### Secret rotation & exposure posture

- Operator API `POST /secrets/:key/rotate` writes to `.secrets` (restricted perms), never echoes back.
- Docker Compose env for the OpenClaw container was hardened in F-157 to inject only `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_HOOK_TOKEN`, `OPENCLAW_BASE_URL`, and the active model API key — other secrets do **not** enter the OpenClaw process environment.
- Agent workspace secret leases are scrubbed on SIGTERM + at startup + periodically (F-163).
- Secrets are redacted from argv, persisted errors, and operator responses (F-64, F-93).

---

## Appendix A — Verification signals

- **Test count.** 31 `*.test.ts` suites across packages; `pnpm test` runs via Vitest (`tests/**/*.test.ts` + `packages/**/*.test.ts`).
- **Verify scripts.** 22 integration verify scripts aggregated by `pnpm verify:all`. Archive notes (2026-04-07) state "All 533 tests pass, typecheck clean" at end of M21.
- **Chaos coverage.** Three chaos scripts + a k6 load test + toxiproxy profile.
- **Migrations.** 18 SQL migrations under `packages/evidence/drizzle/`, numbered 0000–0017.
- **Completed feature count.** 134+ (per features_archive/COMPLETED_FEATURES.md line 5) spanning M0–M22.
- **Active pending features.** `FEATURE_BOARD.md` shows all M20 / M21 / M22 items marked **complete** on the latest read.

## Appendix B — Things to verify before a public release

1. `git ls-files | grep -E '\.env$|\.secrets$'` returns empty.
2. `corepack pnpm verify:all` passes on a clean clone.
3. `corepack pnpm e2e` against a throwaway repo successfully opens and closes a PR (`E2E_CLEANUP=true`).
4. The OpenClaw image tag in `infra/docker/docker-compose.yml` is pinned to a specific version (currently parameterized via `OPENCLAW_IMAGE`, default `:latest`).
5. Tailscale Funnel is configured and `REDDWARF_OPERATOR_API_URL` is reachable from a GitHub Actions runner.
6. `.env.example` includes `GITHUB_ISSUE_AUTHOR_ALLOWLIST` with a comment.
7. Dashboard "Logs" link is either implemented or removed from the sidebar.
