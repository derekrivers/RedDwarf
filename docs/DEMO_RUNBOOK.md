# RedDwarf End-to-End Demo Runbook

This runbook walks through a complete demonstration of RedDwarf — from a fresh clone through the full read-only pipeline: planning, OpenClaw analyst dispatch, validation, and SCM handoff.

> **Prerequisites:** Docker Desktop (or Docker Engine + Compose), Node.js ≥ 22, Corepack, Git, a GitHub Personal Access Token, and an Anthropic API key.

---

## Overview

The demo will:
1. Boot the RedDwarf stack (Postgres required, OpenClaw optional)
2. Configure credentials (GitHub, Anthropic, OpenClaw if available)
3. File a GitHub issue on a target repository
4. Run the planning pipeline (intake → eligibility → planning → policy gate)
5. Approve the plan via the operator API
6. Run the developer phase — with OpenClaw analyst dispatch or deterministic fallback
7. Inspect session evidence (transcript + summary)
8. Run the validation phase (workspace-local lint/test)
9. Run the SCM phase (branch + PR creation)
10. Clean up

> **OpenClaw availability:** The OpenClaw gateway image (`ghcr.io/openclaw/openclaw:latest`) may not yet be published. The entire pipeline works without it — the developer phase falls back to a deterministic agent. When the image becomes available, OpenClaw can be started alongside Postgres to enable live analyst dispatch.

### Pipeline Phases

```
GitHub Issue
    ↓
  Intake → Eligibility → Planning → Policy Gate
    ↓
  [Approval Queue — human review]
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

Edit `.env` to set your Postgres password. For local development, the defaults work:

```
POSTGRES_PASSWORD=reddwarf   # change for shared or production environments
```

### 1.2 Start the stack

By default, `setup` starts **Postgres only**. OpenClaw is behind a Docker Compose profile and starts separately.

```bash
corepack pnpm setup
# Equivalent to: compose:up → wait for Postgres → db:migrate → health check
```

Confirm Postgres is up:

```
[setup] Postgres is reachable.
[setup] Migrations applied.
[setup] Health check passed. Public tables: reddwarf_schema_migrations, ...
[setup] OpenClaw gateway is not running — this is normal.
[setup] The pipeline will use deterministic agent fallbacks.
[setup] Setup complete.
```

### 1.3 (Optional) Start OpenClaw gateway

If the OpenClaw container image is available, start it alongside Postgres:

```bash
corepack pnpm compose:up:openclaw
# Equivalent to: docker compose --profile openclaw up -d
```

Verify it's running:

```bash
docker compose -f infra/docker/docker-compose.yml ps openclaw
```

The gateway listens on port `3578` (configurable via `OPENCLAW_HOST_PORT` in `.env`).

To reach the OpenClaw Control UI from your host browser, set `OPENCLAW_GATEWAY_TOKEN` in `.env` before starting the container. The compose stack mounts [infra/docker/openclaw.json](/c:/Dev/RedDwarf/infra/docker/openclaw.json), which forces `gateway.bind` to `lan` so host port `3578` is reachable.

```bash
OPENCLAW_GATEWAY_TOKEN=<long-random-token>
```

Then browse to `http://127.0.0.1:3578/` and authenticate with `OPENCLAW_GATEWAY_TOKEN`.

> **If the image is not yet published**, skip this step. The full pipeline works without OpenClaw — the developer phase uses a deterministic agent fallback.

### 1.4 Build all packages

```bash
corepack pnpm build
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

### 2.3 OpenClaw hook token (only if OpenClaw is running)

> **Skip this step if OpenClaw is not running.** The pipeline works without these variables.

The hook token authenticates RedDwarf dispatch calls to the OpenClaw gateway webhook endpoint (`POST /hooks/agent`). Treat this token as a privileged secret — holders have full-trust ingress on the gateway.

Retrieve your hook token from the OpenClaw gateway configuration or generate one during gateway setup. Set it along with the gateway base URL:

```bash
export OPENCLAW_HOOK_TOKEN="your_hook_token_here"
export OPENCLAW_BASE_URL="http://localhost:3578"
```

The `createOpenClawSecretsAdapter()` factory reads `OPENCLAW_HOOK_TOKEN` from the environment and exposes it under the `openclaw` secret scope so dispatch adapters can retrieve it without direct `process.env` access.

---

## Part 3 — File a Demo GitHub Issue

On a GitHub repository you control (e.g., `your-org/demo-repo`), file an issue with this body structure:

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
  process.env.HOST_DATABASE_URL ?? "postgresql://reddwarf:reddwarf@127.0.0.1:55532/reddwarf"
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

  console.log("\nPlanning complete. Task ID:", result.manifest.taskId);
  console.log("Approval request ID:", result.approvalRequest?.requestId ?? "(none)");
} finally {
  await repository.close();
}
```

