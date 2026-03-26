# Troubleshooting

## `apply_patch` fails in the Windows sandbox

- Symptom: `functions.apply_patch` returns `windows sandbox: setup refresh failed with status exit code: 1`.
- Root cause: the local Windows sandbox intermittently fails while refreshing the patch-edit environment, so the patch helper never starts.
- Failing approach: direct `apply_patch` edits for repository files.
- Working workaround: use narrow PowerShell or inline Python file edits, then immediately rerun `corepack pnpm typecheck` and the affected test/verify commands.
- Verification: `corepack pnpm typecheck`, `corepack pnpm test`, and any feature-specific Postgres verification still pass after the scripted edit.

## `corepack pnpm test:postgres` fails or skips in the sandbox

- Symptom: `corepack pnpm test:postgres` fails with `spawn EPERM` while loading `vitest.config.ts`, or the file runs but all Postgres tests are skipped.
- Root cause: in this Windows sandbox, Vitest/Vite may not be allowed to spawn the esbuild helper process, and the test file only enables the Postgres suite when `HOST_DATABASE_URL` or `DATABASE_URL` is present.
- Failing approach: rerunning `corepack pnpm test:postgres` inside the default sandbox without the DB env vars.
- Working workaround: rerun `corepack pnpm test:postgres` with escalated permissions when the spawn error appears, and use `corepack pnpm verify:postgres`, `corepack pnpm verify:approvals`, and `corepack pnpm verify:development` for live database verification when the env-gated Vitest file is skipped.
- Verification: `corepack pnpm typecheck`, `corepack pnpm test`, `corepack pnpm verify:postgres`, `corepack pnpm verify:approvals`, `corepack pnpm verify:workspace-manager`, and `corepack pnpm verify:development`.
