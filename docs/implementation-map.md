# RedDwarf Implementation Map

RedDwarf operationalizes the architecture document as a mountable Dev Squad definition repo.

## Major Decisions

- OpenClaw is the runtime host and is expected to run in Docker.
- This repo is mounted into OpenClaw as a mostly read-only policy pack during development, and promoted as a versioned immutable package from `artifacts/policy-packs/.../policy-root` for runtime releases.
- Postgres is the authoritative store for manifests, planning specs, policy snapshots, evidence metadata, run events, derived run summaries, and partitioned memory records.
- Task workspaces and file evidence are isolated from the repo through separate writable volumes.
- V1 only activates `intake -> eligibility -> planning -> policy_gate -> archive`.
- Workspace materialization writes the `.context` bundle expected by the architecture doc: `task.json`, `spec.md`, `policy_snapshot.json`, `allowed_paths.json`, and `acceptance_criteria.json`.
- Observability is first-class in the planning path: every run gets a durable `runId`, per-phase event stream, explicit failure classification, and a queryable run summary.
- Concurrency is enforced with durable pipeline-run records, serialized overlap strategy, heartbeat-based stale-run retirement, and explicit blocking of fresh overlaps for the same task source.
- Memory is partitioned into task, project, organization, and external retrieval scopes so OpenClaw can materialize context without mixing ephemeral task state and broader organizational knowledge.
- The integration plane is modeled as read-only in v1: GitHub issue intake and CI status reads exist as deterministic adapters, while PR, branch, label, workflow, and secret mutation calls remain hard-blocked.
- Policy-pack packaging now produces a manifest-backed immutable runtime root with built packages, mounted assets, and a self-contained runtime dependency tree, so OpenClaw can run without a live source checkout.

## Package Map

- `packages/contracts`: canonical task, evidence, lifecycle, context, failure, run-summary, and partitioned-memory contracts
- `packages/policy`: deterministic guardrails and approval logic
- `packages/control-plane`: planning pipeline, state transitions, concurrency/stale-run enforcement, workspace context materialization, structured observability logging, and policy-pack packaging helpers
- `packages/execution-plane`: agent identities and disabled future execution phases
- `packages/evidence`: persistence schema, policy snapshot storage, partitioned memory storage/query helpers, pipeline-run persistence, event modeling, and run-summary queries
- `packages/integrations`: GitHub and CI adapter contracts, issue-intake conversion helpers, fixture-backed verification adapters, and mutation guards