Run it:

```bash
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

Planning complete. Task ID: ...
Approval request ID: <request-id>
```

Save the **Task ID** and **Approval request ID** — you'll need them for the next steps.

---

## Part 5 — Approve the Plan

If the task requires human approval (medium/high risk), it will be in the approval queue. Start the operator API and resolve it.

### 5.1 Start the operator API

```bash
# In a separate terminal
node scripts/start-operator-api.mjs
# or: corepack pnpm operator:api
```

This is the RedDwarf operator API, not the OpenClaw Control UI. The operator API listens on `127.0.0.1:8080` and exposes JSON endpoints only.

### 5.2 List pending approvals

**PowerShell:**
```powershell
Invoke-RestMethod http://localhost:8080/approvals
```

**Git Bash / WSL / Linux / macOS:**
```bash
curl http://localhost:8080/approvals
```

### 5.3 Approve the plan

**PowerShell:**
```powershell
Invoke-RestMethod `
  -Method POST `
  -Uri "http://localhost:8080/approvals/<request-id>/resolve" `
  -ContentType "application/json" `
  -Body '{"decision":"approve","decidedBy":"your-name","decisionSummary":"Looks good","rationale":"Proceed to development"}'
```

**Git Bash / WSL / Linux / macOS:**
```bash
# Use curl.exe in Git Bash on Windows to avoid the PowerShell alias
curl.exe -X POST "http://localhost:8080/approvals/<request-id>/resolve" \
  -H "Content-Type: application/json" \
  -d '{"decision":"approve","decidedBy":"your-name","decisionSummary":"Looks good","rationale":"Proceed to development"}'
```

### 5.4 Operator API reference

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Server health check |
| GET | `/runs` | List pipeline runs (filter: `taskId`, `statuses`, `limit`) |
| GET | `/approvals` | List approval requests (filter: `taskId`, `runId`, `statuses`, `limit`) |
| POST | `/approvals/:id/resolve` | Resolve an approval request |
| GET | `/approvals/:id` | Get specific approval request |
| GET | `/tasks/:taskId/evidence` | List evidence records for a task |
| GET | `/tasks/:taskId/snapshot` | Full task snapshot |
| GET | `/blocked` | Summary of blocked runs and pending approvals |

---

## Part 6 — Run the Developer Phase

After approval, run the developer phase. This phase supports two modes:

| Mode | When to use | What happens |
|------|-------------|--------------|
| **With OpenClaw** | Gateway running (Part 1.3) | Dispatches to Holly (read-only analyst) via `/hooks/agent` |
| **Without OpenClaw** | Gateway not available | Uses `DeterministicDeveloperAgent` stub — full pipeline still works |

Create a demo script:

```js
// demo-developer.mjs
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import {
  runDeveloperPhase,
  DeterministicDeveloperAgent
} from "./packages/control-plane/dist/index.js";
import { PostgresPlanningRepository } from "./packages/evidence/dist/index.js";
import { createHttpOpenClawDispatchAdapter } from "./packages/integrations/dist/index.js";

const taskId = "<task-id-from-part-4>";  // Replace with your task ID

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

// ── Choose your mode ─────────────────────────────────────────────────────
// Option A: With OpenClaw (requires gateway running + OPENCLAW_HOOK_TOKEN set)
const useOpenClaw = !!process.env.OPENCLAW_HOOK_TOKEN;

const dependencies = {
  repository,
  developer: new DeterministicDeveloperAgent()
};

if (useOpenClaw) {
  dependencies.openClawDispatch = createHttpOpenClawDispatchAdapter();
  // reads OPENCLAW_BASE_URL and OPENCLAW_HOOK_TOKEN from env
  // dispatches to reddwarf-analyst (Holly) by default
  dependencies.openClawAgentId = "reddwarf-analyst";
}
// ──────────────────────────────────────────────────────────────────────────

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
  console.log("  Workspace ID:", result.workspace?.workspaceId);
  console.log("  Tool policy:", result.workspace?.descriptor?.toolPolicy?.mode);
  console.log("  Code write enabled:", result.workspace?.descriptor?.toolPolicy?.codeWriteEnabled);

  if (result.openClawDispatchResult) {
    console.log("\nOpenClaw dispatch:");
    console.log("  Accepted:", result.openClawDispatchResult.accepted);
    console.log("  Session ID:", result.openClawDispatchResult.sessionId);
    console.log("  Agent:", result.openClawDispatchResult.agentId);
  } else {
    console.log("\nOpenClaw: not used (deterministic fallback)");
  }

  if (result.handoffPath) {
    const handoff = await readFile(result.handoffPath, "utf8");
    console.log("\nDeveloper handoff (first 500 chars):");
    console.log(handoff.slice(0, 500));
  }

  console.log("\nDeveloper phase complete. Proceed to validation.");
} finally {
  await repository.close();
}
```

