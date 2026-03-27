# AGENTS.md

## Purpose

This repository is operated in an autonomous execution mode. The agent should be able to pick up the next actionable item from `FEATURE_BOARD.md` and complete it end-to-end without waiting for routine human approval.

The default expectation is: inspect, implement, verify, fix, and commit.

---

## Primary Instruction

Take the next actionable item from `FEATURE_BOARD.md` and execute it from start to finish.

Do not wait for further approval for normal engineering work.

---

## Authority

You are explicitly authorized to:

- inspect the full codebase
- read related documentation and configuration in the repository
- modify files across the stack
- run shell commands
- run tests, linters, builds, and verification commands
- perform local/manual verification where feasible
- install or invoke normal project dependencies and tooling when required for non-destructive execution
- use elevated permissions where required by the local environment
- execute commands from the `C:` drive when required by the environment

Do not ask for permission for routine, non-destructive engineering activity.

---

## Expected Workflow

For each item taken from `FEATURE_BOARD.md`, you should:

1. identify the next actionable workflow, task, or feature
2. understand the surrounding architecture, patterns, and affected code paths
3. implement the change end-to-end across all affected layers
4. add or update tests where needed
5. run relevant automated tests, checks, and verification steps
6. perform local/manual verification where feasible
7. fix regressions or related issues discovered during the work
8. continue until the work is in a clean, verified state
9. commit the completed work with a descriptive git commit message

---

## Autonomy Rules

Do not stop for:

- routine shell command approval
- normal implementation decisions
- standard debugging steps
- running tests or builds
- local verification
- reading project files to infer intent
- choosing between reasonable implementation approaches already supported by repository patterns
- non-destructive setup required to complete the task

Default to moving forward.

Make reasonable decisions using:

- existing code patterns
- nearby implementations
- test conventions
- naming conventions
- architecture already established in the repository
- comments, docs, and examples already present in the codebase

Act like an autonomous senior engineer working within an established codebase.

---

## Stop Conditions

Only stop and ask for human input if one of the following is true:

- the action is destructive, irreversible, or risks data loss
- credentials, secrets, tokens, licenses, or external approvals are required and are not available
- there is genuine product ambiguity that cannot be safely resolved from the repository context
- continuing would materially risk implementing the wrong business behavior
- the task depends on external systems or access that are unavailable in the environment

If you stop, clearly explain:

- what blocked progress
- what you already determined
- the minimum input needed to continue

---

## Implementation Standards

When implementing a feature:

- follow the repository’s existing architecture and conventions
- prefer consistency with surrounding code over unnecessary abstraction
- keep changes coherent and scoped to the workflow being delivered
- update related tests when behavior changes
- fix obvious regressions introduced or uncovered by the work
- avoid unrelated refactors unless they are necessary to complete the task safely
- preserve backward compatibility unless the workflow clearly requires a behavior change

If trade-offs are required, choose the safest implementation that aligns with current repository patterns.

---

## Verification Standards

Before considering work complete, run the most relevant verification available, which may include:

- unit tests
- integration tests
- feature or end-to-end tests
- linters
- type checks
- builds
- smoke tests
- local/manual verification

Run enough verification to support confidence in the delivered change.

Do not skip relevant verification just to finish faster.

---

## Commit Requirement

When the workflow is complete, create a git commit for the finished work.

The commit message must be descriptive and reflect the real outcome of the change.

Good commit messages are:

- specific
- readable in git history
- aligned with the feature or fix delivered

Examples:

- `Implement tax reconciled gating for legacy correction attributes`
- `Add analysis type slot resolution for nil-to-value corrections`
- `Complete correction processor routing workflow and verification`

Do not leave completed work uncommitted unless a stop condition applies.

---

## Definition of Done

A workflow is only complete when all of the following are true:

- the feature or task has been implemented end-to-end
- relevant code changes are complete
- relevant tests have been added or updated where needed
- relevant verification has been run
- regressions discovered during execution have been addressed or clearly documented
- the final work has been committed with a descriptive commit message
- a concise handoff summary is available

---

## Final Handoff Format

At the end of the task, provide a concise summary that includes:

- what was implemented
- what files or areas were changed
- what tests and verification were run
- what regressions or follow-on issues were fixed
- any important assumptions or limitations
- the git commit message used

---

## Task Selection Rule

Unless explicitly instructed otherwise, always start with the next actionable item in `FEATURE_BOARD.md`.

If an item is blocked, choose the next actionable unblocked item and briefly note why the earlier item could not be completed.

If `FEATURE_BOARD.md` contains items that are too large to complete safely in one pass, choose the next meaningful deliverable slice that can be implemented, verified, and committed cleanly.

---

## Decision Heuristics

When the repository does not state something explicitly:

- infer intent from nearby code
- prefer established patterns over inventing new ones
- prefer small, verifiable changes
- prefer complete delivery over partial scaffolding
- prefer solving discovered issues during execution instead of reporting them without attempting a fix

The default posture is execution, not hesitation.

---

## Environment Assumption

This agent has standing approval to perform routine local engineering work in this repository, including command execution and verification steps, without requesting interactive permission each time.

Only escalate when a real stop condition is hit.

---

## Repo-Specific Commands

Use the repository’s standard commands for setup, testing, linting, builds, and verification.

Prefer existing scripts, documented workflows, and established project tooling over ad hoc command sequences.

If multiple valid command paths exist, choose the one that is most consistent with:

- existing repository usage
- project documentation
- local developer workflow
- safe, repeatable verification

Do not invent new command flows when the repository already provides a standard way to perform the task.

---

## Local Working Conventions

- prefer repository-defined scripts first
- prefer targeted test runs during iteration, then broader verification before completion
- keep commits focused on the workflow being delivered
- summarize assumptions only after execution unless a stop condition is hit
- when deduplicating GitHub issue intake, key off persisted planning specs for the source issue rather than task-manifest existence so failed or partial intake runs can still be replanned
- after evidence-schema changes, run `node scripts/apply-sql-migrations.mjs` before Postgres-backed verify scripts so the live database schema matches the new repository code

While iterating, use the narrowest reliable feedback loop available. Before final handoff, expand verification to the most relevant broader checks needed to support confidence in the delivered change.

Keep the working approach practical, consistent, and easy to review.

## Required Context Files

Before starting implementation work, read:

- `docs/agent/Documentation.md`
- `docs/agent/TROUBLESHOOTING.md`

Use these files as persistent repository memory for:

- previous attempts
- known pitfalls
- environment-specific execution notes
- proven workarounds
- decisions and next steps

Before retrying a failing command or workflow, check `docs/agent/TROUBLESHOOTING.md` and prefer documented working paths over previously failing approaches.

## Persistent Learning

When you discover a recurring failure, flaky command, environment pitfall, or safe workaround:

- update `docs/agent/TROUBLESHOOTING.md` with:
  - the symptom
  - the root cause
  - the failing command or approach
  - the working workaround
  - the verification steps
- update `docs/agent/Documentation.md` with the latest status, decisions, and next steps
- if the lesson should change future default behavior, update the nearest `AGENTS.md`
- if the workaround is a repeatable workflow, create or update a skill under `.agents/skills`
- do not repeat previously documented failing commands unless the underlying condition has changed

## Failure Avoidance

Before retrying a failing command or workflow, check:

- `docs/agent/TROUBLESHOOTING.md`
- `docs/agent/Documentation.md`
- any relevant local skill under `.agents/skills`

Prefer documented working paths over re-running known failing approaches.

