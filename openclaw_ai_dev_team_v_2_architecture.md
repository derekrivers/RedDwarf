# AI Dev Team with OpenClaw — V2 Architecture Spec

## Purpose

This document defines a refactored architecture for running an AI Dev Team on top of OpenClaw.
It upgrades the original high-level diagram into a more production-ready system design that is easier to extend, govern, observe, and operate safely.

The design assumes:

- OpenClaw is the runtime and orchestration foundation
- GitHub is the primary source of backlog and code collaboration
- Agents work in isolated task-scoped workspaces
- Human approval can be added selectively based on risk
- Final product code lives only in the Project Repo

---

## Design Goals

1. Make the system modular and extensible
2. Separate orchestration, execution, policy, integrations, and evidence storage
3. Support bounded autonomy with clear approval gates
4. Make task execution deterministic, observable, and auditable
5. Reduce blast radius through isolated workspaces and controlled capabilities

---

## Non-Goals

This design does not attempt to:

- replace GitHub as the system of record for product code
- allow unrestricted autonomous production changes
- store all runtime history only in ephemeral workspaces
- hardcode logic around a single agent implementation forever

---

## Core Architectural Decision

The original 3-box model is retained conceptually, but refactored into five explicit planes:

1. **Control Plane** — decides what should happen next  
2. **Execution Plane** — performs the work  
3. **Knowledge & Policy Plane** — defines how agents should behave  
4. **Integration Plane** — connects to external systems  
5. **Evidence Plane** — stores outputs, logs, and audit artifacts  

This separation is the key refactor. It prevents orchestration, policy, and execution responsibilities from becoming tangled as the system grows.

---

# 1. System Context

## Primary Repositories

### A. Project Repo
The actual product being developed.

Contains:

- source code
- tests
- CI configuration
- docs relevant to the product
- GitHub issues, branches, and pull requests

Rules:

- final product changes land here only
- all agent-generated code must flow back through normal Git workflows
- task specs that materially affect implementation may be mirrored here for auditability

### B. Agent Policy Repo
A versioned repository that defines how the AI Dev Team behaves.

Contains:

- agent identity files
- role instructions
- task schemas
- validation schemas
- coding standards
- capability declarations
- approval rules
- escalation rules
- routing policies
- reusable templates and prompt assets

This is not just a config repo. It is the operating model for the AI Dev Team.

### C. OpenClaw Runtime
The runtime environment that hosts orchestration, agent execution, workspace management, tool access, and routing.

Contains:

- orchestrator runtime
- agent sessions
- workspace lifecycle handling
- tool execution layer
- integration adapters
- task state handling

---

# 2. Refactored Component Model

## 2.1 Control Plane

The Control Plane decides task flow and governs execution.

### Components

#### Orchestrator
Responsible for:

- ingesting tasks from GitHub or other inputs
- evaluating task eligibility
- selecting the next phase
- coordinating handoffs between agents
- enforcing deterministic workflow progression

#### Dispatcher
Responsible for:

- selecting which agent type should handle a task
- choosing model tier or execution mode
- deciding whether work should be decomposed
- routing based on task type, risk, and capabilities

#### State Manager
Responsible for:

- tracking lifecycle state for each task
- recording per-phase status
- handling retries, pauses, escalations, and failures

#### Policy Gate Engine
Responsible for:

- validating outputs before phase transitions
- checking whether human approval is required
- blocking disallowed actions
- applying task risk rules and approval classes

---

## 2.2 Execution Plane

The Execution Plane is where work actually happens.

### Components

#### Architect Agent
Produces:

- implementation plan
- task decomposition
- constraints
- acceptance criteria refinements
- technical spec for downstream agents

#### Developer Agent
Produces:

- code changes
- tests
- docs updates
- local task outputs inside a task workspace

#### Validation Agent
Responsible for:

- running tests
- linting
- static checks
- contract validation
- detecting obvious policy violations

#### Reviewer Agent
Responsible for:

- reviewing correctness and alignment to the spec
- checking code quality and maintainability
- spotting risky or unrelated changes
- deciding pass, fail, or escalate

#### SCM Agent
Responsible for:

- branch creation
- commit hygiene
- PR creation
- metadata enrichment
- associating task IDs and evidence with repository actions

#### Workspace Manager
Responsible for:

- creating isolated task workspaces
- injecting task context
- mounting allowed tools and credentials
- destroying the workspace after completion

---

## 2.3 Knowledge & Policy Plane

This plane defines how the team behaves and how architectural knowledge is supplied to agents.

### Contents

- agent role definitions
- system prompts and role prompts
- capability declarations
- file/path access policies
- validation schemas
- approval requirements
- coding and testing conventions
- repo-specific knowledge
- reusable architecture patterns
- escalation criteria

