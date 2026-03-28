/**
 * scripts/e2e-integration.mjs
 *
 * Full end-to-end integration test against a real GitHub repository.
 *
 * Creates a GitHub issue, runs the RedDwarf pipeline
 * (intake -> planning -> approval -> developer -> validation -> optional SCM),
 * inspects the resulting state, and optionally cleans up.
 *
 * Required environment:
 *   GITHUB_TOKEN          - GitHub PAT with repo scope
 *   ANTHROPIC_API_KEY     - Anthropic API key for LLM planning
 *   E2E_TARGET_REPO       - GitHub repo in owner/repo format (for example derekrivers/FirstVoyage)
 *
 * Optional environment:
 *   E2E_CLEANUP=true      - close the created issue and PR after the test
 *   E2E_USE_OPENCLAW=true - dispatch developer phase to OpenClaw instead of deterministic fallback
 *   OPENCLAW_BASE_URL     - required when E2E_USE_OPENCLAW=true
 *   OPENCLAW_HOOK_TOKEN   - required when E2E_USE_OPENCLAW=true
 *   HOST_DATABASE_URL     - Postgres connection string (defaults to local dev)
 *
 * Usage:
 *   corepack pnpm e2e
 *   E2E_TARGET_REPO=owner/repo corepack pnpm e2e
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import pg from "pg";
import { fileURLToPath } from "node:url";

const { Client } = pg;

const __scriptdir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__scriptdir, "..", ".env");

try {
  const envContent = readFileSync(envPath, "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex < 1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
} catch {
  // .env is optional
}

import {
  resolveApprovalRequest,
  runDeveloperPhase,
  runPlanningPipeline,
  runScmPhase,
  runValidationPhase,
  DeterministicDeveloperAgent,
  DeterministicScmAgent,
  DeterministicValidationAgent,
  destroyTaskWorkspace
} from "../packages/control-plane/dist/index.js";
import { createPostgresPlanningRepository } from "../packages/evidence/dist/index.js";
import {
  createRestGitHubAdapter,
  intakeGitHubIssue,
  createHttpOpenClawDispatchAdapter
} from "../packages/integrations/dist/index.js";
import { createPlanningAgent } from "../packages/execution-plane/dist/index.js";
import { connectionString, createScriptLogger, formatError } from "./lib/config.mjs";

const { log, logError } = createScriptLogger("e2e");

const repo = process.env.E2E_TARGET_REPO;
if (!repo) {
  logError("E2E_TARGET_REPO is required (for example owner/repo)");
  process.exit(1);
}
if (!process.env.GITHUB_TOKEN) {
  logError("GITHUB_TOKEN is required");
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  logError("ANTHROPIC_API_KEY is required");
  process.exit(1);
}

const cleanup = process.env.E2E_CLEANUP === "true";
const useOpenClaw = process.env.E2E_USE_OPENCLAW === "true";
const openClawBaseUrl = process.env.OPENCLAW_BASE_URL ?? "";
const openClawHookToken = process.env.OPENCLAW_HOOK_TOKEN ?? "";
const timestamp = Date.now();
const baseTargetRoot = resolve(
  process.env.REDDWARF_HOST_WORKSPACE_ROOT ?? join(tmpdir(), "reddwarf-e2e")
);
const targetRoot = resolve(baseTargetRoot, `e2e-${timestamp}`);
const evidenceRoot = resolve(targetRoot, "..", `e2e-evidence-${timestamp}`);
const setupScriptPath = resolve(__scriptdir, "setup.mjs");

const repository = createPostgresPlanningRepository(connectionString);
const github = createRestGitHubAdapter();
const planner = createPlanningAgent({ type: "anthropic" });

function elapsed(startMs) {
  return `${((Date.now() - startMs) / 1000).toFixed(1)}s`;
}

async function closeIssue(issueNumber) {
  const [owner, repoName] = repo.split("/");
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/issues/${issueNumber}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ state: "closed" })
    }
  );
  if (!res.ok) {
    log(`  Warning: failed to close issue #${issueNumber} (${res.status})`);
  }
}

async function closePullRequest(prNumber) {
  const [owner, repoName] = repo.split("/");
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/pulls/${prNumber}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ state: "closed" })
    }
  );
  if (!res.ok) {
    log(`  Warning: failed to close PR #${prNumber} (${res.status})`);
  }
}

async function deleteBranch(branchName) {
  const [owner, repoName] = repo.split("/");
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/git/refs/heads/${branchName}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json"
      }
    }
  );
  if (!res.ok) {
    log(`  Warning: failed to delete branch ${branchName} (${res.status})`);
  }
}

async function ensureLocalStackReady() {
  log("Preflight: checking local Postgres readiness...");

  const client = new Client({ connectionString, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    await client.end();
    log("Preflight complete: local Postgres is already reachable.");
    return;
  } catch {
    await client.end().catch(() => {});
  }

  log("Preflight: local Postgres is not reachable; running setup script...");
  try {
    execFileSync(process.execPath, [setupScriptPath], {
      stdio: "inherit",
      cwd: resolve(__scriptdir, ".."),
      env: process.env
    });
  } catch (err) {
    throw new Error(
      `Local setup failed before E2E could start. Run \`corepack pnpm run setup\` and retry. ${formatError(err)}`
    );
  }
  log("Preflight complete: local Postgres and migrations are ready.");
}

async function ensureRequestedOpenClawReady() {
  if (!useOpenClaw) {
    return;
  }

  if (openClawBaseUrl.length === 0) {
    throw new Error(
      "E2E_USE_OPENCLAW=true requires OPENCLAW_BASE_URL before E2E can start."
    );
  }

  if (openClawHookToken.length === 0) {
    throw new Error(
      "E2E_USE_OPENCLAW=true requires OPENCLAW_HOOK_TOKEN before E2E can start."
    );
  }

  const healthUrl = `${openClawBaseUrl.replace(/\/+$/, "")}/health`;
  log(`Preflight: verifying OpenClaw gateway at ${healthUrl}...`);

  let response;
  try {
    response = await fetch(healthUrl);
  } catch (err) {
    throw new Error(
      `E2E_USE_OPENCLAW=true but OpenClaw is not reachable at ${healthUrl}. Start the openclaw profile or unset E2E_USE_OPENCLAW. ${formatError(err)}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `E2E_USE_OPENCLAW=true but OpenClaw health check returned ${response.status} for ${healthUrl}. Start the openclaw profile or unset E2E_USE_OPENCLAW.`
    );
  }

  log("Preflight complete: OpenClaw gateway is reachable.");
}

const runStart = Date.now();
let createdIssueNumber = null;
let createdPrNumber = null;
let createdBranch = null;
let scmResult = null;

try {
  await ensureLocalStackReady();
  await ensureRequestedOpenClawReady();

  log("Step 1/7: Creating GitHub issue...");
  const issueStart = Date.now();

  const issue = await github.createIssue({
    repo,
    title: `[E2E Test] RedDwarf pipeline validation ${new Date().toISOString().slice(0, 16)}`,
    body: [
      "This issue was created automatically by the RedDwarf end-to-end integration test.",
      "",
      "## Task",
      "",
      "Add a `docs/health-check.md` file that documents the project's health check endpoints.",
      "The file should include:",
      "- A table listing each health endpoint (path, method, expected response)",
      "- A short description of what each endpoint verifies",
      "- Example curl commands for local verification",
      "",
      "## Acceptance Criteria",
      "- `docs/health-check.md` exists and is valid Markdown",
      "- The table covers at least the `/health` endpoint on the operator API",
      "- Example curl commands are correct for `localhost:8080`",
      "- No existing files are modified",
      "",
      "## Affected Paths",
      "- docs/health-check.md",
      "",
      "## Requested Capabilities",
      "- can_plan",
      "- can_write_code",
      "- can_open_pr",
      "- can_archive_evidence",
      "",
      `_Created by RedDwarf E2E integration test - run ID: e2e-${timestamp}_`
    ].join("\n"),
    labels: ["ai-eligible"]
  });

  createdIssueNumber = issue.issueNumber;
  log(`  Created issue #${issue.issueNumber}: ${issue.url} (${elapsed(issueStart)})`);

  log("Step 2/7: Running intake and planning pipeline (LLM call)...");
  const planningStart = Date.now();

  const intake = await intakeGitHubIssue({ github, repo, issueNumber: issue.issueNumber });
  log(`  Intake complete: "${intake.candidate.title}"`);

  const planningResult = await runPlanningPipeline(intake.planningInput, {
    repository,
    planner
  });

  log(`  Planning complete (${elapsed(planningStart)})`);
  log(`  Task ID: ${planningResult.manifest.taskId}`);
  log(`  Next action: ${planningResult.nextAction}`);
  if (planningResult.spec) {
    log(`  Plan summary: ${planningResult.spec.summary?.slice(0, 120)}...`);
  }

  if (planningResult.nextAction !== "await_human" || !planningResult.approvalRequest) {
    throw new Error("Planning did not produce an approval request and cannot continue.");
  }

  log("Step 3/7: Auto-approving plan...");
  const approvalStart = Date.now();

  await resolveApprovalRequest(
    {
      requestId: planningResult.approvalRequest.requestId,
      decision: "approve",
      decidedBy: "e2e-integration-test",
      decisionSummary: "Auto-approved by end-to-end integration test",
      comment: `Automated approval for E2E run e2e-${timestamp}`
    },
    { repository }
  );

  log(`  Approved request ${planningResult.approvalRequest.requestId} (${elapsed(approvalStart)})`);

  log(`Step 4/7: Running developer phase (${useOpenClaw ? "OpenClaw dispatch" : "deterministic"})...`);
  const devStart = Date.now();

  const devDeps = {
    repository,
    developer: new DeterministicDeveloperAgent()
  };

  if (useOpenClaw) {
    devDeps.openClawDispatch = createHttpOpenClawDispatchAdapter();
    devDeps.openClawAgentId = "reddwarf-analyst";
  }

  const devResult = await runDeveloperPhase(
    {
      taskId: planningResult.manifest.taskId,
      targetRoot,
      evidenceRoot
    },
    devDeps
  );

  log(`  Developer phase complete (${elapsed(devStart)})`);
  log(`  Next action: ${devResult.nextAction}`);
  if (devResult.openClawDispatchResult) {
    log(`  OpenClaw session: ${devResult.openClawDispatchResult.sessionId}`);
  }

  log("Step 5/7: Running validation phase...");
  const validationStart = Date.now();

  const valResult = await runValidationPhase(
    {
      taskId: planningResult.manifest.taskId,
      targetRoot,
      evidenceRoot
    },
    {
      repository,
      validator: new DeterministicValidationAgent()
    }
  );

  log(`  Validation complete (${elapsed(validationStart)})`);
  log(`  Next action: ${valResult.nextAction}`);

  if (valResult.nextAction === "await_scm") {
    log("Step 6/7: Running SCM phase (creating real branch + PR)...");
    const scmStart = Date.now();

    scmResult = await runScmPhase(
      {
        taskId: planningResult.manifest.taskId,
        targetRoot,
        evidenceRoot
      },
      {
        repository,
        scm: new DeterministicScmAgent(),
        github
      }
    );

    log(`  SCM phase complete (${elapsed(scmStart)})`);
    log(`  Next action: ${scmResult.nextAction}`);

    if (scmResult.branch) {
      createdBranch = scmResult.branch.branchName;
      log(`  Branch: ${scmResult.branch.branchName}`);
    }
    if (scmResult.pullRequest) {
      createdPrNumber = scmResult.pullRequest.prNumber;
      log(`  PR #${scmResult.pullRequest.prNumber}: ${scmResult.pullRequest.url}`);
    }
  } else {
    log(`Step 6/7: Skipping SCM phase because validation returned ${valResult.nextAction}.`);
  }

  log("Step 7/7: Inspecting pipeline results...");

  const finalManifest = await repository.getManifest(planningResult.manifest.taskId);
  const snapshot = await repository.getTaskSnapshot(planningResult.manifest.taskId);
  const report = {
    success:
      scmResult !== null
        ? scmResult.nextAction === "complete"
        : valResult.nextAction === "await_review",
    totalDuration: elapsed(runStart),
    repo,
    issue: {
      number: createdIssueNumber,
      url: issue.url
    },
    task: {
      taskId: planningResult.manifest.taskId,
      lifecycleStatus: finalManifest?.lifecycleStatus,
      currentPhase: finalManifest?.currentPhase,
      prNumber: finalManifest?.prNumber,
      branchName: finalManifest?.branchName
    },
    phases: {
      planning: {
        runId: planningResult.runId,
        nextAction: planningResult.nextAction,
        specSummary: planningResult.spec?.summary?.slice(0, 200)
      },
      developer: {
        runId: devResult.runId,
        nextAction: devResult.nextAction,
        openClaw: devResult.openClawDispatchResult
          ? {
              accepted: devResult.openClawDispatchResult.accepted,
              sessionId: devResult.openClawDispatchResult.sessionId
            }
          : null
      },
      validation: {
        runId: valResult.runId,
        nextAction: valResult.nextAction
      },
      scm:
        scmResult !== null
          ? {
              runId: scmResult.runId,
              nextAction: scmResult.nextAction,
              branch: scmResult.branch
                ? {
                    name: scmResult.branch.branchName,
                    sha: scmResult.branch.sha
                  }
                : null,
              pullRequest: scmResult.pullRequest
                ? {
                    number: scmResult.pullRequest.prNumber,
                    url: scmResult.pullRequest.url
                  }
                : null
            }
          : null
    },
    evidence: {
      phaseRecordCount: snapshot?.phaseRecords?.length ?? 0,
      evidenceRecordCount: snapshot?.evidenceRecords?.length ?? 0,
      memoryRecordCount: snapshot?.memoryRecords?.length ?? 0,
      runEventCount: snapshot?.runEvents?.length ?? 0
    }
  };

  log("");
  log("================================================================");
  log("  E2E INTEGRATION TEST RESULTS");
  log("================================================================");
  log("");
  log(`  Result:     ${report.success ? "PASS" : "FAIL"}`);
  log(`  Duration:   ${report.totalDuration}`);
  log(`  Repo:       ${report.repo}`);
  log(`  Issue:      #${report.issue.number} - ${report.issue.url}`);
  log(`  Task ID:    ${report.task.taskId}`);
  log(`  Status:     ${report.task.lifecycleStatus}`);
  log(`  Phase:      ${report.task.currentPhase}`);

  if (report.phases.scm?.pullRequest) {
    log(`  PR:         #${report.phases.scm.pullRequest.number} - ${report.phases.scm.pullRequest.url}`);
  }
  if (report.phases.scm?.branch) {
    log(`  Branch:     ${report.phases.scm.branch.name}`);
  }

  log("");
  log("  Evidence:");
  log(`    Phase records:    ${report.evidence.phaseRecordCount}`);
  log(`    Evidence records: ${report.evidence.evidenceRecordCount}`);
  log(`    Memory records:   ${report.evidence.memoryRecordCount}`);
  log(`    Run events:       ${report.evidence.runEventCount}`);
  log("");

  if (report.phases.developer.openClaw) {
    log("  OpenClaw:");
    log(`    Accepted:   ${report.phases.developer.openClaw.accepted}`);
    log(`    Session ID: ${report.phases.developer.openClaw.sessionId}`);
    log("");
  }

  log("  Full report:");
  console.log(JSON.stringify(report, null, 2));
  log("");

  if (cleanup) {
    log("Cleaning up GitHub resources...");

    if (createdPrNumber) {
      await closePullRequest(createdPrNumber);
      log(`  Closed PR #${createdPrNumber}`);
    }
    if (createdBranch) {
      await deleteBranch(createdBranch);
      log(`  Deleted branch ${createdBranch}`);
    }
    if (createdIssueNumber) {
      await closeIssue(createdIssueNumber);
      log(`  Closed issue #${createdIssueNumber}`);
    }

    log("  GitHub cleanup complete");
  } else if (createdIssueNumber || createdPrNumber) {
    log("Tip: Set E2E_CLEANUP=true to auto-close the issue, PR, and branch after the test.");
  }

  await destroyTaskWorkspace({
    manifest: finalManifest ?? planningResult.manifest,
    repository,
    targetRoot
  }).catch(() => {});

  if (!report.success) {
    logError("Pipeline did not reach its expected terminal state.");
    process.exit(1);
  }

  log("E2E integration test passed.");
} catch (err) {
  logError(`E2E integration test failed: ${formatError(err)}`);

  if (err?.stack) {
    console.error(err.stack);
  }

  if (cleanup) {
    log("Attempting cleanup after failure...");
    if (createdPrNumber) await closePullRequest(createdPrNumber).catch(() => {});
    if (createdBranch) await deleteBranch(createdBranch).catch(() => {});
    if (createdIssueNumber) await closeIssue(createdIssueNumber).catch(() => {});
  }

  process.exit(1);
} finally {
  await rm(targetRoot, { recursive: true, force: true }).catch(() => {});
  await rm(evidenceRoot, { recursive: true, force: true }).catch(() => {});
  await repository.close();
}
