# RedDwarf OpenClaw Dev Team Plan

## Purpose

This document captures the recommended first version of the RedDwarf AI development team built on top of OpenClaw.

The target outcome is:

1. RedDwarf detects or receives a GitHub issue
2. RedDwarf decides whether the work is safe and eligible
3. OpenClaw agents plan, implement, and verify the change
4. RedDwarf creates a branch, commit, and pull request
5. Derek reviews the PR in GitHub

The core principle is:

**RedDwarf governs. OpenClaw executes.**

---

## Executive Summary

We should **not** start with a large, chatty org chart of agents.

We should start with a **lean 3-agent OpenClaw team** plus deterministic RedDwarf workflow logic.

### Inside OpenClaw

- **Holly** — Architect
- **Dave Lister** — Developer
- **Kryten** — Reviewer / Verifier

### Outside OpenClaw

- **RedDwarf Orchestrator** — deterministic workflow engine
- **GitHub branch / commit / PR creation** — deterministic automation
- **approval gates** — deterministic policy logic

This is the best balance of:
- real software delivery flow
- lower token cost
- stronger governance
- easier observability
- safer GitHub mutation

---

## Why We Are Using OpenClaw Selectively

OpenClaw is valuable for:
- agent workspaces
- per-agent sessions
- per-agent configuration
- tool policy
- sandbox controls
- skills
- HTTP/webhook dispatch
- structured runtime execution

OpenClaw is **not** where our core governance should live.

RedDwarf should continue to own:
- GitHub intake
- risk classification
- approval queueing
- task eligibility
- publication rules
- evidence and audit state

That means:

**RedDwarf is the brain. OpenClaw is the hands.**

---

## Primary Architecture Decision

### RedDwarf responsibilities

RedDwarf should own:

- GitHub polling or webhook intake
- issue normalization
- deterministic policy/risk checks
- approval queueing
- workflow selection
- task manifest creation
- deciding whether GitHub mutation is allowed
- branch creation
- commit creation
- PR creation
- evidence and audit storage

### OpenClaw responsibilities

OpenClaw should own:

- running the selected agent
- loading workspace context
- loading skills
- enforcing tool policy
- enforcing sandbox policy
- maintaining per-agent sessions
- bounded reasoning / implementation / review work

---

## Final Recommended Team

## 1. Holly — Architect

### Role

Holly is the **solution architect**.

Holly reads the approved issue, acceptance criteria, and relevant codebase context, then produces a safe, implementation-ready plan for the Developer.

### Why Holly fits

Holly is the best fit for the Architect because this role should feel:

- highly intelligent
- calm
- analytical
- dry and precise
- pragmatic
- intolerant of vague thinking

### Holly’s responsibility

Holly should:

- understand the issue
- inspect the relevant code
- identify the likely implementation shape
- define touched files and components
- define the test strategy
- identify risks and assumptions
- hand off a clear plan to the Developer

### Holly’s outputs

For each task, Holly should produce:

1. Problem summary
2. Acceptance criteria interpretation
3. Proposed implementation approach
4. Likely files/components to change
5. Risks and assumptions
6. Test strategy
7. Developer handoff instructions
8. Explicit non-goals

### Holly’s boundaries

Holly must not:

- silently redesign the product
- invent repository facts
- create branches
- create commits
- open PRs
- make GitHub publication decisions
- drift into implementation unless explicitly allowed

---

## 2. Dave Lister — Developer

### Role

Lister is the **implementation engineer**.

He takes Holly’s plan and turns it into actual code and test changes.

### Why Lister fits

Lister is the best fit for the Developer because this role should feel:

- practical
- hands-on
- grounded
- effective in messy reality
- action-oriented
- focused on shipping the change

### Lister’s responsibility

Lister should:

- read Holly’s plan
- inspect the target files
- implement the approved change
- add/update tests
- keep within scope
- record deviations or blockers clearly
- hand off to review

### Lister’s outputs

For each task, Lister should produce:

1. Implementation summary
2. Files changed
3. Code changes completed
4. Tests added or updated
5. Deviations from the original plan
6. Blockers or follow-up notes
7. Review handoff notes

### Lister’s boundaries

Lister must not:

- silently re-architect the solution
- expand scope without justification
- invent repository facts
- publish directly to GitHub unless RedDwarf explicitly allows it
- skip meaningful test work on non-trivial changes

