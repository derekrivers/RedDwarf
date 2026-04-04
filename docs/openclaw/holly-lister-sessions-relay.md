# Holly → Lister Sessions Relay

**Status:** Planned — infrastructure complete, implementation pending  
**Depends on:** agentToAgent config commit (`1d6feff`) — merged to master

---

## What we're replacing

Today, when the planning phase (Holly / `reddwarf-analyst`) completes, the control plane:

1. Reads `hollyHandoffMarkdown` from disk (`handoffPath` in the planning completion record)
2. Injects it as text into Lister's (`reddwarf-developer`) prompt via `buildDeveloperPrompt` in [packages/control-plane/src/pipeline/prompts.ts](../packages/control-plane/src/pipeline/prompts.ts)
3. The assembled prompt string is sent as the opening message when `dispatchOpenClawSession` is called in [packages/control-plane/src/pipeline/development.ts](../packages/control-plane/src/pipeline/development.ts)

The handoff content is injected by value — the control plane is the middleman, and the content arrives in Lister's session as plain text from an external hook source.

---

## What we want instead

Holly writes her handoff directly into a well-known session key using `sessions_send`. Lister reads it from session history using `sessions_history` before beginning implementation.

The control plane stops injecting the markdown blob. It instead:

1. Waits for Holly's session to complete (as today)
2. Does **not** read or pass `hollyHandoffMarkdown`
3. Dispatches Lister with a prompt that tells him to read from the well-known session key

Lister's prompt tells him: *"The architect's plan is in session `github:issue:<repo>:<number>` under agent `reddwarf-analyst`. Read it with `sessions_history` before you begin."*

---

## Key files to change

| File | What changes |
|---|---|
| [packages/control-plane/src/pipeline/dispatch.ts:166-260](../packages/control-plane/src/pipeline/dispatch.ts) | Remove `hollyHandoffMarkdown` retrieval block (lines ~166–226); remove `hollyHandoffMarkdown` from `dispatchDeveloperPhase` call |
| [packages/control-plane/src/pipeline/development.ts:478-604](../packages/control-plane/src/pipeline/development.ts) | Remove `hollyHandoffMarkdown` from `DeveloperPhaseOptions`/dependencies; remove prompt injection calls at lines ~497–526 |
| [packages/control-plane/src/pipeline/prompts.ts:59,342-405](../packages/control-plane/src/pipeline/prompts.ts) | Remove `hollyHandoffMarkdown` from `buildDeveloperPrompt` params; replace injected block with a `sessions_history` read instruction |
| [packages/control-plane/src/pipeline/types.ts](../packages/control-plane/src/pipeline/types.ts) | Remove `hollyHandoffMarkdown` field from developer phase dependency type |

The session key Lister should read from is already computed in `development.ts:478`:

```typescript
const sessionKey = `github:issue:${currentManifest.source.repo}:${currentManifest.source.issueNumber ?? taskId}`;
```

Holly's session key is the same key, under `agentId: "reddwarf-analyst"`. Lister's prompt should reference both.

---

## New developer prompt instruction (rough)

Replace the injected markdown block with something like:

> The architecture plan for this task was written by the RedDwarf Analyst agent.  
> Before you begin, read it using the `sessions_history` tool:  
> - `agentId`: `reddwarf-analyst`  
> - `sessionKey`: `github:issue:<repo>:<issue>`  
>
> Do not begin implementation until you have read and understood the plan.

---

## What does NOT change

- Holly's planning phase — she continues writing the handoff file to disk (used by the architecture reviewer and for human inspection)
- The architecture review phase — Kryten reads from the handoff file path, not from session history
- The session key scheme — `github:issue:<repo>:<number>` is already the shared namespace
- `dispatchOpenClawSession` itself — the hook dispatch mechanism stays the same

---

## Kryten's `group:sessions` grant

Kryten (`reddwarf-arch-reviewer`) received `group:sessions` in the same commit that enabled agentToAgent. This is **not required for the Holly → Lister relay** and does not change his current flow — he still reads the handoff file from disk via the `handoffPath` in the planning completion record.

The grant is forward-looking: it positions Kryten to read either Holly's or Lister's session transcript in a future pass (e.g. reading Lister's implementation session when forming the architecture review verdict, rather than relying solely on the static handoff file). That is a separate, later improvement and is out of scope here.

For this feature: only `reddwarf-analyst` and `reddwarf-developer` are involved.

---

## Prerequisites

All done:
- [x] `group:sessions` added to `reddwarf-analyst` and `reddwarf-developer` allow lists (relay agents)
- [x] `group:sessions` added to `reddwarf-arch-reviewer` (forward-looking, not required for this relay)
- [x] `sessions_spawn`/`sessions_yield`/`subagents` denied for reviewer and developer
- [x] `tools.agentToAgent` enabled in gateway config with all five agent IDs
- [x] `tools.sessions.visibility: "all"` live in gateway
- [x] Cross-agent session visibility confirmed via CLI

---

## Risk / rollback

Low risk. The handoff file is still written to disk by Holly. If `sessions_history` retrieval fails in Lister's prompt, we can fall back to injecting the file content again. The two approaches are not mutually exclusive during a transition.

Consider keeping a fallback path in `development.ts` that reads the file if the session history instruction is disabled via a feature flag, until the relay is validated in production.

---

## Feature board entry suggestion

```
### Holly → Lister session relay (sessions_send / sessions_history)

Replace hollyHandoffMarkdown prompt injection with native OpenClaw cross-agent
session history. Holly's analysis plan is already in her session transcript;
Lister should read it via sessions_history rather than receiving it as injected
text from the control plane.

Files: dispatch.ts, development.ts, prompts.ts, types.ts (pipeline package)
Prereqs: complete (agentToAgent config, group:sessions grants — commit 1d6feff)
Effort: small-medium (4 files, remove injection path, update developer prompt)
```
