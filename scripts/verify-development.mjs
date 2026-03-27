import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DeterministicDeveloperAgent,
  DeterministicPlanningAgent,
  destroyTaskWorkspace,
  resolveApprovalRequest,
  runDeveloperPhase,
  runPlanningPipeline
} from "../packages/control-plane/dist/index.js";
import { PostgresPlanningRepository } from "../packages/evidence/dist/index.js";
import { connectionString } from "./lib/config.mjs";

const baseTargetRoot = resolve(
  process.env.REDDWARF_HOST_WORKSPACE_ROOT ??
    join(tmpdir(), "reddwarf-development-verify")
);
const baseEvidenceRoot = resolve(
  process.env.REDDWARF_HOST_EVIDENCE_ROOT ??
    join(tmpdir(), "reddwarf-runtime-evidence-development-verify")
);
const repository = new PostgresPlanningRepository({ connectionString });
const issueNumber = Date.now();
const targetRoot = resolve(baseTargetRoot, `verify-${issueNumber}`);
const evidenceRoot = resolve(baseEvidenceRoot, `verify-${issueNumber}`);
const repo = `developer-${issueNumber}/platform-${issueNumber}`;

try {
  const planningResult = await runPlanningPipeline(
    {
      source: {
        provider: "github",
        repo,
        issueNumber,
        issueUrl: `https://github.com/${repo}/issues/${issueNumber}`
      },
      title: "Verify developer phase orchestration",
      summary:
        "Run a planning task that requires human approval, enter the developer phase after approval, and verify that the workspace handoff is captured while code writing stays disabled.",
      priority: 1,
      labels: ["ai-eligible"],
      acceptanceCriteria: [
        "Developer workspace exists",
        "Developer handoff is archived"
      ],
      affectedPaths: ["src/developer-phase.ts"],
      requestedCapabilities: ["can_write_code"],
      metadata: {}
    },
    {
      repository,
      planner: new DeterministicPlanningAgent(),
      clock: () => new Date("2026-03-25T18:00:00.000Z"),
      idGenerator: () => `developer-plan-${issueNumber}`
    }
  );

  const resolved = await resolveApprovalRequest(
    {
      requestId: planningResult.approvalRequest.requestId,
      decision: "approve",
      decidedBy: "operator",
      decisionSummary: "Approved for developer orchestration.",
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
      workspaceId: `${planningResult.manifest.taskId}-development-verify`,
      evidenceRoot
    },
    {
      repository,
      developer: new DeterministicDeveloperAgent(),
      clock: () => new Date("2026-03-25T18:10:00.000Z"),
      idGenerator: () => `developer-run-${issueNumber}`
    }
  );
  const persistedManifest = await repository.getManifest(
    planningResult.manifest.taskId
  );
  const runSummary = await repository.getRunSummary(
    planningResult.manifest.taskId,
    development.runId
  );
  const handoffMarkdown = await readFile(development.handoffPath, "utf8");

  assert.equal(resolved.manifest.lifecycleStatus, "ready");
  assert.equal(development.nextAction, "await_validation");
  assert.equal(
    development.workspace.descriptor.toolPolicy.mode,
    "development_readonly"
  );
  assert.equal(
    development.workspace.descriptor.toolPolicy.codeWriteEnabled,
    false
  );
  assert.equal(persistedManifest?.currentPhase, "development");
  assert.equal(persistedManifest?.lifecycleStatus, "blocked");
  assert.equal(runSummary?.status, "blocked");
  assert.equal(runSummary?.latestPhase, "development");
  assert.match(handoffMarkdown, /Development Handoff/);

  await destroyTaskWorkspace({
    manifest: development.manifest,
    repository,
    targetRoot,
    evidenceRoot
  });

  console.log(
    JSON.stringify(
      {
        taskId: planningResult.manifest.taskId,
        planningRunId: planningResult.runId,
        developmentRunId: development.runId,
        workspaceId: development.workspace.workspaceId,
        toolPolicy: development.workspace.descriptor.toolPolicy,
        manifest: persistedManifest,
        runSummary
      },
      null,
      2
    )
  );
} finally {
  await rm(targetRoot, { recursive: true, force: true }).catch(() => {});
  await rm(evidenceRoot, { recursive: true, force: true }).catch(() => {});
  await repository.close();
}
