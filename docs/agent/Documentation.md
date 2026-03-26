# Agent Documentation

## 2026-03-26

- Completed feature 18 from `FEATURE_BOARD.md`: developer phase orchestration with code-write disabled by default.
- Enabled the `development` phase in policy/execution routing, added `runDeveloperPhase`, and introduced a deterministic developer handoff flow that provisions an isolated workspace, captures a `developer-handoff.md` artifact, and blocks cleanly pending the future validation phase.
- Expanded workspace tool policy contracts with explicit `codeWriteEnabled: false` and `development_readonly` mode so the runtime instructions and workspace descriptors both express that product code mutation is still disabled by default.
- Added `corepack pnpm verify:development` plus new unit and Postgres-backed coverage for developer-phase persistence, approval handoff, workspace policy metadata, and derived task memory.
- Environment note: `corepack pnpm test:postgres` can hit a sandbox `spawn EPERM` during Vitest startup and the test file is skipped unless `HOST_DATABASE_URL` or `DATABASE_URL` is set; prefer the documented workaround in `docs/agent/TROUBLESHOOTING.md`.
- Likely next board item: feature 19, validation phase runner for lint and test execution in workspaces.
