# Agent Documentation

## 2026-03-26

- Completed feature 18 from `FEATURE_BOARD.md`: developer phase orchestration with code-write disabled by default.
- Enabled the `development` phase in policy/execution routing, added `runDeveloperPhase`, and introduced a deterministic developer handoff flow that provisions an isolated workspace, captures a `developer-handoff.md` artifact, and blocks cleanly pending the future validation phase.
- Expanded workspace tool policy contracts with explicit `codeWriteEnabled: false` and `development_readonly` mode so the runtime instructions and workspace descriptors both express that product code mutation is still disabled by default.
- Added `corepack pnpm verify:development` plus new unit and Postgres-backed coverage for developer-phase persistence, approval handoff, workspace policy metadata, and derived task memory.
- Environment note: `corepack pnpm test:postgres` can hit a sandbox `spawn EPERM` during Vitest startup and the test file is skipped unless `HOST_DATABASE_URL` or `DATABASE_URL` is set; prefer the documented workaround in `docs/agent/TROUBLESHOOTING.md`.
- Completed feature 19 from `FEATURE_BOARD.md`: validation phase runner for lint and test execution in workspaces.
- Added `runValidationPhase`, a deterministic validation agent, `validation_only` workspace tool policy metadata, workspace-local validation logs/report artifacts, and `validation.summary` task memory so approved tasks can advance from developer handoff into automated checks before blocking on review.
- Added `corepack pnpm verify:validation` plus unit and Postgres-backed coverage for validation success and failure paths, validation workspace descriptors, validation memory/evidence persistence, and review-pending run summaries.
- Environment note: `corepack pnpm verify:validation` can also hit a sandbox `spawn EPERM` because the validation runner launches workspace-local child processes; rerun it outside the sandbox and prefer the documented workaround in `docs/agent/TROUBLESHOOTING.md`.
- Updated repository docs and the feature board so features 18 and 19 are marked complete and feature 20 is now the likely next actionable item.
- Likely next board item: feature 20, secrets adapter and scoped credential injection rules.
- Completed feature 20 from `FEATURE_BOARD.md`: secrets adapter and scoped credential injection rules.
- Added scoped secret approvals to policy snapshots, runtime tool contracts, workspace descriptors, and approval summaries so approved development and validation runs can express least-privilege secret scopes without persisting secret values in evidence metadata.
- Added a fixture-backed secrets adapter, workspace-local `.workspace/credentials/secret-env.json` materialization, fail-closed lease issuance, and validation-log redaction so injected values stay out of durable logs while remaining available inside the managed workspace.
- Added unit coverage plus `corepack pnpm verify:secrets` to exercise scoped lease issuance, workspace credential policy metadata, fail-closed behavior when no adapter is configured, and end-to-end redaction during validation command execution.
- Environment note: `corepack pnpm verify:secrets` uses the validation runner and can hit the same Windows sandbox `spawn EPERM` behavior as `corepack pnpm verify:validation`; rerun it outside the sandbox and prefer the documented workaround in `docs/agent/TROUBLESHOOTING.md`.
- Updated repository docs and the feature board so feature 20 is marked complete and feature 21 is now the likely next actionable item.
- Likely next board item: feature 21, SCM adapter with branch and PR creation behind approval gates.
