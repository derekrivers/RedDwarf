# RedDwarf Feature Board

The board is ordered by implementation priority.

This active board only lists pending work. Completed items are archived in [features_archive/COMPLETED_FEATURES.md](/home/derek/code/RedDwarf/features_archive/COMPLETED_FEATURES.md).

---

## M23 — Dashboard & Operator UX

### Phase 1 — Discord Issue Submission

| # | Feature | Status | Depends On | Notes |
| - | ------- | ------ | ---------- | ----- |
| 174 | **Discord `/rdsubmit` command with modal form for issue creation** — Add a `/rdsubmit` slash command to the Discord operator plugin. The command first presents a `StringSelectMenu` populated from `GET /repos` for repo selection. On repo selection, open a Discord Modal form with fields: title (short text, required), summary (paragraph, required), acceptance criteria (paragraph, required, one per line). On modal submit, call the existing `POST /issues/submit` operator API endpoint with the collected fields and sensible defaults for capabilities and risk class. Reply with a confirmation embed containing the created issue number, link, and repo. Handle validation errors (missing fields, API failures) with user-friendly error messages. Requires `REDDWARF_OPENCLAW_DISCORD_ENABLED=true`. | pending | — | Uses existing `POST /issues/submit` and `GET /repos` operator API endpoints; no new backend work required. Discord Modals support up to 5 `TextInput` components but no native dropdowns, so the repo selector uses a `StringSelectMenu` message before opening the modal. |

### Phase 3 — CI-driven VPS deploys

| # | Feature | Status | Depends On | Notes |
| - | ------- | ------ | ---------- | ----- |
| 178 | **Manual-trigger GitHub Actions workflow for VPS deploys** — Add `.github/workflows/deploy-vps.yml` (a `workflow_dispatch`-only job) plus `scripts/vps-update.sh`, an idempotent driver that wraps the manual steps in [docs/VPS_OPERATIONS.md §3](docs/VPS_OPERATIONS.md). Workflow inputs: `ref` (branch, tag, or SHA). Required secrets: `VPS_SSH_HOST`, `VPS_SSH_USER`, `VPS_SSH_PRIVATE_KEY`. Optional repo variables: `VPS_SSH_PORT` (default 22), `VPS_REPO_PATH` (default `/root/RedDwarf`), `VPS_SERVICE_NAME` (default `reddwarf`). Must: (1) never auto-trigger on push — only manual dispatch; (2) concurrency-group the job so parallel deploys cannot race; (3) pin the host key via `ssh-keyscan` rather than disabling `StrictHostKeyChecking`; (4) remove the ephemeral private key from the runner on every exit path; (5) run the script non-interactively (`BatchMode=yes`) so a missing sudo password fails fast instead of hanging; (6) assert the systemd unit is `active` after restart and surface the last 50 journal lines on failure. The shell script is also safe to run by hand on the VPS for testing branches. | pending | — | Follows VPS_OPERATIONS §3 conventions: `/root/RedDwarf` checkout, `reddwarf` systemd unit, `corepack pnpm install && build`, dashboard filtered build, `chmod -R o+rX packages/dashboard/dist` for Caddy, `systemctl restart`. Auto-deploy on `push: master` is explicitly out of scope — promote only after the manual flow has proven reliable in real use. |

### Non-functional requirements (apply to all M23 features)

- All new Discord commands must respect the existing `REDDWARF_OPENCLAW_DISCORD_ENABLED` gate and approver ID allowlist.
- No new required env vars added without a corresponding entry in `.env.example` with a comment.
- TypeScript strict mode must pass across all modified packages after each feature merge.
- `verify:all` must pass after every feature.
