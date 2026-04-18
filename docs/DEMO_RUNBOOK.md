# RedDwarf E2E Integration Test

The fastest way to prove the full RedDwarf pipeline is the automated integration test. It creates a real GitHub issue, runs every phase (intake → planning → approval → development → validation → SCM), opens a real pull request, and reports the outcome — all in one command.

This is not a getting-started walkthrough. If you are setting up RedDwarf for the first time, start with [../README.md](../README.md#quick-start).

The E2E test is **not** part of `pnpm test`. It never runs in CI or local unit testing, and each run creates real GitHub resources and consumes real LLM tokens.

## What it does

1. **Preflight** — verifies Postgres is reachable, running `corepack pnpm run setup` if not. Optionally verifies the OpenClaw gateway and hook ingress when `E2E_USE_OPENCLAW=true`.
2. **Creates a GitHub issue** on `E2E_TARGET_REPO` with the `ai-eligible` label.
3. **Runs intake and planning** via the configured provider (`anthropic`, `openai`, or `openai-codex`), or Holly via OpenClaw.
4. **Auto-approves the plan** — no operator interaction.
5. **Runs the developer phase** — via OpenClaw when `E2E_USE_OPENCLAW=true`, otherwise via a deterministic agent fallback.
6. **Runs validation** — workspace-local lint and test.
7. **Runs SCM** — publishes the workspace commits, creates a branch, opens a pull request.
8. **Reports results** — task ID, outcome, phases executed, branch name, PR URL.

## Required environment

| Variable | Description |
|---|---|
| `GITHUB_TOKEN` | GitHub PAT with `repo` scope (contents + pull requests + issues). |
| `E2E_TARGET_REPO` | Target repo in `owner/repo` format. |
| `ANTHROPIC_API_KEY` **or** `OPENAI_API_KEY` | Provider key matching `REDDWARF_MODEL_PROVIDER` (default `anthropic`). |

## Optional environment

| Variable | Default | Description |
|---|---|---|
| `E2E_CLEANUP` | `false` | Close the created issue, PR, and branch when the test finishes (even on failure). |
| `E2E_USE_OPENCLAW` | `false` | Dispatch the developer phase through the live OpenClaw runtime. Requires `OPENCLAW_BASE_URL` and `OPENCLAW_HOOK_TOKEN`. |
| `REDDWARF_MODEL_PROVIDER` | `anthropic` | `anthropic`, `openai`, or `openai-codex`. |
| `HOST_DATABASE_URL` | `postgresql://reddwarf:reddwarf@127.0.0.1:55532/reddwarf` | Host-side Postgres connection string. |

## Running the test

Deterministic mode (fast, no OpenClaw, no agent tokens consumed):

```bash
E2E_TARGET_REPO=owner/repo corepack pnpm e2e
```

Live OpenClaw dispatch (Holly + Lister):

```bash
E2E_TARGET_REPO=owner/repo E2E_USE_OPENCLAW=true corepack pnpm e2e
```

With auto-cleanup:

```bash
E2E_TARGET_REPO=owner/repo E2E_CLEANUP=true corepack pnpm e2e
```

## Expected output

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

## What it creates on GitHub

- An issue titled `[E2E Test] RedDwarf pipeline validation <timestamp>` with the `ai-eligible` label.
- A branch named `reddwarf/<task-id>/scm` once SCM runs.
- A pull request from that branch to the default branch.

If `E2E_CLEANUP=true`, all three are closed or deleted when the run finishes.

## Manual cleanup

If you ran without `E2E_CLEANUP=true`:

```bash
E2E_TARGET_REPO=owner/repo corepack pnpm e2e:cleanup -- \
  --issue 14 --pr 15 --branch reddwarf/owner-repo-14/scm
```

Any combination of `--issue`, `--pr`, and `--branch` is accepted. The script closes the PR before deleting the branch and closes the issue last.

## Inspecting results after a run

Postgres retains evidence, phase records, and run events after the test.

- Dashboard — [http://127.0.0.1:5173](http://127.0.0.1:5173) → **Pipeline** → select the run.

  ![Pipeline run detail after an E2E run](images/dashboard-pipeline-run.png)

- CLI — `corepack pnpm query:evidence`.

- Direct SQL — open a psql shell against the compose-managed Postgres:

  ```bash
  docker compose -f infra/docker/docker-compose.yml exec postgres psql -U reddwarf reddwarf
  ```

  Useful queries:

  ```sql
  SELECT phase, status, actor, summary
  FROM phase_records
  WHERE task_id = '<task-id>'
  ORDER BY created_at;

  SELECT run_id, phase, level, message
  FROM run_events
  WHERE task_id = '<task-id>'
  ORDER BY created_at;

  SELECT artifact_class, source_location, archived_location, metadata
  FROM evidence_records
  WHERE task_id = '<task-id>'
  ORDER BY created_at;
  ```

The temporary workspace under `runtime-data/workspaces/e2e-<timestamp>/` is deleted in the script's `finally` block whether or not the test passes.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `E2E_TARGET_REPO is required` | Missing env var | `export E2E_TARGET_REPO=owner/repo`. |
| GitHub API 404 | Repo not found or token lacks scope | Check `owner/repo` format and that the token has `repo` scope. |
| GitHub API 401 | Invalid token | Regenerate at github.com/settings/tokens. |
| `AnthropicPlanningAgent requires an API key` / `OpenAIPlanningAgent requires an API key` | Provider secret missing | Set the key matching `REDDWARF_MODEL_PROVIDER`. |
| Postgres connection refused | Docker stack not started | Run `corepack pnpm run setup` first. |
| OpenClaw dispatch 401/403 (`E2E_USE_OPENCLAW=true`) | `OPENCLAW_HOOK_TOKEN` mismatch | Confirm `.env` matches the running gateway. |
| OpenClaw dispatch 429/529 | Upstream rate-limit | Retried automatically (3 attempts, 2 s linear backoff). |
| Test fails and leaves GitHub resources | Ran without `E2E_CLEANUP=true` | Run `corepack pnpm e2e:cleanup` as above. |

For broader pitfalls and environment-specific notes, see [agent/TROUBLESHOOTING.md](agent/TROUBLESHOOTING.md).
