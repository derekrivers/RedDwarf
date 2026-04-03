# RedDwarf End-to-End Runbook

This runbook covers how to set up, run, and verify the RedDwarf autonomous pipeline — from a fresh clone through to a real GitHub pull request.

> **Prerequisites:** Docker Desktop (or Docker Engine + Compose), Node.js ≥ 22, Corepack, Git, a GitHub Personal Access Token, and an Anthropic API key.

---

## What Are We Proving?

The full autonomous loop:

1. A GitHub issue is filed with the `ai-eligible` label
2. RedDwarf plans the work using an LLM (or Holly via OpenClaw)
3. The plan is approved (auto-approved in E2E mode)
4. The developer phase dispatches to Dave Lister via OpenClaw (or falls back to a deterministic agent)
5. Validation runs against the workspace
6. The SCM phase publishes a branch and opens a real pull request
7. Evidence is captured and archived to Postgres throughout

### Pipeline Overview

```
GitHub Issue (ai-eligible label)
    ↓
Intake → Eligibility → Planning (Anthropic LLM / Holly architect via OpenClaw)
    ↓
[Approval Queue — human review via operator API on :8080, auto-approved in E2E]
    ↓
Developer Phase → OpenClaw dispatch to Lister (workspace_write sandbox)
    │                 OR deterministic fallback (if OpenClaw unavailable)
    ↓
Validation Phase → workspace-local lint/test
    ↓
SCM Phase → commit publication → branch + pull request
    ↓
Evidence archived to Postgres
```

---

## Part 1 — Stack Setup

### 1.1 Clone and bootstrap

```bash
git clone <reddwarf-repo-url>
cd RedDwarf
corepack enable
corepack pnpm install
cp .env.example .env
```

Edit `.env` and set your real credentials:

```
GITHUB_TOKEN=ghp_your_real_token
ANTHROPIC_API_KEY=sk-ant-your_real_key
OPENCLAW_HOOK_TOKEN=<long-random-token>
OPENCLAW_GATEWAY_TOKEN=<long-random-token>
```

The `.env` file is the bootstrap source of truth, and RedDwarf also maintains an optional repo-root `.secrets` file for rotated credentials. Both the Node.js app and Docker Compose read the pair (`env_file: ../../.env` and `env_file: ../../.secrets`), and the standard startup flows create an empty `.secrets` file automatically.

### 1.2 Boot the full stack (one command)

```bash
corepack pnpm start
```

This boots everything in a single process: Docker Compose (Postgres + OpenClaw), migrations, stale-run sweep, workspace cleanup, operator API, and the polling daemon. See the README for configuration options (`REDDWARF_POLL_INTERVAL_MS`, `REDDWARF_API_PORT`, etc.).

To seed an initial polled repository list at startup:

```bash
REDDWARF_POLL_REPOS=owner/repo corepack pnpm start
```

### 1.2b Alternative: start services separately

If you prefer separate terminals for each service:

```bash
corepack pnpm run setup                     # infrastructure only
corepack pnpm compose:up:openclaw           # OpenClaw (if not using pnpm start)
corepack pnpm operator:api                  # operator API in a separate terminal
```

### 1.3 Start OpenClaw (if running services separately)

```bash
corepack pnpm compose:up:openclaw
```

This starts the OpenClaw gateway alongside Postgres. The compose stack:
- Reads tokens from `.env` and `.secrets` via `env_file: ../../.env` and `env_file: ../../.secrets`
- Generates the live runtime config at `runtime-data/openclaw-home/openclaw.json` from RedDwarf's typed OpenClaw config surface, using [infra/docker/openclaw.json](../infra/docker/openclaw.json) as the checked-in template baseline
- Binds the gateway to LAN (`gateway.bind: "lan"`) so the host can reach port 3578
- Mounts the policy-pack root read-only at `/opt/reddwarf`

Verify OpenClaw is healthy:

