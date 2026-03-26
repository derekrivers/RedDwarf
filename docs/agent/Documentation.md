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
