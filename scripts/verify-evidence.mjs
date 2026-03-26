import assert from "node:assert/strict";
import { access, readFile, rm } from "node:fs/promises";
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

const connectionString =
  process.env.HOST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://reddwarf:reddwarf@127.0.0.1:55432/reddwarf";
const baseTargetRoot = resolve(
  process.env.REDDWARF_HOST_WORKSPACE_ROOT ?? join(tmpdir(), "reddwarf-evidence-verify")
);
const baseEvidenceRoot = resolve(
  process.env.REDDWARF_HOST_EVIDENCE_ROOT ??
    join(tmpdir(), "reddwarf-runtime-evidence-verify")
);
const repository = new PostgresPlanningRepository({ connectionString });
const issueNumber = Date.now();
const targetRoot = resolve(baseTargetRoot, `verify-${issueNumber}`);
const evidenceRoot = resolve(baseEvidenceRoot, `verify-${issueNumber}`);
const repo = `evidence-${issueNumber}/platform-${issueNumber}`;

try {
  const planningResult = await runPlanningPipeline(
    {
      source: {
        provider: "github",
        repo,
        issueNumber,
        issueUrl: `https://github.com/${repo}/issues/${issueNumber}`
      },
      title: "Verify evidence artifact archival",
      summary:
        "Run an approved development, validation, and SCM flow, then destroy the workspace and confirm archived diffs, logs, test results, and reports remain durable in the evidence root.",
      priority: 1,
      labels: ["ai-eligible"],
      acceptanceCriteria: [
        "Archived evidence survives workspace destruction",
        "Diff, log, test-result, and report artifacts are durable"
      ],
      affectedPaths: ["src/evidence-plane.ts"],
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
      idGenerator: () => `evidence-plan-${issueNumber}`
    }
  );

  await resolveApprovalRequest(
    {
      requestId: planningResult.approvalRequest.requestId,
      decision: "approve",
      decidedBy: "operator",
      decisionSummary: "Approved for durable evidence archival.",
      comment: "Run through SCM and archive the resulting artifacts."
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
      workspaceId: `${planningResult.manifest.taskId}-evidence-verify`,
      evidenceRoot
    },
    {
      repository,
      developer: new DeterministicDeveloperAgent(),
      clock: () => new Date("2026-03-25T18:10:00.000Z"),
      idGenerator: () => `evidence-dev-${issueNumber}`
    }
  );

  const validation = await runValidationPhase(
    {
      taskId: planningResult.manifest.taskId,
      targetRoot,
      evidenceRoot
    },
    {
      repository,
      validator: new DeterministicValidationAgent(),
      clock: () => new Date("2026-03-25T18:15:00.000Z"),
      idGenerator: () => `evidence-validation-${issueNumber}`
    }
  );

  const scm = await runScmPhase(
    {
      taskId: planningResult.manifest.taskId,
      targetRoot,
      evidenceRoot
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
          pullRequestNumberStart: 101
        }
      }),
      clock: () => new Date("2026-03-25T18:20:00.000Z"),
      idGenerator: () => `evidence-scm-${issueNumber}`
    }
  );

  const snapshot = await repository.getTaskSnapshot(planningResult.manifest.taskId);
  const archivedArtifacts = snapshot.evidenceRecords.filter(
    (record) => typeof record.metadata.archivePath === "string"
  );
  const runSummary = await repository.getRunSummary(
    planningResult.manifest.taskId,
    scm.runId
  );

  assert.equal(validation.nextAction, "await_scm");
  assert.equal(scm.nextAction, "complete");
  assert.equal(snapshot.manifest?.lifecycleStatus, "completed");
  assert.equal(runSummary?.latestPhase, "scm");
  assert.deepEqual(
    new Set(archivedArtifacts.map((record) => record.metadata.artifactClass)),
    new Set(["handoff", "log", "report", "test_result", "diff"])
  );

  const resultsRecord = archivedArtifacts.find(
    (record) => record.metadata.artifactClass === "test_result"
  );
  const diffRecord = archivedArtifacts.find(
    (record) => record.metadata.artifactClass === "diff"
  );

  assert.ok(resultsRecord, "Expected a validation test-result artifact.");
  assert.ok(diffRecord, "Expected an SCM diff artifact.");

  await destroyTaskWorkspace({
    manifest: scm.manifest,
    repository,
    targetRoot,
    evidenceRoot
  });

  for (const record of archivedArtifacts) {
    assert.match(record.location, /^evidence:\/\//);
    await access(record.metadata.archivePath);
  }

  const archivedResults = JSON.parse(
    await readFile(resultsRecord.metadata.archivePath, "utf8")
  );
  const archivedDiff = await readFile(diffRecord.metadata.archivePath, "utf8");

  assert.equal(archivedResults.taskId, planningResult.manifest.taskId);
  assert.equal(archivedResults.runId, validation.runId);
  assert.match(archivedDiff, /SCM Diff Summary/);
  assert.match(
    archivedDiff,
    /No product-repo diff patch was generated because RedDwarf still keeps product code writes disabled by default\./
  );

  console.log(
    JSON.stringify(
      {
        taskId: planningResult.manifest.taskId,
        validationRunId: validation.runId,
        scmRunId: scm.runId,
        evidenceRoot,
        archivedArtifacts: archivedArtifacts.map((record) => ({
          recordId: record.recordId,
          title: record.title,
          location: record.location,
          artifactClass: record.metadata.artifactClass,
          archivePath: record.metadata.archivePath
        })),
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