Run it:

```bash
node demo-developer.mjs
```

### Expected output (without OpenClaw)

```
Running developer phase...
  Task ID: your-org-demo-repo-42-<hash>
  Mode: Deterministic fallback

Developer phase result:
  Run ID: <uuid>
  Next action: await_validation
  Workspace ID: <workspace-id>
  Tool policy: development_readonly
  Code write enabled: false

OpenClaw: not used (deterministic fallback)

Developer handoff (first 500 chars):
# Development Handoff
...

Developer phase complete. Proceed to validation.
```

### Expected output (with OpenClaw)

```
Running developer phase...
  Task ID: your-org-demo-repo-42-<hash>
  Mode: OpenClaw dispatch (Holly)

Developer phase result:
  Run ID: <uuid>
  Next action: await_validation
  Workspace ID: <workspace-id>
  Tool policy: development_readonly
  Code write enabled: false

OpenClaw dispatch:
  Accepted: true
  Session ID: <session-id>
  Agent: reddwarf-analyst

Developer handoff (first 500 chars):
# Development Handoff
...

Developer phase complete. Proceed to validation.
```

### What happens during this phase

1. RedDwarf provisions an isolated workspace with read-only tool policy
2. **With OpenClaw:** posts to `POST /hooks/agent` on the gateway:
   - Session key: `github:issue:{repo}:{issueNumber}`
   - Agent ID: `reddwarf-analyst` (Holly)
   - Prompt with task context, acceptance criteria, allowed paths
   - Holly performs read-only analysis — **code writes remain disabled**
   - Session transcript (JSONL) and summary (markdown) captured as evidence
3. **Without OpenClaw:** the `DeterministicDeveloperAgent` produces a stub handoff — the pipeline continues identically through validation and SCM
4. A developer handoff artifact is archived with the workspace
5. The task blocks pending validation

---

## Part 7 — Inspect Evidence

### 7.1 Via the operator API

```bash
# Full task snapshot (all phases, evidence, events)
curl http://localhost:8080/tasks/<task-id>/snapshot

# Evidence records only
curl http://localhost:8080/tasks/<task-id>/evidence
```

### 7.2 Via the Node.js query script

```bash
node scripts/query-evidence.mjs
```

This prints the most recent planning spec and phase records without requiring `psql`.

### 7.3 Via psql

**Docker exec (recommended on Windows):**

```bash
docker exec -it reddwarf-postgres-1 psql -U reddwarf reddwarf
```

**psql on the host (Linux / macOS / WSL):**

```bash
psql "postgresql://reddwarf:reddwarf@127.0.0.1:55532/reddwarf"
```

### Queries

```sql
-- View the planning spec for the most recent task
SELECT task_id, summary, assumptions, affected_areas
FROM planning_specs
ORDER BY created_at DESC
LIMIT 1;

-- View all phase records for a task (should now include development)
SELECT phase, status, actor, summary, created_at
FROM phase_records
WHERE task_id = '<task-id>'
ORDER BY created_at;

-- View run events (including OpenClaw dispatch events)
SELECT run_id, phase, level, message
FROM run_events
WHERE task_id = '<task-id>'
ORDER BY created_at;

-- View evidence records (handoff artifacts, session transcripts)
SELECT artifact_class, source_location, archived_location, metadata
FROM evidence_records
WHERE task_id = '<task-id>'
ORDER BY created_at;

-- View memory records (development handoff context)
SELECT partition, key, value
FROM memory_records
WHERE task_id = '<task-id>'
ORDER BY created_at;
```

### What to look for in the evidence

