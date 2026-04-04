# Prompt: Implement Holly → Lister Sessions Relay

Use this prompt to start the implementation session.

---

## Prompt

Implement the Holly → Lister session relay described in `docs/openclaw/holly-lister-sessions-relay.md`.

**Background:** RedDwarf's planning phase (Holly / `reddwarf-analyst`) currently hands off its architecture plan to the developer phase (Lister / `reddwarf-developer`) by having the control plane read a markdown file from disk and inject it as text into Lister's opening prompt. This is a workaround. The infrastructure now exists to do this natively through OpenClaw: Holly's plan lives in her session transcript, and Lister can read it directly using `sessions_history`. The control plane should stop being the middleman.

**What to implement:** Remove the `hollyHandoffMarkdown` injection path and replace it with a `sessions_history` read instruction in Lister's prompt. The four files to change are all in `packages/control-plane/src/pipeline/`:

1. **`dispatch.ts`** — Remove the `hollyHandoffMarkdown` retrieval block (~lines 166–226) that reads the file from disk and the `hollyHandoffMarkdown` argument passed to the developer phase dispatch call (~line 260).

2. **`development.ts`** — Remove `hollyHandoffMarkdown` from `DeveloperPhaseOptions` / the dependency type it reads from; remove the prompt injection calls (~lines 497–526) that currently embed the markdown string.

3. **`prompts.ts`** — Remove the `hollyHandoffMarkdown` parameter from `buildDeveloperPrompt` and its injected block (~lines 342–405). Replace it with an instruction telling Lister to call `sessions_history` before beginning:
   - `agentId`: `reddwarf-analyst`
   - `sessionKey`: the same `github:issue:<repo>:<issueNumber>` key already used for Lister's own session (computed in `development.ts`)
   - The instruction should be firm: do not begin implementation until the plan has been read.

4. **`types.ts`** — Remove the `hollyHandoffMarkdown` field from the developer phase dependency type.

**What does NOT change:**
- Holly still writes the handoff file to disk (used by Kryten and for human inspection)
- Kryten's architecture review flow is unchanged — he reads from the file path, not session history
- `dispatchOpenClawSession` and the hook dispatch mechanism are unchanged
- The session key scheme (`github:issue:<repo>:<number>`) is unchanged

**Prerequisites are already done** (commit `1d6feff`): `group:sessions` is in the allow lists for both `reddwarf-analyst` and `reddwarf-developer`, `tools.agentToAgent` is enabled in the gateway config, and `tools.sessions.visibility: "all"` is live.

Read the pipeline files before changing them. Follow existing code patterns. Update or remove tests that reference `hollyHandoffMarkdown`. Run `pnpm test` and `pnpm typecheck` (or the repo's standard verification commands) before committing. Commit with a descriptive message when the work is clean.
