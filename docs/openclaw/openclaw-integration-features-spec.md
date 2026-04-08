# OpenClaw Integration Features Spec

> Reference document for FEATURE_BOARD milestone M21 (OpenClaw Platform Integration).
> Based on analysis of OpenClaw releases v2026.3.28 through v2026.4.5 against
> RedDwarf's current architecture and project mode pipeline.

---

## Feature 150 — Task Flow Mirrored Mode for Project Ticket Pipeline

### Context

OpenClaw v2026.4.2 introduced **Task Flow** — a durable flow orchestration substrate
that sits above background tasks and manages multi-step flows with their own state,
revision tracking, and sync semantics. Task Flows survive gateway restarts and support
child task spawning with sticky cancel intent.

Two sync modes are available:

- **Managed Mode**: OpenClaw owns the flow state end-to-end.
- **Mirrored Mode**: The flow state mirrors an external source. OpenClaw observes
  externally created tasks and keeps flow state in sync without taking ownership
  of task creation. Designed for external orchestrators.

Mirrored Mode is purpose-built for RedDwarf's architecture — RedDwarf stays the
source of truth for the `pending -> dispatched -> in_progress -> pr_open -> merged`
lifecycle, while OpenClaw provides durable child task spawning, unified progress
visibility, and automatic cleanup when a flow is cancelled.

### What RedDwarf Does Today

The project ticket pipeline is orchestrated entirely through RedDwarf's control plane:

1. On project approval, `executeProjectApproval` dispatches the first ready ticket
   via `POST /hooks/agent` to the OpenClaw gateway.
2. Each ticket runs through the full phase pipeline (planning -> dev -> validation -> SCM).
3. On PR merge, the GitHub Actions workflow calls `POST /projects/advance` which
   marks the ticket as merged, resolves the next ready ticket, and dispatches it.
4. Heartbeats, stale run detection, and timeout handling are managed by RedDwarf's
   `pipeline_runs` table and `claimPipelineRun` concurrency mechanism.

This works but is fragile: heartbeat sweeps, stale run recovery, orphaned run cleanup,
and the polling-based dispatch loop all add complexity and failure surfaces.

### What Changes

Replace the serial dispatch loop with a Task Flow in **mirrored mode**:

- On project approval, RedDwarf creates a Task Flow via the plugin API
  (`api.runtime.taskFlow`) with one child task per ticket in dependency order.
- OpenClaw manages child task lifecycle, heartbeats, and durable state.
- RedDwarf mirrors state transitions: when a ticket's child task completes (PR merged),
  RedDwarf advances the flow to the next child task.
- Cancellation: if RedDwarf marks a project as `failed`, it sends a cancel intent;
  OpenClaw stops scheduling new child tasks and waits for active ones to settle.
- Gateway restart recovery: Task Flow state is durable and revision-tracked, so
  a gateway restart does not lose progress.

### Key Integration Points

- `api.runtime.taskFlow` plugin seam for creating and driving managed Task Flows.
- `openclaw tasks flow list`, `openclaw tasks flow show <id>`, `openclaw tasks flow cancel <id>` for operational visibility.
- RedDwarf's `reddwarf-operator` plugin must register as a Task Flow driver.
- The `advanceProjectTicket` function becomes a flow state transition instead of
  a fresh dispatch.

### Migration Path

This is an additive change. The existing dispatch mechanism continues to work as a
fallback. The Task Flow integration can be gated behind a feature flag
(`REDDWARF_TASKFLOW_ENABLED`) and rolled out incrementally per project.

### References

