import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DeterministicDeveloperAgent,
  DeterministicPlanningAgent,
  DeterministicScmAgent,
  DeterministicValidationAgent,
  PlanningPipelineFailure,
  destroyTaskWorkspace,
  dispatchReadyTask,
  resolveApprovalRequest,
  runDeveloperPhase,
  runPlanningPipeline,
  runValidationPhase
} from "../packages/control-plane/dist/index.js";
import { createPostgresPlanningRepository } from "../packages/evidence/dist/index.js";
import { FixtureGitHubAdapter } from "../packages/integrations/dist/index.js";
import { connectionString, postgresPoolConfig } from "./lib/config.mjs";

const issueNumber = Date.now();
const repo = `recovery-${issueNumber}/platform-${issueNumber}`;
const targetRoot = resolve(
  process.env.REDDWARF_HOST_WORKSPACE_ROOT ??
    join(tmpdir(), "reddwarf-recovery-verify", `verify-${issueNumber}`)
);
const repository = createPostgresPlanningRepository(connectionString, postgresPoolConfig);

const failingValidator = {
  async createPlan() {
    return {
      summary: "Force a failing validation command.",
      commands: [
        {
          id: "failing-test",
          name: "Failing validation command",
          executable: process.execPath,
          args: ["-e", "process.exit(9)"]
        }
      ]
    };
  }
};

try {
  const planningResult = await runPlanningPipeline(
    {
      source: {
        provider: "github",
        repo,
        issueNumber,
        issueUrl: `https://github.com/${repo}/issues/${issueNumber}`
      },
      title: "Verify failure recovery automation",
      summary:
        "Run a task through developer and validation, exhaust the validation retry budget, and verify the control plane blocks the task with a follow-up issue and pending escalation request.",
      priority: 1,
      labels: ["ai-eligible"],
      acceptanceCriteria: [
        "Validation failures queue a retry",
        "Retry exhaustion escalates and opens a follow-up issue"
      ],
      affectedPaths: ["src/recovery-phase.ts"],
      requestedCapabilities: ["can_write_code"],
      metadata: {}
    },
    {
      repository,
      planner: new DeterministicPlanningAgent(),
      clock: () => new Date("2026-03-25T18:00:00.000Z"),
      idGenerator: () => `recovery-plan-${issueNumber}`
    }
  );

  await resolveApprovalRequest(
    {
      requestId: planningResult.approvalRequest.requestId,
      decision: "approve",
      decidedBy: "operator",
      decisionSummary: "Approved for recovery verification.",
      comment: "Exercise failure recovery automation."
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
      workspaceId: `${planningResult.manifest.taskId}-recovery-verify`
    },
    {
      repository,
      developer: new DeterministicDeveloperAgent(),
      clock: () => new Date("2026-03-25T18:10:00.000Z"),
      idGenerator: () => `recovery-dev-${issueNumber}`
    }
  );

  await assert.rejects(
    () =>
      runValidationPhase(
        {
          taskId: planningResult.manifest.taskId,
          targetRoot
        },
        {
          repository,
          validator: failingValidator,
          clock: () => new Date("2026-03-25T18:15:00.000Z"),
          idGenerator: () => `recovery-validation-first-${issueNumber}`
        }
      ),
    PlanningPipelineFailure
  );

  await assert.rejects(
    () =>
      runValidationPhase(
        {
          taskId: planningResult.manifest.taskId,
          targetRoot
        },
        {
          repository,
          validator: failingValidator,
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
              allowIssueCreation: true,
              issueNumberStart: 701
            }
          }),
          clock: () => new Date("2026-03-25T18:20:00.000Z"),
          idGenerator: () => `recovery-validation-second-${issueNumber}`
        }
      ),
    PlanningPipelineFailure
  );

  const snapshot = await repository.getTaskSnapshot(planningResult.manifest.taskId);
  const runSummary = await repository.getRunSummary(
    planningResult.manifest.taskId,
    `recovery-validation-second-${issueNumber}`
  );
  const failureRequest = snapshot.approvalRequests.find(
    (request) =>
      request.phase === "validation" &&
      request.status === "pending" &&
      request.requestedBy === "failure-automation"
  );
  const followUpIssue = snapshot.memoryRecords.find(
    (record) => record.key === "failure.follow_up_issue.validation"
  );
  const recoveryMemory = snapshot.memoryRecords.find(
    (record) => record.key === "failure.recovery"
  );

  assert.equal(snapshot.manifest?.lifecycleStatus, "blocked");
  assert.equal(snapshot.manifest?.currentPhase, "validation");
  assert.equal(snapshot.manifest?.retryCount, 1);
  assert.equal(runSummary?.status, "blocked");
  assert.equal(failureRequest?.requestedBy, "failure-automation");
  assert.equal(failureRequest?.status, "pending");
  assert.equal(recoveryMemory?.value.action, "escalate");
  assert.equal(recoveryMemory?.value.retryLimit, 1);
  assert.equal(followUpIssue?.value.issueNumber, 701);
  assert.match(String(followUpIssue?.value.title), /Validation failure/);
  assert.ok(
    snapshot.runEvents.some((event) => event.code === "PHASE_ESCALATED")
  );
  assert.ok(
    snapshot.runEvents.some((event) => event.code === "FOLLOW_UP_ISSUE_CREATED")
  );

  await resolveApprovalRequest(
    {
      requestId: failureRequest.requestId,
      decision: "approve",
      decidedBy: "operator",
      decisionSummary: "Resume directly at validation for recovery verification.",
      comment: "Feature 102 verification path."
    },
    {
      repository,
      clock: () => new Date("2026-03-25T18:25:00.000Z")
    }
  );

  const resumeResult = await dispatchReadyTask(
    {
      taskId: planningResult.manifest.taskId,
      targetRoot
    },
    {
      repository,
      developer: new DeterministicDeveloperAgent(),
      validator: new DeterministicValidationAgent(),
      scm: new DeterministicScmAgent(),
      github: new FixtureGitHubAdapter({ candidates: [] }),
      clock: () => new Date("2026-03-25T18:30:00.000Z")
    }
  );

  const resumedSnapshot = await repository.getTaskSnapshot(planningResult.manifest.taskId);

  assert.equal(resumeResult.outcome, "completed");
  assert.equal(resumeResult.finalPhase, "validation");
  assert.deepEqual(resumeResult.phasesExecuted, ["validation"]);
  assert.equal(resumedSnapshot.manifest?.currentPhase, "validation");
  assert.equal(resumedSnapshot.manifest?.lifecycleStatus, "blocked");

  await destroyTaskWorkspace({
    manifest: resumedSnapshot.manifest,
    repository,
    targetRoot
  });

  console.log(
    JSON.stringify(
      {
        taskId: planningResult.manifest.taskId,
        planningRunId: planningResult.runId,
        validationRunId: `recovery-validation-second-${issueNumber}`,
        manifest: resumedSnapshot.manifest,
        failureRequest,
        followUpIssue: followUpIssue?.value ?? null,
        recoveryMemory: recoveryMemory?.value ?? null,
        runSummary,
        resumeResult
      },
      null,
      2
    )
  );
} finally {
  await rm(targetRoot, { recursive: true, force: true }).catch(() => {});
  await repository.close();
}