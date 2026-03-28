# RedDwarf End-to-End Runbook

This runbook walks through a complete demonstration of RedDwarf — from a fresh clone through the current read-only pipeline: automated issue polling, planning, OpenClaw analyst dispatch, validation, and review-pending handoff. Real SCM PR creation remains reserved for a future write-enabled developer workflow.

> **Prerequisites:** Docker Desktop (or Docker Engine + Compose), Node.js ≥ 22, Corepack, Git, a GitHub Personal Access Token, and an Anthropic API key.

---

## What Are We Proving?

The MVP goal is to demonstrate the full autonomous loop:

1. A GitHub issue is filed with the `ai-eligible` label
2. RedDwarf's polling daemon detects it and runs the planning pipeline
3. The plan is approved via the operator API
4. The developer phase dispatches to the OpenClaw dev team (Holly — read-only analyst)
5. Evidence is captured and archived to Postgres
6. Validation and SCM phases complete the pipeline

**Current constraints:**
- Code writing is **disabled** — Holly performs read-only analysis only
- Dave Lister (the writing developer agent, Feature 84) is not yet implemented
- The polling daemon automates intake-through-planning; downstream phases (developer, validation, SCM) are triggered manually
- Review phase is deferred to Phase 3

Once this loop is proven working, we can move forward to enabling code writes with Lister.

### Pipeline Overview

```
GitHub Issue (ai-eligible label)
    ↓
Polling Daemon (auto-detects new issues)
    ↓
Intake → Eligibility → Planning (Anthropic LLM) → Policy Gate
    ↓
[Approval Queue — human review via operator API on :8080]
    ↓
Developer Phase → OpenClaw dispatch to Holly (read-only analyst)
    │                 OR deterministic fallback (if OpenClaw unavailable)
    ↓
Validation Phase → workspace-local lint/test
    ↓
SCM Phase → branch + pull request (approval-gated)
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

The `.env` file is referenced by both the Node.js app and the Docker Compose stack (`env_file: ../../.env`). All tokens and secrets are loaded from this single file.

### 1.2 Start the stack (Postgres only)

```bash
corepack pnpm run setup
```

This runs: `build` → `compose:up` → wait for Postgres → `db:migrate` → health check.

Expected output:

```
[setup] Postgres is reachable.
[setup] Migrations applied.
[setup] Health check passed. Public tables: reddwarf_schema_migrations, ...
[setup] Setup complete.
```

### 1.3 Start OpenClaw (required for live agent dispatch)

```bash
corepack pnpm compose:up:openclaw
```

This starts the OpenClaw gateway alongside Postgres. The compose stack:
- Reads tokens from your `.env` file via `env_file: ../../.env`
- Seeds [infra/docker/openclaw.json](../infra/docker/openclaw.json) into writable state at `runtime-data/openclaw-home/openclaw.json`
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

You should see three agents: `reddwarf-coordinator` (Rimmer), `reddwarf-analyst` (Holly), `reddwarf-validator` (Kryten).

Browse the OpenClaw Control UI at `http://127.0.0.1:3578/` — authenticate with your `OPENCLAW_GATEWAY_TOKEN`.

> **If OpenClaw is not running**, the pipeline still works — the developer phase falls back to a deterministic agent stub. But proving the OpenClaw dispatch is the point of this MVP.

### 1.4 Build all packages

```bash
corepack pnpm build
```

---

## Part 2 — Agent Roster

RedDwarf's OpenClaw dev team uses three agent personas:

| Agent | Character | Role | ID | Tool Policy | Model | Sandbox |
|-------|-----------|------|----|-------------|-------|---------|
| **Holly** | Ship's Computer | Architect / Analyst | `reddwarf-analyst` | `coding` (read-only) | claude-opus-4-6 | ro |
| **Rimmer** | Session Coordinator | Coordinator | `reddwarf-coordinator` | `minimal` (read-only) | claude-sonnet-4-6 | ro |
| **Kryten** | Mechanoid | Validator / Reviewer | `reddwarf-validator` | `coding` (workspace-write) | claude-sonnet-4-6 | rw |