| Evidence | Description |
|----------|-------------|
| **Phase record** `development:passed` | Developer phase completed successfully |
| **Evidence record** with `artifact_class: "handoff"` | Developer handoff markdown archived |
| **Run event** with `OPENCLAW_DISPATCH` | OpenClaw dispatch was triggered |
| **Memory record** with key `development.handoff` | Handoff summary, blocked actions, next steps |
| **Session transcript** (if OpenClaw ran) | Full JSONL of the analyst session |
| **Session summary** (if OpenClaw ran) | Markdown summary of Holly's analysis |

---

## Part 8 — Run the Validation Phase

After development, run validation to execute workspace-local lint and test commands.

```js
// demo-validation.mjs
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import {
  runValidationPhase,
  DeterministicValidationAgent
} from "./packages/control-plane/dist/index.js";
import { PostgresPlanningRepository } from "./packages/evidence/dist/index.js";

const taskId = "<task-id-from-part-4>";  // Same task ID

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
    {
      taskId,
      targetRoot,
      evidenceRoot
    },
    {
      repository,
      validator: new DeterministicValidationAgent()
    }
  );

  console.log("\nValidation phase result:");
  console.log("  Run ID:", result.runId);
  console.log("  Next action:", result.nextAction);
  console.log("  Tool policy:", result.workspace?.descriptor?.toolPolicy?.mode);
  console.log("  Code write enabled:", result.workspace?.descriptor?.toolPolicy?.codeWriteEnabled);

  if (result.reportPath) {
    const report = await readFile(result.reportPath, "utf8");
    console.log("\nValidation report (first 500 chars):");
    console.log(report.slice(0, 500));
  }

  console.log("\nValidation complete. Proceed to SCM.");
} finally {
  await repository.close();
}
```

Run it:

```bash
node demo-validation.mjs
```

Expected output:

```
Running validation phase...

Validation phase result:
  Run ID: <uuid>
  Next action: await_scm
  Tool policy: validation_only
  Code write enabled: false

Validation report (first 500 chars):
# Validation Report
...

Validation complete. Proceed to SCM.
```

The validation phase:
- Reuses the workspace provisioned by the developer phase
- Runs in `validation_only` tool policy mode with `can_run_tests` capability
- Archives a validation report as evidence
- Blocks the task pending SCM handoff

---

## Part 9 — Run the SCM Phase (Branch + PR)

After validation, run the SCM phase to create a branch and pull request.

```js
// demo-scm.mjs
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import {
  runScmPhase,
  DeterministicScmAgent
} from "./packages/control-plane/dist/index.js";
import { PostgresPlanningRepository } from "./packages/evidence/dist/index.js";
import {
  createRestGitHubAdapter,
  FixtureGitHubAdapter
} from "./packages/integrations/dist/index.js";

const taskId = "<task-id-from-part-4>";  // Same task ID
const repo = "your-org/demo-repo";       // Same repo

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
    {
      taskId,
      targetRoot
    },
    {
      repository,
      scm: new DeterministicScmAgent(),

      // Option A: Live GitHub (creates a real branch + PR)
      // github: createRestGitHubAdapter(),

      // Option B: Fixture GitHub (dry-run — no real GitHub calls)
      github: new FixtureGitHubAdapter({
        candidates: [
          {
            repo,
            issueNumber: 42,
            title: "RedDwarf AI Dev Squad Demo",
            body: "Demo issue",
            labels: ["ai-eligible"],
            url: `https://github.com/${repo}/issues/42`,
            state: "open"
          }
        ],
        mutations: {
          allowBranchCreation: true,
          allowPullRequestCreation: true,
          pullRequestNumberStart: 91
        }
      })
    }
  );

  console.log("\nSCM phase result:");
  console.log("  Run ID:", result.runId);
  console.log("  Next action:", result.nextAction);
  console.log("  Tool policy:", result.workspace?.descriptor?.toolPolicy?.mode);

  if (result.branch) {
    console.log("\nBranch:");
    console.log("  Name:", result.branch.branchName);
  }

  if (result.pullRequest) {
    console.log("\nPull Request:");
    console.log("  Number:", result.pullRequest.number);
    console.log("  URL:", result.pullRequest.url);
  }

  if (result.reportPath) {
    const report = await readFile(result.reportPath, "utf8");
    console.log("\nSCM report (first 500 chars):");
    console.log(report.slice(0, 500));
  }

  console.log("\nPipeline complete!");
} finally {
  await repository.close();
}
```

Run it:

```bash
node demo-scm.mjs
```

Expected output:

```
Running SCM phase...