- [Task Flow Documentation](https://docs.openclaw.ai/automation/taskflow)
- [OpenClaw v2026.4.2 Release](https://github.com/openclaw/openclaw/releases/tag/v2026.4.2)

---

## Feature 151 — Structured Execution Items on Dashboard

### Context

OpenClaw v2026.4.5 added **structured plan updates** and **structured execution
item events** — agents can emit typed progress events during long-running runs so
compatible UIs show step-by-step progress. This is tracked as OpenClaw issue #61319.

### What RedDwarf Does Today

During agent sessions (Holly planning, Lister developing, Kryten validating),
the dashboard has no real-time visibility into what the agent is doing. Operators
see `status: "active"` and heartbeat timestamps until the phase completes or fails.
The only mid-session signal is the heartbeat metadata (e.g., `scmStep: "publish"`).

### What Changes

Wire structured execution item events from OpenClaw into RedDwarf's evidence layer:

1. **Capture**: The OpenClaw session transcript (JSONL) already flows through
   `openclaw-session.ts`. Extend the parser to recognise structured execution
   item events.
2. **Persist**: Map execution items to a new `run_events` code
   (e.g., `AGENT_PROGRESS_ITEM`) with structured `data` payloads containing
   the plan step, status, and optional detail.
3. **Surface**: Expose execution items on the dashboard task detail view as a
   live timeline. Each item shows what the agent is working on, its status
   (pending/active/done), and elapsed time.
4. **Agent bootstrap**: Update Holly, Lister, and Kryten's bootstrap files to
   encourage emitting structured plan updates at natural milestones (e.g.,
   Holly: "Analysing repository structure", "Drafting ticket 3/5";
   Lister: "Implementing feature", "Running test suite").

### Key Design Decisions

- Execution items are **informational only** — they do not drive pipeline state.
  RedDwarf's phase lifecycle remains authoritative.
- Items are stored as run events, not a separate table, to avoid schema proliferation.
- The dashboard polls or subscribes to run events filtered by the active run ID.
- If the agent does not emit structured items, the dashboard falls back to
  heartbeat-only display (backwards compatible).

### References

- [OpenClaw v2026.4.5 Release](https://github.com/openclaw/openclaw/releases/tag/v2026.4.5)

---

## Feature 152 — Plugin Approval Hook for Agent-Side Safety Rails

### Context

OpenClaw v2026.3.28 introduced `before_tool_call` hooks with async `requireApproval`.
Plugins can pause tool execution mid-flight and prompt the user for approval through
the exec approval overlay, Discord, Telegram, Matrix, or the `/approve` command.

This is distinct from RedDwarf's existing approval gates (policy gate, failure
escalation, architecture review override), which are orchestrator-level gates that
block entire phases. The plugin approval hook operates at the **tool call level**
within a running agent session.

### What RedDwarf Does Today

RedDwarf enforces safety through:
- **Policy snapshots**: allowed/denied file paths per task.
- **Approval gates**: operator must approve before a phase starts.
- **AllowedPathViolationError**: SCM phase rejects commits touching denied paths.

But these are all enforced **after the fact** or **before a phase**. During a session,
if Lister attempts to write to a file outside allowed paths, the agent wastes time
and tokens before the SCM phase rejects the diff.

### What Changes

Add a `before_tool_call` hook in the `reddwarf-operator` plugin that:

1. **Intercepts file write operations** (`write`, `edit`, `bash` with redirects)
   against the task's policy snapshot allowed/denied paths.
2. **Intercepts sensitive operations**: database mutations, network requests to
   external services, large file deletions.
3. **Routes approval** through the RedDwarf operator API rather than OpenClaw's
   native approval surface, so all approvals flow through the same operator
   dashboard and audit trail.
4. **Records denied tool calls** as evidence records for post-hoc analysis.

### Scope Boundaries

- Only gate operations that are **operationally sensitive** or violate known policy.
  Do not gate every tool call — that would stall agent sessions.
- The hook must be fast (< 100ms for non-approval checks) to avoid degrading
  agent throughput.
- Auto-approve tool calls that are within policy. Only pause for approval when
  a policy violation or sensitive operation is detected.

### References

- [Exec Approvals Documentation](https://docs.openclaw.ai/tools/exec-approvals)
- [OpenClaw v2026.3.28 Release](https://github.com/openclaw/openclaw/releases/tag/v2026.3.28)

---

## Feature 153 — Model Failover Profiles

### Context

OpenClaw has built-in model failover with auth profile rotation and automatic
fallbacks between providers. Recent releases (v2026.3.28+) hardened this with
Bedrock Guardrails support and improved provider transport routing.

### What RedDwarf Does Today

RedDwarf supports two model providers (Anthropic and OpenAI) via the
`REDDWARF_MODEL_PROVIDER` environment variable in `openclaw-models.ts`. This is
a **static** configuration choice — all agents use one provider at a time. If
Anthropic has an outage, the entire pipeline stalls until an operator manually
switches the config and regenerates the OpenClaw config.

### What Changes

Configure OpenClaw model failover profiles in the generated `openclaw.json`:

1. **Primary/fallback chain**: Each agent role gets a failover chain.
   - Holly (analyst): `claude-opus-4-6` -> `gpt-5.4` -> `claude-sonnet-4-6`
   - Lister (developer): `claude-sonnet-4-6` -> `gpt-5.4`
   - Kryten (reviewer/validator): `claude-sonnet-4-6` -> `gpt-5`
   - Rimmer (coordinator): `claude-sonnet-4-6` -> `gpt-5`
2. **Automatic rotation**: On transient provider errors (429, 500, 503), OpenClaw
   automatically rotates to the next profile in the chain.
3. **Auth profiles**: Both `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` configured
   simultaneously with per-profile auth bindings.
4. **Operator visibility**: Record which model actually served each session in
   the run event metadata so operators can see when failover occurred.

### Key Design Decisions

- Failover is **transparent** to RedDwarf's pipeline — it happens inside OpenClaw.
- RedDwarf's `REDDWARF_MODEL_PROVIDER` becomes the **primary** preference, not the
  exclusive choice. Set to `anthropic` means "prefer Anthropic, fall back to OpenAI."
- Both API keys must be configured for failover to activate. If only one is set,
  failover is disabled (current behaviour).

### References

- [OpenClaw v2026.3.28 Release](https://github.com/openclaw/openclaw/releases/tag/v2026.3.28)

---

## Feature 154 — ACPX Embedded Dispatch

### Context

OpenClaw v2026.4.5 embedded the ACPX (Agent Client Protocol) runtime directly
in the bundled plugin, removing the external CLI hop. Combined with the MCP loopback
bridge, this enables tighter bidirectional communication between external orchestrators
and agent sessions.

The current dispatch mechanism (`POST /hooks/agent`) is fire-and-forget. RedDwarf
dispatches a task, then polls for completion by checking session state or waiting
for a heartbeat timeout. There is no mid-session feedback channel from the agent
back to RedDwarf.

### What RedDwarf Does Today

1. `HttpOpenClawDispatchAdapter.dispatch()` sends `POST /hooks/agent` with the
   task prompt, session key, agent ID, and `deliver: false`.
2. `OpenClawCompletionAwaiter` polls or watches for session completion.
3. On completion, `captureOpenClawSessionEvidence` parses the session JSONL transcript.
4. Heartbeats are managed by RedDwarf's `pipeline_runs` mechanism independently.

### What Changes

Replace HTTP hook dispatch with ACPX session binding:

1. **Session creation**: Use ACPX to create a bound session instead of firing a
   webhook. This gives RedDwarf a persistent handle to the session.
2. **Streaming progress**: ACPX sessions emit partial-message streaming events.
   RedDwarf can process these in real-time for heartbeat updates and progress
   tracking (complementary to Feature 151).
3. **Mid-session queries**: Through the MCP bridge, agents can call RedDwarf's
   operator MCP tools (task history, evidence lookup) with lower latency than
   the current REST-based MCP server.
4. **Graceful cancellation**: ACPX supports session cancellation signals, replacing
   the current stale-run-sweep mechanism with explicit cancellation.

### Migration Path

ACPX dispatch can coexist with HTTP hook dispatch. Gate behind
`REDDWARF_ACPX_DISPATCH_ENABLED`. The `OpenClawDispatchAdapter` interface stays
the same — only the implementation changes.

### Dependencies

- Feature 150 (Task Flow) benefits from ACPX session binding for child task management.
- Feature 151 (Structured Execution Items) benefits from streaming for real-time capture.

### References

- [ACPX GitHub](https://github.com/openclaw/acpx)
- [OpenClaw MCP Documentation](https://docs.openclaw.ai/cli/mcp)
- [OpenClaw v2026.4.5 Release](https://github.com/openclaw/openclaw/releases/tag/v2026.4.5)

---

## Feature 155 — ClawHub Skill Publishing

### Context

OpenClaw v2026.4.5 added ClawHub search, detail, and install flows directly in
the Skills panel. Agents can discover and pull community-published skills on demand.
ClawHub is OpenClaw's public skill registry (`clawhub.com`).

### What RedDwarf Does Today

Agent skills are statically bootstrapped from the `agents/openclaw/` directory:

- Holly: `issue_to_architecture_plan` skill
- Lister: `implement_architecture_plan` skill
- Kryten: `review_implementation_against_plan` skill

Skills are baked into the agent workspace at config generation time. There is no
mechanism for agents to discover or install new skills at runtime.

### What Changes

Two complementary workstreams:

#### A. Publish RedDwarf Skills to ClawHub

Package RedDwarf's governance skills for community consumption:

- `reddwarf-architect-planning` — Holly's issue-to-architecture-plan skill
- `reddwarf-developer-implementation` — Lister's plan implementation skill
- `reddwarf-code-review` — Kryten's architecture conformance review skill
- `reddwarf-validation` — Kryten's bounded validation check skill

Each published skill includes its SOUL, IDENTITY, and AGENTS context so it can
function standalone in any OpenClaw workspace. This is the most direct path to
community growth without requiring full RedDwarf adoption.

#### B. Enable Dynamic Skill Discovery for Holly

When Holly analyses an unfamiliar codebase, allow ClawHub skill search:

1. During the planning phase, Holly can search ClawHub for framework-specific
   skills (e.g., `next.js testing patterns`, `terraform deployment`, `rust cargo workspace`).
2. Discovered skills are installed into the session workspace and available for
   the current task only (not persisted to the agent's permanent workspace).
3. RedDwarf records which skills were discovered and used as evidence metadata.

### Scope Boundaries

- Skill discovery is **optional** — planning succeeds without it.
- Only skills from verified ClawHub publishers or a RedDwarf-curated allowlist.
- No auto-installation of skills that request elevated permissions (e.g., `group:automation`).

### References

- [ClawHub Registry](https://clawhub.com)
- [OpenClaw v2026.4.5 Release](https://github.com/openclaw/openclaw/releases/tag/v2026.4.5)

---

## Feature 156 — Dreaming Memory Integration

### Context

OpenClaw's dreaming feature (GA in v2026.4.5) lets agents consolidate session
learnings into persistent memory through a "REM" process. After a session ends,
the dreaming pass distils key learnings, patterns, and decisions into a structured
`dreams.md` file. New tooling includes `openclaw memory rem-harness` and
`promote-explain` commands, plus a Dream Diary surface in the UI.

### What RedDwarf Does Today

RedDwarf has its own memory system:

- `memory_records` table with `scope` (task, repo, global) and `provenance`
  (pipeline_derived, operator_supplied, agent_observed).
- Memory records are created explicitly by pipeline code (e.g., architect handoff,
  developer handoff, validation summary).
- Repo-scoped memories persist across tasks for the same repository.
- The `MemoryContext` builder assembles relevant memories for each phase prompt.

Agents do not contribute to persistent memory — only the pipeline does.

### What Changes

Map OpenClaw dreaming output to RedDwarf's memory system:

1. **Post-session dreaming**: After each agent session completes, trigger a
   dreaming pass (if not already triggered by OpenClaw's default schedule).
2. **Capture**: Parse the agent's `dreams.md` output and extract structured
   learnings (architectural patterns, codebase conventions, tool preferences,
   failure patterns).
3. **Persist**: Save extracted learnings as `memory_records` with:
   - `scope: "repo"` — scoped to the repository being worked on.
   - `provenance: "agent_observed"` — originated from agent session analysis.
   - `tags`: derived from the dream content (e.g., `["architecture", "testing", "react"]`).
4. **Recall**: Include repo-scoped agent observations in the `MemoryContext` for
   future tasks on the same repository. Holly sees what Lister learned about the
   codebase's test patterns; Lister benefits from Holly's architectural observations.

### Key Design Decisions

- Dreaming memories are **supplementary** — they inform but do not override
  pipeline-derived memories (handoffs, validation summaries).
- A deduplication pass prevents the same observation from being stored repeatedly
  across sessions.
- Operators can view and prune dreaming-derived memories through the operator API.
- Memory records from dreaming are tagged with `source: "dreaming"` for filtering.

### References

- [OpenClaw v2026.4.5 Release](https://github.com/openclaw/openclaw/releases/tag/v2026.4.5)

---

## Cross-Cutting Concerns

### Version Requirement

All features in this milestone require **OpenClaw >= v2026.4.2**. Features 151,
154, 155, and 156 require **>= v2026.4.5**. The Docker Compose config should pin
to a minimum version rather than using `latest`.

### Feature Flags

All features are gated behind environment variables and disabled by default:

| Feature | Flag | Default |
|---------|------|---------|
| 150 | `REDDWARF_TASKFLOW_ENABLED` | `false` |
| 151 | `REDDWARF_EXECUTION_ITEMS_ENABLED` | `false` |
| 152 | `REDDWARF_PLUGIN_APPROVAL_HOOK_ENABLED` | `false` |
| 153 | `REDDWARF_MODEL_FAILOVER_ENABLED` | `false` |
| 154 | `REDDWARF_ACPX_DISPATCH_ENABLED` | `false` |
| 155 | `REDDWARF_CLAWHUB_ENABLED` | `false` |
| 156 | `REDDWARF_DREAMING_MEMORY_ENABLED` | `false` |

### Backwards Compatibility

The existing HTTP hook dispatch, polling-based completion, and static skill
bootstrap must continue to work when the new features are disabled. No feature
in this milestone may break the existing single-issue or project mode pipelines.
