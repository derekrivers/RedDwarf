# RedDwarf Implementation Map

RedDwarf operationalizes the architecture document as a mountable Dev Squad definition repo.

## Major Decisions

- OpenClaw is the runtime host and is expected to run in Docker.
- This repo is mounted into OpenClaw as a mostly read-only policy pack during development, and promoted as a versioned immutable package from `artifacts/policy-packs/.../policy-root` for runtime releases.
- Postgres is the authoritative store for manifests, planning specs, policy snapshots, approval requests and decisions, evidence metadata, run events, derived run summaries, and partitioned memory records.
- Task workspaces and durable file evidence are isolated from the repo through separate writable volumes, and phase artifacts are archived out of temporary workspaces before teardown.
- V1 activates `intake -> eligibility -> planning -> policy_gate`, plus a human-gated `development` phase, a workspace-local `validation` phase, and an approval-gated `scm` phase for branch/PR creation, while product code-writing remains disabled by default and review stays blocked. Downstream phase failures now drive automated retry planning, pending human escalation requests, and optional follow-up GitHub issue creation instead of silently leaving tasks failed.
- Workspace materialization writes the `.context` bundle expected by the architecture doc: `task.json`, `spec.md`, `policy_snapshot.json`, `allowed_paths.json`, and `acceptance_criteria.json`, plus root-level runtime instruction files such as `SOUL.md`, `AGENTS.md`, `TOOLS.md`, and `skills/reddwarf-task/SKILL.md`. The workspace manager also provisions `.workspace/workspace.json`, isolated `scratch/`, and `artifacts/` directories and supports explicit teardown.
- Observability is first-class in the planning path: every run gets a durable `runId`, per-phase event stream, explicit failure classification, a queryable run summary, and approval-decision events for human-gated work.
- Concurrency is enforced with durable pipeline-run records, serialized overlap strategy, heartbeat-based stale-run retirement, and explicit blocking of fresh overlaps for the same task source.
- Memory is partitioned into task, project, organization, and external retrieval scopes so OpenClaw can materialize context without mixing ephemeral task state and broader organizational knowledge.
- The integration plane is modeled conservatively in v1: GitHub issue intake and CI status reads exist as deterministic adapters, approved SCM runs can create branches and pull requests through the GitHub adapter after validation, while labels, issue comments, workflow, and remote secret mutation calls remain hard-blocked. Approved development and validation tasks can also receive scoped workspace-local secret leases.
- Policy-pack packaging now produces a manifest-backed immutable runtime root with built packages, mounted assets, and a self-contained runtime dependency tree, so OpenClaw can run without a live source checkout.

## Package Map

- `packages/contracts`: canonical task, evidence, lifecycle, context, failure, run-summary, and partitioned-memory contracts
- `packages/policy`: deterministic guardrails and approval logic
- `packages/control-plane`: planning pipeline, developer-, validation-, and SCM-phase orchestration, automated failure recovery with retry/escalation/follow-up issue planning, durable evidence archival, scoped secret lease injection, state transitions, concurrency/stale-run enforcement, approval queue and decision workflow helpers, workspace context and runtime instruction materialization, managed workspace lifecycle helpers, structured observability logging, and policy-pack packaging helpers
- `packages/execution-plane`: agent identities and the remaining disabled review phase
- `packages/evidence`: persistence schema, policy snapshot storage, approval-request persistence/query helpers, partitioned memory storage/query helpers, pipeline-run persistence, archived artifact metadata storage, event modeling, and run-summary queries
- `packages/integrations`: GitHub, CI, and secrets adapter contracts, issue-intake conversion helpers, fixture-backed verification adapters, scoped lease redaction helpers, approval-gated branch/PR and follow-up issue fixtures, and remaining mutation guards