SCM phase result:
  Run ID: <uuid>
  Next action: complete
  Tool policy: scm_only

Branch:
  Name: reddwarf/your-org-demo-repo-42-<hash>

Pull Request:
  Number: 91
  URL: https://github.com/your-org/demo-repo/pull/91

SCM report (first 500 chars):
# SCM Report
...Pull Request URL...

Pipeline complete!
```

The SCM phase:
- Runs in `scm_only` tool policy mode
- Creates a feature branch from the workspace diff
- Opens a pull request linking back to the originating issue
- Archives the SCM report (branch name, PR URL, metadata) as evidence
- Marks the task lifecycle as `completed`

### Live vs Fixture GitHub

The example above uses `FixtureGitHubAdapter` for a safe dry-run. To create a **real branch and PR** on GitHub:

1. Replace `FixtureGitHubAdapter` with `createRestGitHubAdapter()`
2. Ensure `GITHUB_TOKEN` has `contents:write` and `pull_requests:write` scopes
3. Ensure the workspace contains actual file changes to commit

---

## Part 10 — Verify the Full Pipeline

After completing all phases, confirm the full pipeline state:

```bash
# Via operator API
curl http://localhost:8080/tasks/<task-id>/snapshot
```

Or via SQL:

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

The task manifest should show:
- `lifecycleStatus: "completed"`
- `currentPhase: "scm"`
- `branchName` and `prNumber` populated (if SCM ran with live GitHub)

---

## Part 11 — Clean Up

```bash
# Stop the Docker stack
corepack pnpm compose:down

# (Optional) Clean up evidence older than 0 days (removes everything)
node scripts/cleanup-evidence.mjs --max-age-days 0 --delete
```

---

## Agent Reference

RedDwarf uses three agent personas based on Red Dwarf characters:

| Agent | Role | ID | Tool Policy | Model |
|-------|------|----|-------------|-------|
| **Holly** | Architect / Analyst | `reddwarf-analyst` | `coding` (read-only sandbox) | claude-opus-4-6 |
| **Rimmer** | Session Coordinator | `reddwarf-coordinator` | `minimal` (read-only sandbox) | claude-sonnet-4-6 |
| **Kryten** | Validator / Reviewer | `reddwarf-validator` | `coding` (workspace-write sandbox) | claude-sonnet-4-6 |

Agent bootstrap files are in `agents/openclaw/{holly,rimmer,kryten}/`:
- `IDENTITY.md` — Agent name, role, and title
- `SOUL.md` — Personality and operating principles
- `AGENTS.md` — Runtime roster and delegation rules
- `TOOLS.md` — Tool profile, allow/deny lists, sandbox mode, model binding
- `SKILL.md` files — Task-specific skills

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
| `OPENCLAW_HOOK_TOKEN not set` | Hook token missing for dispatch | `export OPENCLAW_HOOK_TOKEN="..."` — retrieve from OpenClaw gateway config |
| OpenClaw dispatch returns 401/403 | Invalid or expired hook token | Regenerate the hook token in OpenClaw gateway config and re-export |
| `OPENCLAW_BASE_URL not set` | Gateway URL missing | `export OPENCLAW_BASE_URL="http://localhost:3578"` |
| OpenClaw UI on `3578` accepts TCP but returns an empty reply | Gateway is still bound to container loopback | Ensure the stack is using [infra/docker/openclaw.json](/c:/Dev/RedDwarf/infra/docker/openclaw.json), set `OPENCLAW_GATEWAY_TOKEN=...`, then recreate the `openclaw` container |
| OpenClaw dispatch returns 429/529 | Gateway rate-limited or overloaded | Adapter retries automatically (3 attempts, 2s backoff) — wait and retry |
| Developer phase returns `task_blocked` | Task not in `ready` lifecycle status | Check that approval was resolved — query `/approvals` |
| Validation phase returns `task_blocked` | Developer phase not completed | Run developer phase first — check phase records |
| SCM phase returns `task_blocked` | Validation phase not completed | Run validation phase first — check phase records |
| `nextAction: "await_validation"` after dev | Expected — this is normal flow | Proceed to run the validation phase |
| No OpenClaw dispatch result in output | `openClawDispatch` not in dependencies | Add `createHttpOpenClawDispatchAdapter()` — or this is the deterministic fallback |

For more known issues, see [docs/agent/TROUBLESHOOTING.md](agent/TROUBLESHOOTING.md).
