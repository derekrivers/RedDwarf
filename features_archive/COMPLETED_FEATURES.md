# RedDwarf Completed Features Archive

This archive lists all features completed to date. Active pending work remains in [FEATURE_BOARD.md](/c:/Dev/RedDwarf/FEATURE_BOARD.md).

Last archive sweep: 2026-04-19. Completed feature count: 169.

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
| 46       | Concrete env-var-backed secret vault adapter as first non-fixture secrets implementation | M8 | completed | Integration Plane, Isolation and Security Model                        |
| 47       | Unit test suite for DeterministicPlanningAgent, DeterministicDeveloperAgent, DeterministicValidationAgent, and DeterministicScmAgent | M8 | completed | Execution Plane                                                        |
| 48       | verify:all composite script running all eighteen verify scripts in sequence     | M8        | completed | Observability Model                                                    |
| 49       | Idempotent setup script combining compose:up, db:migrate, and stack health check | M8       | completed | System Context                                                         |
| 50       | Evidence volume retention policy with configurable age threshold and cleanup script | M8     | completed | Evidence Plane                                                         |
| 51       | End-to-end local demo runbook targeting a real GitHub repository with live inputs and outputs | M8 | completed | System Context, Refactored Workflow                                   |
| 52       | README improvements covering Windows host configuration, registry access, and boot health check | M8 | completed | System Context                                                        |
| 53       | GitHub issue polling daemon with configurable interval and deduplication against existing planning specs | M9 | completed | Integration Plane, Control Plane                                      |
| 54       | Polling cursor persistence in Postgres with per-repo last-seen issue tracking and operator API health exposure | M9 | completed | Integration Plane, Evidence Plane, Observability Model                |
| 55       | OpenClaw agent role definitions and bootstrap files for coordinator, analyst, and validator agents | M9 | completed | Knowledge & Policy Plane, Execution Plane, Isolation and Security Model |
| 56       | Per-agent tool policy specification with profiles, allow/deny lists, sandbox settings, and Anthropic model binding | M9 | completed | Knowledge & Policy Plane, Isolation and Security Model                |
| 82       | Rename OpenClaw agents from coordinator/analyst/validator to rimmer/holly/kryten with full Red Dwarf persona files | M10 | completed | Knowledge & Policy Plane, Execution Plane                             |
| 83       | Update docs/openclaw to reflect Anthropic as primary provider with model equivalents across all five docs | M10 | completed | Knowledge & Policy Plane                                              |
| 57       | openclaw.json generation from RedDwarf policy configuration with per-agent workspace paths, tool profiles, and skipBootstrap | M10 | completed | System Context, Knowledge & Policy Plane, Integration Plane           |
| 58       | Hook token secret wiring through EnvVarSecretsAdapter with .env.example and runbook documentation | M10 | completed | Integration Plane, Isolation and Security Model                       |
| 59       | OpenClawDispatchAdapter contract and fixture adapter registered alongside existing integration adapters | M10 | completed | Integration Plane, Execution Plane                                    |
| 60       | HTTP implementation of OpenClawDispatchAdapter posting to /hooks/agent with sessionKey, agentId, bearer auth, and retry | M10 | completed | Integration Plane, Execution Plane                                    |
| 61       | Session result and transcript capture reading OpenClaw session JSONL and persisting agent output as phase evidence | M10 | completed | Integration Plane, Evidence Plane, Observability Model                |
| 62       | Wire developer phase to OpenClaw dispatch for read-only analyst handoff replacing the deterministic stub | M10 | completed | Execution Plane, Control Plane, Integration Plane                     |
| 63       | Workspace bootstrap alignment verifying IDENTITY.md, SOUL.md, AGENTS.md, TOOLS.md, and SKILL.md match OpenClaw consumption format | M10 | completed | Workspace Context, Knowledge & Policy Plane, Execution Plane          |
| 64       | Fix SQL injection vector in hasPlanningSpecForSource and ReDoS vulnerability in redactSecretValues | M11 | completed | Evidence Plane, Integration Plane                                      |
| 65       | Extract shared script configuration module for connection string, workspace root, and error formatting | M11 | completed | System Context                                                         |
| 66       | Split contracts/src/index.ts into focused domain modules with barrel re-export | M11 | completed | Contracts                                                              |
| 67       | Extract duplicate pipeline phase helpers for snapshot validation, approval lookup, and phase initialization | M11 | completed | Control Plane                                                          |
| 68       | Decompose monolithic pipeline phase functions into orchestrated sub-steps | M11 | completed | Control Plane                                                          |
| 69       | Deduplicate dedupeMemoryRecords and consolidate magic event-code string constants | M11 | completed | Evidence Plane                                                         |
| 70       | Extract tool-policy mode literals and validation-schema magic numbers into named constants | M11 | completed | Control Plane, Contracts, Execution Plane                              |
| 71       | Fix silent exception swallowing in cleanup-evidence and cap polling batch growth | M11 | completed | System Context, Control Plane                                          |
| 72       | Parallelize verify-all.mjs script execution with configurable concurrency | M11 | completed | Observability Model                                                    |
| 73       | Optimize PostgresPlanningRepository.getTaskSnapshot to reduce from 9 queries to 1â€“2 via JOINs | M11 | completed | Evidence Plane                                                         |
| 74       | Reduce repeated taskManifestSchema.parse calls in pipeline.ts by parsing once at phase entry | M11 | completed | Control Plane                                                          |
| 75       | Stream file hashing in archiveEvidenceArtifact instead of buffering entire file | M11 | completed | Control Plane                                                          |
| 76       | Extract AnthropicPlanningAgent retry logic and response parsing into reusable concerns | M11 | completed | Execution Plane                                                        |
| 77       | Segment GitHubAdapter interface into separate read and write contracts | M11 | completed | Integration Plane                                                      |
| 78       | Replace hardcoded phase failure maps and approval rules with extensible registry pattern | M11 | completed | Control Plane, Policy                                                  |
| 79       | Split PostgresPlanningRepository row mappers into standalone testable module | M11 | completed | Evidence Plane                                                         |
| 80       | Fix defaultLogger.child() LSP violation returning same instance | M11 | completed | Control Plane                                                          |
| 81       | Enable no-floating-promises ESLint rule and fix all unawaited promise call sites | M11 | completed | All Packages                                                           |
| 84       | Dave Lister developer agent - workspace_write sandbox, scoped file edit capability, implement_architecture_plan and report_deviation_or_blocker skills, wired to developer phase | M12 | completed | Execution Plane, Knowledge & Policy Plane                             |
| 85       | PR-capable OpenClaw E2E path - materialize target-repo workspaces, wait for completed developer sessions, publish workspace changes as commits, and open real PRs at SCM handoff | M12 | completed | Execution Plane, Control Plane, Integration Plane, SCM Agent          |
| 89       | Post-approval execution dispatcher - auto-dispatch ready manifests through developer/validation/SCM phases via OpenClaw agents (Hollyâ†’Listerâ†’Kryten), single-pass sequencing, one task at a time, block on failure for human intervention, integrate as parallel polling loop in start-stack | M13 | completed | Control Plane, Execution Plane, Integration Plane                     |
| 90       | Atomic run claiming for each pipeline phase - replace read-then-write overlap checks with database-backed ownership claims and stale-run takeover in one path | M15 | completed | Control Plane, Concurrency and Conflict Handling, Evidence Plane      |
| 91       | Transactional manifest, approval, phase, evidence, and run-event transitions - commit each logical state change as one database transaction | M15 | completed | Control Plane, Evidence Plane, Approval and Risk Model                |
| 92       | Enforce allowed-path boundaries before commit and push - fail SCM when workspace changes escape policy-approved file scopes | M15 | completed | Control Plane, SCM Agent, Isolation and Security Model                |
| 93       | Remove tokenized git remotes and redact secret-bearing failures - keep credentials out of argv, persisted errors, and operator-visible responses | M15 | completed | Integration Plane, SCM Agent, Isolation and Security Model          |
| 94       | Authenticate the operator API and constrain manual dispatch roots - require operator auth, bound request size, and reject writes outside managed roots | M15 | completed | Control Plane, Isolation and Security Model                           |
| 95       | Align heartbeats, stale windows, and subprocess timeouts - heartbeat long waits and bound git and validation child processes end to end | M15 | completed | Control Plane, Failure Recovery Model, Execution Plane              |
| 96       | Scrub or destroy secret-bearing workspaces on phase exit - remove scoped secret files once the requiring phase finishes or fails | M15 | completed | Control Plane, Isolation and Security Model, Evidence Plane         |
| 97       | Fence untrusted issue content inside planner and agent prompts - isolate GitHub issue text as data instead of executable instruction context | M15 | completed | Integration Plane, Execution Plane, Knowledge & Policy Plane        |
| 137      | Transcript-aware developer completion detection - fail fast when an OpenClaw development session terminates without producing `developer-handoff.md` (for example `stopReason = length`, stalled transcript growth, or dead-end tool/error loops), and tighten prompts to avoid broad repo enumeration that burns output budget before implementation starts | M15 | completed | Control Plane, Integration Plane, Failure Recovery Model |
| 98       | Harden the Postgres pool with timeouts, sizing, and telemetry - make DB stalls fail boundedly and expose saturation before the pipeline wedges | M16 | completed | Evidence Plane, Observability Model, Control Plane                  |
| 99       | Wire structured runtime logging and degraded-startup health across poller and dispatcher - replace noop defaults and keep startup alive on first-cycle failures | M16 | completed | Observability Model, Control Plane, Integration Plane               |
| 100      | Sweep stale script call sites to the current Postgres repository factory - replace legacy constructor usage so verifiers and maintenance scripts survive repository DI changes | M16 | completed | Evidence Plane, System Context                                      |
| 101      | Add idempotent guards for external side effects during retries and recovery - prevent duplicate follow-up issues, branch publication, and PR mutations when phases restart or transactions retry | M16 | completed | Control Plane, Integration Plane, Failure Recovery Model           |
| 102      | Resume approved retries from the failed phase instead of replaying upstream phases - let operator-approved recovery restart validation or SCM directly without re-running developer work | M16 | completed | Control Plane, Failure Recovery Model, Execution Plane             |
| 103      | Auto-dispatch retry-eligible blocked phases without manual intervention - let failure-recovery retries actually re-enter validation or SCM when automation schedules another attempt | M16 | completed | Control Plane, Failure Recovery Model, Execution Plane             |
| 88       | Restore Holly to the live OpenClaw workflow - route architecture planning through reddwarf-analyst, persist Holly handoff as evidence, and pass the approved plan into Lister and downstream review | M14 | completed | Execution Plane, Control Plane, Knowledge & Policy Plane              |
| 105      | [QUAL-001] Extract phase run context into a shared initialiser â€” introduce `PhaseRunContext` interface and `createPhaseRunContext` factory eliminating copy-pasted boilerplate across all four phase functions | M17 | completed | Control Plane |
| 106      | [QUAL-002] Split pipeline.ts (6524 lines) into focused orchestration modules â€” extract planning, development, validation, scm, prompts, failure, approval, and context into a pipeline/ subdirectory; barrel-export unchanged public API | M17 | completed | Control Plane |
| 107      | [QUAL-003] Inject runtime environment configuration â€” introduce WorkspaceRuntimeConfig injectable parameter with process.env fallback replacing direct process.env reads in pipeline.ts and workspace.ts | M17 | completed | Control Plane, Contracts |
| 108      | [QUAL-004] Split integrations/src/index.ts (1740 lines) into domain-scoped modules â€” github.ts, secrets.ts, openclaw.ts, knowledge.ts, ci.ts, errors.ts with unchanged barrel export | M17 | completed | Integration Plane |
| 109      | [QUAL-005] Add unit tests for RestGitHubAdapter read and error paths â€” readIssueStatus, listIssueCandidates, fetchIssueCandidate with 404/401/429/timeout cases using vi.stubGlobal fetch | M17 | completed | Integration Plane |
| 110      | [QUAL-006] Encapsulate PostgresPlanningRepository WithExecutor methods â€” made ~10 *WithExecutor methods private via Extract Interface pattern | M17 | completed | Evidence, Persistence |
| 111      | [QUAL-007] Separate InMemoryPlanningRepository from interface definitions â€” moved implementation to in-memory-repository.ts leaving repository.ts as pure interface | M17 | completed | Evidence |
| 112      | [QUAL-008] Add failure-path tests for EnvVarSecretsAdapter and HttpOpenClawDispatchAdapter â€” missing env var, partial scopes, 401/500/429 responses using vi.stubEnv and vi.stubGlobal | M17 | completed | Integration Plane, Isolation and Security Model |
| 113      | [QUAL-009] Replace instanceof chain in normalizePipelineFailure with PipelineErrorMapper registry â€” AllowedPathViolationError now first-class with violatingFiles/allowedPaths preserved in failure details | M17 | completed | Control Plane, Failure Recovery Model |
| 114      | [QUAL-010] Guard waitWithHeartbeat against heartbeat errors masking work errors â€” onHeartbeat() wrapped in try/catch with warn logging so transient Postgres failures don't surface as phase errors | M17 | completed | Control Plane |
| 115      | [QUAL-011] Split control-plane/src/index.test.ts (5602 lines) â€” operator API, polling daemon, knowledge ingestion, and OpenClaw config test groups moved into co-located files | M17 | completed | Control Plane |
| 128      | Add CORS support to the operator API HTTP server | M19 | completed | Control Plane, Operator Dashboard |
| 129      | Scaffold `packages/dashboard` workspace package with Tabler layout shell and auth | M19 | completed | Operator Dashboard |
| 130      | Typed API client (`src/api/client.ts`) | M19 | completed | Operator Dashboard |
| 131      | Approval list page (`/approvals`) | M19 | completed | Operator Dashboard |
| 132      | Approval detail and resolve page (`/approvals/:id`) | M19 | completed | Operator Dashboard |
| 133      | Dashboard home (`/dashboard`) | M19 | completed | Operator Dashboard |
| 134      | Pipeline runs page (`/pipeline`) | M19 | completed | Operator Dashboard |
| 88       | Architecture Reviewer Agent phase - add a post-Developer pre-Validator OpenClaw phase that checks implementation against the planning spec, flags structural drift, and emits a structured conformance verdict before the Validator runs | M15 | completed | Integration Plane, Control Plane, Contracts |