```bash
docker compose -f infra/docker/docker-compose.yml ps openclaw
curl http://127.0.0.1:3578/health
```

Verify the agent roster is loaded:

```bash
docker compose -f infra/docker/docker-compose.yml exec openclaw sh -lc "node openclaw.mjs agents list"
```

You should see five agents: `reddwarf-coordinator` (Rimmer), `reddwarf-analyst` (Holly), `reddwarf-arch-reviewer` (Kryten), `reddwarf-developer` (Lister), and `reddwarf-validator` (Kryten).

Browse the OpenClaw Control UI at `http://127.0.0.1:3578/` — authenticate with your `OPENCLAW_GATEWAY_TOKEN`.

> **If OpenClaw is not running**, the pipeline still works — the developer phase falls back to a deterministic agent stub. But the live OpenClaw dispatch is the real proof.

### 1.4 Build all packages

```bash
corepack pnpm build
```

---

## Part 2 — Agent Roster

RedDwarf's OpenClaw dev team currently uses five agent personas:

| Agent | Character | Role | ID | Tool Policy | Model | Sandbox |
|-------|-----------|------|----|-------------|-------|---------|
| **Holly** | Ship's Computer | Architect / Analyst | `reddwarf-analyst` | `full` + allow/deny groups | claude-opus-4-6 | `off` in current Docker topology |
| **Rimmer** | Session Coordinator | Coordinator | `reddwarf-coordinator` | `full` + allow/deny groups | claude-sonnet-4-6 | `off` in current Docker topology |
| **Kryten** | Mechanoid | Architecture Reviewer | `reddwarf-arch-reviewer` | `full` + allow/deny groups | claude-sonnet-4-6 | `off` in current Docker topology |
| **Kryten** | Mechanoid | Validator | `reddwarf-validator` | `full` + allow/deny groups | claude-sonnet-4-6 | `off` in current Docker topology |
| **Lister** | Last Human Alive | Developer | `reddwarf-developer` | `full` + allow/deny groups | claude-sonnet-4-6 | `off` in current Docker topology |

Agent bootstrap files are in `agents/openclaw/{holly,rimmer,lister,kryten}/` and are mounted per generated role definition:
- `IDENTITY.md` — Agent name, role, and title
- `SOUL.md` — Personality and operating principles
- `AGENTS.md` — Runtime roster and delegation rules
- `TOOLS.md` — Tool profile, allow/deny lists, sandbox mode, model binding
- `SKILL.md` files — Task-specific skills

The checked-in Docker template lives at [infra/docker/openclaw.json](../infra/docker/openclaw.json), but the standard `setup` and `start` flows now generate the live host-mounted runtime config at `runtime-data/openclaw-home/openclaw.json` from RedDwarf's typed policy/config surface. You can also generate the current config on demand:

```bash
corepack pnpm generate:openclaw-config
```

The generated config also loads the repo-mounted `reddwarf-operator` OpenClaw plugin and points it at `REDDWARF_OPENCLAW_OPERATOR_API_URL` so WebChat can talk back to the host-side operator API from inside the container.
It also registers a read-only `mcp.servers.reddwarf` entry that starts `scripts/start-operator-mcp.mjs` inside the gateway container for task-history and evidence lookups.

To enable the native Discord operator surface in the generated config, set:

```bash
export REDDWARF_OPENCLAW_DISCORD_ENABLED=true
export OPENCLAW_DISCORD_BOT_TOKEN=<discord-bot-token>
export REDDWARF_OPENCLAW_DISCORD_GUILD_IDS=<guild-id>
corepack pnpm generate:openclaw-config
```

To also surface native Discord status updates and approval prompts:

```bash
export REDDWARF_OPENCLAW_DISCORD_NOTIFICATIONS_ENABLED=true
export REDDWARF_OPENCLAW_DISCORD_EXEC_APPROVALS_ENABLED=true
export REDDWARF_OPENCLAW_DISCORD_APPROVER_IDS=<discord-user-id>
corepack pnpm generate:openclaw-config
```

