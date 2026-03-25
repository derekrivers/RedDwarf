# RedDwarf Feature Board

The board is ordered by implementation priority.

| Priority | Feature | Milestone | Status | Architecture Trace |
| --- | --- | --- | --- | --- |
| 1 | Docker topology for OpenClaw, Postgres, workspace, and evidence mounts | M0 | completed | System Context, Integration Plane, Isolation and Security Model |
| 2 | TypeScript monorepo foundation and shared package boundaries | M0 | completed | Core Architectural Decision |
| 3 | Mounted policy-pack assets for agents, prompts, schemas, and standards | M0 | completed | Knowledge & Policy Plane |
| 4 | Shared runtime contracts and Zod schemas | M1 | completed | Runtime Data Model |
| 5 | Lifecycle engine and legal phase transitions | M1 | completed | Task Lifecycle Model |
| 6 | Eligibility, risk, and approval rule engine | M1 | completed | Approval and Risk Model |
| 7 | Planning-only pipeline with disabled downstream phases | M1 | completed | Refactored Workflow, Execution Plane |
| 8 | Postgres evidence persistence and audit records | M1 | completed | Evidence Plane |
| 9 | OpenClaw context materialization helpers | M1 | completed | Workspace Context |
| 10 | Observability, run IDs, failure classes, and event records | M2 | completed | Observability Model, Failure Recovery Model |
| 11 | GitHub and CI adapter contracts with mutation disabled | M2 | completed | Integration Plane |
| 12 | Memory partitions for task, project, organization, and external retrieval | M2 | completed | Memory Model |
| 13 | Concurrency strategy contracts and stale-run detection | M3 | completed | Concurrency and Conflict Handling |
| 14 | Versioned policy-pack packaging beyond bind mounts | M3 | completed | Extension Points |
| 15 | Runtime instruction layer generation for OpenClaw workspaces | M3 | planned | Knowledge & Policy Plane, Workspace Context, Runtime Instruction Layer |
| 16 | Workspace manager and isolated workspace lifecycle | M3 | planned | Execution Plane, Workspace Manager, Isolation and Security Model |
| 17 | Human approval queue and decision workflow | M3 | planned | Approval and Risk Model, Control Plane |
| 18 | Developer phase orchestration with code-write disabled by default | M4 | planned | Execution Plane, Refactored Workflow |
| 19 | Validation phase runner for lint and test execution in workspaces | M4 | planned | Validation Agent, Execution Plane |
| 20 | Secrets adapter and scoped credential injection rules | M4 | planned | Integration Plane, Isolation and Security Model |
| 21 | SCM adapter with branch and PR creation behind approval gates | M4 | planned | SCM Agent, Integration Plane |
| 22 | Evidence artifact archival for diffs, logs, test results, and review outputs | M4 | planned | Evidence Plane |
| 23 | Retry, escalation, and follow-up issue automation | M4 | planned | Failure Recovery Model |
| 24 | Operator dashboard or API for runs, approvals, evidence, and blocked tasks | M5 | planned | Control Plane, Observability Model |
| 25 | Knowledge ingestion pipeline for ADRs, standards, and curated external context | M5 | planned | Knowledge & Policy Plane, External Knowledge Retrieval |
