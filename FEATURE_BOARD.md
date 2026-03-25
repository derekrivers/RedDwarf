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