Feature 101 enables the built-in OpenClaw browser for Holly by default. If you need to toggle it explicitly:

```bash
export REDDWARF_OPENCLAW_BROWSER_ENABLED=true
corepack pnpm generate:openclaw-config
```

---

## Part 3 — E2E Integration Test (Recommended)

The fastest way to prove the full pipeline is the automated E2E integration test. It creates a real GitHub issue, runs every phase, opens a real PR, and reports the results — all in one command.

### 3.1 What the E2E test does

1. **Preflight** — verifies Postgres is reachable (runs `setup` if not), optionally verifies OpenClaw gateway and hook ingress
2. **Creates a GitHub issue** — files a new issue with the `ai-eligible` label on the target repo
3. **Runs intake + planning** — calls the Anthropic LLM (or Holly via OpenClaw) to produce a structured plan
4. **Auto-approves the plan** — no manual operator API interaction needed
5. **Runs the developer phase** — dispatches to Lister via OpenClaw (or deterministic fallback)
6. **Runs validation** — workspace-local checks
7. **Runs SCM** — publishes workspace commits, creates a real branch and pull request
8. **Reports results** — prints a full summary including task ID, PR URL, evidence counts, and pass/fail

### 3.2 Required environment

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | Yes | GitHub PAT with `repo` scope (contents + pull requests + issues) |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for LLM planning |
| `E2E_TARGET_REPO` | Yes | Target repo in `owner/repo` format (e.g. `derekrivers/FirstVoyage`) |

### 3.3 Optional environment

| Variable | Default | Description |
|----------|---------|-------------|
| `E2E_CLEANUP=true` | `false` | Close the created issue, PR, and branch after the test |
| `E2E_USE_OPENCLAW=true` | `false` | Dispatch developer phase to OpenClaw instead of deterministic fallback |
| `OPENCLAW_BASE_URL` | — | Required when `E2E_USE_OPENCLAW=true` (e.g. `http://127.0.0.1:3578`) |
| `REDDWARF_OPENCLAW_OPERATOR_API_URL` | `http://host.docker.internal:8080` | Container-reachable Operator API URL for the OpenClaw operator-command plugin |
| `OPENCLAW_HOOK_TOKEN` | — | Required when `E2E_USE_OPENCLAW=true` |
| `HOST_DATABASE_URL` | `postgresql://reddwarf:reddwarf@127.0.0.1:55532/reddwarf` | Postgres connection string |

### 3.4 Running the E2E test

**Deterministic mode** (no OpenClaw, fast, no agent tokens consumed):

```bash
E2E_TARGET_REPO=owner/repo corepack pnpm e2e
```

**With OpenClaw dispatch** (live agent sessions via Holly + Lister):

```bash
E2E_TARGET_REPO=owner/repo E2E_USE_OPENCLAW=true corepack pnpm e2e
```

**With auto-cleanup** (closes issue, PR, and branch after the test):

```bash
E2E_TARGET_REPO=owner/repo E2E_CLEANUP=true corepack pnpm e2e
```

### 3.5 Expected output

```
[e2e] Preflight complete: local Postgres is already reachable.
[e2e] Step 1/5: Creating GitHub issue...
[e2e]   Created issue #14: https://github.com/owner/repo/issues/14 (1.2s)
[e2e] Step 2/5: Running intake and planning pipeline...
[e2e]   Planning complete (8.3s)
[e2e]   Task ID: owner-repo-14
[e2e] Step 3/5: Auto-approving plan...
[e2e] Step 4/5: Dispatching approved task...
[e2e]   Dispatch complete (45.2s)
[e2e]   Outcome: completed
[e2e]   Final phase: scm
[e2e]   Phases executed: development -> validation -> scm
[e2e] Step 5/5: Inspecting pipeline results...
[e2e]
[e2e] ================================================================
[e2e]   E2E INTEGRATION TEST RESULTS
[e2e] ================================================================
[e2e]
[e2e]   Result:     PASS
[e2e]   Duration:   55.1s
[e2e]   Dispatch:   completed (final phase: scm)
[e2e]   Executed:   development -> validation -> scm
[e2e]   PR:         #15
[e2e]   Branch:     reddwarf/owner-repo-14/scm
[e2e]
[e2e] E2E integration test passed.
```

