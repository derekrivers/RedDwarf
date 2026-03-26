import assert from "node:assert/strict";
import {
  DeterministicPlanningAgent,
  resolveApprovalRequest,
  runPlanningPipeline
} from "../packages/control-plane/dist/index.js";
import { PostgresPlanningRepository } from "../packages/evidence/dist/index.js";

const connectionString =
  process.env.HOST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://reddwarf:reddwarf@127.0.0.1:55432/reddwarf";

const repository = new PostgresPlanningRepository({ connectionString });
const issueNumber = Date.now();
const repo = `approval-${issueNumber}/platform-${issueNumber}`;

try {
  const result = await runPlanningPipeline(
    {
      source: {
        provider: "github",
        repo,
        issueNumber,
        issueUrl: `https://github.com/${repo}/issues/${issueNumber}`
      },
      title: "Verify approval queue workflow",
      summary:
        "Run a planning task that requires human approval, verify the durable approval queue entry, and resolve the decision against live Postgres.",
      priority: 1,
      labels: ["ai-eligible"],
      acceptanceCriteria: [
        "Approval request is queued",
        "Approval decision updates task state"
      ],
      affectedPaths: ["src/approval-flow.ts"],
      requestedCapabilities: ["can_write_code"],
      metadata: {}
    },
    {
      repository,
      planner: new DeterministicPlanningAgent(),
      clock: () => new Date("2026-03-25T18:00:00.000Z"),
      idGenerator: () => `approval-${issueNumber}`
    }
  );

  const queuedRequest = result.approvalRequest;
  assert.ok(queuedRequest);
  const snapshot = await repository.getTaskSnapshot(result.manifest.taskId);
  const runSummary = await repository.getRunSummary(
    result.manifest.taskId,
    result.runId
  );

  assert.equal(result.manifest.lifecycleStatus, "blocked");
  assert.equal(queuedRequest?.status, "pending");
  assert.equal(snapshot.approvalRequests.length, 1);
  assert.equal(snapshot.pipelineRuns[0]?.status, "blocked");
  assert.equal(runSummary?.status, "blocked");

  const resolved = await resolveApprovalRequest(
    {
      requestId: queuedRequest.requestId,
      decision: "approve",
      decidedBy: "operator",
      decisionSummary: "Approved for developer orchestration.",
      comment: "Live verification path succeeded."
    },
    {
      repository,
      clock: () => new Date("2026-03-25T18:05:00.000Z")
    }
  );
  const persistedRequest = await repository.getApprovalRequest(
    queuedRequest.requestId
  );
  const persistedManifest = await repository.getManifest(
    result.manifest.taskId
  );

  assert.equal(resolved.manifest.lifecycleStatus, "ready");
  assert.equal(persistedRequest?.status, "approved");
  assert.equal(persistedRequest?.decision, "approve");
  assert.equal(persistedManifest?.lifecycleStatus, "ready");

  console.log(
    JSON.stringify(
      {
        taskId: result.manifest.taskId,
        runId: result.runId,
        queuedRequest,
        resolvedRequest: persistedRequest,
        manifest: persistedManifest
      },
      null,
      2
    )
  );
} finally {
  await repository.close();
}
