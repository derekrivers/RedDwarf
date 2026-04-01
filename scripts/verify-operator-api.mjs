import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import {
  DeterministicPlanningAgent,
  createOperatorApiServer,
  resolveApprovalRequest,
  runPlanningPipeline
} from "../packages/control-plane/dist/index.js";
import { createPostgresPlanningRepository } from "../packages/evidence/dist/index.js";
import { connectionString, postgresPoolConfig } from "./lib/config.mjs";

const issueNumber = 100000 + (Date.now() % 1000000);
const repo = `operator-api-${issueNumber}/platform-${issueNumber}`;
const repository = createPostgresPlanningRepository(connectionString, postgresPoolConfig);
const operatorApiToken = "verify-operator-token";

function buildAuthHeaders(authToken = operatorApiToken) {
  return authToken === null ? {} : { Authorization: `Bearer ${authToken}` };
}

function apiGet(port, path, authToken = operatorApiToken) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port, path, method: "GET", headers: buildAuthHeaders(authToken) },
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

function apiPost(port, path, body, authToken = operatorApiToken) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          ...buildAuthHeaders(authToken),
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

function apiPut(port, path, body, authToken = operatorApiToken) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "PUT",
        headers: {
          ...buildAuthHeaders(authToken),
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
  { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
  {
    repository,
    planner: new DeterministicPlanningAgent(),
    clock: () => new Date("2026-03-26T12:00:00.000Z")
  }
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
  const health = await apiGet(port, "/health", null);

  // Protected routes reject missing auth
  const unauthorizedApprovals = await apiGet(port, "/approvals", null);
  assert.equal(unauthorizedApprovals.status, 401);
  assert.equal(unauthorizedApprovals.body.error, "unauthorized");
  assert.equal(health.status, 200);
  assert.equal(health.body.status, "ok");
  assert.equal(health.body.timestamp, "2026-03-26T12:00:00.000Z");
  assert.equal(health.body.repository.storage, "postgres");
  assert.ok(health.body.repository.postgresPool.maxConnections >= 1);
  assert.equal(health.body.polling.status, "healthy");
  assert.equal(health.body.polling.runtimeStatus, "idle");
  assert.equal(health.body.polling.startupStatus, "idle");
  assert.equal(health.body.polling.consecutiveFailures, 0);
  assert.equal(health.body.polling.lastError, null);
  assert.ok(health.body.polling.totalRepositories >= 1);
  const seededRepository = health.body.polling.repositories.find((entry) => entry.repo === repo);
  assert.ok(seededRepository, "polling health should include the seeded repository");
  assert.equal(seededRepository.lastSeenIssueNumber, issueNumber);

  // GET /runs?taskId=...
  const runsForTask = await apiGet(port, `/runs?taskId=${taskId}`);
  assert.equal(runsForTask.status, 200);
  assert.ok(runsForTask.body.total >= 1);
  assert.ok(
    runsForTask.body.runs.some((run) => run.taskId === taskId),
    "task-scoped run listing should include the seeded task"
  );

  // GET /runs?statuses=blocked
  const blockedRuns = await apiGet(port, "/runs?statuses=blocked");
  assert.equal(blockedRuns.status, 200);
  assert.ok(Array.isArray(blockedRuns.body.runs));
  assert.equal(blockedRuns.body.total, blockedRuns.body.runs.length);

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
  assert.equal(blocked.body.totalBlockedRuns, blocked.body.blockedRuns.length);
  assert.equal(blocked.body.totalPendingApprovals, blocked.body.pendingApprovals.length);
  assert.ok(
    blocked.body.pendingApprovals.some(
      (req) => req.requestId === requestId
    )
  );

  // GET /config and /config/schema
  const config = await apiGet(port, "/config");
  assert.equal(config.status, 200);
  assert.ok(config.body.total > 0);
  assert.ok(
    config.body.config.some((entry) => entry.key === "REDDWARF_POLL_INTERVAL_MS")
  );

  const configSchema = await apiGet(port, "/config/schema");
  assert.equal(configSchema.status, 200);
  assert.equal(configSchema.body.schema.type, "object");
  assert.equal(
    configSchema.body.schema.properties.REDDWARF_POLL_INTERVAL_MS.type,
    "integer"
  );

  const badConfigUpdate = await apiPut(port, "/config", {
    entries: [{ key: "REDDWARF_POLL_INTERVAL_MS", value: "bad" }]
  });
  assert.equal(badConfigUpdate.status, 400);

  const updatedConfig = await apiPut(port, "/config", {
    entries: [
      { key: "REDDWARF_POLL_INTERVAL_MS", value: 45000 },
      { key: "REDDWARF_SKIP_OPENCLAW", value: true }
    ]
  });
  assert.equal(updatedConfig.status, 200);
  assert.ok(
    updatedConfig.body.config.some(
      (entry) =>
        entry.key === "REDDWARF_POLL_INTERVAL_MS" &&
        entry.value === 45000 &&
        entry.source === "database"
    )
  );

  // POST /tasks/inject
  const injected = await apiPost(port, "/tasks/inject", {
    repo,
    title: "Inject a task via the operator API",
    summary: "Verify that structured local tasks can enter the planning pipeline without GitHub polling.",
    priority: 2,
    issueNumber: issueNumber + 1,
    issueUrl: `https://github.com/${repo}/issues/${issueNumber + 1}`,
    acceptanceCriteria: [
      "The injected task produces a planning result",
      "The response includes a manifest and nextAction"
    ],
    affectedPaths: ["packages/control-plane/src/operator-api.ts"],
    constraints: ["Keep the operator contract stable."],
    requestedCapabilities: ["can_write_code"]
  });
  assert.equal(injected.status, 201);
  assert.equal(injected.body.nextAction, "await_human");
  assert.equal(injected.body.manifest.source.repo, repo);

  // POST /task-groups/inject
  const grouped = await apiPost(port, "/task-groups/inject", {
    groupId: "operator-docs-rollout",
    executionMode: "sequential",
    tasks: [
      {
        taskKey: "draft-plan",
        repo,
        title: "Draft the grouped rollout plan",
        summary: "Verify grouped task intake through the operator API.",
        acceptanceCriteria: ["The first grouped task produces a planning result."],
        affectedPaths: ["docs/rollout-plan.md"]
      },
      {
        taskKey: "publish-follow-up",
        repo,
        title: "Publish the grouped follow-up plan",
        summary: "Verify grouped task dependency metadata is persisted for later dispatch.",
        acceptanceCriteria: ["The second grouped task produces a planning result."],
        affectedPaths: ["docs/rollout-follow-up.md"]
      }
    ]
  });
  assert.equal(grouped.status, 201);
  assert.equal(grouped.body.groupId, "operator-docs-rollout");
  assert.equal(grouped.body.totalTasks, 2);
  assert.deepEqual(grouped.body.tasks[1].dependsOn, ["draft-plan"]);

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
        injectedTaskId: injected.body.manifest.taskId,
        groupedTaskIds: grouped.body.tasks.map((task) => task.manifest.taskId),
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