Agent bootstrap files are in `agents/openclaw/{holly,rimmer,kryten}/`:
- `IDENTITY.md` — Agent name, role, and title
- `SOUL.md` — Personality and operating principles
- `AGENTS.md` — Runtime roster and delegation rules
- `TOOLS.md` — Tool profile, allow/deny lists, sandbox mode, model binding
- `SKILL.md` files — Task-specific skills

The agent roster is defined in [infra/docker/openclaw.json](../infra/docker/openclaw.json) using the `agents.list[]` array format. RedDwarf can also generate this from policy config:

```bash
corepack pnpm generate:openclaw-config
```

---

## Part 3 — File a GitHub Issue

On a GitHub repository you control (e.g., `your-org/demo-repo`), file an issue:

```markdown
This issue is a RedDwarf AI Dev Squad demo.

Acceptance Criteria:
- The planning agent produces a structured plan
- The analyst agent completes a read-only analysis
- Evidence is archived durably in Postgres

Affected Paths:
- docs/demo.md

Requested Capabilities:
- can_plan
- can_archive_evidence
```

Add the label **`ai-eligible`** to the issue. Note the issue number (e.g., `#1`).

---

## Part 4 — Start the Operator API

The operator API is needed for approvals and monitoring. Start it in a separate terminal:

```bash
corepack pnpm operator:api
```

This starts the RedDwarf operator HTTP API on `http://127.0.0.1:8080`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Server health check (includes polling cursor state) |
| GET | `/runs` | List pipeline runs (filter: `taskId`, `statuses`, `limit`) |
| GET | `/approvals` | List approval requests (filter: `taskId`, `runId`, `statuses`, `limit`) |
| POST | `/approvals/:id/resolve` | Resolve an approval request |
| GET | `/approvals/:id` | Get specific approval request |
| GET | `/tasks/:taskId/evidence` | List evidence records for a task |
| GET | `/tasks/:taskId/snapshot` | Full task snapshot |
| GET | `/blocked` | Summary of blocked runs and pending approvals |

> **Note:** This is the RedDwarf operator API, not the OpenClaw Control UI. The operator API is on port 8080; OpenClaw is on port 3578.

---

## Part 5 — Run the Polling Daemon

The polling daemon watches GitHub for new `ai-eligible` issues and automatically runs them through the planning pipeline.

There is no committed start script for the daemon yet. Create a one-off launcher:

```js
// start-polling.mjs (not committed — one-off demo script)
import { createGitHubIssuePollingDaemon } from "./packages/control-plane/dist/index.js";
import { createPostgresPlanningRepository } from "./packages/evidence/dist/index.js";
import { createRestGitHubAdapter } from "./packages/integrations/dist/index.js";
import { createAnthropicPlanningAgent } from "./packages/execution-plane/dist/index.js";

const repo = "your-org/demo-repo"; // Replace with your repo (owner/repo format)

const repository = createPostgresPlanningRepository(
  process.env.HOST_DATABASE_URL ?? "postgresql://reddwarf:reddwarf@127.0.0.1:55532/reddwarf"
);
const github = createRestGitHubAdapter();
const planner = createAnthropicPlanningAgent();

const daemon = createGitHubIssuePollingDaemon(
  {
    intervalMs: 30_000, // poll every 30 seconds
    repositories: [{ repo, labels: ["ai-eligible"] }],
    runOnStart: true
  },
  { repository, github, planner }
);

console.log(`Polling ${repo} for ai-eligible issues every 30s...`);
console.log("Press Ctrl+C to stop.\n");

await daemon.start();

process.on("SIGINT", async () => {
  console.log("\nStopping polling daemon...");
  await daemon.stop();
  await repository.close();
  process.exit(0);
});
```

Run it:

```bash
node start-polling.mjs
```

The daemon will:
1. Poll your repo for issues with the `ai-eligible` label
2. Deduplicate against existing planning specs in Postgres
3. Run new issues through the full planning pipeline (intake → eligibility → planning → policy gate)
4. Persist polling cursors so restarts don't reprocess old issues

