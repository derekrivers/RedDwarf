# RedDwarf End-to-End Demo Runbook

This runbook walks through a complete demonstration of RedDwarf from a fresh clone to a completed AI Dev Squad planning cycle with real GitHub inputs.

> **Prerequisites:** Docker Desktop (or Docker Engine + Compose), Node.js ≥ 22, Corepack, Git, a GitHub Personal Access Token, and an Anthropic API key.

---

## Overview

The demo will:
1. Boot the RedDwarf stack (OpenClaw + Postgres)
2. File a GitHub issue on a target repository
3. Run the RedDwarf planning pipeline against that issue using the real GitHub adapter and the Anthropic planning agent
4. Inspect the durable planning evidence in Postgres
5. (Optional) Walk through the approval workflow and SCM handoff

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

Edit `.env` to set your Postgres password. For local development, the defaults work:

```
POSTGRES_PASSWORD=reddwarf   # change for shared or production environments
```

### 1.2 Start the stack

```bash
corepack pnpm setup
# Equivalent to: compose:up → wait for Postgres → db:migrate → health check
```

Confirm everything is up:

```
[setup] Postgres is reachable.
[setup] Migrations applied.
[setup] Health check passed. Public tables: reddwarf_schema_migrations, ...
[setup] Setup complete.
```

---

## Part 2 — Configure Credentials

### 2.1 GitHub token

Create a GitHub Personal Access Token (classic) at https://github.com/settings/tokens with at minimum:

- `repo` scope (for private repos) or no scope (for public repos)
- `issues:read` for reading issues
- `contents:write` and `pull_requests:write` for the SCM phase (branch + PR creation)

Set it in your shell:

```bash
export GITHUB_TOKEN="ghp_..."
```

### 2.2 Anthropic API key

Obtain an API key at https://console.anthropic.com/keys.

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

---

## Part 3 — File a Demo GitHub Issue

On a GitHub repository you control (e.g., `your-org/demo-repo`), file an issue with this body structure:

```markdown
This issue is a RedDwarf AI Dev Squad demo.

Acceptance Criteria:
- The planning agent produces a structured plan
- Evidence is archived durably in Postgres

Affected Paths:
- docs/demo.md

Requested Capabilities:
- can_plan
- can_archive_evidence
```

Add the label `ai-eligible` to the issue.

Note the issue number (e.g., `#42`).

---

## Part 4 — Run the Planning Pipeline

Create a demo script at the repo root (not committed — this is a one-off demo):

```js
// demo-run.mjs
import { runPlanningPipeline } from "./packages/control-plane/dist/index.js";
import { createPostgresPlanningRepository } from "./packages/evidence/dist/index.js";
import {
  intakeGitHubIssue,
  createRestGitHubAdapter
} from "./packages/integrations/dist/index.js";
import { createAnthropicPlanningAgent } from "./packages/execution-plane/dist/index.js";

const repo = "your-org/demo-repo"; // owner/repo format — NOT a full GitHub URL
const issueNumber = 42;            // Replace with your issue number

const github = createRestGitHubAdapter();          // reads GITHUB_TOKEN from env
const planner = createAnthropicPlanningAgent();    // reads ANTHROPIC_API_KEY from env
const repository = createPostgresPlanningRepository(
  process.env.HOST_DATABASE_URL ?? "postgresql://reddwarf:reddwarf@127.0.0.1:55432/reddwarf"
);

try {
  // Step 1: Intake the GitHub issue
  console.log(`Intaking ${repo}#${issueNumber}...`);
  const intake = await intakeGitHubIssue({ github, repo, issueNumber });
  console.log("Issue title:", intake.candidate.title);
  console.log("Acceptance criteria:", intake.planningInput.acceptanceCriteria);

  // Step 2: Run the planning pipeline
  console.log("\nRunning planning pipeline...");
  const result = await runPlanningPipeline(intake.planningInput, {
    repository,
    planner
  });

  console.log("\nPipeline result:");
  console.log("  Task ID:", result.manifest.taskId);
  console.log("  Run ID:", result.runId);
  console.log("  Next action:", result.nextAction);
  console.log("  Risk class:", result.manifest.riskClass);

  // Step 3: Inspect the evidence
  const snapshot = await repository.getTaskSnapshot(result.manifest.taskId);
  console.log("\nEvidence snapshot:");
  console.log("  Phase records:", snapshot.phaseRecords.map((p) => `${p.phase}:${p.status}`));
  console.log("  Planning spec summary:", snapshot.spec?.summary ?? "(none)");

  console.log("\nDemo complete. Task ID:", result.manifest.taskId);
} finally {
  await repository.close();
}
```

Build the packages first, then run:

```bash
corepack pnpm build
node demo-run.mjs
```

Expected output:

```
Intaking your-org/demo-repo#42...
Issue title: RedDwarf AI Dev Squad Demo
Acceptance criteria: [ 'The planning agent produces a structured plan', ... ]