### 3.6 What it creates on GitHub

- A new issue titled `[E2E Test] RedDwarf pipeline validation <timestamp>` with the `ai-eligible` label
- A branch named `reddwarf/<task-id>/scm` when the task reaches SCM
- A pull request from that branch to the repo's default branch

If `E2E_CLEANUP=true`, all three are closed/deleted after the test completes (even on failure).

### 3.7 Manual cleanup

If you ran without `E2E_CLEANUP=true` and want to clean up afterwards:

```bash
E2E_TARGET_REPO=owner/repo corepack pnpm e2e:cleanup -- --issue 14 --pr 15 --branch reddwarf/owner-repo-14/scm
```

Pass any combination of `--issue`, `--pr`, and `--branch`. The cleanup script closes PRs before deleting branches, and closes issues last.

### 3.8 Important notes

- The E2E test is **not** part of `pnpm test` — it will never run during CI or local unit testing
- Each run creates real GitHub resources and consumes Anthropic API tokens
- The test creates a temporary workspace under `runtime-data/workspaces/e2e-<timestamp>/` and cleans it up in the `finally` block
- Evidence is written to a temporary directory alongside the workspace and also cleaned up
- The Postgres database retains all evidence, phase records, and run events after the test — use the operator API to inspect them

---

## Part 4 — Manual Phase-by-Phase Walkthrough

If you prefer to run each phase individually (for debugging or demonstration), follow these steps.

### 4.1 Start the Operator API

The operator API is needed for approvals and monitoring. Start it in a separate terminal:

```bash
corepack pnpm operator:api
```

This starts the RedDwarf operator HTTP API on `http://127.0.0.1:8080`. The server verifies Postgres connectivity before accepting requests. Set `REDDWARF_OPERATOR_TOKEN` first; every route except `/health` requires `Authorization: Bearer <REDDWARF_OPERATOR_TOKEN>`.

For secret rotation, use the write-only endpoint:

```bash
curl -X POST http://127.0.0.1:8080/secrets/GITHUB_TOKEN/rotate \
  -H "Authorization: Bearer ${REDDWARF_OPERATOR_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"value":"ghp_new_token"}'
```

The response confirms the key and whether a restart is required, but it never returns the secret value. Rotated OpenClaw-facing secrets still require a service restart before the running container sees the new token.

For the main browser workflow, start the dashboard SPA in another terminal:

```bash
corepack pnpm --filter @reddwarf/dashboard dev
```

Then open `http://localhost:5173`. The dashboard stores `REDDWARF_OPERATOR_TOKEN` only in the current tab's `sessionStorage` and proxies API requests back to `http://127.0.0.1:8080`.