| 89       | Deterministic eligibility gate - cheap pre-check before context materialization that confirms task eligibility (required label, acceptance criteria, minimum summary) and short-circuits ineligible tasks without an LLM call | M15 | completed | Control Plane, Knowledge & Policy Plane |
| 90       | Role-scoped context materialization - restrict the context window handed to each agent phase to only the slice relevant to that role; Architect gets policy and domain docs, Developer gets spec and code, Validator gets spec and diff | M15 | completed | Integration Plane, Knowledge & Policy Plane |
| 93       | Per-run project memory cache - cache the resolved project memory snapshot once per pipeline run so it is tokenized once and reused across all phases rather than reloaded per phase | M15 | completed | Knowledge & Policy Plane, Control Plane |
| 94       | Pre-screener agent phase - add a lightweight pre-pipeline step that runs before the Architect and rejects tasks that are under-specified, duplicate, or out of scope, returning structured rejection reasons rather than consuming a full planning pass | M16 | completed | Integration Plane, Control Plane, Contracts |
| 95       | Structured GitHub issue template - add a repo issue template that collects the fields required for direct pipeline intake (title, acceptance criteria, affected areas, priority signal), reducing freeform-to-spec translation burden on the Architect | M16 | completed | Integration Plane |
| 96       | Direct task injection endpoint - add POST /tasks/inject operator API endpoint that accepts a structured task payload and enqueues it directly into the pipeline, bypassing the GitHub polling path for programmatic intake | M16 | completed | Control Plane, Integration Plane, Contracts |
| 97       | Local CLI task submission - add a reddwarf submit CLI command that wraps the direct injection endpoint, allowing a developer to push a task from the terminal without opening GitHub | M16 | completed | Control Plane |
| 98       | Task grouping and batch intake - allow multiple related tasks to be submitted as a named group with a declared dependency order, with the pipeline serializing or parallelizing them accordingly | M16 | completed | Control Plane, Contracts |
| 102      | CI adapter tool for agents - add a tool that lets Developer and Validator phases trigger and query CI runs so they can confirm build and test health as part of their phase execution | M16 | completed | Integration Plane |
| 103      | OpenAI provider support - extend openClawModelBindingSchema provider to enum, update openclaw.json generation, add gpt model mapping alongside Anthropic equivalents | M17 | completed | Contracts, Integration Plane, Knowledge & Policy Plane |
| 99       | Discord approval bot - surface pending approval requests as interactive Discord messages with approve/reject buttons and respond to status queries | Fast-track | completed | Integration Plane, Operator Surface |
| 100      | Discord notifications for agents - push status updates and approval requests to a Discord channel mid-run for async human oversight | Fast-track | completed | Integration Plane, Operator Surface |
| 101      | Browser / web search for Architect agent - allow the Architect phase to pull current library docs and API references when formulating the planning spec | Fast-track | completed | Integration Plane, Knowledge & Policy Plane |
| 114      | Classify `.env` into boot-time, runtime, and secret tiers; refactor `.env.example` with grouped comment headers | M14 | completed | UX report: Section 1.2, Appendix |
| 115      | Add `operator_config` Drizzle table and startup merge logic so DB-backed runtime config overrides `.env` | M14 | completed | UX report: Sections 1.5, 2.4 |
| 116      | Add `GET /config`, `PUT /config`, and `GET /config/schema` Operator API endpoints with Zod contracts | M14 | completed | UX report: Sections 2.2, 2.4 |
| 117      | Add `GET /repos`, `POST /repos`, and `DELETE /repos/:owner/:repo`; replace comma-string poll repo config with DB-backed repo management | M14 | completed | UX report: Sections 1.3, 2.2 |
| 118      | Expand observability endpoints: filtered `GET /runs`, `GET /runs/:id`, `GET /runs/:id/evidence`, `GET /tasks`, `GET /tasks/:id` | M14 | completed | UX report: Section 2.2 |
| 119      | Add `POST /secrets/:key/rotate` write-only endpoint backed by a permissions-restricted local secrets store | M14 | completed | UX report: Sections 1.4, 2.2 |
| 120      | Build and serve a single-file operator configuration panel from `GET /ui` for Polling, DB Pool, Logging, Paths, Status, and secret rotation | M14 | completed | UX report: Sections 1.3, 2.2 |
| 121      | Register OpenClaw WebChat operator commands for `status`, `approve`, `reject`, `submit`, and `runs` | M14 | completed | UX report: Section 4.2 |
| 122      | Add an MCP bridge over the Operator API so OpenClaw agents can query RedDwarf task history and evidence during context building | M14 | completed | UX report: Section 4.3 |
| 107      | Dry-run / simulation mode | M16 | completed | Proposal source |
| 108      | Plan confidence gate | M16 | completed | Proposal source |
| 109      | Token budget enforcement | M16 | completed | Proposal source |
| 110      | Pipeline run report export | M16 | completed | Proposal source |
| 111      | Prompt version tracking | M16 | completed | Proposal source |
| 112      | Phase retry budget | M16 | completed | Proposal source |
| 113      | Structured eligibility rejection reasons | M16 | completed | Proposal source |
| 140      | Rimmer coordinator: complexity classifier + project mode routing | M20 | completed | docs/reddwarf_project_mode_spec.md §6 T-01 |
| 141      | ProjectSpec + TicketSpec schema, migration, contracts, and repositories | M20 | completed | docs/reddwarf_project_mode_spec.md §6 T-02 |
| 142      | Holly planning phase: project mode (single/project flag, ClarificationRequest, ProjectSpec persistence) | M20 | completed | docs/reddwarf_project_mode_spec.md §6 T-03 |
| 143      | Operator API: clarification endpoints for project planning loop | M20 | completed | docs/reddwarf_project_mode_spec.md §6 T-03 AC-3/4 |
| 144      | GitHub Issues adapter for sub-issue creation on plan approval | M20 | completed | docs/reddwarf_project_mode_spec.md §6 T-05 |
| 145      | Operator API: project listing + approval flow (GET /projects, POST /projects/:id/approve) | M20 | completed | docs/reddwarf_project_mode_spec.md §6 T-08 |
| 146      | Sub-issue writer on plan approval + first ticket dispatch | M20 | completed | docs/reddwarf_project_mode_spec.md §6 T-06 |
| 147      | Tailscale Funnel: operator API external reachability for GitHub Actions | M20 | completed | docs/reddwarf_project_mode_spec.md §4.1 step 11 |
| 148      | GitHub Actions merge workflow + ticket advance endpoint (reddwarf-advance.yml) | M20 | completed | docs/reddwarf_project_mode_spec.md §6 T-07 |
| 150      | Task Flow mirrored mode for project ticket pipeline | M21 | completed | docs/openclaw/openclaw-integration-features-spec.md §150 |
| 151      | Structured execution items on dashboard (AGENT_PROGRESS_ITEM events + live timeline) | M21 | completed | docs/openclaw/openclaw-integration-features-spec.md §151 |
| 152      | Plugin approval hook for agent-side safety rails (before_tool_call) | M21 | completed | docs/openclaw/openclaw-integration-features-spec.md §152 |
| 153      | Model failover profiles (Anthropic ↔ OpenAI rotation on 429/5xx) | M21 | completed | docs/openclaw/openclaw-integration-features-spec.md §153 |
| 154      | ACPX embedded dispatch (replaces HTTP hook POST /hooks/agent) | M21 | completed | docs/openclaw/openclaw-integration-features-spec.md §154 |
| 155      | ClawHub skill publishing and dynamic discovery | M21 | completed | docs/openclaw/openclaw-integration-features-spec.md §155 |
| 156      | Dreaming memory integration (dreams.md → memory_records, dedup, operator pruning) | M21 | completed | docs/openclaw/openclaw-integration-features-spec.md §156 |
| 157      | Scope Docker env injection to minimal required OpenClaw secrets | M22 | completed | docs/openclaw/OPENCLAW_AUDIT.md F-157 |
| 158      | Document and audit agent tool allow/deny groups as sole sandbox enforcement | M22 | completed | docs/openclaw/OPENCLAW_AUDIT.md F-158 |
| 159      | Fail-closed on policy lookup failure in before-tool-call hook | M22 | completed | docs/openclaw/OPENCLAW_AUDIT.md F-159 |
| 160      | Remove HOOK_TOKEN from openclaw secret scope | M22 | completed | docs/openclaw/OPENCLAW_AUDIT.md F-160 |
| 161      | Add retry logic to AcpxOpenClawDispatchAdapter (429/529 backoff, 404 fallback) | M22 | completed | docs/openclaw/OPENCLAW_AUDIT.md F-161 |
| 162      | Default agent-to-agent messaging to opt-in | M22 | completed | docs/openclaw/OPENCLAW_AUDIT.md F-162 |
| 163      | Startup-time stale secret lease audit and cleanup + periodic + SIGTERM scrub | M22 | completed | docs/openclaw/OPENCLAW_AUDIT.md F-163 |
| 164      | Fix tool approval polling — jitter, single endpoint, pending state | M22 | completed | docs/openclaw/OPENCLAW_AUDIT.md F-164 |
| 165      | Prompt sanitization and length cap before OpenClaw dispatch | M22 | completed | docs/openclaw/OPENCLAW_AUDIT.md F-165 |
| 166      | Enforce session key normalization at the type level (branded NormalizedSessionKey) | M22 | completed | docs/openclaw/OPENCLAW_AUDIT.md F-166 |
| 167      | Cancel Task Flow on all abnormal pipeline termination paths | M22 | completed | docs/openclaw/OPENCLAW_AUDIT.md F-167 |
| 168      | Consolidate tool approval polling to single HTTP call (GET /tool-approvals/:id) | M22 | completed | docs/openclaw/OPENCLAW_AUDIT.md F-168 |
| 169      | Expose `deliver` as a configurable dispatch option in OpenClawDispatchOptions | M22 | completed | docs/openclaw/OPENCLAW_AUDIT.md F-169 |
| 170      | Move ClawHub publisher allow-list to operator configuration (REDDWARF_CLAWHUB_ALLOWED_PUBLISHERS) | M22 | completed | docs/openclaw/OPENCLAW_AUDIT.md F-170 |
| 171      | Harden session transcript parsing against malformed/crafted input (Zod schema per JSONL line) | M22 | completed | docs/openclaw/OPENCLAW_AUDIT.md F-171 |
| 172      | Cache and timeout OpenClaw health check in dashboard bootstrap (2s AbortSignal, 15s cache) | M22 | completed | docs/openclaw/OPENCLAW_AUDIT.md F-172 |
| 173      | Integration test coverage for HTTP hook and ACPX dispatch adapters (msw-based) | M22 | completed | docs/openclaw/OPENCLAW_AUDIT.md F-173 |
| 175      | Approval rework decision for failed phase retry (approve / rework / reject, rework.feedback memory record) | M23 | completed | M23 Dashboard & Operator UX — board-flipped 2026-04-19 after code verification |
| 176      | Webhook-driven project ticket advancement on PR merge (GitHub webhook → advanceProjectTicket) | M23 | completed | M23 Dashboard & Operator UX |