Running planning pipeline...

Pipeline result:
  Task ID: your-org-demo-repo-42-<hash>
  Run ID: <uuid>
  Next action: complete
  Risk class: low

Evidence snapshot:
  Phase records: [ 'intake:passed', 'eligibility:passed', 'planning:passed', 'policy_gate:passed' ]
  Planning spec summary: <AI-generated plan summary>

Demo complete. Task ID: ...
```

---

## Part 5 — Inspect Evidence in Postgres

### Option A — Docker exec (recommended on Windows)

`psql` is not installed by default on Windows. Use the copy bundled inside the Postgres container:

```bash
docker exec -it reddwarf-postgres-1 psql -U reddwarf reddwarf
```

Then run the queries below at the `reddwarf=#` prompt.

### Option B — psql on the host (Linux / macOS / WSL)

```bash
psql "postgresql://reddwarf:reddwarf@127.0.0.1:55432/reddwarf"
```

### Option C — Node.js query script

```bash
node scripts/query-evidence.mjs
```

This prints the most recent planning spec and phase records without requiring `psql`.

### Queries

```sql
-- View the planning spec for the most recent task
SELECT task_id, summary, assumptions, affected_areas
FROM planning_specs
ORDER BY created_at DESC
LIMIT 1;

-- View the phase records for that task
SELECT phase, status, actor, summary, created_at
FROM phase_records
WHERE task_id = '<task-id-from-above>'
ORDER BY created_at;

-- View run events
SELECT run_id, phase, level, message
FROM run_events
WHERE task_id = '<task-id-from-above>'
ORDER BY created_at;
```

---

## Part 6 — Approval Workflow (Optional)

If the task needs human review before development (e.g., medium/high risk), query the approval queue via the operator API:

```bash
# Start the operator API server (from a separate terminal)
node -e "
import('./packages/control-plane/dist/index.js').then(async ({ createOperatorApiServer }) => {
  const { createPostgresPlanningRepository } = await import('./packages/evidence/dist/index.js');
  const repo = createPostgresPlanningRepository(process.env.HOST_DATABASE_URL ?? 'postgresql://reddwarf:reddwarf@127.0.0.1:55432/reddwarf');
  const server = createOperatorApiServer({ port: 8080 }, { repository: repo });
  await server.start();
  console.log('Operator API on port', server.port);
});
"
```

Then in a second terminal — use whichever shell you have:

**PowerShell:**
```powershell
# List pending approvals
Invoke-RestMethod http://localhost:8080/approvals

# Resolve an approval
Invoke-RestMethod `
  -Method POST `
  -Uri "http://localhost:8080/approvals/<request-id>/resolve" `
  -ContentType "application/json" `
  -Body '{"decision":"approved","rationale":"Looks good — proceed to development"}'
```

**Git Bash / WSL / Linux / macOS:**
```bash
# List pending approvals
curl http://localhost:8080/approvals

# Resolve an approval — use curl.exe in Git Bash on Windows to avoid the PowerShell alias
curl.exe -X POST "http://localhost:8080/approvals/<request-id>/resolve" \
  -H "Content-Type: application/json" \
  -d '{"decision":"approved","rationale":"Looks good — proceed to development"}'
```

---

## Part 7 — Clean Up

```bash
# Stop the Docker stack
corepack pnpm compose:down

# (Optional) Clean up evidence older than 0 days (removes everything)
node scripts/cleanup-evidence.mjs --max-age-days 0 --delete
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `RestGitHubAdapter requires a token` | `GITHUB_TOKEN` not set | `export GITHUB_TOKEN="ghp_..."` |
| `AnthropicPlanningAgent requires an API key` | `ANTHROPIC_API_KEY` not set | `export ANTHROPIC_API_KEY="sk-ant-..."` |
| `GitHub API GET /repos/... returned 404` | Repo not found or no access | Check repo name and token scope |
| `GitHub API GET /repos/... returned 401` | Invalid token | Regenerate the token at github.com/settings/tokens |
| Postgres connection refused | Docker stack not running | `corepack pnpm setup` |
| `spawn EPERM` in verify scripts | Windows sandbox restriction | Run commands outside the Claude Code sandbox or with elevated permissions |

For more known issues, see [docs/agent/TROUBLESHOOTING.md](agent/TROUBLESHOOTING.md).