The older single-file panel still exists at `http://127.0.0.1:8080/ui` for configuration-heavy tasks such as repo management, runtime config edits, and secret rotation.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Server health check (includes repository, polling runtime, cursor, and dispatcher state) |
| GET | `/ui` | Single-file operator configuration panel shell |
| GET | `/ui/bootstrap` | Protected UI bootstrap metadata for paths, masked secret state, version, uptime, and OpenClaw reachability |
| GET | `/runs` | List pipeline runs (filter: `repo`, `taskId`, `status`/`statuses`, `limit`) |
| GET | `/runs/:id` | Return full detail for a specific pipeline run |
| GET | `/runs/:id/evidence` | Return run-scoped evidence records for a specific pipeline run |
| GET | `/config` | List runtime-configurable operator settings with current value, default, description, and source |
| GET | `/config/schema` | Return JSON-schema-style metadata for runtime-configurable operator settings |
| PUT | `/config` | Persist one or more runtime-configurable operator settings to `operator_config` |
| GET | `/repos` | List the DB-backed polled repo roster with cursor status |
| POST | `/repos` | Add a repo to the polled repo roster |
| DELETE | `/repos/:owner/:repo` | Remove a repo from the polled repo roster |
| GET | `/approvals` | List approval requests (filter: `taskId`, `runId`, `statuses`, `limit`) |
| POST | `/approvals/:id/resolve` | Resolve an approval request |
| GET | `/approvals/:id` | Get specific approval request |
| GET | `/tasks` | List task summaries (filter: `repo`, `status`/`statuses`, `phase`/`phases`, `limit`) |
| GET | `/tasks/:taskId` | Return task detail including history, approvals, and run summaries |
| GET | `/tasks/:taskId/evidence` | List evidence records for a task |
| GET | `/tasks/:taskId/snapshot` | Full task snapshot |
| GET | `/blocked` | Summary of blocked runs and pending approvals |

> **Note:** This is the RedDwarf operator API, not the OpenClaw Control UI. The operator API is on port 8080, the dashboard dev server is on 5173, and OpenClaw is on port 3578.

### 4.2 File a GitHub Issue

On a GitHub repository you control (e.g., `your-org/demo-repo`), file an issue:

```markdown
This issue is a RedDwarf AI Dev Squad demo.

Acceptance Criteria:
- The planning agent produces a structured plan
- The developer agent implements the change
- Evidence is archived durably in Postgres

Affected Paths:
- docs/demo.md

Requested Capabilities:
- can_plan
- can_write_code
- can_open_pr
- can_archive_evidence
```

Add the label **`ai-eligible`** to the issue. Note the issue number (e.g., `#1`).

### 4.3 Add Your Repo to the Polling Roster

If `corepack pnpm start` is already running, the polling daemon is already live. The only thing you need to do is tell RedDwarf which GitHub repo to watch.

The friendliest option is the dashboard or the legacy operator panel:

1. Start `corepack pnpm --filter @reddwarf/dashboard dev`
2. Open `http://localhost:5173`
3. Paste `REDDWARF_OPERATOR_TOKEN`
4. Review approvals, runs, evidence, and agent status there

For repo-management, runtime config edits, or secret rotation, use the legacy panel:

1. Open `http://127.0.0.1:8080/ui`
2. Paste `REDDWARF_OPERATOR_TOKEN`
3. Add `owner/repo` under the repo-management section

If you prefer the API directly:

**PowerShell:**
```powershell
Invoke-RestMethod `
  -Method POST `
  -Uri "http://localhost:8080/repos" `
  -Headers @{ Authorization = "Bearer $env:REDDWARF_OPERATOR_TOKEN" } `
  -ContentType "application/json" `
  -Body '{"repo":"your-org/demo-repo"}'
```

**Bash:**
```bash
curl -X POST "http://localhost:8080/repos" \
  -H "Authorization: Bearer ${REDDWARF_OPERATOR_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"repo":"your-org/demo-repo"}'
```

After that, the running polling daemon will:
1. Watch the repo for issues with the `ai-eligible` label
2. Deduplicate against persisted planning specs in Postgres
3. Run new issues through intake, eligibility, planning, and the policy gate
4. Persist polling cursors so restarts do not reprocess old issues
5. Back off automatically if GitHub is temporarily unreachable

You can confirm the roster with `GET /repos`, then watch `/tasks`, `/runs`, the dashboard, or the operator panel for the new issue to appear.

### 4.4 Approve the Plan

Check for pending approvals:

**PowerShell:**
```powershell
Invoke-RestMethod http://localhost:8080/health
Invoke-RestMethod http://localhost:8080/approvals -Headers @{ Authorization = "Bearer $env:REDDWARF_OPERATOR_TOKEN" }
```

**Bash:**
```bash
curl http://localhost:8080/health
curl http://localhost:8080/approvals \
  -H "Authorization: Bearer ${REDDWARF_OPERATOR_TOKEN}"
