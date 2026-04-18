# Getting Started with RedDwarf

Goal: from a fresh clone to your first approved plan and merged PR, with enough detail to understand what each step does.

The [README](../README.md) has the five-minute version. If you just want to boot the stack and see the dashboard, start there. Come back here when you want to go deeper.

## 1. Prerequisites

- Docker Desktop, or Docker Engine + the Compose plugin.
- Node.js ≥ 22 (`node --version`) with Corepack enabled (`corepack enable`).
- Git.
- A GitHub personal access token with `repo` scope — used for issue intake, branch publishing, and PR creation.
- An LLM API key — Anthropic or OpenAI. Alternatively a ChatGPT Pro/Plus subscription (see §2 below).

You do not install pnpm directly. `corepack pnpm install` pulls the exact version pinned in `package.json#packageManager`.

## 2. Clone and configure

```bash
git clone <repo-url>
cd RedDwarf
corepack enable
corepack pnpm install
cp .env.example .env
```

Fill in these five values in `.env`. Every other variable has a sensible default documented inline in [.env.example](../.env.example).

| Variable | Purpose |
|---|---|
| `GITHUB_TOKEN` | GitHub PAT for issue intake, branch publishing, and PR creation |
| `ANTHROPIC_API_KEY` **or** `OPENAI_API_KEY` | Whichever matches `REDDWARF_MODEL_PROVIDER` (default `anthropic`) |
| `OPENCLAW_HOOK_TOKEN` | Long random string — authenticates RedDwarf → OpenClaw dispatch |
| `OPENCLAW_GATEWAY_TOKEN` | Long random string — authenticates the OpenClaw Control UI |
| `REDDWARF_OPERATOR_TOKEN` | Long random string — bearer token for the operator API and dashboard |

Generate random tokens with `openssl rand -hex 32`.

`.env` is the bootstrap source of truth. A companion `.secrets` file is created automatically the first time the stack starts, with restricted permissions, and is used for rotated credentials.

### Choosing a model provider

`REDDWARF_MODEL_PROVIDER` accepts three values:

