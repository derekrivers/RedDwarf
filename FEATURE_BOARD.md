# RedDwarf Feature Board

The board is ordered by implementation priority.

This active board only lists pending work. Completed items are archived in [features_archive/COMPLETED_FEATURES.md](/c:/Dev/RedDwarf/features_archive/COMPLETED_FEATURES.md).

Priority reset note: after the March 29, 2026 hardening audit and the April 2026 UX research pass, pending feature work is intentionally ordered by operator leverage and production blast radius rather than feature-number chronology. Operator onboarding, configuration safety, and day-to-day observability now sit ahead of speculative platform expansion. Read [docs/RedDwarf-UX-Research-Report.md](/home/derek/code/RedDwarf/docs/RedDwarf-UX-Research-Report.md) before picking up features 114-127, and read [docs/pipeline-hardening-audit-2026-03-29.md](/c:/Dev/RedDwarf/docs/pipeline-hardening-audit-2026-03-29.md) before picking up features 90-99.

**OpenClaw platform principle (adopted March 2026):** Use OpenClaw for infrastructure concerns — sandboxing, model failover, notifications, scheduling, browser access. Own RedDwarf's domain logic — eligibility gating, role-scoped context, policy enforcement, pipeline orchestration. Where OpenClaw already provides a capability, configure it rather than build it. See [`docs/openclaw/reddwarf-openclaw-opportunities.md`](/c:/Dev/RedDwarf/docs/openclaw/reddwarf-openclaw-opportunities.md).

Column legend: `Depends On` captures explicit delivery sequencing; `Deployment` is `Local`, `VPS`, or `Both`.

---

## M14 — Operator UX

Source reference: [`docs/RedDwarf-UX-Research-Report.md`](/home/derek/code/RedDwarf/docs/RedDwarf-UX-Research-Report.md). This milestone is the current top priority because operator friction is now a bigger adoption blocker than core pipeline semantics.

| # | Feature | Milestone | Status | Depends On | Deployment | Architecture Trace |
| - | ------- | --------- | ------ | ---------- | ---------- | ------------------ |
| 114 | Classify `.env` into boot-time, runtime, and secret tiers; refactor `.env.example` with grouped comment headers | M14 | complete | — | Both | UX report: Section 1.2, Appendix |
| 115 | Add `operator_config` Drizzle table and startup merge logic so DB-backed runtime config overrides `.env` | M14 | complete | 114 | Both | UX report: Sections 1.5, 2.4 |
| 116 | Add `GET /config`, `PUT /config`, and `GET /config/schema` Operator API endpoints with Zod contracts | M14 | complete | 115 | Both | UX report: Sections 2.2, 2.4 |
| 117 | Add `GET /repos`, `POST /repos`, and `DELETE /repos/:owner/:repo`; replace comma-string poll repo config with DB-backed repo management | M14 | complete | 116 | Both | UX report: Sections 1.3, 2.2 |
| 118 | Expand observability endpoints: filtered `GET /runs`, `GET /runs/:id`, `GET /runs/:id/evidence`, `GET /tasks`, `GET /tasks/:id` | M14 | complete | — | Both | UX report: Section 2.2 |
| 119 | Add `POST /secrets/:key/rotate` write-only endpoint backed by a permissions-restricted local secrets store | M14 | complete | 115 | Both | UX report: Sections 1.4, 2.2 |
| 120 | Build and serve a single-file operator configuration panel from `GET /ui` for Polling, DB Pool, Logging, Paths, Status, and secret rotation | M14 | complete | 116, 117, 118, 119 | Both | UX report: Sections 1.3, 2.2 |
| 121 | Register OpenClaw WebChat operator commands for `status`, `approve`, `reject`, `submit`, and `runs` | M14 | complete | 118 | Both | UX report: Section 4.2 |
| 122 | Add an MCP bridge over the Operator API so OpenClaw agents can query RedDwarf task history and evidence during context building | M14 | complete | 118 | Both | UX report: Section 4.3 |

---

## M15 — Pipeline Hardening

| # | Feature | Milestone | Status | Depends On | Deployment | Architecture Trace |
| - | ------- | --------- | ------ | ---------- | ---------- | ------------------ |
| 91 | **[STALE]** Spec distillation pass. _OpenClaw `/compact` provides session compaction natively; no custom build needed._ | M15 | stale | — | Both | — |
| 92 | **[STALE]** Project memory compression. _OpenClaw `/compact` covers context/memory compression natively; no custom build needed._ | M15 | stale | — | Both | — |

---

## Fast-track — OpenClaw Infrastructure Config

These items are configuration tasks against confirmed OpenClaw platform capabilities. They do not touch pipeline domain logic and can be picked up in any order independent of milestone sequencing.