```

Approve the plan:

**PowerShell:**
```powershell
Invoke-RestMethod `
  -Method POST `
  -Uri "http://localhost:8080/approvals/<request-id>/resolve" `
  -Headers @{ Authorization = "Bearer $env:REDDWARF_OPERATOR_TOKEN" } `
  -ContentType "application/json" `
  -Body '{"decision":"approve","decidedBy":"your-name","decisionSummary":"Looks good"}'
```

**Bash:**
```bash
curl -X POST "http://localhost:8080/approvals/<request-id>/resolve" \
  -H "Authorization: Bearer ${REDDWARF_OPERATOR_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"decision":"approve","decidedBy":"your-name","decisionSummary":"Looks good"}'
```

> **Note:** The decision value is `"approve"` (not `"approved"`). The `decidedBy` and `decisionSummary` fields are required.

### 4.5 Run Downstream Phases

After approval, the rest of the pipeline continues automatically as long as the full stack is running. Use the dashboard, the operator panel, `GET /tasks`, or `GET /runs` to watch the task move through development, validation, and SCM.

---

## Part 5 — Verify Results

After all phases, confirm the end-to-end state:

```bash
curl http://localhost:8080/tasks/<task-id>/snapshot
```

Or query Postgres directly:

```bash
docker exec -it reddwarf-postgres-1 psql -U reddwarf reddwarf
```

```sql
-- Full phase progression
SELECT phase, status, actor, summary
FROM phase_records
WHERE task_id = '<task-id>'
ORDER BY created_at;
```

Expected phase records:

```
 phase       | status | actor
-------------+--------+------------------
 intake      | passed | system
 eligibility | passed | system
 planning    | passed | anthropic-planner
 policy_gate | passed | system
 development | passed | reddwarf-developer
 validation  | passed | system
 scm         | passed | system
```

### Other useful queries

```sql
-- View the planning spec
SELECT task_id, summary, assumptions, affected_areas
FROM planning_specs ORDER BY created_at DESC LIMIT 1;

-- View run events (including OpenClaw dispatch)
SELECT run_id, phase, level, message
FROM run_events WHERE task_id = '<task-id>' ORDER BY created_at;

-- View evidence records
SELECT artifact_class, source_location, archived_location, metadata
FROM evidence_records WHERE task_id = '<task-id>' ORDER BY created_at;

-- View polling cursors
SELECT repo, last_seen_issue_number, last_poll_status, last_polled_at
FROM github_issue_polling_cursors;
```

You can also query without psql:

```bash
corepack pnpm query:evidence
```

---

## Part 6 — Teardown

Use the teardown script to safely shut down the stack:

```bash
# Safe default — sweep stale runs, stop services, clean old workspaces
corepack pnpm teardown

# Preview what would happen without taking action
corepack pnpm teardown -- --dry-run

# Also remove evidence directories older than 14 days
corepack pnpm teardown -- --clean-evidence 14

# Full reset — stop services AND destroy database volumes
corepack pnpm teardown -- --destroy-volumes
```

The teardown script:
1. Sweeps active pipeline runs to stale (prevents zombie state on next boot)
2. Stops Docker Compose services gracefully
3. Cleans up workspace directories older than 24 hours
4. Optionally cleans old evidence directories
5. Removes stale OpenClaw config artifacts (`.clobbered.*` files)

The database volume is **preserved by default** so you can restart without losing state. Only `--destroy-volumes` removes it.

---

## Quick Command Reference

