/**
 * scripts/e2e-integration.mjs
 *
 * Full end-to-end integration test against a real GitHub repository.
 *
 * Creates a GitHub issue, runs the RedDwarf pipeline
 * (intake -> planning -> approval -> dispatch -> developer -> validation -> optional SCM),
 * inspects the resulting state, and optionally cleans up.
 *
 * Required environment:
 *   GITHUB_TOKEN          - GitHub PAT with repo scope
 *   REDDWARF_MODEL_PROVIDER - anthropic or openai (default: anthropic)
 *   ANTHROPIC_API_KEY     - required when REDDWARF_MODEL_PROVIDER=anthropic
 *   OPENAI_API_KEY        - required when REDDWARF_MODEL_PROVIDER=openai
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
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import pg from "pg";
import { fileURLToPath } from "node:url";
import { loadRepoEnv } from "./lib/repo-env.mjs";

const { Client } = pg;

const __scriptdir = dirname(fileURLToPath(import.meta.url));
await loadRepoEnv();

import {
  dispatchReadyTask,
  resolveApprovalRequest,
  runPlanningPipeline,
  DeterministicDeveloperAgent,
  DeterministicScmAgent,
  DeterministicValidationAgent,
  createArchitectHandoffAwaiter,
  createDeveloperHandoffAwaiter,
  createGitHubWorkspaceRepoBootstrapper,
  createGitWorkspaceCommitPublisher,
  destroyTaskWorkspace
} from "../packages/control-plane/dist/index.js";
import { createPostgresPlanningRepository } from "../packages/evidence/dist/index.js";
import {
  createRestGitHubAdapter,
  intakeGitHubIssue,
  createHttpOpenClawDispatchAdapter
} from "../packages/integrations/dist/index.js";
import { createPlanningAgentForModelProvider } from "../packages/execution-plane/dist/index.js";
import {
  connectionString,
  createScriptLogger,
  formatError,
  postgresPoolConfig,
  refreshDerivedConfig,
  resolveModelProviderEnv
} from "./lib/config.mjs";

refreshDerivedConfig();

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
const modelProvider = resolveModelProviderEnv();
const requiredProviderSecret =
  modelProvider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
if (!process.env[requiredProviderSecret]) {
  logError(`${requiredProviderSecret} is required for REDDWARF_MODEL_PROVIDER=${modelProvider}`);
  process.exit(1);
}

const cleanup = process.env.E2E_CLEANUP === "true";
const useOpenClaw = process.env.E2E_USE_OPENCLAW === "true";
const openClawBaseUrl = process.env.OPENCLAW_BASE_URL ?? "";
const openClawHookToken = process.env.OPENCLAW_HOOK_TOKEN ?? "";
const timestamp = Date.now();
const defaultHostWorkspaceRoot = resolve(__scriptdir, "..", "runtime-data", "workspaces");
const baseTargetRoot = resolve(
  process.env.REDDWARF_HOST_WORKSPACE_ROOT ?? defaultHostWorkspaceRoot
);
process.env.REDDWARF_HOST_WORKSPACE_ROOT ??= baseTargetRoot;
const targetRoot = resolve(baseTargetRoot, `e2e-${timestamp}`);
const evidenceRoot = resolve(targetRoot, "..", `e2e-evidence-${timestamp}`);
const setupScriptPath = resolve(__scriptdir, "setup.mjs");

const repository = createPostgresPlanningRepository(connectionString, postgresPoolConfig);
const github = createRestGitHubAdapter();
const planner = createPlanningAgentForModelProvider(modelProvider);

function elapsed(startMs) {
  return `${((Date.now() - startMs) / 1000).toFixed(1)}s`;
}

function findLatestRunEvent(snapshot, code) {
  const runEvents = snapshot?.runEvents ?? [];
  for (let index = runEvents.length - 1; index >= 0; index -= 1) {
    if (runEvents[index]?.code === code) {
      return runEvents[index];
    }
  }
  return null;
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
  const encodedRef = encodeURIComponent(`heads/${branchName}`);
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/git/refs/${encodedRef}`,
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

  const hookUrl = `${openClawBaseUrl.replace(/\/+$/, "")}/hooks/agent`;
  log(`Preflight: verifying OpenClaw hook ingress at ${hookUrl}...`);

  let hookResponse;
  try {
    hookResponse = await fetch(hookUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openClawHookToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({})
    });
  } catch (err) {
    throw new Error(
      `E2E_USE_OPENCLAW=true but the OpenClaw hook ingress is not reachable at ${hookUrl}. ${formatError(err)}`
    );
  }

  if (hookResponse.status === 404) {
    throw new Error(
      `E2E_USE_OPENCLAW=true but ${hookUrl} returned 404. Enable OpenClaw hooks in openclaw.json before rerunning E2E.`
    );
  }

  if (hookResponse.status === 401 || hookResponse.status === 403) {
    throw new Error(
      `E2E_USE_OPENCLAW=true but ${hookUrl} rejected the configured OPENCLAW_HOOK_TOKEN with ${hookResponse.status}.`
    );
  }

  if (!hookResponse.ok && hookResponse.status !== 400) {
    const hookBody = await hookResponse.text().catch(() => "");
    throw new Error(
      `E2E_USE_OPENCLAW=true but OpenClaw hook ingress preflight returned ${hookResponse.status} for ${hookUrl}: ${hookBody}`
    );
  }

  log("Preflight complete: OpenClaw gateway and hook ingress are reachable.");
}

const runStart = Date.now();
let createdIssueNumber = null;
let createdPrNumber = null;
let createdBranch = null;
let dispatchResult = null;

try {
  await ensureLocalStackReady();
  await ensureRequestedOpenClawReady();
  await mkdir(baseTargetRoot, { recursive: true });

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
      "Add an `index.html` file at the repository root that displays a short story about the Red Dwarf cast members.",
      "The page should:",
      "- Be a valid, self-contained HTML5 document with inline CSS styling",
      "- Include a title heading: \"Red Dwarf: A Short Story\"",
      "- Tell a short fictional story (3-5 paragraphs) featuring Lister, Rimmer, Cat, Kryten, and Holly",
      "- Include character names styled in bold",
      "- Have a simple, readable layout with a max-width container",
      "",
      "## Acceptance Criteria",
      "- `index.html` exists at the repository root and is valid HTML5",
      "- The story mentions all five main characters: Lister, Rimmer, Cat, Kryten, and Holly",
      "- The page renders correctly when opened in a browser",
      "- No existing files are modified",
      "",
      "## Affected Paths",
      "- index.html",
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

  log(`Step 2/7: Running intake and planning pipeline (${useOpenClaw ? "Holly via OpenClaw" : "LLM call"})...`);
  const planningStart = Date.now();

  const intake = await intakeGitHubIssue({ github, repo, issueNumber: issue.issueNumber });
  log(`  Intake complete: "${intake.candidate.title}"`);

  const planningDeps = {
    repository,
    planner
  };

  if (useOpenClaw) {
    planningDeps.openClawDispatch = createHttpOpenClawDispatchAdapter();
    planningDeps.openClawArchitectAgentId = "reddwarf-analyst";
    planningDeps.openClawArchitectAwaiter = createArchitectHandoffAwaiter();
    planningDeps.architectTargetRoot = targetRoot;
  }

  const planningResult = await runPlanningPipeline(intake.planningInput, planningDeps);

  log(`  Planning complete (${elapsed(planningStart)})`);
  log(`  Task ID: ${planningResult.manifest.taskId}`);
  log(`  Next action: ${planningResult.nextAction}`);
  if (planningResult.hollyHandoffMarkdown) {
    log(`  Holly architect handoff: ${planningResult.hollyHandoffMarkdown.length} chars`);
  }
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

  log(`Step 4/5: Dispatching approved task (${useOpenClaw ? "OpenClaw developer handoff" : "deterministic dispatcher"})...`);
  const dispatchStart = Date.now();

  const dispatchDeps = {
    repository,
    developer: new DeterministicDeveloperAgent(),
    validator: new DeterministicValidationAgent(),
    scm: new DeterministicScmAgent(),
    github,
    workspaceRepoBootstrapper: createGitHubWorkspaceRepoBootstrapper(),
    workspaceCommitPublisher: createGitWorkspaceCommitPublisher()
  };

  if (useOpenClaw) {
    dispatchDeps.openClawDispatch = createHttpOpenClawDispatchAdapter();
    dispatchDeps.openClawCompletionAwaiter = createDeveloperHandoffAwaiter();
  }

  dispatchResult = await dispatchReadyTask(
    {
      taskId: planningResult.manifest.taskId,
      targetRoot,
      evidenceRoot
    },
    dispatchDeps
  );

  log(`  Dispatch complete (${elapsed(dispatchStart)})`);
  log(`  Outcome: ${dispatchResult.outcome}`);
  log(`  Final phase: ${dispatchResult.finalPhase}`);
  log(`  Phases executed: ${dispatchResult.phasesExecuted.join(" -> ") || "(none)"}`);
  if (dispatchResult.error) {
    log(`  Error: ${dispatchResult.error}`);
  }

  log("Step 5/5: Inspecting pipeline results...");

  const finalManifest = await repository.getManifest(planningResult.manifest.taskId);
  const snapshot = await repository.getTaskSnapshot(planningResult.manifest.taskId);
  const openClawDispatchEvent = findLatestRunEvent(snapshot, "OPENCLAW_DISPATCH");
  const openClawDispatchData =
    openClawDispatchEvent &&
    typeof openClawDispatchEvent.data === "object" &&
    openClawDispatchEvent.data !== null
      ? openClawDispatchEvent.data
      : null;

  createdPrNumber = finalManifest?.prNumber ?? createdPrNumber;
  createdBranch = finalManifest?.branchName ?? createdBranch;

  const report = {
    success:
      dispatchResult?.outcome === "completed" &&
      ((dispatchResult.finalPhase === "validation" &&
        finalManifest?.lifecycleStatus === "blocked" &&
        finalManifest?.currentPhase === "validation") ||
        (dispatchResult.finalPhase === "scm" &&
          finalManifest?.lifecycleStatus === "completed" &&
          finalManifest?.currentPhase === "scm")),
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
    planning: {
      runId: planningResult.runId,
      nextAction: planningResult.nextAction,
      specSummary: planningResult.spec?.summary?.slice(0, 200)
    },
    dispatch: {
      outcome: dispatchResult?.outcome ?? null,
      finalPhase: dispatchResult?.finalPhase ?? null,
      phasesExecuted: dispatchResult?.phasesExecuted ?? [],
      error: dispatchResult?.error ?? null
    },
    openClaw:
      openClawDispatchData
        ? {
            accepted: openClawDispatchData.accepted ?? null,
            sessionId: openClawDispatchData.sessionId ?? null
          }
        : null,
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

  log(`  Dispatch:   ${report.dispatch.outcome} (final phase: ${report.dispatch.finalPhase})`);
  log(`  Executed:   ${report.dispatch.phasesExecuted.join(" -> ") || "(none)"}`);

  if (report.task.prNumber) {
    log(`  PR:         #${report.task.prNumber}`);
  }
  if (report.task.branchName) {
    log(`  Branch:     ${report.task.branchName}`);
  }
  if (report.dispatch.error) {
    log(`  Error:      ${report.dispatch.error}`);
  }

  log("");
  log("  Evidence:");
  log(`    Phase records:    ${report.evidence.phaseRecordCount}`);
  log(`    Evidence records: ${report.evidence.evidenceRecordCount}`);
  log(`    Memory records:   ${report.evidence.memoryRecordCount}`);
  log(`    Run events:       ${report.evidence.runEventCount}`);
  log("");

  if (report.openClaw) {
    log("  OpenClaw:");
    log(`    Accepted:   ${report.openClaw.accepted}`);
    log(`    Session ID: ${report.openClaw.sessionId}`);
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