---

## 3. Kryten — Reviewer / Verifier

### Role

Kryten is the **quality and verification agent**.

He reviews the issue, Holly’s plan, Lister’s implementation, and the produced evidence.

### Why Kryten fits

Kryten is the best fit for the reviewer because this role should feel:

- methodical
- procedural
- rules-driven
- careful
- checklist-oriented
- evidence-based

### Kryten’s responsibility

Kryten should:

- compare the implementation to the acceptance criteria
- compare the implementation to Holly’s plan
- assess whether tests are adequate
- identify regressions, risks, or suspicious shortcuts
- recommend pass or rework

### Kryten’s outputs

For each task, Kryten should produce:

1. Pass / rework recommendation
2. Acceptance criteria coverage report
3. Plan-vs-implementation comparison
4. Test adequacy notes
5. Risk / regression notes
6. Release confidence summary

---

## Why Not Rimmer as Reviewer?

Rimmer is not the best fit for the Reviewer / Verifier role.

The reviewer should be:
- systematic
- unemotional
- process-oriented
- accurate
- disciplined

That is much closer to Kryten.

### Best use of Rimmer later

If we add a fourth role in the future, Rimmer is better suited to:

- approval gate
- compliance officer
- release sign-off persona
- escalation / governance role

So the preferred trio is:

- **Holly** = Architect
- **Dave Lister** = Developer
- **Kryten** = Reviewer

---

## Orchestrator Decision

We should **not** start with an LLM Dev Team Manager.

The orchestrator should remain **deterministic RedDwarf code**.

### Why

A manager-style agent would add:
- another agent run
- another baton pass
- more prompt/context overhead
- more token burn
- more ambiguity in the workflow

At this stage, the manager work is better done with code.

### The RedDwarf orchestrator should:

- detect issues
- classify risk
- choose the workflow
- choose which agent runs next
- enforce approval rules
- decide whether publication is allowed
- create the PR only when the workflow has passed

---

## GitHub Publication Decision

The final objective is:

**code changes are produced and a PR is opened in GitHub for Derek to review**

That means the final branch / commit / PR path should be **owned by RedDwarf**, not by a freeform agent loop.

### Recommended pattern

1. OpenClaw agents finish their work
2. RedDwarf checks policy state and review status
3. RedDwarf creates the branch
4. RedDwarf commits the changes
5. RedDwarf opens the PR
6. RedDwarf assigns Derek as reviewer

### Why this is important

This keeps GitHub mutation:
- deterministic
- auditable
- policy-controlled
- easy to reason about

---

## Recommended Model Assignment

Provider selection is now controlled by `REDDWARF_MODEL_PROVIDER`. Anthropic defaults and OpenAI mappings are generated from the central provider-role map.

## Holly — Architect

**Default model binding:** provider-selected analyst model

### Why

Holly is the most reasoning-heavy role. This is where we want the best design quality. Opus is the right choice — deep reasoning, strong architecture judgment, handles ambiguity well.

Use Holly for:
- architecture planning
- ambiguous requirements
- cross-cutting design changes
- higher-risk work
- multi-file implementation planning

---

## Dave Lister — Developer

**Default model binding:** provider-selected developer model

### Why

Lister is the workhorse implementer. Sonnet provides strong coding ability at lower cost than Opus.

Use Lister for:
- implementation work
- test writing
- repo navigation
- bugfix execution
- following Holly’s plan

### Escalate Lister to `anthropic/claude-opus-4-6` when:

- schema or persistence behavior changes
- debugging loops get stuck
- framework-level behavior is involved
- the change becomes highly cross-cutting
- the implementation challenge is much harder than expected

---

## Kryten — Reviewer

**Default model binding:** provider-selected reviewer model

### Why

Kryten needs solid reasoning, but usually not the same open-ended design depth as Holly. Sonnet handles structured verification and checklist-style review well.

Use Kryten for:
- acceptance criteria verification
- diff review
- plan-vs-implementation checking
- test adequacy checks
- risk spotting

### Escalate Kryten to the provider's stronger reviewer/analyst model when:

- the change is high-risk
- the diff is unusually large
- security or critical correctness is involved
- the review requires more architectural judgment

---

## Arnold Rimmer — Coordinator

**Default model binding:** provider-selected coordinator model

### Why