Watch the output — when it picks up your issue, you should see planning pipeline output including a Task ID and Approval Request ID.

### Alternative: Manual single-issue run

If you prefer to run a single issue without the daemon:

```js
// demo-run.mjs (not committed — one-off demo script)
import { runPlanningPipeline } from "./packages/control-plane/dist/index.js";
import { createPostgresPlanningRepository } from "./packages/evidence/dist/index.js";
import {
  intakeGitHubIssue,
  createRestGitHubAdapter
} from "./packages/integrations/dist/index.js";
import { createAnthropicPlanningAgent } from "./packages/execution-plane/dist/index.js";

const repo = "your-org/demo-repo";
const issueNumber = 1;

const github = createRestGitHubAdapter();
const planner = createAnthropicPlanningAgent();
const repository = createPostgresPlanningRepository(
  process.env.HOST_DATABASE_URL ?? "postgresql://reddwarf:reddwarf@127.0.0.1:55532/reddwarf"
);

try {
  console.log(`Intaking ${repo}#${issueNumber}...`);
  const intake = await intakeGitHubIssue({ github, repo, issueNumber });
  console.log("Issue title:", intake.candidate.title);

  console.log("\nRunning planning pipeline...");
  const result = await runPlanningPipeline(intake.planningInput, {
    repository,
    planner
  });

  console.log("\nTask ID:", result.manifest.taskId);
  console.log("Approval request ID:", result.approvalRequest?.requestId ?? "(none)");
} finally {
  await repository.close();
}
```

```bash
node demo-run.mjs
```

---

## Part 6 — Approve the Plan

Check for pending approvals:

**PowerShell:**
```powershell
Invoke-RestMethod http://localhost:8080/approvals
```

**Bash:**
```bash
curl http://localhost:8080/approvals
```

Approve the plan:

**PowerShell:**
```powershell
Invoke-RestMethod `
  -Method POST `
  -Uri "http://localhost:8080/approvals/<request-id>/resolve" `
  -ContentType "application/json" `
  -Body '{"decision":"approve","decidedBy":"your-name","decisionSummary":"Looks good","rationale":"Proceed to development"}'
```

**Bash:**
```bash
curl -X POST "http://localhost:8080/approvals/<request-id>/resolve" \
  -H "Content-Type: application/json" \
  -d '{"decision":"approve","decidedBy":"your-name","decisionSummary":"Looks good","rationale":"Proceed to development"}'
```

> **Note:** The decision value is `"approve"` (not `"approved"`). The `decidedBy` and `decisionSummary` fields are required.

---

## Part 7 — Run the Developer Phase

After approval, run the developer phase manually. This dispatches to Holly via OpenClaw (or falls back to the deterministic agent).

```js
// demo-developer.mjs (not committed — one-off demo script)
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import {
  runDeveloperPhase,
  DeterministicDeveloperAgent
} from "./packages/control-plane/dist/index.js";
import { PostgresPlanningRepository } from "./packages/evidence/dist/index.js";
import { createHttpOpenClawDispatchAdapter } from "./packages/integrations/dist/index.js";

const taskId = "<task-id-from-planning>";  // Replace with your task ID

const repository = new PostgresPlanningRepository({
  connectionString:
    process.env.HOST_DATABASE_URL ?? "postgresql://reddwarf:reddwarf@127.0.0.1:55532/reddwarf"
});

const targetRoot = resolve(
  process.env.REDDWARF_HOST_WORKSPACE_ROOT ??
    join(tmpdir(), "reddwarf-demo-workspace")
);
const evidenceRoot = resolve(
  process.env.REDDWARF_HOST_EVIDENCE_ROOT ??
    join(tmpdir(), "reddwarf-demo-evidence")
);

const useOpenClaw = !!process.env.OPENCLAW_HOOK_TOKEN;

const dependencies = {
  repository,
  developer: new DeterministicDeveloperAgent()
};

