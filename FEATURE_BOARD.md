# RedDwarf Feature Board

The board is ordered by implementation priority.

This active board only lists pending work. Completed items are archived in [features_archive/COMPLETED_FEATURES.md](/c:/Dev/RedDwarf/features_archive/COMPLETED_FEATURES.md).

Priority reset note: after the March 29, 2026 hardening audit, pending feature work is intentionally ordered by production blast radius rather than feature-number chronology. Concurrency correctness, transactional durability, policy enforcement, credential safety, and operator-surface hardening now take precedence over new provider and intake features. Read [docs/pipeline-hardening-audit-2026-03-29.md](/c:/Dev/RedDwarf/docs/pipeline-hardening-audit-2026-03-29.md) before picking up features 90-99.

**OpenClaw platform principle (adopted March 2026):** Use OpenClaw for infrastructure concerns — sandboxing, model failover, notifications, scheduling, browser access. Own RedDwarf's domain logic — eligibility gating, role-scoped context, policy enforcement, pipeline orchestration. Where OpenClaw already provides a capability, configure it rather than build it. See [`docs/openclaw/reddwarf-openclaw-opportunities.md`](/c:/Dev/RedDwarf/docs/openclaw/reddwarf-openclaw-opportunities.md).

---

### M15 — Pipeline Hardening

| # | Feature | Milestone | Status | Architecture Trace |
| - | ------- | --------- | ------ | ------------------ |
| 89 | Deterministic eligibility gate - before materializing any context for an agent phase, run a cheap pre-check (no LLM call) that confirms the task is eligible to proceed and short-circuits ineligible tasks to avoid wasting tokens | M15 | complete | Control Plane, Knowledge & Policy Plane |
| 90 | Role-scoped context materialization - restrict the context window handed to each agent phase to only the slice relevant to that role; Architect gets policy and domain docs, Developer gets spec and code, Validator gets spec and diff | M15 | complete | Integration Plane, Knowledge & Policy Plane |
| 91 | **[STALE]** Spec distillation pass. _OpenClaw `/compact` provides session compaction natively; no custom build needed._ | M15 | stale | — |
| 92 | **[STALE]** Project memory compression. _OpenClaw `/compact` covers context/memory compression natively; no custom build needed._ | M15 | stale | — |
| 93 | Per-run project memory cache - cache the resolved project memory snapshot once per pipeline run so it is tokenized once and reused across all phases rather than reloaded per phase | M15 | complete | Knowledge & Policy Plane, Control Plane |

---

### Fast-track — OpenClaw infrastructure config (low effort, no domain risk)

These items are configuration tasks against confirmed OpenClaw platform capabilities. They do not touch pipeline domain logic and can be picked up in any order independent of milestone sequencing.

| # | Feature | Status | Notes |
| - | ------- | ------ | ----- |
| 99 | Discord approval bot - surface pending approval requests as interactive Discord messages with approve/reject buttons and respond to status queries | pending | OpenClaw native Discord channel integration (`channels.discord.token`); configure, don't build |
| 100 | Discord notifications for agents - push status updates and approval requests to a Discord channel mid-run for async human oversight | pending | OpenClaw native Discord channels; configure, don't build |
| 104 | Telegram channel integration - wire OpenClaw's native Telegram channel support for operators who prefer Telegram for approval and status notifications | pending | OpenClaw native Telegram support; config-only, mirrors 99–100 |
| 101 | Browser / web search for Architect agent - allow the Architect phase to pull current library docs and API references when formulating the planning spec | pending | OpenClaw built-in browser control (CDP-backed Chrome); enable via `browser.enabled: true` in openclaw.json |
| 105 | **[BLOCKED FOR CURRENT TOPOLOGY]** Docker sandboxing for developer phase - run the Developer phase in a per-session Docker sandbox for execution isolation | blocked | Blocked in RedDwarf's current Docker-hosted OpenClaw topology because the seeded gateway container does not have Docker backend access, so sandboxed sessions fail and all agents currently use `sandbox: { mode: "off" }`. This is not a platform-wide OpenClaw limitation. Unblocks if deployment moves to a Linux host-installed OpenClaw gateway that can reach host Docker, or if the Docker deployment is rebuilt around OpenClaw's upstream sandbox-enabled container flow. See TROUBLESHOOTING.md. |
| 106 | **[NEEDS SCHEMA]** Model failover wiring - configure OpenClaw auth profile rotation between OAuth and API keys with automatic fallbacks so a model outage does not stall the full pipeline | blocked | OpenClaw failover config schema is not documented in this repo. Current gateway auth is `mode: "token"` only. Do not implement blind. Needs OpenClaw docs review before any config change. |

---

### M16 — Pipeline Domain Features

| # | Feature | Milestone | Status | Architecture Trace |
| - | ------- | --------- | ------ | ------------------ |
| 94 | Pre-screener agent phase - add a lightweight pre-pipeline step that runs before the Architect and rejects tasks that are under-specified, duplicate, or out of scope, returning structured rejection reasons rather than consuming a full planning pass | M16 | pending | Integration Plane, Control Plane, Contracts |
| 95 | Structured GitHub issue template - add a repo issue template that collects the fields required for direct pipeline intake (title, acceptance criteria, affected areas, priority signal), reducing freeform-to-spec translation burden on the Architect | M16 | complete | Integration Plane |
| 96 | Direct task injection endpoint - add POST /tasks/inject operator API endpoint that accepts a structured task payload and enqueues it directly into the pipeline, bypassing the GitHub polling path for programmatic intake | M16 | complete | Control Plane, Integration Plane, Contracts |
| 97 | Local CLI task submission - add a reddwarf submit CLI command that wraps the direct injection endpoint, allowing a developer to push a task from the terminal without opening GitHub | M16 | complete | Control Plane |
| 98 | Task grouping and batch intake - allow multiple related tasks to be submitted as a named group with a declared dependency order, with the pipeline serializing or parallelizing them accordingly | M16 | pending | Control Plane, Contracts |
| 102 | CI adapter tool for agents - add a tool that lets Developer and Validator phases trigger and query CI runs so they can confirm build and test health as part of their phase execution | M16 | pending | Integration Plane |

---

### M17 — Provider Expansion

| # | Feature | Milestone | Status | Architecture Trace |
| - | ------- | --------- | ------ | ------------------ |
| 103 | OpenAI provider support - extend openClawModelBindingSchema provider to enum, update openclaw.json generation, add gpt model mapping alongside Anthropic equivalents | M17 | pending | Contracts, Integration Plane, Knowledge & Policy Plane |

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