Rimmer coordinates the session, delegates to Holly and Kryten, and assembles results. Sonnet is sufficient — orchestration and session management does not require Opus-level reasoning.

---

## Optional Helper Model

**Optional:** provider-selected fast helper model, if added to the central model map

Use only for:
- PR title drafting
- PR body drafting
- release notes
- testing notes
- summary formatting

This should remain optional and should not become a core team role.

---

## Recommended Workflow

## Stage 1 — Intake

RedDwarf detects a GitHub issue and normalizes it.

## Stage 2 — Eligibility and risk

RedDwarf performs deterministic risk and policy checks.

- safe → proceed
- risky → approval queue

## Stage 3 — Holly run

Holly reads:
- issue
- acceptance criteria
- relevant code
- relevant repo standards/patterns

Holly produces:
- `architecture_plan.md`
- risk notes
- test strategy
- developer handoff

## Stage 4 — Lister run

Lister reads:
- issue
- acceptance criteria
- Holly’s plan
- target files
- related tests

Lister produces:
- code changes
- test changes
- `implementation_report.md`

## Stage 5 — Kryten run

Kryten reads:
- issue
- Holly’s plan
- Lister’s implementation
- diff
- test results

Kryten produces:
- `review_report.md`
- pass / rework recommendation

## Stage 6 — Publication

If policy and review allow publication, RedDwarf:
- creates branch
- creates commit
- opens PR
- populates title/body/testing notes
- assigns Derek as reviewer

---

## TDD Recommendation

We should use **TDD discipline**, but not necessarily create a separate permanent Test Engineer agent yet.

### Recommended approach

- Holly must define the test strategy
- Lister must add/update tests with the implementation
- Kryten must verify that the tests prove the acceptance criteria

This gives most of the value of TDD without creating another expensive baton pass.

---

## Dispatch Recommendation: RedDwarf to OpenClaw

The preferred first dispatch path is:

**RedDwarf → `POST /hooks/agent` → OpenClaw**

### Why this is preferred

It is:
- simple
- internal-service friendly
- explicit
- easier than wrapping CLI calls in production
- aligned with OpenClaw’s documented hook ingress

### Recommended usage

- RedDwarf chooses the agent
- RedDwarf supplies the task prompt / manifest
- RedDwarf uses a deterministic `sessionKey`
- OpenClaw executes the run
- evidence is written back to shared storage

### Good `sessionKey` example

`github:issue:<repo>:<issue_number>`

This keeps continuity for repeated work on the same issue if needed.

### Secondary option

A later alternative is OpenClaw’s responses-style HTTP API.

### Not preferred as the main contract

- shelling out to CLI for every production run
- shared-volume manifest watching as the primary dispatch path

Shared volume is best used for evidence/artifacts, not the main control channel.

---

## Security and Trust Model

OpenClaw should be treated as a trusted internal execution runtime.

It should **not** be treated as a hostile multi-tenant security boundary.

That means:

- OpenClaw runs inside the RedDwarf trusted environment
- RedDwarf remains the real policy wall
- hook tokens and gateway auth must be treated as privileged secrets
- approval and publication decisions must remain outside freeform agent behavior

---

## Token and Team Shape Guidance

We should optimize for **artifact handoff**, not for agents chatting endlessly.

### Good pattern

- Holly produces `architecture_plan.md`
- Lister consumes it and produces `implementation_report.md`
- Kryten consumes both and produces `review_report.md`

### Bad pattern

- agents free-chat back and forth for many turns

### Principle

Each role should earn its place by producing a distinct, valuable artifact.

That is why the starting team should remain:

- Architect
- Developer
- Reviewer

And not expand further unless the system proves it needs more specialization.

---

## OpenClaw File Strategy

OpenClaw injects a fixed set of workspace files into context when they exist.

That makes file discipline important.

### Recommended approach

Use:

- **small always-loaded files**
- **deep process detail in on-demand skills**

### Why

Always-loaded files increase context use every run.
Heavy process detail is better stored in skills and loaded only when needed.

---

## Architect File Strategy (Holly First)

Holly should be the first agent we define properly.

