# RedDwarf Implementation Map

RedDwarf operationalizes the architecture document as a mountable Dev Squad definition repo.

## Major Decisions

- OpenClaw is the runtime host and is expected to run in Docker.
- This repo is mounted into OpenClaw as a mostly read-only policy pack during development, and promoted as a versioned immutable package from `artifacts/policy-packs/.../policy-root` for runtime releases.
- Postgres is the authoritative store for manifests, planning specs, policy snapshots, approval requests and decisions, evidence metadata, run events, derived run summaries, and partitioned memory records.
- Task workspaces and file evidence are isolated from the repo through separate writable volumes.
- V1 activates `intake -> eligibility -> planning -> policy_gate`, plus a human-gated `development` phase and a workspace-local `validation` phase, while product code-writing remains disabled by default and review/SCM stay blocked.
- Workspace materialization writes the `.context` bundle expected by the architecture doc: `task.json`, `spec.md`, `policy_snapshot.json`, `allowed_paths.json`, and `acceptance_criteria.json`, plus root-level runtime instruction files such as `SOUL.md`, `AGENTS.md`, `TOOLS.md`, and `skills/reddwarf-task/SKILL.md`. The workspace manager also provisions `.workspace/workspace.json`, isolated `scratch/`, and `artifacts/` directories and supports explicit teardown.
- Observability is first-class in the planning path: every run gets a durable `runId`, per-phase event stream, explicit failure classification, a queryable run summary, and approval-decision events for human-gated work.
- Concurrency is enforced with durable pipeline-run records, serialized overlap strategy, heartbeat-based stale-run retirement, and explicit blocking of fresh overlaps for the same task source.
- Memory is partitioned into task, project, organization, and external retrieval scopes so OpenClaw can materialize context without mixing ephemeral task state and broader organizational knowledge.
- The integration plane is modeled as read-only in v1: GitHub issue intake and CI status reads exist as deterministic adapters, while PR, branch, label, workflow, and remote secret mutation calls remain hard-blocked; approved development and validation tasks can now receive scoped workspace-local secret leases.
- Policy-pack packaging now produces a manifest-backed immutable runtime root with built packages, mounted assets, and a self-contained runtime dependency tree, so OpenClaw can run without a live source checkout.

## Package Map

- `packages/contracts`: canonical task, evidence, lifecycle, context, failure, run-summary, and partitioned-memory contracts
- `packages/policy`: deterministic guardrails and approval logic
- `packages/control-plane`: planning pipeline, developer- and validation-phase orchestration, scoped secret lease injection, state transitions, concurrency/stale-run enforcement, approval queue and decision workflow helpers, workspace context and runtime instruction materialization, managed workspace lifecycle helpers, structured observability logging, and policy-pack packaging helpers
- `packages/execution-plane`: agent identities and disabled future execution phases
- `packages/evidence`: persistence schema, policy snapshot storage, approval-request persistence/query helpers, partitioned memory storage/query helpers, pipeline-run persistence, event modeling, and run-summary queries
- `packages/integrations`: GitHub, CI, and secrets adapter contracts, issue-intake conversion helpers, fixture-backed verification adapters, scoped lease redaction helpers, and mutation guards