- `anthropic` — direct Anthropic API. Requires `ANTHROPIC_API_KEY`.
- `openai` — direct OpenAI API. Requires `OPENAI_API_KEY`.
- `openai-codex` — ChatGPT Pro/Plus subscription via OpenAI Codex OAuth. No API key; OAuth profiles are materialized under `runtime-data/workspaces/.agents/<role>/agent/auth-profiles.json`. See [VPS_OPERATIONS.md §10](VPS_OPERATIONS.md#10-codex-oauth-re-sync) for the re-sync flow used when tokens get close to expiring.

Switching providers is a config change, not a code change: edit `.env`, restart the stack, and the generated OpenClaw agent roster rebinds to the new provider.

## 3. Start the stack

```bash
corepack pnpm start
```

This command:

1. Brings up Docker Compose (Postgres + OpenClaw).
2. Applies database migrations.
3. Sweeps stale pipeline runs from prior crashed processes.
4. Cleans up workspace directories older than 24 hours.
5. Starts the operator API (`:8080`), the dashboard (`:5173`), and the polling daemon.

It runs in the foreground and tails logs. `Ctrl+C` shuts everything down. The command is idempotent — safe to re-run.

### Verifying it came up

```bash
# Operator API — returns JSON with repository, polling, dispatcher, and DB state
curl http://127.0.0.1:8080/health

# OpenClaw gateway
curl http://127.0.0.1:3578/health
```

Open the dashboard at [http://127.0.0.1:5173](http://127.0.0.1:5173) and paste your `REDDWARF_OPERATOR_TOKEN` on the login screen. The token is stored only in the current tab's `sessionStorage`.

![Operator dashboard home](images/dashboard-home.png)

### Running services separately (optional)

Occasionally useful when you want each service's logs in a separate terminal:

```bash
corepack pnpm run setup               # infrastructure + migrations
corepack pnpm compose:up:openclaw     # OpenClaw gateway
corepack pnpm operator:api            # operator API + dashboard
```

For normal work, prefer `corepack pnpm start`.

## 4. Submit your first task

Three intake paths. Pick whichever is easiest.

### Path A — dashboard Submit Issue page

![Submit Issue page](images/dashboard-submit-issue.png)

Dashboard → **Submit Issue**. Pick a repo from the dropdown (or add one first), fill in title, summary, and acceptance criteria, submit. This calls `POST /issues/submit` behind the scenes: RedDwarf files a GitHub issue with the `ai-eligible` label and queues the task.

### Path B — GitHub issue directly

Open an issue on a repo you control using the template at [.github/ISSUE_TEMPLATE/ai-task.yml](../.github/ISSUE_TEMPLATE/ai-task.yml). The template applies the `ai-eligible` label automatically and captures summary, priority, acceptance criteria, affected areas, constraints, and risk class.

First, add the repo to the polling roster so RedDwarf watches it:

- Dashboard → **Repositories** → add `owner/repo`, **or**
- `curl -X POST http://127.0.0.1:8080/repos -H "Authorization: Bearer $REDDWARF_OPERATOR_TOKEN" -H "Content-Type: application/json" -d '{"repo":"owner/repo"}'`

Polling runs every 30 s by default (`REDDWARF_POLL_INTERVAL_MS`). Within one cycle, the new issue appears under **Pipeline** and a plan request appears under **Approvals**.

![An ai-eligible issue on GitHub](images/github-issue-ai-eligible.png)

### Path C — CLI

```bash
export REDDWARF_OPERATOR_TOKEN=<your-token>
corepack pnpm exec reddwarf submit \
  --repo owner/repo \
  --title "Tighten operator retries" \
  --summary "Surface poll failures faster in the operator dashboard." \
  --acceptance "Polling failures appear in /health within one cycle." \
  --path packages/control-plane/src/polling.ts
```

Run `corepack pnpm exec reddwarf --help` for the full flag list.

## 5. Approve the plan

Within a few seconds of submission, a plan appears under **Approvals**.

![Pending approval in the Approvals list](images/dashboard-approvals-list.png)

Click into the approval to see the full plan — summary, acceptance criteria, affected paths, risk class, and the raw model output — then Approve, Reject, or (on architecture-review escalations) Rework.

![Approval detail with plan summary](images/dashboard-approval-detail.png)

Small issues produce a single plan. Medium or large issues produce a **project** with ordered tickets; the project appears under **Projects**, and each ticket's plan approval flows one at a time in dependency order.

![A project with ticket children](images/dashboard-projects-list.png)

### Via API (reference)

```bash
curl -X POST http://127.0.0.1:8080/approvals/<request-id>/resolve \
  -H "Authorization: Bearer $REDDWARF_OPERATOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"decision":"approve","decidedBy":"you","decisionSummary":"LGTM"}'
```

The decision value is `"approve"` (not `"approved"`). `decidedBy` and `decisionSummary` are required.

## 6. Watch the run

After approval, the task flows through development → architecture review → validation → SCM automatically. Each phase streams into **Pipeline**.

![Pipeline run detail](images/dashboard-pipeline-run.png)

When SCM finishes, a real pull request opens on the target repo.

![A pull request opened by RedDwarf](images/github-pr-by-reddwarf.png)

For the architecture behind each phase, see [ARCHITECTURE.md](ARCHITECTURE.md).

## 7. Inspect evidence

Every phase archives artifacts (plans, diffs, validation logs, SCM reports) to the evidence root. Browse them from the dashboard under **Evidence**, filtered by run.

![Evidence browser for a completed run](images/dashboard-evidence-browser.png)

From the CLI:

```bash
corepack pnpm query:evidence                # browse via the script
corepack pnpm exec reddwarf report --last   # export the most recent run as markdown
```

The Postgres database is the system of record. Evidence metadata and run history survive workspace cleanup.

## 8. Stopping

```bash
corepack pnpm teardown
```

Sweeps in-flight runs, stops Docker services, cleans workspaces older than 24 hours, removes stale OpenClaw config backups. The Postgres volume is preserved by default.

Variants:

```bash
corepack pnpm teardown -- --dry-run            # preview only
corepack pnpm teardown -- --clean-evidence 14  # also prune evidence older than 14 days
corepack pnpm teardown -- --destroy-volumes    # full reset — deletes Postgres data
```

## Common setup problems

| Symptom | Cause | Fix |
|---|---|---|
| `RestGitHubAdapter requires a token` | `GITHUB_TOKEN` missing | Set it in `.env`. |
| `AnthropicPlanningAgent requires an API key` / `OpenAIPlanningAgent requires an API key` | Provider secret missing | Set the key matching `REDDWARF_MODEL_PROVIDER`. |
| Postgres connection refused | Docker stack not running | `corepack pnpm run setup`. |
| Port `:5173` / `:8080` / `:3578` / `:55532` already in use | Another process bound to it | Stop it, or override `REDDWARF_DASHBOARD_PORT` / `REDDWARF_API_PORT` / `OPENCLAW_HOST_PORT` / `POSTGRES_HOST_PORT`. |
| Dashboard login rejects the token | Token mismatch | Verify `REDDWARF_OPERATOR_TOKEN` in `.env` matches what you paste. |
| Dashboard stays on the login screen after paste | Operator API unreachable | `curl http://127.0.0.1:8080/health`. If it fails, check stack logs. |
| OpenClaw Control UI returns empty reply on `:3578` | Gateway bound to container loopback | Ensure `runtime-data/openclaw-home/openclaw.json` has `gateway.bind: "lan"` and recreate the container. |
| WebChat / Discord commands fail with Operator API connection errors | Container cannot reach the host API | On Linux (not Docker Desktop) set `REDDWARF_API_HOST=0.0.0.0` so `host.docker.internal` resolves to a reachable bind. |
| Polling cycle never picks up a new issue | Repo not on the roster | Add via dashboard → **Repositories** or `POST /repos`. |
| `spawn EPERM` in verify scripts | Sandbox restriction (Windows / Claude Code sandbox) | Run outside the sandbox. |

For deeper pitfalls and environment-specific notes, see [agent/TROUBLESHOOTING.md](agent/TROUBLESHOOTING.md).

## Where to go next

- Full E2E integration test — [DEMO_RUNBOOK.md](DEMO_RUNBOOK.md).
- Architecture — [ARCHITECTURE.md](ARCHITECTURE.md).
- Configuration reference — [.env.example](../.env.example) (every variable, grouped and commented).
- GitHub webhooks, replaces polling — [WEBHOOK_SETUP.md](WEBHOOK_SETUP.md).
- Running on a Linux VPS — [VPS_OPERATIONS.md](VPS_OPERATIONS.md).