if (useOpenClaw) {
  dependencies.openClawDispatch = createHttpOpenClawDispatchAdapter();
  dependencies.openClawAgentId = "reddwarf-analyst"; // Holly
}

try {
  console.log("Running developer phase...");
  console.log("  Task ID:", taskId);
  console.log("  Mode:", useOpenClaw ? "OpenClaw dispatch (Holly)" : "Deterministic fallback");

  const result = await runDeveloperPhase(
    { taskId, targetRoot, evidenceRoot },
    dependencies
  );

  console.log("\nDeveloper phase result:");
  console.log("  Run ID:", result.runId);
  console.log("  Next action:", result.nextAction);
  console.log("  Code write enabled:", result.workspace?.descriptor?.toolPolicy?.codeWriteEnabled);

  if (result.openClawDispatchResult) {
    console.log("\nOpenClaw dispatch:");
    console.log("  Accepted:", result.openClawDispatchResult.accepted);
    console.log("  Session ID:", result.openClawDispatchResult.sessionId);
    console.log("  Agent:", result.openClawDispatchResult.agentId);
  }

  console.log("\nDeveloper phase complete. Proceed to validation.");
} finally {
  await repository.close();
}
```

```bash
node demo-developer.mjs
```

**With OpenClaw running**, you should see:
- Holly dispatched via `POST /hooks/agent` on the gateway
- Session transcript captured as evidence
- `codeWriteEnabled: false` — read-only analysis only

**Without OpenClaw**, you'll see the deterministic fallback produce a stub handoff. The pipeline continues identically.

---

## Part 8 — Run the Validation Phase

```js
// demo-validation.mjs (not committed — one-off demo script)
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  runValidationPhase,
  DeterministicValidationAgent
} from "./packages/control-plane/dist/index.js";
import { PostgresPlanningRepository } from "./packages/evidence/dist/index.js";

const taskId = "<task-id-from-planning>";

const repository = new PostgresPlanningRepository({
  connectionString:
    process.env.HOST_DATABASE_URL ?? "postgresql://reddwarf:reddwarf@127.0.0.1:55532/reddwarf"
});

const targetRoot = resolve(
  process.env.REDDWARF_HOST_WORKSPACE_ROOT ??
    join(tmpdir(), "reddwarf-demo-workspace")
);
const evidenceRoot = resolve(
  process.env.REDDWARF_HOST_EVIDENCE_ROOT ??
    join(tmpdir(), "reddwarf-demo-evidence")
);

try {
  console.log("Running validation phase...");
  const result = await runValidationPhase(
    { taskId, targetRoot, evidenceRoot },
    { repository, validator: new DeterministicValidationAgent() }
  );
  console.log("  Next action:", result.nextAction);
  console.log("Validation complete. Proceed to SCM.");
} finally {
  await repository.close();
}
```

```bash
node demo-validation.mjs
```

---

## Part 9 — Run the SCM Phase (Branch + PR)

```js
// demo-scm.mjs (not committed — one-off demo script)
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  runScmPhase,
  DeterministicScmAgent
} from "./packages/control-plane/dist/index.js";
import { PostgresPlanningRepository } from "./packages/evidence/dist/index.js";
import {
  createRestGitHubAdapter,
  FixtureGitHubAdapter
} from "./packages/integrations/dist/index.js";

const taskId = "<task-id-from-planning>";
const repo = "your-org/demo-repo";

const repository = new PostgresPlanningRepository({
  connectionString:
    process.env.HOST_DATABASE_URL ?? "postgresql://reddwarf:reddwarf@127.0.0.1:55532/reddwarf"
});

const targetRoot = resolve(
  process.env.REDDWARF_HOST_WORKSPACE_ROOT ??
    join(tmpdir(), "reddwarf-demo-workspace")
);

