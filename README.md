# RedDwarf

RedDwarf turns a GitHub issue into a reviewed, tested pull request using an AI dev squad running on [OpenClaw](https://github.com/openclaw). Every plan, policy decision, and artifact is persisted to Postgres. An operator dashboard keeps you in the loop: you approve plans before code is written, and you can inspect every run, every piece of evidence, and every agent session afterwards.

The design is deliberately conservative:

- **planning-first** — nothing ships without a plan
- **human-gated** — plans, risky actions, and SCM writes require operator approval
- **durable and auditable** — nothing important lives only in agent memory
- OpenClaw is the runtime substrate, intentionally swappable

![Operator dashboard home](docs/images/dashboard-home.png)

## Who this is for

Engineers who want supervised AI development on their own repos, running on their own infrastructure — laptop, workstation, or a single Linux VPS. This is self-hosted, not a service.

## How a task flows

```
GitHub issue (ai-eligible)  ─┐
reddwarf submit CLI         ─┼─►  Intake → Plan → Approve → Develop → Review → Validate → SCM → PR
Dashboard "Submit Issue"    ─┘                                                                │
                                                                                              ▼
                                                                         Evidence + run history in Postgres
```

An LLM architect persona (Holly) plans the work. Small issues produce a single plan; medium or large ones produce a project with ordered tickets. Development, architecture review, and validation run as OpenClaw agent sessions in isolated workspaces. SCM publishes a real branch and opens a pull request on the target repo.

For the architecture in detail, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Prerequisites

- Docker Desktop (or Docker Engine + Compose plugin)
- Node.js ≥ 22 with `corepack enable`
- Git
- A GitHub personal access token with `repo` scope
- An LLM API key — Anthropic **or** OpenAI

## Quick start

```bash
git clone <repo-url>
cd RedDwarf
corepack enable
corepack pnpm install
cp .env.example .env
```

Edit `.env` and set these five required values:

| Variable | Purpose |
|---|---|
| `GITHUB_TOKEN` | Issue intake, branch publishing, PR creation |
| `ANTHROPIC_API_KEY` **or** `OPENAI_API_KEY` | Planning + agent model access, matching `REDDWARF_MODEL_PROVIDER` (default `anthropic`) |
| `OPENCLAW_HOOK_TOKEN` | Authenticates RedDwarf → OpenClaw dispatch |
| `OPENCLAW_GATEWAY_TOKEN` | Authenticates the OpenClaw Control UI |
| `REDDWARF_OPERATOR_TOKEN` | Bearer token for the operator API and dashboard |

Generate random tokens with `openssl rand -hex 32`. Every other variable in [`.env.example`](.env.example) is documented inline and grouped into boot-time, runtime-configurable, secrets, and dev/E2E classes.

Then boot the full stack:

```bash
corepack pnpm start
```

This starts Postgres, OpenClaw, the operator API on `:8080`, the dashboard on `:5173`, and the polling daemon. It is idempotent — safe to re-run if the stack is already up. `Ctrl+C` shuts everything down.

## Your first approved plan

1. Open the dashboard at [http://127.0.0.1:5173](http://127.0.0.1:5173) and paste your `REDDWARF_OPERATOR_TOKEN` into the login field. The token lives only in the current tab's `sessionStorage`.

2. Under **Repositories**, add a repo you control (`owner/repo` format). The polling daemon will start watching it.

3. Open a GitHub issue on that repo using the `ai-eligible` template at [.github/ISSUE_TEMPLATE/ai-task.yml](.github/ISSUE_TEMPLATE/ai-task.yml) — or use the dashboard's **Submit Issue** page to create one without leaving the UI.

   ![Submit Issue page](docs/images/dashboard-submit-issue.png)

4. Within one polling cycle (default 30s), a plan appears under **Approvals**. Review it and approve.

   ![Approval detail view](docs/images/dashboard-approval-detail.png)

5. The task flows through development, architecture review, validation, and SCM. When SCM finishes, a real pull request is opened on the target repo. Watch the run under **Pipeline**.

   ![Pipeline run detail](docs/images/dashboard-pipeline-run.png)

To prove the full loop end-to-end without clicking through the dashboard, run the E2E integration test: `E2E_TARGET_REPO=owner/repo corepack pnpm e2e`. See [docs/DEMO_RUNBOOK.md](docs/DEMO_RUNBOOK.md) for what it does and expected output.

## Stopping

```bash
corepack pnpm teardown
```

Sweeps in-flight runs, stops services, cleans old workspaces. The Postgres volume is preserved by default; add `-- --destroy-volumes` to wipe it.

## Where to go next

Narrative:

- **Fuller walkthrough** — [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)
- **E2E integration test** — [docs/DEMO_RUNBOOK.md](docs/DEMO_RUNBOOK.md)
- **Architecture** — [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **VPS deployment** — [docs/VPS_DEPLOYMENT.md](docs/VPS_DEPLOYMENT.md) · day-2 ops: [docs/VPS_OPERATIONS.md](docs/VPS_OPERATIONS.md)
- **GitHub webhooks** (optional; replaces polling) — [docs/WEBHOOK_SETUP.md](docs/WEBHOOK_SETUP.md)

Reference:

- **API routes** — [docs/reference/OPERATOR_API.md](docs/reference/OPERATOR_API.md)
- **Configuration** — [docs/reference/CONFIG.md](docs/reference/CONFIG.md); or [.env.example](.env.example) for the inline-commented source
- **Commands** — [docs/reference/COMMANDS.md](docs/reference/COMMANDS.md)

Roadmap: [FEATURE_BOARD.md](FEATURE_BOARD.md).

## Project status

The full loop from GitHub issue to merged PR is proven end-to-end against real repos. V1 is conservative: everything risky is gated by explicit operator approval, and non-critical mutations (labels, comments, remote secret changes) are blocked behind `V1MutationDisabledError` guards. Extending autonomy is a policy decision, not a code change.
