# OpenClaw Agent Tool Permissions Audit

**Date:** 2026-04-07
**Context:** Runtime sandboxing is `mode: "off"` for all agents (Feature 105 pending). The Docker container boundary and per-agent tool allow/deny groups are the **only** runtime enforcement layers.

---

## Agent Permissions Matrix

| Agent ID | Role | Declared sandboxMode | Tool Profile | Allowed Groups | Denied Groups/Tools | Gap? |
|----------|------|---------------------|-------------|---------------|---------------------|------|
| `reddwarf-coordinator` | coordinator | `read_only` | full | `group:fs`, `group:sessions`, `group:openclaw` | `group:automation`, `group:messaging`, `group:nodes` | **Yes** — `group:fs` includes write tools; `read_only` intent not enforced |
| `reddwarf-analyst` | analyst | `read_only` | full | `group:fs`, `group:web`, `group:sessions`, `group:openclaw` | `group:automation`, `group:messaging` | **Yes** — same `group:fs` write access as coordinator; `read_only` intent not enforced |
| `reddwarf-arch-reviewer` | reviewer | `workspace_write` | full | `group:fs`, `group:sessions`, `group:openclaw` | `group:automation`, `group:messaging`, `group:runtime`, `sessions_spawn`, `sessions_yield`, `subagents` | Acceptable — `workspace_write` matches `group:fs` grants. `group:runtime` correctly denied (no process execution). Sub-agent spawning denied. |
| `reddwarf-validator` | validator | `workspace_write` | full | `group:fs`, `group:runtime`, `group:openclaw` | `group:automation`, `group:messaging` | Acceptable — `workspace_write` matches grants. `group:runtime` is intentionally allowed for test execution. |
| `reddwarf-developer` | developer | `workspace_write` | full | `group:fs`, `group:runtime`, `group:sessions`, `group:openclaw` | `group:automation`, `group:messaging`, `sessions_spawn`, `sessions_yield`, `subagents` | Acceptable — `workspace_write` matches grants. Sub-agent spawning denied. |
| `reddwarf-developer-opus` | developer | `workspace_write` | full | `group:fs`, `group:runtime`, `group:sessions`, `group:openclaw` | `group:automation`, `group:messaging`, `sessions_spawn`, `sessions_yield`, `subagents` | Acceptable — identical to standard developer. |

---

## Identified Gaps

### Gap 1: `read_only` agents have `group:fs` write tools (Coordinator, Analyst)

**Impact:** The coordinator (Rimmer) and analyst (Holly) roles declare `sandboxMode: "read_only"` but are granted `group:fs`, which includes `write`, `edit`, `create`, `patch`, and `replace` tools. In practice, these agents *can* write to any path within the mounted workspace volume.

**Mitigating factors:**
- The coordinator is an internal orchestrator that does not receive untrusted user prompts directly.
- The analyst (Holly) writes planning artifacts (`architect-handoff.md`, `project-architect-handoff.md`) which is legitimate write activity within the architect workspace subdirectory.
- The `before_tool_call` plugin hook (Feature 152) provides a policy-based secondary check when enabled.

**Recommendation:** When OpenClaw supports per-tool allow/deny within a group (or a `group:fs:read` subset), split `group:fs` so read-only agents get only read tools. Until then, the before_tool_call hook is the compensating control.

### Gap 2: Agent-to-agent messaging enabled roster-wide

**Impact:** All agents have `group:sessions` or `group:openclaw` which includes `sessions_send`. Any agent can message any other roster agent without explicit pairing. The arch-reviewer denies `sessions_spawn`/`sessions_yield`/`subagents` but NOT `sessions_send`.

**Status:** Addressed by F-162 (defaulting agent-to-agent to opt-in).

### Gap 3: `group:runtime` grants process execution without path restrictions

**Impact:** The developer, developer-opus, and validator agents have `group:runtime` which allows arbitrary process execution (`bash`, `shell`, `run`, `exec`). There is no per-command or per-path restriction at the OpenClaw tool level — the only restriction is the Docker container boundary and the workspace volume mount.

**Mitigating factors:**
- Process execution is required for running tests, builds, and linting.
- The `before_tool_call` hook intercepts shell commands with file redirections (`>`) and routes them for operator approval.
- The Docker container limits what external systems are reachable (host network is not shared; only `host.docker.internal` is available via `extra_hosts`).

**Recommendation:** No immediate change needed. The Docker boundary is sufficient for v1. When Feature 105 is implemented, consider restricting `group:runtime` to a specific set of allowed commands.

---

## Runtime Enforcement Summary

| Layer | Status | Coverage |
|-------|--------|----------|
| OpenClaw `sandbox.mode` | **OFF for all agents** | None — declarations are advisory only |
| Tool allow/deny groups | Active | Coarse-grained (group-level, not per-tool) |
| `before_tool_call` plugin hook (F-152) | Active when `REDDWARF_PLUGIN_APPROVAL_HOOK_ENABLED=true` | File writes, shell redirections, path policy |
| Docker container boundary | Active | Network isolation, volume mounts, process namespace |
| Workspace path validation (post-completion) | Active | `assertWorkspaceRepoChangesWithinAllowedPaths` runs after agent completion |

The before_tool_call hook (F-152) and post-completion path validation are the primary compensating controls until OpenClaw supports native sandbox enforcement (Feature 105).