try {
  console.log("Running SCM phase...");
  const result = await runScmPhase(
    { taskId, targetRoot },
    {
      repository,
      scm: new DeterministicScmAgent(),

      // Option A: Live GitHub (creates a real branch + PR)
      // github: createRestGitHubAdapter(),

      // Option B: Fixture (dry-run — no real GitHub calls)
      github: new FixtureGitHubAdapter({
        candidates: [{
          repo, issueNumber: 1, title: "Demo", body: "Demo issue",
          labels: ["ai-eligible"], url: `https://github.com/${repo}/issues/1`, state: "open"
        }],
        mutations: { allowBranchCreation: true, allowPullRequestCreation: true, pullRequestNumberStart: 1 }
      })
    }
  );

  console.log("  Next action:", result.nextAction);
  if (result.pullRequest) {
    console.log("  PR URL:", result.pullRequest.url);
  }
  console.log("\nPipeline complete!");
} finally {
  await repository.close();
}
```

```bash
node demo-scm.mjs
```

To create a **real PR on GitHub**, swap `FixtureGitHubAdapter` for `createRestGitHubAdapter()` and ensure your `GITHUB_TOKEN` has `contents:write` and `pull_requests:write` scopes.

---

## Part 10 — Verify the Full Pipeline

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
 development | passed | reddwarf-analyst
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

## Part 11 — Clean Up

```bash
# Stop the Docker stack (Postgres + OpenClaw)
corepack pnpm compose:down

# (Optional) Clean up old evidence
node scripts/cleanup-evidence.mjs --max-age-days 0 --delete
```

---

## Quick Command Reference

| Command | Purpose |
|---------|---------|
| `corepack pnpm run setup` | Build + start Postgres + migrate + health check |
| `corepack pnpm compose:up:openclaw` | Start OpenClaw alongside Postgres |
| `corepack pnpm compose:down` | Stop Docker stack |
| `corepack pnpm build` | TypeScript build |
| `corepack pnpm operator:api` | Start operator API on :8080 |
| `corepack pnpm query:evidence` | Query Postgres evidence |
| `corepack pnpm cleanup:evidence` | Remove old evidence (dry-run default) |
| `corepack pnpm generate:openclaw-config` | Generate openclaw.json from policy |
| `corepack pnpm test` | Run unit tests |
| `corepack pnpm typecheck` | TypeScript type check |
| `corepack pnpm verify:all` | Run all 18 verification scripts |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `RestGitHubAdapter requires a token` | `GITHUB_TOKEN` not in `.env` | Set it in `.env` |
| `AnthropicPlanningAgent requires an API key` | `ANTHROPIC_API_KEY` not in `.env` | Set it in `.env` |
| GitHub API 404 | Repo not found or token lacks scope | Check repo name format (`owner/repo`) and token scopes |
| GitHub API 401 | Invalid token | Regenerate at github.com/settings/tokens |
| Postgres connection refused | Docker stack not running | `corepack pnpm run setup` |
| `spawn EPERM` in verify scripts | Windows sandbox restriction | Run outside the Claude Code sandbox |
| OpenClaw `curl` returns empty reply on 3578 | Gateway bound to container loopback | Ensure `openclaw.json` has `gateway.bind: "lan"`, check `runtime-data/openclaw-home/openclaw.json`, recreate the container |
| OpenClaw agents not showing in Control UI | Old agent config format | Ensure `openclaw.json` uses `agents.list[]` array format (not object keys), recreate container |
| OpenClaw dispatch 401/403 | Invalid `OPENCLAW_HOOK_TOKEN` | Check `.env` token matches gateway config |
| OpenClaw dispatch 429/529 | Rate limited | Adapter retries automatically (3 attempts, 2s backoff) |
| Developer phase `task_blocked` | Approval not resolved | Check `/approvals` — resolve pending approval first |
| Approval decision rejected | Wrong enum value | Use `"approve"` not `"approved"` |
| Inline docker env overrides tokens to empty | `environment:` block overrides `env_file` | Remove explicit token entries from `environment:`, rely on `env_file: ../../.env` |

For more known issues, see [docs/agent/TROUBLESHOOTING.md](agent/TROUBLESHOOTING.md).