| # | Feature | Status | Depends On | Deployment | Notes |
| - | ------- | ------ | ---------- | ---------- | ----- |
| 104 | Telegram channel integration - wire OpenClaw's native Telegram channel support for operators who prefer Telegram for approval and status notifications | pending | — | Both | OpenClaw native Telegram support; config-only, mirrors Discord-style operator notifications without changing RedDwarf domain logic |
| 105 | **[BLOCKED FOR CURRENT TOPOLOGY]** Docker sandboxing for developer phase - run the Developer phase in a per-session Docker sandbox for execution isolation | blocked | VPS deployment or sandbox-capable host OpenClaw | VPS | Blocked in RedDwarf's current Docker-hosted OpenClaw topology because the seeded gateway container does not have Docker backend access, so sandboxed sessions fail and all agents currently use `sandbox: { mode: "off" }`. This is not a platform-wide OpenClaw limitation. Unblocks if deployment moves to a Linux host-installed OpenClaw gateway that can reach host Docker, or if the Docker deployment is rebuilt around OpenClaw's upstream sandbox-enabled container flow. See TROUBLESHOOTING.md. |
| 106 | **[NEEDS SCHEMA]** Model failover wiring - configure OpenClaw auth profile rotation between OAuth and API keys with automatic fallbacks so a model outage does not stall the full pipeline | blocked | OpenClaw failover config schema review | Both | OpenClaw failover config schema is not documented in this repo. Current gateway auth is `mode: "token"` only. Do not implement blind. Needs OpenClaw docs review before any config change. |

---

## M16 — Pipeline Domain Features

Source reference: proposed additions in [`docs/REDDWARF_PROPOSED_FEATURES (1).md`](/home/derek/code/RedDwarf/docs/REDDWARF_PROPOSED_FEATURES%20(1).md). Read the linked section before implementation so schema, contract, control-plane, and operator-surface notes stay aligned with the original proposal.

| # | Feature | Milestone | Status | Architecture Trace |
| - | ------- | --------- | ------ | ------------------ |
| 107 | Dry-run / simulation mode | M16 | complete | Proposal source: [`docs/REDDWARF_PROPOSED_FEATURES (1).md#1-dry-run--simulation-mode`](/home/derek/code/RedDwarf/docs/REDDWARF_PROPOSED_FEATURES%20(1).md) |
| 108 | Plan confidence gate | M16 | complete | Proposal source: [`docs/REDDWARF_PROPOSED_FEATURES (1).md#2-plan-confidence-gate`](/home/derek/code/RedDwarf/docs/REDDWARF_PROPOSED_FEATURES%20(1).md) |
| 109 | Token budget enforcement | M16 | complete | Proposal source: [`docs/REDDWARF_PROPOSED_FEATURES (1).md#3-token-budget-enforcement`](/home/derek/code/RedDwarf/docs/REDDWARF_PROPOSED_FEATURES%20(1).md) |
| 110 | Pipeline run report export | M16 | complete | Proposal source: [`docs/REDDWARF_PROPOSED_FEATURES (1).md#4-pipeline-run-report-export`](/home/derek/code/RedDwarf/docs/REDDWARF_PROPOSED_FEATURES%20(1).md) |
| 111 | Prompt version tracking | M16 | complete | Proposal source: [`docs/REDDWARF_PROPOSED_FEATURES (1).md#5-prompt-version-tracking`](/home/derek/code/RedDwarf/docs/REDDWARF_PROPOSED_FEATURES%20(1).md) |
| 112 | Phase retry budget | M16 | complete | Proposal source: [`docs/REDDWARF_PROPOSED_FEATURES (1).md#6-phase-retry-budget`](/home/derek/code/RedDwarf/docs/REDDWARF_PROPOSED_FEATURES%20(1).md) |
| 113 | Structured eligibility rejection reasons | M16 | complete | Proposal source: [`docs/REDDWARF_PROPOSED_FEATURES (1).md#7-structured-eligibility-rejection-reasons`](/home/derek/code/RedDwarf/docs/REDDWARF_PROPOSED_FEATURES%20(1).md) |

---

## M17 — Provider Expansion

| # | Feature | Milestone | Status | Architecture Trace |
| - | ------- | --------- | ------ | ------------------ |

---

## M18 — VPS Expansion

Source reference: [`docs/RedDwarf-UX-Research-Report.md`](/home/derek/code/RedDwarf/docs/RedDwarf-UX-Research-Report.md). These features are intentionally grouped after Operator UX because they are materially more valuable once the stack is continuously hosted.

| # | Feature | Milestone | Status | Depends On | Deployment | Architecture Trace |
| - | ------- | --------- | ------ | ---------- | ---------- | ------------------ |
| 123 | VPS-specific Docker Compose config: internal-only Postgres, no `HOST_DATABASE_URL` workaround, optional TLS reverse proxy | M18 | pending | — | VPS | UX report: Section 5.9 |
| 124 | GitHub webhook intake endpoint to replace polling; reuse the direct task-intake path instead of duplicating intake logic | M18 | pending | S-4 resolution | VPS | UX report: Section 5.5 |
| 125 | Tailscale Funnel guide and optional `funnel` compose profile for authenticated remote access to gateway and operator UI | M18 | pending | 123 | VPS | UX report: Sections 5.3, 4.7 |
| 126 | CI adapter webhook receiver so validation can await real CI status events from GitHub Actions or equivalent | M18 | pending | 123 | VPS | UX report: Section 5.8 |
| 127 | Multi-provider per-phase failover using Anthropic and OpenAI once provider routing semantics are settled | M18 | pending | 106 | VPS | UX report: Section 5.7 |