| Command | Purpose |
|---------|---------|
| `corepack pnpm start` | **Boot the full stack** — infrastructure, housekeeping, operator API, and optional polling daemon |
| `corepack pnpm teardown` | **Safely shut down** — sweep stale runs, stop services, clean workspaces |
| `corepack pnpm run setup` | Infrastructure only — Postgres + migrations + health check + workspace cleanup |
| `corepack pnpm compose:up:openclaw` | Start OpenClaw alongside Postgres |
| `corepack pnpm compose:down` | Stop Docker stack (without housekeeping) |
| `corepack pnpm build` | TypeScript build |
| `corepack pnpm test` | Run unit tests (does **not** run E2E) |
| `corepack pnpm e2e` | Run full E2E integration test against a real GitHub repo |
| `corepack pnpm e2e:cleanup` | Clean up GitHub resources from a prior E2E run |
| `corepack pnpm operator:api` | Start operator API on :8080 (standalone) |
| `corepack pnpm --filter @reddwarf/dashboard dev` | Start the operator dashboard dev server on :5173 |
| `corepack pnpm query:evidence` | Query Postgres evidence |
| `corepack pnpm cleanup:evidence` | Remove old evidence (dry-run default) |
| `corepack pnpm generate:openclaw-config` | Regenerate the live OpenClaw config at `runtime-data/openclaw-home/openclaw.json` |
| `corepack pnpm typecheck` | TypeScript type check |
| `corepack pnpm verify:all` | Run all verification scripts |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `RestGitHubAdapter requires a token` | `GITHUB_TOKEN` not in `.env` | Set it in `.env` |
| `AnthropicPlanningAgent requires an API key` | `ANTHROPIC_API_KEY` not in `.env` | Set it in `.env` |
| `E2E_TARGET_REPO is required` | Missing env var | Set `E2E_TARGET_REPO=owner/repo` |
| GitHub API 404 | Repo not found or token lacks scope | Check repo name format (`owner/repo`) and token scopes |
| GitHub API 401 | Invalid token | Regenerate at github.com/settings/tokens |
| Postgres connection refused | Docker stack not running | `corepack pnpm run setup` |
| `spawn EPERM` in verify scripts | Windows sandbox restriction | Run outside the Claude Code sandbox |
| OpenClaw `curl` returns empty reply on 3578 | Gateway bound to container loopback | Ensure `openclaw.json` has `gateway.bind: "lan"`, check `runtime-data/openclaw-home/openclaw.json`, recreate the container |
| OpenClaw agents not showing in Control UI | Old agent config format | Ensure `openclaw.json` uses `agents.list[]` array format (not object keys), recreate container |
| WebChat RedDwarf commands fail with Operator API connection errors | Gateway container cannot reach the host API | Confirm `REDDWARF_OPENCLAW_OPERATOR_API_URL` points at the host-reachable operator API and Compose has the `host.docker.internal` host-gateway mapping |
| RedDwarf MCP bridge cannot reach the Operator API | MCP server inherits the wrong API base URL or token | Confirm `mcp.servers.reddwarf.env.REDDWARF_API_URL` points at `http://host.docker.internal:8080`, and `REDDWARF_OPERATOR_TOKEN` is present in the OpenClaw container |
| OpenClaw dispatch 401/403 | Invalid `OPENCLAW_HOOK_TOKEN` | Check `.env` token matches gateway config |
| OpenClaw dispatch 429/529 | Rate limited | Adapter retries automatically (3 attempts, 2s backoff) |
| Developer phase `task_blocked` | Approval not resolved | Check `/approvals` — resolve pending approval first |
| Approval decision rejected | Wrong enum value | Use `"approve"` not `"approved"` |
| Inline docker env overrides tokens to empty | `environment:` block overrides `env_file` | Remove explicit token entries from `environment:`, rely on `env_file: ../../.env` and `env_file: ../../.secrets` |
| E2E test fails but leaves GitHub resources | Ran without `E2E_CLEANUP=true` | Use `corepack pnpm e2e:cleanup -- --issue N --pr N --branch name` |

For more known issues, see [docs/agent/TROUBLESHOOTING.md](agent/TROUBLESHOOTING.md).
After startup, prefer managing the polled repo list through the operator API (`POST /repos`, `DELETE /repos/:owner/:repo`) instead of editing `REDDWARF_POLL_REPOS`.
