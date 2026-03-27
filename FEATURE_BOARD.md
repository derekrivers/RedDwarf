# RedDwarf Feature Board

The board is ordered by implementation priority.

| Priority | Feature                                                                        | Milestone | Status    | Architecture Trace                                                     |
| -------- | ------------------------------------------------------------------------------ | --------- | --------- | ---------------------------------------------------------------------- |
| 1        | Docker topology for OpenClaw, Postgres, workspace, and evidence mounts         | M0        | completed | System Context, Integration Plane, Isolation and Security Model        |
| 2        | TypeScript monorepo foundation and shared package boundaries                   | M0        | completed | Core Architectural Decision                                            |
| 3        | Mounted policy-pack assets for agents, prompts, schemas, and standards         | M0        | completed | Knowledge & Policy Plane                                               |
| 4        | Shared runtime contracts and Zod schemas                                       | M1        | completed | Runtime Data Model                                                     |
| 5        | Lifecycle engine and legal phase transitions                                   | M1        | completed | Task Lifecycle Model                                                   |
| 6        | Eligibility, risk, and approval rule engine                                    | M1        | completed | Approval and Risk Model                                                |
| 7        | Planning-only pipeline with disabled downstream phases                         | M1        | completed | Refactored Workflow, Execution Plane                                   |
| 8        | Postgres evidence persistence and audit records                                | M1        | completed | Evidence Plane                                                         |
| 9        | OpenClaw context materialization helpers                                       | M1        | completed | Workspace Context                                                      |
| 10       | Observability, run IDs, failure classes, and event records                     | M2        | completed | Observability Model, Failure Recovery Model                            |
| 11       | GitHub and CI adapter contracts with mutation disabled                         | M2        | completed | Integration Plane                                                      |
| 12       | Memory partitions for task, project, organization, and external retrieval      | M2        | completed | Memory Model                                                           |
| 13       | Concurrency strategy contracts and stale-run detection                         | M3        | completed | Concurrency and Conflict Handling                                      |
| 14       | Versioned policy-pack packaging beyond bind mounts                             | M3        | completed | Extension Points                                                       |
| 15       | Runtime instruction layer generation for OpenClaw workspaces                   | M3        | completed | Knowledge & Policy Plane, Workspace Context, Runtime Instruction Layer |
| 16       | Workspace manager and isolated workspace lifecycle                             | M3        | completed | Execution Plane, Workspace Manager, Isolation and Security Model       |
| 17       | Human approval queue and decision workflow                                     | M3        | completed | Approval and Risk Model, Control Plane                                 |
| 18       | Developer phase orchestration with code-write disabled by default              | M4        | completed | Execution Plane, Refactored Workflow                                   |
| 19       | Validation phase runner for lint and test execution in workspaces              | M4        | completed | Validation Agent, Execution Plane                                      |
| 20       | Secrets adapter and scoped credential injection rules                          | M4        | completed | Integration Plane, Isolation and Security Model                        |
| 21       | SCM adapter with branch and PR creation behind approval gates                  | M4        | completed | SCM Agent, Integration Plane                                           |
| 22       | Evidence artifact archival for diffs, logs, test results, and review outputs   | M4        | completed | Evidence Plane                                                         |
| 23       | Retry, escalation, and follow-up issue automation                              | M4        | completed | Failure Recovery Model                                                 |
| 24       | Operator dashboard or API for runs, approvals, evidence, and blocked tasks     | M5        | completed | Control Plane, Observability Model                                     |
| 25       | Knowledge ingestion pipeline for ADRs, standards, and curated external context | M5        | completed | Knowledge & Policy Plane, External Knowledge Retrieval                 |
| 26       | Extract concurrency detection into a shared utility function                   | M6        | completed | Control Plane, Concurrency and Conflict Handling                       |
| 27       | Split control-plane/src/index.ts into focused module files                     | M6        | completed | Control Plane                                                          |
| 28       | Split evidence/src/index.ts into repository, factories, and utilities          | M6        | completed | Evidence Plane                                                         |
| 29       | Consolidate duplicate phase-capability constants across packages               | M6        | completed | Policy, Control Plane, Execution Plane                                 |
| 30       | Fix InMemoryPlanningRepository.getTaskSnapshot to use Promise.all              | M6        | completed | Evidence Plane                                                         |
| 31       | Eliminate redundant Zod re-parsing in workspace materialization path           | M6        | completed | Control Plane                                                          |
| 32       | Move deterministic agent classes from control-plane into execution-plane       | M6        | completed | Execution Plane, Control Plane                                         |
| 33       | Replace if/else phase chains with capability-per-phase map in policy package   | M6        | completed | Policy                                                                 |
| 34       | Fix SecretLeaseRequest to use imported RiskClass and ApprovalMode types        | M6        | completed | Integration Plane                                                      |
| 35       | Fix isCapability guard to derive values from the contracts array               | M6        | completed | Integration Plane                                                      |
| 36       | Merge disabled-phases list into a single shared constant                       | M6        | completed | Policy, Execution Plane                                                |
| 37       | Fix archive phase to measure real duration rather than always reporting zero   | M6        | completed | Control Plane                                                          |
| 38       | Optimize InMemoryPlanningRepository filter chain and redactSecretValues        | M6        | completed | Evidence Plane, Integration Plane                                      |
| 39       | Split PlanningRepository interface into read and write contracts               | M7        | completed | Evidence Plane                                                         |
| 40       | Inject pg.Pool dependency into PostgresPlanningRepository constructor          | M7        | completed | Evidence Plane                                                         |
| 41       | Move agent interfaces and draft types to contracts to unblock F32              | M7        | completed | Contracts, Execution Plane, Control Plane                              |
| 42       | Move deterministic agent classes to execution-plane (unblocked by F41)         | M7        | completed | Execution Plane, Control Plane                                         |
| 43       | Real GitHub issue intake adapter reading live repositories and issues via GitHub REST API | M8 | completed | Integration Plane                                                      |
| 44       | Live LLM planning agent binding through OpenClaw system prompt and configurable agent selection | M8 | completed | Execution Plane, Knowledge & Policy Plane                              |
| 45       | Real GitHub SCM adapter for live branch and PR creation behind existing approval gates | M8 | completed | Integration Plane, SCM Agent                                           |
| 46       | Concrete env-var-backed secret vault adapter as first non-fixture secrets implementation | M8 | pending | Integration Plane, Isolation and Security Model                        |
| 47       | Unit test suite for DeterministicPlanningAgent, DeterministicDeveloperAgent, DeterministicValidationAgent, and DeterministicScmAgent | M8 | pending | Execution Plane                                                        |
| 48       | verify:all composite script running all eighteen verify scripts in sequence     | M8        | pending   | Observability Model                                                    |
| 49       | Idempotent setup script combining compose:up, db:migrate, and stack health check | M8       | pending   | System Context                                                         |
| 50       | Evidence volume retention policy with configurable age threshold and cleanup script | M8     | pending   | Evidence Plane                                                         |
| 51       | End-to-end local demo runbook targeting a real GitHub repository with live inputs and outputs | M8 | pending | System Context, Refactored Workflow                                   |
| 52       | README improvements covering Windows host configuration, registry access, and boot health check | M8 | pending | System Context                                                        |
