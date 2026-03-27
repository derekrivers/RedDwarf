import assert from "node:assert/strict";
import { DeterministicPlanningAgent, runPlanningPipeline } from "../packages/control-plane/dist/index.js";
import { PostgresPlanningRepository, createPipelineRun } from "../packages/evidence/dist/index.js";
import { connectionString } from "./lib/config.mjs";

const repository = new PostgresPlanningRepository({ connectionString });
const issueNumber = Date.now();
const repo = `concurrency-${issueNumber}/platform-${issueNumber}`;
const concurrencyKey = `github:${repo}:${issueNumber}`;
const taskId = `${repo.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase()}-${issueNumber}`;

try {
  await repository.savePipelineRun(
    createPipelineRun({
      runId: `stale-${issueNumber}`,
      taskId,
      concurrencyKey,
      strategy: "serialize",
      status: "active",
      startedAt: "2026-03-25T17:45:00.000Z",
      lastHeartbeatAt: "2026-03-25T17:45:00.000Z",
      metadata: {}
    })
  );

  const input = {
    source: {
      provider: "github",
      repo,
      issueNumber,
      issueUrl: `https://github.com/${repo}/issues/${issueNumber}`
    },
    title: "Verify concurrency controls",
    summary:
      "Verify that stale overlapping runs are retired and fresh overlaps are blocked conservatively in the Postgres-backed planning pipeline.",
    priority: 1,
    labels: ["ai-eligible"],
    acceptanceCriteria: ["Stale runs are marked", "Fresh overlaps are blocked"],
    affectedPaths: ["docs/concurrency-verification.md"],
    requestedCapabilities: ["can_plan", "can_archive_evidence"],
    metadata: {}
  };

  const staleResult = await runPlanningPipeline(input, {
    repository,
    planner: new DeterministicPlanningAgent(),
    clock: () => new Date("2026-03-25T18:00:00.000Z"),
    idGenerator: () => `fresh-${issueNumber}`,
    concurrency: {
      staleAfterMs: 60_000
    }
  });

  await repository.savePipelineRun(
    createPipelineRun({
      runId: `active-${issueNumber}`,
      taskId,
      concurrencyKey,
      strategy: "serialize",
      status: "active",
      startedAt: "2026-03-25T18:00:01.000Z",
      lastHeartbeatAt: "2026-03-25T18:00:01.000Z",
      metadata: {}
    })
  );

  const blockedResult = await runPlanningPipeline(input, {
    repository,
    planner: new DeterministicPlanningAgent(),
    clock: () => new Date("2026-03-25T18:00:05.000Z"),
    idGenerator: () => `blocked-${issueNumber}`,
    concurrency: {
      staleAfterMs: 60_000
    }
  });

  const pipelineRuns = await repository.listPipelineRuns({ concurrencyKey, limit: 10 });
  const blockedSummary = await repository.getRunSummary(taskId, `blocked-${issueNumber}`);

  assert.deepEqual(staleResult.concurrencyDecision.staleRunIds, [`stale-${issueNumber}`]);
  assert.equal(blockedResult.concurrencyDecision.action, "block");
  assert.equal(blockedResult.concurrencyDecision.blockedByRunId, `active-${issueNumber}`);
  assert.equal(blockedSummary?.status, "blocked");
  assert.equal(blockedSummary?.failureClass, "execution_loop");
  assert.equal(pipelineRuns.find((run) => run.runId === `stale-${issueNumber}`)?.status, "stale");
  assert.equal(pipelineRuns.find((run) => run.runId === `fresh-${issueNumber}`)?.status, "completed");
  assert.equal(pipelineRuns.find((run) => run.runId === `blocked-${issueNumber}`)?.status, "blocked");

  console.log(
    JSON.stringify(
      {
        taskId,
        concurrencyKey,
        staleDecision: staleResult.concurrencyDecision,
        blockedDecision: blockedResult.concurrencyDecision,
        pipelineRuns: pipelineRuns.map((run) => ({
          runId: run.runId,
          status: run.status,
          blockedByRunId: run.blockedByRunId,
          staleAt: run.staleAt
        })),
        blockedSummary
      },
      null,
      2
    )
  );
} finally {
  await repository.close();
}