### Source Hierarchy

The system should distinguish between **canonical engineering knowledge** and **runtime instruction files**.

#### Canonical Sources (versioned in git)
These should live in the Dev Team repo and/or Project repo and act as the long-term source of truth.

Examples:

- architecture principles
- ADRs
- SOLID principles guidance
- domain glossary
- coding standards
- testing standards
- security rules
- path ownership and subsystem boundaries
- reference implementations and exemplar PRs

#### Runtime Instruction Layer (in OpenClaw workspaces)
These should remain thinner and operational.

Examples:

- `SOUL.md`
- `AGENTS.md`
- `TOOLS.md`
- `skills/*/SKILL.md`

Purpose:

- define how agents should behave at runtime
- point agents toward canonical docs
- inject repo- and role-specific operating instructions
- constrain tool usage and workflow expectations

### Architecture Context Layer

Sophisticated enterprise architecture should not be stored in one giant prompt.
Instead, it should be represented as an **Architecture Context Layer** made up of:

- durable architecture docs in git
- retrieved task-relevant context at runtime
- policy rules that constrain agent behavior
- validation and review gates that verify architectural compliance

This allows agents to work with advanced design principles consistently instead of depending on vague latent knowledge.

### External Knowledge Retrieval

Agents may also need authoritative context from outside the repo.
That should be treated as a supported input path, but not as an uncontrolled substitute for internal standards.

Approved patterns include:

- public web retrieval for public docs and articles
- curated ingestion of notes, excerpts, PDFs, or distilled summaries into a searchable knowledge store
- direct integration with external systems or services through approved tools/connectors

Examples of appropriate use:

- an online SOLID principles reference
- vendor documentation
- public framework guidance
- internal wiki or docs platforms connected through tooling

### Key Rule

Agent behavior should be driven by versioned policy artifacts plus retrieved context rather than hardcoded orchestration branches whenever possible.

Canonical engineering knowledge should live in repos.
OpenClaw workspace files should inject and operationalize that knowledge at runtime, not replace it.

This keeps the system maintainable as more agents, projects, and workflows are introduced.

---

## 2.4 Integration Plane

This plane connects the runtime to external systems.

### Core Integrations

#### GitHub Adapter
Responsible for:

- reading issues
- managing labels
- creating branches and pull requests
- reading CI and PR status
- updating issue and PR metadata

#### Notification Adapter
Responsible for:

- Discord notifications
- optional Slack notifications
- human approval prompts
- status updates and failure alerts

#### CI Adapter
Responsible for:

- invoking build/test workflows
- reading status checks
- attaching build outputs to task evidence

#### Secrets Adapter
Responsible for:

- scoped credential delivery
- token masking
- lease-based access to secrets
- denying secrets to untrusted tasks or high-risk contexts

---

## 2.5 Evidence Plane

The Evidence Plane stores durable outputs from otherwise temporary work.

### Stores

- architect specs
- task manifests
- diffs
- test results
- review outputs
- logs
- execution traces
- PR metadata
- failure records
- approval decisions

### Why it matters

Ephemeral workspaces should not be the only place important context exists.
A production system needs durable evidence for auditability, debugging, compliance, and improvement.

---

# 3. Runtime Data Model

## Task Manifest

Each task should have a durable manifest.

Suggested fields:

- task_id
- source_issue_id
- source_repo
- priority
- risk_class
- current_phase
- lifecycle_status
- assigned_agent_type
- retry_count
- evidence_links
- workspace_id
- branch_name
- pr_number
- policy_version
- created_at
- updated_at

## Workspace Context

Each workspace should receive a task-scoped context bundle, for example:

```text
.context/
  task.json
  spec.md
  policy_snapshot.json
  allowed_paths.json
  acceptance_criteria.json
```

This bundle should be treated as a task contract.

---

# 4. Memory Model

The original design uses task-local context only. That should be extended into three levels.

## 4.1 Task Memory
Used only for the current task.

Examples:

- issue summary
- acceptance criteria
- current branch
- phase outputs
- retry notes

## 4.2 Project Memory
Shared across tasks within one product repo.

Examples:

- architectural conventions
- coding patterns
- repo layout
- common pitfalls
- testing commands
- path ownership hints

## 4.3 Organization Memory
Shared across multiple projects or teams.

Examples:

- approval policy
- compliance rules
- secure coding rules
- standard PR templates
- reusable prompt assets

## 4.4 Retrieved External Memory
Used when the task depends on authoritative sources outside the repo.

Examples:

- public framework documentation
- public architecture articles
- curated book notes or excerpts
- internal docs platforms connected through approved tools
- vendor integration documentation

Rules:

- external retrieval should be used to enrich reasoning, not override internal policy blindly
- important external guidance should be distilled into durable internal docs when it becomes part of normal engineering practice
- the system should prefer stable curated sources over ad hoc browsing for recurring architectural domains

