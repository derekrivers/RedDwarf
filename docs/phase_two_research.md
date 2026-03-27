# RedDwarf Phase 2: GitHub Intake to OpenClaw Execution

## Overview

The next phase of RedDwarf should treat **RedDwarf as the decision-making control plane** and **OpenClaw as the bounded execution runtime**.

This means:

- **RedDwarf decides**
- **OpenClaw executes**

RedDwarf should remain responsible for issue intake, risk assessment, policy checks, approval routing, orchestration, evidence requirements, and execution eligibility.

OpenClaw should only be invoked **after** RedDwarf has determined that the work is safe and eligible to proceed.

---

## Current Position

MVP v1 is effectively complete.

Current capabilities already demonstrated:

- GitHub issue can be pulled into the system
- The issue can be examined
- High-risk issues can be identified
- High-risk work can be queued for approval
- The entire flow can be run locally on a home PC using Docker containers

This proves the core control-plane concept.

---

## Immediate Plan

The immediate next step is to move from a manual demo flow to an automated intake flow.

### Proposed flow

1. RedDwarf polls the GitHub repository for newly created issues
2. Each issue is normalized into a RedDwarf intake task
3. RedDwarf performs deterministic policy and risk assessment
4. If the issue is high risk, it is queued for approval
5. If the issue is considered safe, it is handed off to OpenClaw
6. OpenClaw executes the work using predefined agents, policies, and orchestration rules
7. Evidence and execution outcomes are returned to RedDwarf

---

## Architectural Boundary

The boundary between RedDwarf and OpenClaw should remain very clear.

### RedDwarf responsibilities

RedDwarf should own:

- GitHub polling or event intake
- Issue normalization
- Risk classification
- Policy evaluation
- Approval queueing
- Task eligibility checks
- Execution orchestration
- Evidence requirements
- Result persistence
- Audit trail
- Secret lease injection
- SCM mutation approval rules

### OpenClaw responsibilities

OpenClaw should own:

- Agent runtime execution
- Agent workspace loading
- Prompt/bootstrap loading
- Tool access enforcement
- Sandbox execution
- Session handling
- Model/provider routing
- Agent task execution within a bounded scope

---

## Guiding Principle

OpenClaw should **not** be the component that decides whether work is safe.

That decision should remain inside RedDwarf.

### Correct model

- RedDwarf determines whether the issue is safe
- RedDwarf decides whether approval is required
- RedDwarf defines what the agent is allowed to do
- OpenClaw executes only within those constraints

This preserves a strong trust boundary and keeps policy decisions deterministic.

---

## Recommended RedDwarf Phase 2 Pipeline

```text
GitHub issue detected
  -> intake record created
  -> issue normalized
  -> risk and policy checks performed
  -> if risky: queue for approval
  -> if safe: build execution manifest
  -> hand off to OpenClaw
  -> OpenClaw runs approved agent workflow
  -> evidence and results captured
  -> optional approval before SCM mutation