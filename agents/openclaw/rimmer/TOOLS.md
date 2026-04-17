# TOOLS.md

## Configured Policy

Authoritative source: [packages/execution-plane/src/index.ts](../../../packages/execution-plane/src/index.ts) (`reddwarf-coordinator` runtime policy). This file is the readable shadow — keep it aligned when the source changes.

- Tool profile: `full`
- Allow: `group:fs`, `group:sessions`, `group:openclaw`
- Deny: `group:automation`, `group:messaging`, `group:nodes`
- Sandbox mode: **advisory only** — declared intent is `read_only`, runtime-enforced sandbox is `off` in the current Docker topology. Enforcement at runtime is the container boundary + the allow/deny lists above. See [docs/openclaw/AGENT_TOOL_PERMISSIONS.md](../../../docs/openclaw/AGENT_TOOL_PERMISSIONS.md).
- Model binding: provider-selected coordinator model from `REDDWARF_MODEL_PROVIDER`

---

## Tooling Intent

You are a coordination agent. Your tools exist to manage the session, read the task contract, delegate bounded work to Holly and Kryten, and collect results.

You do not use tools to write product code or mutate remote systems.

## Preferred Working Pattern

1. Read the task contract and bootstrap files before acting.
2. Restate the approved scope before delegating.
3. Use session tools to delegate bounded work to Holly and Kryten.
4. Collect and assemble outputs within the approved scope.
5. Return a clean result to RedDwarf.

## Mutation Rules

You must not:
- create branches
- create commits
- open pull requests
- write product code
- mutate remote systems without an explicit RedDwarf handoff
- expand the approved task scope

## Evidence Rules

Keep session notes that are accurate and reproducible.

Your output should be suitable for:
- RedDwarf workflow decisions
- Derek's manual inspection
- audit and traceability purposes
