import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DeterministicDeveloperAgent,
  DeterministicPlanningAgent,
  DeterministicScmAgent,
  DeterministicValidationAgent,
  destroyTaskWorkspace,
  resolveApprovalRequest,
  runDeveloperPhase,
  runPlanningPipeline,
  runScmPhase,
  runValidationPhase
} from "../packages/control-plane/dist/index.js";
import { PostgresPlanningRepository } from "../packages/evidence/dist/index.js";
import { FixtureGitHubAdapter } from "../packages/integrations/dist/index.js";
import { connectionString } from "./lib/config.mjs";

const connectionString =
  process.env.HOST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://reddwarf:reddwarf@127.0.0.1:55532/reddwarf";
const baseTargetRoot = resolve(
  process.env.REDDWARF_HOST_WORKSPACE_ROOT ?? join(tmpdir(), "reddwarf-scm-verify")
);
const repository = new PostgresPlanningRepository({ connectionString });
const issueNumber = Date.now();
const targetRoot = resolve(baseTargetRoot, `verify-${issueNumber}`);
const repo = `scm-${issueNumber}/platform-${issueNumber}`;

try {
  const planningResult = await runPlanningPipeline(
    {
      source: {
        provider: "github",
        repo,
        issueNumber,
        issueUrl: `https://github.com/${repo}/issues/${issueNumber}`
      },
      title: "Verify SCM phase orchestration",
      summary:
        "Run a planning task that requires validation before opening an approved branch and pull request, then verify the SCM phase persists the resulting branch and PR metadata.",
      priority: 1,
      labels: ["ai-eligible"],
      acceptanceCriteria: [
        "Validation hands off to SCM",
        "SCM creates branch and pull request artifacts"
      ],
      affectedPaths: ["src/scm-phase.ts"],
      requestedCapabilities: ["can_write_code", "can_open_pr"],
      metadata: {
        github: {
          baseBranch: "main"
        }
      }
    },
    {
      repository,
      planner: new DeterministicPlanningAgent(),
      clock: () => new Date("2026-03-25T18:00:00.000Z"),
      idGenerator: () => `scm-plan-${issueNumber}`
    }
  );

  await resolveApprovalRequest(
    {
      requestId: planningResult.approvalRequest.requestId,
      decision: "approve",
      decidedBy: "operator",
      decisionSummary: "Approved for SCM orchestration.",
      comment: "Open the branch and pull request after validation."
    },
    {
      repository,
      clock: () => new Date("2026-03-25T18:05:00.000Z")
    }
  );

  await runDeveloperPhase(
    {
      taskId: planningResult.manifest.taskId,
      targetRoot,
      workspaceId: `${planningResult.manifest.taskId}-scm-verify`
    },
    {
      repository,
      developer: new DeterministicDeveloperAgent(),
      clock: () => new Date("2026-03-25T18:10:00.000Z"),
      idGenerator: () => `scm-dev-${issueNumber}`
    }
  );

  const validation = await runValidationPhase(
    {
      taskId: planningResult.manifest.taskId,
      targetRoot
    },
    {
      repository,
      validator: new DeterministicValidationAgent(),
      clock: () => new Date("2026-03-25T18:15:00.000Z"),
      idGenerator: () => `scm-validation-${issueNumber}`
    }
  );

  const scm = await runScmPhase(
    {
      taskId: planningResult.manifest.taskId,
      targetRoot
    },
    {
      repository,
      scm: new DeterministicScmAgent(),
      github: new FixtureGitHubAdapter({
        candidates: [
          {
            repo,
            issueNumber,
            title: planningResult.manifest.title,
            body: planningResult.manifest.summary,
            labels: ["ai-eligible"],
            url: `https://github.com/${repo}/issues/${issueNumber}`,
            state: "open"
          }
        ],
        mutations: {
          allowBranchCreation: true,
          allowPullRequestCreation: true,
          pullRequestNumberStart: 91
        }
      }),
      clock: () => new Date("2026-03-25T18:20:00.000Z"),
      idGenerator: () => `scm-run-${issueNumber}`
    }
  );

  const persistedManifest = await repository.getManifest(planningResult.manifest.taskId);
  const runSummary = await repository.getRunSummary(
    planningResult.manifest.taskId,
    scm.runId
  );
  const reportMarkdown = await readFile(scm.reportPath, "utf8");

  assert.equal(validation.nextAction, "await_scm");
  assert.equal(scm.nextAction, "complete");
  assert.equal(scm.workspace.descriptor.toolPolicy.mode, "scm_only");
  assert.equal(persistedManifest?.currentPhase, "scm");
  assert.equal(persistedManifest?.lifecycleStatus, "completed");
  assert.equal(persistedManifest?.prNumber, 91);
  assert.equal(persistedManifest?.branchName, scm.branch.branchName);
  assert.equal(runSummary?.status, "completed");
  assert.equal(runSummary?.latestPhase, "scm");
  assert.match(reportMarkdown, /SCM Report/);
  assert.match(reportMarkdown, /Pull Request URL/);

  await destroyTaskWorkspace({
    manifest: scm.manifest,
    repository,
    targetRoot
  });

  console.log(
    JSON.stringify(
      {
        taskId: planningResult.manifest.taskId,
        planningRunId: planningResult.runId,
        validationRunId: validation.runId,
        scmRunId: scm.runId,
        branch: scm.branch,
        pullRequest: scm.pullRequest,
        manifest: persistedManifest,
        runSummary
      },
      null,
      2
    )
  );
} finally {
  await rm(targetRoot, { recursive: true, force: true }).catch(() => {});
  await repository.close();
}
