# RedDwarf Issue Scoping Prompt

Paste this prompt into the Claude session you use to flesh out requirements.
Its job is to convert your conversation into a clean, structured GitHub issue
body that the RedDwarf architect agent (Holly) will consume, plan from, and
potentially decompose into tickets.

---

## Prompt (copy everything below this line into your Claude session)

You are helping me prepare a GitHub issue for the RedDwarf autonomous pipeline.
The issue body you produce will be read by an architect agent that plans the
work and, when the scope is large enough, decomposes it into tickets. Convert
our conversation into a structured issue body using the shape below.

### Rules

- Use the exact headings below, in order. Omit optional sections entirely when
  we genuinely have nothing useful to say — do NOT fabricate content to fill
  them.
- Write for an engineer who has repo access but no memory of our chat. Be
  specific: prefer concrete filenames, function names, and observable behaviors
  over vague descriptions.
- If something is ambiguous, ASK me before emitting the issue body. Don't guess.
- Keep every acceptance criterion verifiable — each bullet should be something
  you could write a test or manual check for.
- Do NOT include a `## Proposed sub-tasks` section unless we explicitly
  discussed a decomposition. Omission means "let the architect decide the
  breakdown." Including the section is a strong hint — the architect will
  follow it unless repo evidence forces a refinement.
- Output ONLY the issue body markdown inside a single fenced block, no preamble
  or commentary outside the block.

### Output shape

````markdown
## Goal

<2–4 sentences: what outcome, and why it matters. Stick to the problem and the
chosen direction; implementation detail belongs in later sections.>

## Acceptance Criteria

- <verifiable outcome 1>
- <verifiable outcome 2>
- <verifiable outcome 3>

## Constraints & Non-Goals

- <must-preserve behavior, out-of-scope areas, perf/security/compat
  constraints>

<!-- Optional sections below. Include only when they add real signal. -->

## Affected Paths

- <package/file/directory hints from our discussion>

## Dependencies

- <blockers, related open work, required external access or credentials>

## Verification Plan

- <how we'll prove it works: unit tests, integration runs, manual steps,
  smoke checks>

## Proposed sub-tasks

1. <title> — <one-line scope>
2. <title> — <one-line scope>
3. <title> — <one-line scope>

## Context & Background

- <links, prior decisions, incidents, design notes>
````

### Notes on specific sections

- **Acceptance Criteria, Affected Paths** — RedDwarf's intake parses these by
  heading. Keep them as bullet lists.
- **Proposed sub-tasks** — also parsed by heading. Each bullet or numbered item
  becomes one ticket hint. Order matters (the architect prefers the given
  sequence). Keep each line short: "Title — one-line scope" is ideal.
- **Goal, Constraints & Non-Goals, Verification Plan, Context & Background**
  — free-form prose/bullets. The architect reads the whole body; structure
  helps it, but these sections aren't machine-parsed.

### When to include "Proposed sub-tasks"

Include it when any of the following is true:

- The work is clearly bigger than one PR.
- We've identified natural seams (e.g. "schema change, then API change, then
  UI wiring").
- There are strict ordering constraints between pieces of the work.
- We want a specific piece shipped first as a risk check before committing to
  the rest.

Omit it when the scope is small enough for a single PR, or when we genuinely
don't yet know how the work should split and want the architect to decide.
