# RedDwarf × OpenClaw — Untapped Feature Opportunities

> Analysis of OpenClaw features that RedDwarf should be leveraging, mapped against
> the current implementation and the active FEATURE_BOARD roadmap.

---

## 1. Features RedDwarf Should Be Using Now

### Agent-to-Agent Coordination (`sessions_*` tools)

OpenClaw has `sessions_list`, `sessions_history`, and `sessions_send` tools specifically
for coordinating work across sessions without jumping between chat surfaces.

RedDwarf's **Architect → Developer → Validator** pipeline is currently orchestrated
externally through the control plane. These tools would let the phases talk to each other
natively through OpenClaw, which is cleaner and more observable.

Relevant tools:
- `sessions_list` — discover active sessions (agents) and their metadata
- `sessions_history` — fetch transcript logs for a session
- `sessions_send` — message another session with optional reply-back ping-pong

---

### Session Compaction (`/compact`)

OpenClaw has a built-in `/compact` command that summarises and compresses session context.

This maps directly to **Feature 91** (spec distillation pass) and **Feature 92** (project
memory compression) on the FEATURE_BOARD. These do not need to be built — they are already
available in OpenClaw.

---

### Docker Sandboxing

OpenClaw supports `agents.defaults.sandbox.mode: "non-main"` to run non-main sessions
inside per-session Docker sandboxes, with bash running in Docker for those sessions.

RedDwarf's developer phase should already be running in an isolated sandbox. This feature
provides that isolation through OpenClaw's Docker backend, but not in RedDwarf's current
Docker-hosted gateway topology. The present local stack hard-disables sandboxing because
the seeded gateway container is not wired for Docker-backed session sandboxes. This is
still a strong fit on a Linux host-installed OpenClaw gateway, or after rebuilding the
container deployment around OpenClaw's upstream sandbox-enabled Docker flow.

Sandbox defaults (allowlist): `bash`, `process`, `read`, `write`, `edit`, `sessions_list`,
`sessions_history`, `sessions_send`, `sessions_spawn`.

Sandbox defaults (denylist): `browser`, `canvas`, `nodes`, `cron`, `discord`, `gateway`.

---

### Model Failover

OpenClaw has built-in model failover with auth profile rotation between OAuth and API keys,
with automatic fallbacks.

RedDwarf is almost certainly not using this, meaning a model outage stalls the entire
pipeline. Wiring this in would make the system significantly more resilient with minimal
implementation effort.

Reference: `docs.openclaw.ai/concepts/model-failover`

---

## 2. Features That Unlock Roadmap Items

### Discord + Telegram Channels → FEATURE_BOARD #99 and #100

| Board Item | Description | OpenClaw Status |
|---|---|---|
| Feature 99 | Discord approval bot | ✅ Already built — configure, don't code |
| Feature 100 | Discord notification tool for agents | ✅ Already built — configure, don't code |

OpenClaw has native Discord and Telegram channel integrations. Both features are essentially
already available. Implementation becomes a configuration task rather than a development task.

Discord config example:
```json
{
  "channels": {
    "discord": {
      "token": "your-bot-token"
    }
  }
}
```

---

### Webhooks Instead of Polling

OpenClaw has a webhook surface for wiring external triggers.

RedDwarf's polling daemon currently watches GitHub every 30 seconds
(`REDDWARF_POLL_INTERVAL_MS` default: `30000`). Switching to webhooks means the pipeline
starts the moment an issue is labelled — not up to 30 seconds later — and eliminates the
constant background polling process.

Reference: `docs.openclaw.ai/automation/webhook`

---

### Cron + Wakeups

OpenClaw has built-in cron scheduling and wakeup triggers.

RedDwarf's housekeeping tasks — stale run sweeps, workspace cleanup, health checks — are
currently managed by custom setup scripts. These could be moved into OpenClaw's native
scheduler, reducing the surface area of custom infrastructure code.

Reference: `docs.openclaw.ai/automation/cron-jobs`

---

### Browser Control for the Architect → FEATURE_BOARD #101

| Board Item | Description | OpenClaw Status |
|---|---|---|
| Feature 101 | Web search tool for Architect agent | ✅ Browser control already available |

OpenClaw has built-in browser control with a dedicated Chrome/Chromium instance using CDP,
supporting snapshots, actions, and uploads. This gives the Architect agent web search and
live documentation lookup without building a custom integration.

Enable in config:
```json
{
  "browser": {
    "enabled": true
  }
}
```

Reference: `docs.openclaw.ai/tools/browser`

---

## 3. The Skills Platform — Biggest Untapped Opportunity

RedDwarf already uses OpenClaw's native workspace conventions:

- `skills/` directory ✅
- `AGENTS.md` ✅
- `SOUL.md` ✅

### What's Missing: ClawHub Publishing

OpenClaw has **ClawHub** — a skill registry where the agent can search for and pull in
skills automatically as needed (`clawhub.com`).

RedDwarf's entire policy pack — the Architect skills, validation rules, task intake logic —
could be published to ClawHub. This would make RedDwarf's governance layer:

- **Discoverable** by the broader OpenClaw community (342k+ stars)
- **Installable** without setting up the full RedDwarf stack
- A **reference implementation** for governed, auditable agentic pipelines

This is the most direct path to community growth and contributors without requiring people
to adopt the full system upfront.

---

## 4. Priority Order

| Priority | Feature | Effort | Impact |
|---|---|---|---|
| 🔴 High | Agent-to-Agent coordination (`sessions_*`) | Medium | Pipeline observability and phase handoffs |
| 🔴 High | Docker sandboxing for developer phase | Low | Security and isolation |
| 🔴 High | Session compaction (replaces Features 91–92) | Low | Token efficiency, free from OpenClaw |
| 🟡 Medium | Model failover | Low | Pipeline resilience |
| 🟡 Medium | Discord/Telegram channels (replaces Features 99–100) | Low | Operator UX, free from OpenClaw |
| 🟡 Medium | Webhooks (replace polling daemon) | Medium | Latency and reliability |
| 🟡 Medium | Browser control for Architect (replaces Feature 101) | Low | Spec quality, free from OpenClaw |
| 🟢 Long-term | Cron for housekeeping | Low | Code simplification |
| 🟢 Long-term | ClawHub publishing | Medium | Community growth and discoverability |

---

## 5. Contacts and Resources

| Resource | URL |
|---|---|
| OpenClaw GitHub | `github.com/openclaw/openclaw` |
| OpenClaw Docs | `docs.openclaw.ai` |
| ClawHub Registry | `clawhub.com` |
| acpx (ACP CLI client) | `github.com/openclaw/acpx` |
| Discord Community | `discord.gg/clawd` |
| Peter Steinberger (creator) | `@steipete` on X/Twitter |
| OpenClaw on X | `@openclaw` |

---

*Generated from analysis of the RedDwarf repository (`github.com/derekrivers/RedDwarf`)
and the OpenClaw platform (`github.com/openclaw/openclaw`) — March 2026.*
