import assert from "node:assert/strict";
import {
  DeterministicPlanningAgent,
  PlanningPipelineFailure,
  createBufferedPlanningLogger,
  runPlanningPipeline
} from "../packages/control-plane/dist/index.js";
import { PostgresPlanningRepository } from "../packages/evidence/dist/index.js";

const connectionString =
  process.env.HOST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://reddwarf:reddwarf@127.0.0.1:55432/reddwarf";

const repository = new PostgresPlanningRepository({ connectionString });
const unique = Date.now();
const successLogger = createBufferedPlanningLogger();
const failureLogger = createBufferedPlanningLogger();

const successInput = {
  source: {
    provider: "github",
    repo: "acme/platform",
    issueNumber: unique,
    issueUrl: `https://github.com/acme/platform/issues/${unique}`
  },
  title: "Verify observability success path",
  summary:
    "Run the planning pipeline through the live database and verify that structured logs, run events, and summaries are persisted for a successful planning run.",
  priority: 1,
  labels: ["ai-eligible"],
  acceptanceCriteria: ["Observability summary exists", "Structured logs are captured"],
  affectedPaths: ["docs/observability-success.md"],
  requestedCapabilities: ["can_plan", "can_archive_evidence"],
  metadata: {}
};

const failureInput = {
  source: {
    provider: "github",
    repo: "acme/platform",
    issueNumber: unique + 1,
    issueUrl: `https://github.com/acme/platform/issues/${unique + 1}`
  },
  title: "Verify observability failure path",
  summary:
    "Run the planning pipeline through the live database and verify that planning failures are classified, logged, and queryable from durable run summaries.",
  priority: 1,
  labels: ["ai-eligible"],
  acceptanceCriteria: ["Failure summary exists", "Failure class is persisted"],
  affectedPaths: ["docs/observability-failure.md"],
  requestedCapabilities: ["can_plan", "can_archive_evidence"],
  metadata: {}
};

try {
  const successResult = await runPlanningPipeline(successInput, {
    repository,
    planner: new DeterministicPlanningAgent(),
    logger: successLogger.logger
  });
  const successSummary = await repository.getRunSummary(successResult.manifest.taskId, successResult.runId);

  assert.ok(successSummary, "Expected a run summary for the successful planning run.");
  assert.equal(successSummary.status, "completed");
  assert.ok(successSummary.eventCounts.info >= 6, "Expected structured info events for the run.");
  assert.ok(
    successLogger.records.some((record) => record.bindings.code === "PIPELINE_COMPLETED"),
    "Expected a structured completion log record."
  );

  let failure;

  try {
    await runPlanningPipeline(failureInput, {
      repository,
      planner: {
        async createSpec() {
          throw new Error("Planner exploded during observability verification.");
        }
      },
      logger: failureLogger.logger
    });
    assert.fail("Expected the failure verification run to throw.");
  } catch (error) {
    assert.ok(error instanceof PlanningPipelineFailure, "Expected a classified planning pipeline failure.");
    failure = error;
  }

  const failedManifest = await repository.getManifest(failure.taskId);
  const failureSummary = await repository.getRunSummary(failure.taskId, failure.runId);

  assert.ok(failureSummary, "Expected a run summary for the failed planning run.");
  assert.equal(failureSummary.status, "failed");
  assert.equal(failureSummary.failureClass, "planning_failure");
  assert.equal(failedManifest?.lifecycleStatus, "failed");
  assert.ok(
    failureLogger.records.some((record) => record.bindings.failureClass === "planning_failure"),
    "Expected a structured failure log record."
  );

  console.log(
    JSON.stringify(
      {
        successTaskId: successResult.manifest.taskId,
        successRunId: successResult.runId,
        successEventCounts: successSummary.eventCounts,
        successTotalDurationMs: successSummary.totalDurationMs,
        failureTaskId: failure.taskId,
        failureRunId: failure.runId,
        failureClass: failureSummary.failureClass,
        failureCodes: failureSummary.failureCodes,
        successLogCount: successLogger.records.length,
        failureLogCount: failureLogger.records.length
      },
      null,
      2
    )
  );
} finally {
  await repository.close();
}