### Recommended always-loaded files

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`

### Recommended setting

Use a repo-owned workspace and disable auto-generated bootstrap files:

- `skipBootstrap: true`

This allows RedDwarf to fully own the role definition.

---

## What Each Holly File Should Do

## `AGENTS.md`

This is Holly’s operational contract.

It should define:
- mission
- required inputs
- required outputs
- escalation rules
- boundaries
- explicit non-implementation behavior

This is where standing orders should live.

---

## `SOUL.md`

This is Holly’s persona and style.

It should define:
- calm, intelligent systems persona
- dry, lightly sardonic voice
- preference for evidence and clarity
- skepticism of vague thinking
- no theatrical roleplay

### Holly persona rule

**Holly provides the personality. RedDwarf provides the engineering discipline.**

---

## `TOOLS.md`

This should define:
- repo-search habits
- how Holly explores the codebase
- evidence file conventions
- where plans are written
- non-mutating tool expectations

This is guidance, not enforcement. Enforcement comes from tool policy.

---

## `IDENTITY.md`

This should stay small.

Suggested shape:
- Name: Holly
- Role: Architect
- Title: RedDwarf Solution Architect

---

## `USER.md`

This should encode working preferences such as:
- assume senior software engineering knowledge
- prefer explicit tradeoffs
- prefer pragmatic solutions
- produce copy-paste-ready markdown
- make risks visible clearly

---

## `HEARTBEAT.md`

This should be tiny.

It should only include a short checklist such as:
- check for waiting architecture tasks
- check for unresolved escalations
- if nothing pending, return `HEARTBEAT_OK`

---

## Holly Skill Strategy

Heavy methodology should live in skills, not in always-loaded files.

### Recommended Holly skills

#### `issue_to_architecture_plan`
Primary planning playbook.

Defines:
- how to go from issue to architecture plan
- required output sections
- how to identify impacted files
- how to structure the developer handoff

#### `repo_architecture_analysis`
How Holly inspects RedDwarf safely.

Defines:
- how to locate patterns
- how to compare extension points
- how to avoid duplicate abstractions
- how to prefer existing conventions

#### `risk_and_escalation`
How Holly handles risky work.

Defines:
- what counts as high risk
- when to stop
- when to escalate
- how to record uncertainty

#### `test_strategy_planning`
How Holly derives test expectations.

Defines:
- unit/integration/e2e implications
- what Lister must prove
- acceptable depth for different classes of change

#### `handoff_to_developer`
Normalizes Holly’s output.

Defines a stable schema for:
- summary
- approach
- file list
- implementation steps
- risks
- test plan
- non-goals
- open questions

---

## Recommended Holly Workspace Layout

```text
architect/
  AGENTS.md
  SOUL.md
  TOOLS.md
  IDENTITY.md
  USER.md
  HEARTBEAT.md
  skills/
    issue_to_architecture_plan/
      SKILL.md
    repo_architecture_analysis/
      SKILL.md
    risk_and_escalation/
      SKILL.md
    test_strategy_planning/
      SKILL.md
    handoff_to_developer/
      SKILL.md

---

## Why We Are Starting with Holly

Holly is the highest-leverage role because:

- good architecture reduces downstream waste
- bad architecture causes expensive implementation churn
- Holly defines the shape that Lister and Kryten work within
- Holly’s outputs create the handoff contract for the rest of the team

So the correct next step is to define Holly first in production-ready markdown.

---

## Versioned Rollout Plan

### Phase 1

Build:
- Holly
- Lister
- Kryten
- RedDwarf deterministic orchestrator
- deterministic GitHub publication flow

### Phase 2

Add:
- optional PR wording helper
- richer evidence tooling
- optional approvals persona if needed

### Phase 3

Only if scale demands it, consider:
- frontend specialist
- backend specialist
- data/migration specialist
- security reviewer
- performance investigator

We should not add these until real task volume or repeated failure modes justify them.

---

## Final Recommendation

The best initial RedDwarf OpenClaw team is:

### Inside OpenClaw
- **Arnold Rimmer** — Coordinator — provider-selected coordinator model
- **Holly** — Architect — provider-selected analyst model
- **Dave Lister** — Developer — provider-selected developer model
- **Kryten** — Reviewer — provider-selected reviewer model

### Outside OpenClaw
- **RedDwarf Orchestrator** — deterministic workflow engine
- **GitHub publication** — deterministic branch/commit/PR creation
- **approval gates** — deterministic policy logic

### Key principles
- RedDwarf governs
- OpenClaw executes
- use artifact handoff, not chatty baton passing
- keep always-loaded files small
- put deep process detail into skills
- keep GitHub mutation deterministic
- define Holly first
