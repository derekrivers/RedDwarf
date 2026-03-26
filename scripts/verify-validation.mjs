import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DeterministicDeveloperAgent,
  DeterministicPlanningAgent,
  DeterministicValidationAgent,
  destroyTaskWorkspace,
  resolveApprovalRequest,
  runDeveloperPhase,
  runPlanningPipeline,
  runValidationPhase
} from "../packages/control-plane/dist/index.js";
import { PostgresPlanningRepository } from "../packages/evidence/dist/index.js";

const connectionString =
  process.env.HOST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://reddwarf:reddwarf@127.0.0.1:55432/reddwarf";
const baseTargetRoot = resolve(
  process.env.REDDWARF_HOST_WORKSPACE_ROOT ??
    join(tmpdir(), "reddwarf-validation-verify")
);
const repository = new PostgresPlanningRepository({ connectionString });
const issueNumber = Date.now();
const targetRoot = resolve(baseTargetRoot, `verify-${issueNumber}`);
const repo = `validation-${issueNumber}/platform-${issueNumber}`;

try {
  const planningResult = await runPlanningPipeline(
    {
      source: {
        provider: "github",
        repo,
        issueNumber,
        issueUrl: `https://github.com/${repo}/issues/${issueNumber}`
      },
      title: "Verify validation phase orchestration",
      summary:
        "Run a planning task that requires human approval, capture the developer handoff, run deterministic validation commands in the managed workspace, and verify the task blocks cleanly pending review.",
      priority: 1,
      labels: ["ai-eligible"],
      acceptanceCriteria: [
        "Validation workspace exists",
        "Validation report is archived"
      ],
      affectedPaths: ["src/validation-phase.ts"],
      requestedCapabilities: ["can_write_code"],
      metadata: {}
    },
    {
      repository,
      planner: new DeterministicPlanningAgent(),
      clock: () => new Date("2026-03-25T18:00:00.000Z"),
      idGenerator: () => `validation-plan-${issueNumber}`
    }
  );

  const resolved = await resolveApprovalRequest(
    {
      requestId: planningResult.approvalRequest.requestId,
      decision: "approve",
      decidedBy: "operator",
      decisionSummary: "Approved for validation orchestration.",
      comment: "Keep product writes disabled."
    },
    {
      repository,
      clock: () => new Date("2026-03-25T18:05:00.000Z")
    }
  );

  const development = await runDeveloperPhase(
    {
      taskId: planningResult.manifest.taskId,
      targetRoot,
      workspaceId: `${planningResult.manifest.taskId}-validation-verify`
    },
    {
      repository,
      developer: new DeterministicDeveloperAgent(),
      clock: () => new Date("2026-03-25T18:10:00.000Z"),
      idGenerator: () => `validation-dev-${issueNumber}`
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
      idGenerator: () => `validation-run-${issueNumber}`
    }
  );
  const persistedManifest = await repository.getManifest(
    planningResult.manifest.taskId
  );
  const runSummary = await repository.getRunSummary(
    planningResult.manifest.taskId,
    validation.runId
  );
  const reportMarkdown = await readFile(validation.reportPath, "utf8");

  assert.equal(resolved.manifest.lifecycleStatus, "ready");
  assert.equal(development.nextAction, "await_validation");
  assert.equal(validation.nextAction, "await_review");
  assert.equal(
    validation.workspace.descriptor.toolPolicy.mode,
    "validation_only"
  );
  assert.equal(
    validation.workspace.descriptor.toolPolicy.codeWriteEnabled,
    false
  );
  assert.equal(
    validation.workspace.descriptor.toolPolicy.allowedCapabilities.includes(
      "can_run_tests"
    ),
    true
  );
  assert.equal(persistedManifest?.currentPhase, "validation");
  assert.equal(persistedManifest?.lifecycleStatus, "blocked");
  assert.equal(runSummary?.status, "blocked");
  assert.equal(runSummary?.latestPhase, "validation");
  assert.match(reportMarkdown, /Validation Report/);

  await destroyTaskWorkspace({
    manifest: validation.manifest,
    repository,
    targetRoot
  });

  console.log(
    JSON.stringify(
      {
        taskId: planningResult.manifest.taskId,
        planningRunId: planningResult.runId,
        developmentRunId: development.runId,
        validationRunId: validation.runId,
        workspaceId: validation.workspace.workspaceId,
        toolPolicy: validation.workspace.descriptor.toolPolicy,
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
