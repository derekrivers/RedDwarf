import assert from "node:assert/strict";
import { DeterministicPlanningAgent, runPlanningPipeline } from "../packages/control-plane/dist/index.js";
import { PostgresPlanningRepository } from "../packages/evidence/dist/index.js";

const connectionString =
  process.env.HOST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://reddwarf:reddwarf@127.0.0.1:55432/reddwarf";

const repository = new PostgresPlanningRepository({ connectionString });
const unique = Date.now();
const input = {
  source: {
    provider: "github",
    repo: "acme/platform",
    issueNumber: unique,
    issueUrl: `https://github.com/acme/platform/issues/${unique}`
  },
  title: "Verify Postgres planning persistence",
  summary:
    "Run the planning pipeline against live Postgres and verify that manifests, phase records, policy snapshots, evidence, and observability events are persisted.",
  priority: 1,
  labels: ["ai-eligible"],
  acceptanceCriteria: ["The planning spec is stored", "Audit records are queryable"],
  affectedPaths: ["docs/verification.md"],
  requestedCapabilities: ["can_plan", "can_archive_evidence"],
  metadata: {}
};

try {
  const result = await runPlanningPipeline(input, {
    repository,
    planner: new DeterministicPlanningAgent()
  });

  const manifest = await repository.getManifest(result.manifest.taskId);
  const snapshot = await repository.getTaskSnapshot(result.manifest.taskId);
  const runSummary = await repository.getRunSummary(result.manifest.taskId, result.runId);

  assert.ok(manifest, "Expected a persisted manifest.");
  assert.ok(snapshot.spec, "Expected a persisted planning spec.");
  assert.ok(snapshot.policySnapshot, "Expected a persisted policy snapshot.");
  assert.equal(snapshot.phaseRecords.length, 5, "Expected 5 phase records.");
  assert.ok(snapshot.evidenceRecords.length >= 3, "Expected evidence records to be persisted.");
  assert.ok(snapshot.runEvents.length >= 7, "Expected run events to be persisted.");
  assert.equal(runSummary?.status, "completed", "Expected a completed run summary.");

  console.log(
    JSON.stringify(
      {
        taskId: result.manifest.taskId,
        runId: result.runId,
        approvalMode: result.policySnapshot?.approvalMode ?? null,
        phaseRecordCount: snapshot.phaseRecords.length,
        evidenceRecordCount: snapshot.evidenceRecords.length,
        runEventCount: snapshot.runEvents.length,
        policySnapshotPersisted: snapshot.policySnapshot !== null,
        runSummary
      },
      null,
      2
    )
  );
} finally {
  await repository.close();
}