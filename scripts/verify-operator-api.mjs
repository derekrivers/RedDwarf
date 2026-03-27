import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import {
  DeterministicPlanningAgent,
  createOperatorApiServer,
  resolveApprovalRequest,
  runPlanningPipeline
} from "../packages/control-plane/dist/index.js";
import { createPostgresPlanningRepository } from "../packages/evidence/dist/index.js";

const connectionString =
  process.env.HOST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://reddwarf:reddwarf@127.0.0.1:55432/reddwarf";
const issueNumber = 100000 + (Date.now() % 1000000);
const repo = `operator-api-${issueNumber}/platform-${issueNumber}`;
const repository = createPostgresPlanningRepository(connectionString);

function apiGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port, path, method: "GET" },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk.toString()));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
          } catch {
            reject(new Error(`Non-JSON response: ${raw}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function apiPost(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk.toString()));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
          } catch {
            reject(new Error(`Non-JSON response: ${raw}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

const apiServer = createOperatorApiServer(
  { port: 0, host: "127.0.0.1" },
  { repository, clock: () => new Date("2026-03-26T12:00:00.000Z") }
);

try {
  await repository.saveGitHubIssuePollingCursor({
    repo,
    lastSeenIssueNumber: issueNumber,
    lastSeenUpdatedAt: "2026-03-26T11:59:00.000Z",
    lastPollStartedAt: "2026-03-26T11:59:30.000Z",
    lastPollCompletedAt: "2026-03-26T11:59:45.000Z",
    lastPollStatus: "succeeded",
    lastPollError: null,
    updatedAt: "2026-03-26T11:59:45.000Z"
  });

  // Seed a blocked task requiring human approval.
  const planResult = await runPlanningPipeline(
    {
      source: {
        provider: "github",
        repo,
        issueNumber,
        issueUrl: `https://github.com/${repo}/issues/${issueNumber}`
      },
      title: "Verify operator API endpoints",
      summary:
        "Seed a task requiring human approval so the operator API can query runs, approvals, evidence, and blocked state.",
      priority: 1,
      labels: ["ai-eligible"],
      acceptanceCriteria: [
        "Operator API returns runs for this task",
        "Operator API returns the pending approval",
        "Operator can resolve the approval via POST"
      ],
      affectedPaths: ["src/operator-api.ts"],
      requestedCapabilities: ["can_write_code"],
      metadata: {}
    },
    {
      repository,
      planner: new DeterministicPlanningAgent(),
      clock: () => new Date("2026-03-26T12:00:00.000Z"),
      idGenerator: () => `operator-plan-${issueNumber}`
    }
  );

  const taskId = planResult.manifest.taskId;
  const requestId = planResult.approvalRequest.requestId;

  await apiServer.start();
  const port = apiServer.port;

  // GET /health
  const health = await apiGet(port, "/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.status, "ok");
  assert.equal(health.body.timestamp, "2026-03-26T12:00:00.000Z");
  assert.equal(health.body.polling.status, "healthy");
  assert.equal(health.body.polling.totalRepositories, 1);
  assert.equal(health.body.polling.repositories[0].repo, repo);
  assert.equal(health.body.polling.repositories[0].lastSeenIssueNumber, issueNumber);

  // GET /runs?taskId=...
  const runsForTask = await apiGet(port, `/runs?taskId=${taskId}`);
  assert.equal(runsForTask.status, 200);
  assert.equal(runsForTask.body.total, 1);
  assert.equal(runsForTask.body.runs[0].taskId, taskId);

  // GET /runs?statuses=blocked
  const blockedRuns = await apiGet(port, "/runs?statuses=blocked");
  assert.equal(blockedRuns.status, 200);
  assert.ok(blockedRuns.body.total >= 1);
  assert.ok(
    blockedRuns.body.runs.some((run) => run.taskId === taskId),
    "blocked runs should include the seeded task"
  );

  // GET /approvals?taskId=...&statuses=pending
  const pendingApprovals = await apiGet(
    port,
    `/approvals?taskId=${taskId}&statuses=pending`
  );
  assert.equal(pendingApprovals.status, 200);
  assert.equal(pendingApprovals.body.total, 1);
  assert.equal(pendingApprovals.body.approvals[0].requestId, requestId);
  assert.equal(pendingApprovals.body.approvals[0].status, "pending");

  // GET /approvals/:requestId
  const singleApproval = await apiGet(port, `/approvals/${requestId}`);
  assert.equal(singleApproval.status, 200);
  assert.equal(singleApproval.body.approval.requestId, requestId);
  assert.equal(singleApproval.body.approval.status, "pending");

  // GET /approvals/:requestId — missing ID returns 404
  const missingApproval = await apiGet(port, "/approvals/does-not-exist");
  assert.equal(missingApproval.status, 404);

  // GET /blocked
  const blocked = await apiGet(port, "/blocked");
  assert.equal(blocked.status, 200);
  assert.ok(blocked.body.totalBlockedRuns >= 1);
  assert.ok(blocked.body.totalPendingApprovals >= 1);
  assert.ok(
    blocked.body.blockedRuns.some((run) => run.taskId === taskId)
  );
  assert.ok(
    blocked.body.pendingApprovals.some(
      (req) => req.requestId === requestId
    )
  );

  // GET /tasks/:taskId/evidence
  const evidence = await apiGet(port, `/tasks/${taskId}/evidence`);
  assert.equal(evidence.status, 200);
  assert.equal(evidence.body.taskId, taskId);
  assert.ok(evidence.body.total > 0, "evidence records should be present");

  // GET /tasks/:taskId/evidence — unknown task returns 404
  const missingEvidence = await apiGet(
    port,
    "/tasks/nonexistent-task/evidence"
  );
  assert.equal(missingEvidence.status, 404);

  // GET /tasks/:taskId/snapshot
  const snapshot = await apiGet(port, `/tasks/${taskId}/snapshot`);
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.body.manifest.taskId, taskId);
  assert.ok(
    Array.isArray(snapshot.body.phaseRecords),
    "snapshot should include phase records"
  );
  assert.ok(
    Array.isArray(snapshot.body.approvalRequests),
    "snapshot should include approval requests"
  );

  // POST /approvals/:requestId/resolve — bad request (missing fields)
  const badResolve = await apiPost(
    port,
    `/approvals/${requestId}/resolve`,
    { decision: "approve" }
  );
  assert.equal(badResolve.status, 400);

  // POST /approvals/:requestId/resolve — approve via API
  const resolved = await apiPost(
    port,
    `/approvals/${requestId}/resolve`,
    {
      decision: "approve",
      decidedBy: "operator-verify",
      decisionSummary: "Approved via operator API verification script.",
      comment: "Automated verify run."
    }
  );
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.approval.status, "approved");
  assert.equal(resolved.body.approval.decidedBy, "operator-verify");
  assert.equal(resolved.body.manifest.lifecycleStatus, "ready");

  // After approval, /blocked should no longer show the approval as pending
  const blockedAfter = await apiGet(port, "/blocked");
  assert.ok(
    !blockedAfter.body.pendingApprovals.some(
      (req) => req.requestId === requestId
    ),
    "resolved approval should not appear in /blocked"
  );

  // GET /unknown-route returns 404
  const unknown = await apiGet(port, "/no-such-route");
  assert.equal(unknown.status, 404);

  console.log(
    JSON.stringify(
      {
        taskId,
        requestId,
        port,
        runsTotal: runsForTask.body.total,
        evidenceTotal: evidence.body.total,
        pollingRepositories: health.body.polling.totalRepositories,
        resolvedApprovalStatus: resolved.body.approval.status,
        manifestLifecycleAfterResolve: resolved.body.manifest.lifecycleStatus
      },
      null,
      2
    )
  );
} finally {
  await apiServer.stop().catch(() => {});
  await repository.close();
}