---

## M19 — Operator Dashboard

Source reference: [`docs/Dashboard.md`](/home/derek/code/RedDwarf/docs/Dashboard.md). **Read `docs/Dashboard.md` in full before implementing any feature in this milestone.** It is the authoritative specification for component markup, API wiring, layout decisions, quality standards, build configuration, and Tabler documentation URLs. Do not rely on memory for Tabler class names or component patterns — fetch the Tabler docs pages linked in the file before writing any markup.

Key constraints that apply to every dashboard feature:
- Framework: React 18 + TypeScript strict + Vite + Tabler UI (`@tabler/core` + `@tabler/icons-react`) + TanStack Query + React Router v6
- Auth: `REDDWARF_OPERATOR_TOKEN` stored in `sessionStorage`; `decidedBy` is always the hardcoded string `"operator"` — never exposed as a UI field or accepted as a parameter
- Every API call must have a loading state (Tabler spinner), error state (Tabler alert), and empty state (Tabler empty state component with icon and message)
- No inline styles — Tabler utility classes only; no `any` in TypeScript; derive types from `packages/contracts` where possible
- Vite dev server proxies `/api/*` → `http://127.0.0.1:8080` so the `Authorization` header is forwarded and CORS is not an issue in development

| # | Feature | Milestone | Status | Depends On | Deployment | Notes |
| - | ------- | --------- | ------ | ---------- | ---------- | ----- |
| 131 | Approval list page (`/approvals`) | M19 | pending | 130 | Both | Full-page Tabler table: columns Request ID, Task Source, Risk Level, Phase, Created At, Status, Actions; status badge colouring — pending orange, approved green, rejected red; "Review" button on pending rows only, navigates to `/approvals/:id`; auto-refresh every 10 s via `refetchInterval`; show a Tabler toast "New approval request received." when a new pending item appears. Full spec in `docs/Dashboard.md` §PRIORITY 1 — Route: /approvals. |
| 133 | Dashboard home (`/dashboard`) | M19 | pending | 130 | Both | Stat cards row: total pipeline runs, active runs (status = running), pending approvals count (links to `/approvals`), failed runs last 24 h. Two columns below: left — last 10 pipeline runs with status badges; right — pending approvals list with "Review" buttons linking to `/approvals/:id`. Full spec in `docs/Dashboard.md` §PRIORITY 2. |
| 134 | Pipeline runs page (`/pipeline`) | M19 | pending | 130 | Both | Full-page table: Run ID, Task Source, Status, Phase, Started At, Duration, Actions; status filter dropdown; sortable by `started_at`; pagination at page size 25; expandable row detail panel; auto-refresh every 15 s. Full spec in `docs/Dashboard.md` §PRIORITY 3. |
| 135 | Evidence browser (`/evidence`) | M19 | pending | 130 | Both | Table: Run ID, Phase, Type, Recorded At, Size; client-side search/filter by run ID; expandable row showing raw JSON in `<pre>`; export row as `.json` file. Full spec in `docs/Dashboard.md` §PRIORITY 4. |
| 136 | Agent status page (`/agents`) | M19 | pending | 130 | Both | Responsive 3-column card grid; one card per agent definition; each card shows name, role, permission scopes as Tabler badges, last-seen timestamp derived from evidence records, and a healthy/unconfigured status indicator. Full spec in `docs/Dashboard.md` §PRIORITY 5. |

---

## Architectural Backlog

Items with confirmed platform support that require a design decision before implementation. Do not pick up without first resolving the stated question.

| # | Feature | Blocking question |
| - | ------- | ----------------- |
| S-1 | Agent-to-agent coordination via `sessions_*` tools - replace external control-plane orchestration of the Architect → Developer → Validator handoffs with OpenClaw-native `sessions_list` / `sessions_history` / `sessions_send` so phase coordination is observable through the session graph | Does the control plane become a thin wrapper or is it deprecated? Phase handoff semantics must be validated against OpenClaw session model before implementation begins. |
| S-4 | GitHub webhook intake (replace polling daemon) - fire the pipeline the moment an issue is labelled rather than waiting up to 30 seconds (`REDDWARF_POLL_INTERVAL_MS`) | Requires a publicly reachable webhook endpoint or tunnel; operator environment and security surface must be confirmed before any implementation work. |

---

## Long-term

| # | Feature | Notes |
| - | ------- | ----- |
| S-6 | OpenClaw cron for housekeeping - migrate stale run sweeps, workspace cleanup, and health checks from custom setup scripts into OpenClaw's native cron scheduler | Reduces bespoke infrastructure surface; low urgency |
| S-7 | ClawHub publishing - publish RedDwarf's Architect skills, validation rules, and task intake policy pack to the ClawHub registry for community discoverability | Requires deliberate decision on which internal policy rules are safe to expose publicly |
