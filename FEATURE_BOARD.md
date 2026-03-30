# RedDwarf Feature Board

The board is ordered by implementation priority.

This active board only lists pending work. Completed items are archived in [features_archive/COMPLETED_FEATURES.md](/c:/Dev/RedDwarf/features_archive/COMPLETED_FEATURES.md).

Priority reset note: after the March 29, 2026 hardening audit, pending feature work is intentionally ordered by production blast radius rather than feature-number chronology. Concurrency correctness, transactional durability, policy enforcement, credential safety, and operator-surface hardening now take precedence over new provider and intake features. Read [docs/pipeline-hardening-audit-2026-03-29.md](/c:/Dev/RedDwarf/docs/pipeline-hardening-audit-2026-03-29.md) before picking up features 90-99.


| Priority | Feature                                                                        | Milestone | Status    | Architecture Trace                                                     |
| -------- | ------------------------------------------------------------------------------ | --------- | --------- | ---------------------------------------------------------------------- |
| 104      | Reconcile orphaned dispatcher state after approval resets - add a maintenance path that detects blocked retry tasks and ready manifests whose approval rows were deleted, then marks or repairs them so the dispatcher cannot loop on missing approvals | M16 | pending | Control Plane, Failure Recovery Model, Operator Surface            |
| 86       | OpenAI provider support - extend openClawModelBindingSchema provider to enum, update openclaw.json generation, add gpt model mapping alongside Anthropic equivalents | M14 | pending | Contracts, Integration Plane, Knowledge & Policy Plane                |
| 87       | GitHub user allowlist for issue intake - reject issues from non-whitelisted authors before processing, configurable via env or policy config, default-deny posture | M15 | pending | Integration Plane, Isolation and Security Model, Control Plane        |