---

# 5. Task Lifecycle Model

The original state machine is directionally correct, but too tightly coupled to one path.
It should be split into a task lifecycle and a phase lifecycle.

## 5.1 Task Lifecycle

- `draft`
- `ready`
- `active`
- `blocked`
- `completed`
- `failed`
- `cancelled`

## 5.2 Phase Lifecycle

Per phase:

- `pending`
- `running`
- `passed`
- `failed`
- `escalated`
- `skipped`

## 5.3 Typical Phase Sequence

1. intake
2. eligibility
3. planning
4. development
5. validation
6. review
7. SCM / PR
8. merge confirmation
9. archive / close

This model allows retries and policy checks without distorting the business state of the task itself.

---

# 6. Refactored Workflow

## End-to-End Flow

```text
Issue Intake
  -> Eligibility Check
  -> Planning / Spec
  -> Policy Gate
  -> Development
  -> Validation Gate
  -> Review Gate
  -> PR Gate
  -> Merge / Close
  -> Evidence Archive
```

## Detailed Flow

### 1. Issue Intake
The GitHub Adapter detects a task candidate.

### 2. Eligibility Check
The Control Plane verifies:

- task is labeled as AI-eligible
- task is sufficiently structured
- repo and path permissions allow automated work
- risk class is within current autonomy boundaries

### 3. Planning / Spec
The Architect Agent creates or refines:

- solution plan
- affected areas
- implementation constraints
- test expectations
- acceptance mapping

### 4. Policy Gate
The Policy Gate Engine decides whether to continue automatically, request clarification, or escalate.

### 5. Development
The Developer Agent works inside an isolated workspace.

### 6. Validation Gate
The Validation Agent runs automated checks.

### 7. Review Gate
The Reviewer Agent checks correctness and relevance.

### 8. PR Gate
The SCM Agent prepares branch, commits, and PR only if prior gates pass.

### 9. Merge / Close
The system confirms PR state and task completion.

### 10. Evidence Archive
The Evidence Plane stores outputs and execution history for traceability.

---

# 7. Approval and Risk Model

Not every task should be equally autonomous.

## Risk Classes

### Low Risk
Examples:

- docs
- tests
- formatting
- safe refactors in isolated files

Default handling:

- fully autonomous path may be allowed

### Medium Risk
Examples:

- business logic changes
- API changes
- moderate refactors

Default handling:

- autonomous development allowed
- review or PR approval required

### High Risk
Examples:

- auth
- billing
- migrations
- secrets
- infrastructure
- production config

Default handling:

- human approval required before merge
- some actions may be disallowed entirely

## Approval Modes

- `auto`
- `review_required`
- `human_signoff_required`
- `disallowed`

This policy should be driven by rules, not by agent discretion alone.

---

# 8. Capability Model

Agents should declare capabilities rather than rely only on role names.

Examples:

- `can_plan`
- `can_write_code`
- `can_run_tests`
- `can_open_pr`
- `can_modify_schema`
- `can_touch_sensitive_paths`
- `can_use_secrets`

The dispatcher should route tasks according to required capabilities plus policy constraints.

This is more extensible than binding all behavior directly to agent names.

---

# 9. Isolation and Security Model

## Workspace Isolation

Each task should run in an isolated workspace with:

- task-specific context only
- restricted filesystem scope
- restricted tool access
- optional container sandboxing
- explicit cleanup after completion

## Secret Handling

Secrets must not be implicitly available to every task.

Rules:

- secrets are injected only when needed
- secrets are scoped by agent, task, and environment
- secrets are masked from logs and chat history where possible
- untrusted or high-risk tasks may receive no secrets at all

## Restricted Surfaces

Examples:

- deployment config
- billing code
- authentication code
- infrastructure definitions
- compliance-sensitive data flows

These areas should require explicit approval or be blocked by default.

---

# 10. Concurrency and Conflict Handling

A production system must expect multiple tasks to be active at once.

## Required Controls

- repo-level task locks when appropriate
- path ownership hints
- stale branch detection
- merge conflict recovery flow
- duplicate task detection
- retry backoff strategy

## Recommended Principle

Autonomy should be conservative when overlap is detected.
If two tasks target the same surface, the system should prefer serialization or escalation.

---

# 11. Failure Recovery Model

The system needs explicit failure semantics.

## Failure Classes

- planning failure
- validation failure
- review failure
- integration failure
- merge failure
- policy violation
- execution loop / runaway behavior

## Recovery Actions

- retry
- rollback workspace state
- create a follow-up issue
- escalate to human review
- quarantine the task
- mark permanently failed with evidence attached

A task should never silently disappear after a failed phase.

---

