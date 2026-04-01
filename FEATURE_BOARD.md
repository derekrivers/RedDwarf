# RedDwarf Feature Board

The board is ordered by implementation priority.

This active board only lists pending work. Completed items are archived in [features_archive/COMPLETED_FEATURES.md](/c:/Dev/RedDwarf/features_archive/COMPLETED_FEATURES.md).

Priority reset note: after the March 29, 2026 hardening audit, pending feature work is intentionally ordered by production blast radius rather than feature-number chronology. Concurrency correctness, transactional durability, policy enforcement, credential safety, and operator-surface hardening now take precedence over new provider and intake features. Read [docs/pipeline-hardening-audit-2026-03-29.md](/c:/Dev/RedDwarf/docs/pipeline-hardening-audit-2026-03-29.md) before picking up features 90-99.

**OpenClaw platform principle (adopted March 2026):** Use OpenClaw for infrastructure concerns — sandboxing, model failover, notifications, scheduling, browser access. Own RedDwarf's domain logic — eligibility gating, role-scoped context, policy enforcement, pipeline orchestration. Where OpenClaw already provides a capability, configure it rather than build it. See [`docs/openclaw/reddwarf-openclaw-opportunities.md`](/c:/Dev/RedDwarf/docs/openclaw/reddwarf-openclaw-opportunities.md).

---

### M15 — Pipeline Hardening

| # | Feature | Milestone | Status | Architecture Trace |
| - | ------- | --------- | ------ | ------------------ |
| 91 | **[STALE]** Spec distillation pass. _OpenClaw `/compact` provides session compaction natively; no custom build needed._ | M15 | stale | — |
| 92 | **[STALE]** Project memory compression. _OpenClaw `/compact` covers context/memory compression natively; no custom build needed._ | M15 | stale | — |

---

### Fast-track — OpenClaw infrastructure config (low effort, no domain risk)

These items are configuration tasks against confirmed OpenClaw platform capabilities. They do not touch pipeline domain logic and can be picked up in any order independent of milestone sequencing.

| # | Feature | Status | Notes |
| - | ------- | ------ | ----- |
| 104 | Telegram channel integration - wire OpenClaw's native Telegram channel support for operators who prefer Telegram for approval and status notifications | pending | OpenClaw native Telegram support; config-only, mirrors 99–100 |
| 105 | **[BLOCKED FOR CURRENT TOPOLOGY]** Docker sandboxing for developer phase - run the Developer phase in a per-session Docker sandbox for execution isolation | blocked | Blocked in RedDwarf's current Docker-hosted OpenClaw topology because the seeded gateway container does not have Docker backend access, so sandboxed sessions fail and all agents currently use `sandbox: { mode: "off" }`. This is not a platform-wide OpenClaw limitation. Unblocks if deployment moves to a Linux host-installed OpenClaw gateway that can reach host Docker, or if the Docker deployment is rebuilt around OpenClaw's upstream sandbox-enabled container flow. See TROUBLESHOOTING.md. |
| 106 | **[NEEDS SCHEMA]** Model failover wiring - configure OpenClaw auth profile rotation between OAuth and API keys with automatic fallbacks so a model outage does not stall the full pipeline | blocked | OpenClaw failover config schema is not documented in this repo. Current gateway auth is `mode: "token"` only. Do not implement blind. Needs OpenClaw docs review before any config change. |

---

### M16 — Pipeline Domain Features

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

### M17 — Provider Expansion

| # | Feature | Milestone | Status | Architecture Trace |
| - | ------- | --------- | ------ | ------------------ |

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
