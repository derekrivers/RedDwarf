---
name: issue_to_architecture_plan
description: Turn an approved GitHub issue and acceptance criteria into a safe, implementation-ready architecture plan for the Developer.
---

# Issue to Architecture Plan

Use this skill when you have an approved issue and need to produce a concrete architecture handoff.

## Objectives

Produce a plan that is:
- grounded in the real codebase
- scoped to the approved issue
- explicit enough for implementation
- explicit about risk and testing

## Structured Progress Updates

Emit a `plan_update` event at the start of each major milestone so the RedDwarf dashboard can show a live progress timeline. Use clear, concise step titles:

```json
{ "type": "plan_update", "items": [
  { "id": "read-issue",    "title": "Reading issue and acceptance criteria", "status": "active" },
  { "id": "inspect-repo",  "title": "Inspecting repository structure",       "status": "pending" },
  { "id": "draft-plan",    "title": "Drafting architecture plan",            "status": "pending" },
  { "id": "write-handoff", "title": "Writing developer handoff",             "status": "pending" }
] }
```

Update each item to `done` (with `durationMs`) as you complete it. This is informational only and does not affect pipeline state.

## Process

1. Read the issue and acceptance criteria carefully.
2. Identify the likely subsystem or files involved.
3. Inspect the relevant repository files.
4. Identify the current pattern being used.
5. Choose the smallest safe implementation approach.
6. Note risks, assumptions, and unknowns.
7. Define what the Developer must change.
8. Define what tests should be added or updated.
9. Produce the final architecture handoff.

## Output Format

Your final output should contain:

1. Problem summary
2. Acceptance criteria interpretation
3. Proposed implementation approach
4. Files/components likely to change
5. Implementation complexity estimate (see below)
6. Risks and assumptions
7. Test strategy
8. Developer handoff instructions (see Handoff Format below)
9. Non-goals / out-of-scope notes

## Implementation Complexity Estimate

Include a short complexity estimate so the Developer and pipeline can plan resource allocation. State:

- **Expected file count** — how many files will be created or modified.
- **Largest file estimate** — whether any single file is expected to exceed ~150 lines. If so, name it and estimate the rough size (e.g. "index.html ~400 lines").
- **Write pattern** — "single-file scaffolding" if all work concentrates into one large file, "multi-file incremental" if changes are spread across several smaller files, or "mixed" if both apply.
- **Scope category** — "small" (1-2 files, ≤4 acceptance criteria), "medium" (3-5 files or 5-7 criteria), or "large" (6+ files or 8+ criteria).

This estimate does not need to be exact. Its purpose is to signal whether the Developer should plan batched writes and expect elevated timeouts.

## Handoff Format

The developer handoff section must allow the Developer to implement without guessing your intent. Structure it as:

1. **Summary** — short description of the problem and chosen direction.
2. **Implementation shape** — the chosen solution and reasoning for it.
3. **Likely files to change** — main files, components, modules, or tests involved.
4. **Implementation steps** — intended sequence of work in concrete terms.
5. **Risks and watch-outs** — edge cases, hazards, coupling concerns, or policy-sensitive areas.
6. **Test plan** — what the Developer must prove with tests.
7. **Non-goals** — what should not be changed as part of this task.
8. **Open questions** — anything the Developer must treat carefully or escalate if contradicted by the code.

Prefer specific file-level guidance over generic advice. Make it easy for Kryten to compare the implementation against this plan later.

## Rules

- Do not propose abstractions without checking whether the repository already has a suitable pattern.
- Do not recommend broad refactors unless they are necessary for correctness.
- Do not hand off vague instructions.
- Do not hide uncertainty.
- If the issue is too ambiguous to plan safely, escalate clearly.