# 12. Observability Model

To improve the AI Dev Team over time, the system must measure itself.

## Suggested Metrics

- average time per phase
- success/failure rate by phase
- retry count by task type
- PR acceptance rate
- review rejection rate
- cost per completed task
- token usage by agent type
- failure clusters by rule or repo area

## Suggested Dashboards

- task pipeline dashboard
- agent performance dashboard
- cost and latency dashboard
- failure and escalation dashboard

---

# 13. Extension Points

This refactor is designed to support future expansion.

## Recommended Extension Points

### New Agent Types
Examples:

- documentation agent
- migration planner
- security reviewer
- release agent
- product analyst
- architecture reviewer

### New Intake Sources
Examples:

- Jira
- Linear
- Discord commands
- Slack commands
- scheduled maintenance queues

### New Validation Layers
Examples:

- security scan
- architecture conformance check
- license policy scan
- dependency risk scan

### New Knowledge Sources
Examples:

- indexed ADR repositories
- curated architecture note collections
- internal wiki connectors
- searchable design review archives
- vetted public reference material for engineering design principles such as SOLID

### New Deployment Targets
Examples:

- monorepos
- multiple service repos
- docs repos
- infra repos with stricter controls

---

# 14. Refactored Diagram Model

## Logical Topology

```text
┌──────────────────────────────────────────────┐
│                Control Plane                 │
│ Orchestrator / Dispatcher / State / Policy  │
└───────────────────────┬──────────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────┐
│               Execution Plane                │
│ Architect / Developer / Validation / Review │
│ SCM Agent / Workspace Manager               │
└───────────────┬───────────────────────┬──────┘
                │                       │
                ▼                       ▼
┌──────────────────────────┐   ┌──────────────────────────┐
│      Project Repo        │   │     Ephemeral Workspace  │
│ source / tests / PRs     │   │ task context / code run  │
└──────────────────────────┘   └──────────────────────────┘
                ▲                       │
                │                       ▼
┌──────────────────────────┐   ┌──────────────────────────┐
│    Integration Plane     │   │     Evidence Plane       │
│ GitHub / Discord / CI    │   │ logs / specs / diffs     │
│ secrets / notifications  │   │ reviews / test results   │
└──────────────────────────┘   └──────────────────────────┘
                ▲
                │
┌──────────────────────────────────────────────┐
│           Knowledge & Policy Plane           │
│ agent roles / schemas / capabilities / rules│
└──────────────────────────────────────────────┘
```

---

# 15. Recommended Naming Changes

To make the architecture more precise:

| Old Name | Recommended Name |
|---|---|
| OpenClaw Ecosystem | OpenClaw Runtime |
| Dev Team Definition Repo | Agent Policy Repo |
| Git Agent | SCM Agent |
| Build Agent | Validation Agent |

These names better reflect the responsibilities of each component.

---

# 16. Implementation Roadmap

## Phase 1 — Clean Separation

- split current design into the five planes
- formalize the Agent Policy Repo structure
- define task manifest schema
- define workspace context schema
- define lifecycle states
- define the split between canonical repo docs and OpenClaw runtime instruction files
- establish a first-pass Architecture Context Layer for enterprise design guidance

## Phase 2 — Guardrails

- add eligibility checks
- add risk classes
- add approval modes
- add policy gates between phases
- add secrets scoping rules

## Phase 3 — Durability

- introduce evidence storage
- persist specs, logs, and review outcomes
- add failure recovery handling
- add retry and escalation flows
- add retrieval over architecture docs, ADRs, and curated external knowledge sources
- define how useful external guidance is promoted into durable internal docs

## Phase 4 — Scale-Out

- add capability-based routing
- add additional agent types
- add concurrency controls
- add metrics and dashboards

---

# 17. Final Recommendation

The original architecture is a strong conceptual starting point, but it should be refactored before being treated as a durable autonomous dev-team design.

## Keep

- GitHub-centric workflow
- isolated task workspaces
- multiple specialized agents
- clear task progression
- versioned agent instructions

## Refactor

- separate control from execution
- promote agent definitions into a proper policy system
- add evidence storage explicitly
- add risk and approval gates
- split lifecycle state from phase state
- add isolation, concurrency, and recovery rules

## Outcome

This produces a more scalable and production-ready AI Dev Team architecture that can evolve from a simple orchestrated workflow into a governed autonomous engineering system.

---

# 18. Short Summary

Yes, the architecture can be extended.

The right next move is not to add more agents immediately, but to refactor the system into:

- a clear control plane
- a bounded execution plane
- a versioned policy plane
- explicit integrations
- durable evidence storage
- an architecture context layer that combines repo-based standards, runtime instructions, approved retrieval, and core engineering principles such as SOLID

That refactor will make future additions much safer and much easier.

