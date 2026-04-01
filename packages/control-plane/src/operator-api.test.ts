import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DeterministicArchitectureReviewAgent,
  DeterministicDeveloperAgent,
  DeterministicPlanningAgent,
  DeterministicScmAgent,
  DeterministicValidationAgent,
  createOperatorApiServer,
  resolveApprovalRequest,
  runDeveloperPhase,
  runPlanningPipeline,
  runValidationPhase
} from "@reddwarf/control-plane";
import {
  FixtureGitHubAdapter
} from "@reddwarf/integrations";
import {
  InMemoryPlanningRepository
} from "@reddwarf/evidence";
import type { PlanningTaskInput } from "@reddwarf/contracts";

const eligibleInput: PlanningTaskInput = {
  source: {
    provider: "github",
    repo: "acme/platform",
    issueNumber: 99,
    issueUrl: "https://github.com/acme/platform/issues/99"
  },
  title: "Plan a docs-safe change",
  summary:
    "Plan a deterministic docs-safe change for the platform repository with durable evidence output.",
  priority: 1,
  dryRun: false,
  labels: ["ai-eligible"],
  acceptanceCriteria: ["A planning spec exists", "Policy output is archived"],
  affectedPaths: ["docs/guide.md"],
  requestedCapabilities: ["can_plan", "can_archive_evidence"],
  metadata: {}
};

const operatorApiToken = "operator-test-token";

function buildOperatorHeaders(authToken: string | null = operatorApiToken): Record<string, string> {
  if (authToken === null) {
    return {};
  }

  return {
    Authorization: `Bearer ${authToken}`
  };
}

function operatorGet(
  port: number,
  path: string,
  authToken: string | null = operatorApiToken
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: buildOperatorHeaders(authToken)
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer) => (raw += chunk.toString()));
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

function operatorGetRaw(
  port: number,
  path: string,
  accept: string,
  authToken: string | null = operatorApiToken
): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: {
          ...buildOperatorHeaders(authToken),
          Accept: accept
        }
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer) => (raw += chunk.toString()));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: raw,
            contentType: String(res.headers["content-type"] ?? "")
          });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function operatorPost(
  port: number,
  path: string,
  body: unknown,
  authToken: string | null = operatorApiToken
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          ...buildOperatorHeaders(authToken),
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer) => (raw += chunk.toString()));
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

function operatorPut(
  port: number,
  path: string,
  body: unknown,
  authToken: string | null = operatorApiToken
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "PUT",
        headers: {
          ...buildOperatorHeaders(authToken),
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer) => (raw += chunk.toString()));
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

function operatorDelete(
  port: number,
  path: string,
  authToken: string | null = operatorApiToken
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "DELETE",
        headers: buildOperatorHeaders(authToken)
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer) => (raw += chunk.toString()));
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

describe("operator API server", () => {
  it("serves health, runs, and blocked endpoints with an empty repository", async () => {
    const repository = new InMemoryPlanningRepository();
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date("2026-03-26T12:00:00.000Z") }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const health = await operatorGet(port, "/health");
      expect(health.status).toBe(200);
      expect((health.body as Record<string, unknown>)["status"]).toBe("ok");
      expect((health.body as Record<string, unknown>)["timestamp"]).toBe(
        "2026-03-26T12:00:00.000Z"
      );
      expect(
        ((health.body as Record<string, unknown>)["repository"] as Record<string, unknown>)["storage"]
      ).toBe("in_memory");
      expect(
        ((health.body as Record<string, unknown>)["polling"] as Record<string, unknown>)["status"]
      ).toBe("idle");
      expect(
        ((health.body as Record<string, unknown>)["polling"] as Record<string, unknown>)["totalRepositories"]
      ).toBe(0);

      const runs = await operatorGet(port, "/runs");
      expect(runs.status).toBe(200);
      expect((runs.body as Record<string, unknown>)["total"]).toBe(0);
      expect((runs.body as Record<string, unknown>)["runs"]).toEqual([]);

      const approvals = await operatorGet(port, "/approvals");
      expect(approvals.status).toBe(200);
      expect((approvals.body as Record<string, unknown>)["total"]).toBe(0);

      const rejected = await operatorGet(port, "/rejected");
      expect(rejected.status).toBe(200);
      expect((rejected.body as Record<string, unknown>)["total"]).toBe(0);

      const blocked = await operatorGet(port, "/blocked");
      expect(blocked.status).toBe(200);
      expect(
        (blocked.body as Record<string, unknown>)["totalBlockedRuns"]
      ).toBe(0);
      expect(
        (blocked.body as Record<string, unknown>)["totalPendingApprovals"]
      ).toBe(0);

      const notFound = await operatorGet(port, "/unknown-route");
      expect(notFound.status).toBe(404);
    } finally {
      await apiServer.stop();
    }
  });


  it("rejects protected routes without operator auth", async () => {
    const repository = new InMemoryPlanningRepository();
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date("2026-03-26T12:00:00.000Z") }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const health = await operatorGet(port, "/health", null);
      expect(health.status).toBe(200);

      const approvals = await operatorGet(port, "/approvals", null);
      expect(approvals.status).toBe(401);
      expect((approvals.body as Record<string, unknown>)["error"]).toBe("unauthorized");
    } finally {
      await apiServer.stop();
    }
  });

  it("includes repository health in the /health response", async () => {
    const repository = new InMemoryPlanningRepository();
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date("2026-03-27T10:01:00.000Z") }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const health = await operatorGet(port, "/health");
      const repositoryHealth =
        (health.body as Record<string, unknown>)["repository"] as Record<string, unknown>;

      expect(health.status).toBe(200);
      expect(repositoryHealth["storage"]).toBe("in_memory");
      expect(repositoryHealth["status"]).toBe("healthy");
      expect(repositoryHealth["postgresPool"]).toBeNull();
    } finally {
      await apiServer.stop();
    }
  });

  it("serves operator config values, schema metadata, and persists updates", async () => {
    const previousPollInterval = process.env.REDDWARF_POLL_INTERVAL_MS;
    const previousSkipOpenClaw = process.env.REDDWARF_SKIP_OPENCLAW;
    delete process.env.REDDWARF_POLL_INTERVAL_MS;
    delete process.env.REDDWARF_SKIP_OPENCLAW;

    const repository = new InMemoryPlanningRepository();
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date("2026-04-01T09:30:00.000Z") }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const configResponse = await operatorGet(port, "/config");
      expect(configResponse.status).toBe(200);
      expect((configResponse.body as Record<string, unknown>)["total"]).toBeGreaterThan(0);
      const configItems = (configResponse.body as Record<string, unknown>)["config"] as Array<Record<string, unknown>>;
      const pollInterval = configItems.find(
        (entry) => entry["key"] === "REDDWARF_POLL_INTERVAL_MS"
      );
      expect(pollInterval).toMatchObject({
        value: 30000,
        defaultValue: 30000,
        source: "default"
      });

      const schemaResponse = await operatorGet(port, "/config/schema");
      expect(schemaResponse.status).toBe(200);
      const schema = (schemaResponse.body as Record<string, unknown>)["schema"] as Record<string, unknown>;
      const properties = schema["properties"] as Record<string, unknown>;
      expect((properties["REDDWARF_POLL_INTERVAL_MS"] as Record<string, unknown>)["type"]).toBe(
        "integer"
      );

      const badUpdate = await operatorPut(port, "/config", {
        entries: [{ key: "REDDWARF_POLL_INTERVAL_MS", value: "not-a-number" }]
      });
      expect(badUpdate.status).toBe(400);

      const updated = await operatorPut(port, "/config", {
        entries: [
          { key: "REDDWARF_POLL_INTERVAL_MS", value: 45000 },
          { key: "REDDWARF_SKIP_OPENCLAW", value: true }
        ]
      });
      expect(updated.status).toBe(200);

      const updatedItems = (updated.body as Record<string, unknown>)["config"] as Array<Record<string, unknown>>;
      expect(
        updatedItems.find((entry) => entry["key"] === "REDDWARF_POLL_INTERVAL_MS")
      ).toMatchObject({
        value: 45000,
        source: "database",
        updatedAt: "2026-04-01T09:30:00.000Z"
      });
      expect(
        updatedItems.find((entry) => entry["key"] === "REDDWARF_SKIP_OPENCLAW")
      ).toMatchObject({
        value: true,
        source: "database"
      });

      await expect(
        repository.getOperatorConfigEntry("REDDWARF_POLL_INTERVAL_MS")
      ).resolves.toMatchObject({
        value: 45000,
        updatedAt: "2026-04-01T09:30:00.000Z"
      });
      expect(process.env.REDDWARF_POLL_INTERVAL_MS).toBe("45000");
      expect(process.env.REDDWARF_SKIP_OPENCLAW).toBe("true");
    } finally {
      if (previousPollInterval === undefined) {
        delete process.env.REDDWARF_POLL_INTERVAL_MS;
      } else {
        process.env.REDDWARF_POLL_INTERVAL_MS = previousPollInterval;
      }

      if (previousSkipOpenClaw === undefined) {
        delete process.env.REDDWARF_SKIP_OPENCLAW;
      } else {
        process.env.REDDWARF_SKIP_OPENCLAW = previousSkipOpenClaw;
      }

      await apiServer.stop();
    }
  });

  it("manages the polled repository list through the operator API", async () => {
    const repository = new InMemoryPlanningRepository();
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date("2026-04-01T10:00:00.000Z") }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const empty = await operatorGet(port, "/repos");
      expect(empty.status).toBe(200);
      expect((empty.body as Record<string, unknown>)["total"]).toBe(0);

      const created = await operatorPost(port, "/repos", { repo: "acme/platform" });
      expect(created.status).toBe(201);
      expect((created.body as Record<string, unknown>)["created"]).toBe(true);
      expect(
        ((created.body as Record<string, unknown>)["repo"] as Record<string, unknown>)[
          "repo"
        ]
      ).toBe("acme/platform");

      const duplicate = await operatorPost(port, "/repos", { repo: "acme/platform" });
      expect(duplicate.status).toBe(200);
      expect((duplicate.body as Record<string, unknown>)["created"]).toBe(false);

      const listed = await operatorGet(port, "/repos");
      expect(listed.status).toBe(200);
      expect((listed.body as Record<string, unknown>)["total"]).toBe(1);

      const deleted = await operatorDelete(port, "/repos/acme/platform");
      expect(deleted.status).toBe(200);
      expect((deleted.body as Record<string, unknown>)["deleted"]).toBe(true);

      const missingDelete = await operatorDelete(port, "/repos/acme/platform");
      expect(missingDelete.status).toBe(404);
    } finally {
      await apiServer.stop();
    }
  });

  it("serves expanded run and task observability endpoints", async () => {
    const repository = new InMemoryPlanningRepository();
    const result = await runPlanningPipeline(
      {
        ...eligibleInput,
        source: {
          provider: "github",
          repo: "acme/platform",
          issueNumber: 123,
          issueUrl: "https://github.com/acme/platform/issues/123"
        },
        requestedCapabilities: ["can_write_code"]
      },
      {
        repository,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-04-01T10:30:00.000Z"),
        idGenerator: () => "observability-run-001"
      }
    );
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date("2026-04-01T10:35:00.000Z") }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const runs = await operatorGet(port, "/runs?repo=acme/platform&status=blocked");
      expect(runs.status).toBe(200);
      expect((runs.body as Record<string, unknown>)["total"]).toBe(1);

      const runEvidence = await operatorGet(port, `/runs/${result.runId}/evidence`);
      expect(runEvidence.status).toBe(200);
      expect((runEvidence.body as Record<string, unknown>)["runId"]).toBe(result.runId);
      expect((runEvidence.body as Record<string, unknown>)["total"]).toBeGreaterThan(0);

      const tasks = await operatorGet(port, "/tasks?repo=acme/platform&status=blocked");
      expect(tasks.status).toBe(200);
      expect((tasks.body as Record<string, unknown>)["total"]).toBe(1);

      const task = await operatorGet(port, `/tasks/${result.manifest.taskId}`);
      expect(task.status).toBe(200);
      expect(
        ((task.body as Record<string, unknown>)["manifest"] as Record<string, unknown>)[
          "taskId"
        ]
      ).toBe(result.manifest.taskId);
      expect(
        (task.body as Record<string, unknown>)["evidenceTotal"]
      ).toBeGreaterThan(0);
      expect(
        ((task.body as Record<string, unknown>)["runSummaries"] as Array<unknown>).length
      ).toBeGreaterThan(0);
    } finally {
      await apiServer.stop();
    }
  });

  it("includes polling cursor health in the /health response", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveGitHubIssuePollingCursor({
      repo: "acme/platform",
      lastSeenIssueNumber: 42,
      lastSeenUpdatedAt: "2026-03-27T10:00:00.000Z",
      lastPollStartedAt: "2026-03-27T10:00:01.000Z",
      lastPollCompletedAt: "2026-03-27T10:00:05.000Z",
      lastPollStatus: "succeeded",
      lastPollError: null,
      updatedAt: "2026-03-27T10:00:05.000Z"
    });
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date("2026-03-27T10:01:00.000Z") }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const health = await operatorGet(port, "/health");
      const polling = (health.body as Record<string, unknown>)["polling"] as Record<string, unknown>;
      const repositories = polling["repositories"] as Array<Record<string, unknown>>;

      expect(health.status).toBe(200);
      expect(polling["status"]).toBe("healthy");
      expect(polling["totalRepositories"]).toBe(1);
      expect(polling["failingRepositories"]).toBe(0);
      expect(polling["runtimeStatus"]).toBe("idle");
      expect(polling["startupStatus"]).toBe("idle");
      expect(polling["consecutiveFailures"]).toBe(0);
      expect(repositories[0]?.["repo"]).toBe("acme/platform");
      expect(repositories[0]?.["lastSeenIssueNumber"]).toBe(42);
    } finally {
      await apiServer.stop();
    }
  });
  it("includes degraded runtime loop health in the /health response", async () => {
    const repository = new InMemoryPlanningRepository();
    const pollingDaemon = {
      intervalMs: 5_000,
      isRunning: true,
      consecutiveFailures: 2,
      health: {
        status: "degraded",
        startupStatus: "degraded",
        lastCycleStartedAt: "2026-03-27T10:00:00.000Z",
        lastCycleCompletedAt: "2026-03-27T10:00:02.000Z",
        lastCycleDurationMs: 2_000,
        lastError: "startup poll failure"
      },
      async start() {},
      async stop() {},
      async pollOnce() {
        return {
          startedAt: "2026-03-27T10:00:00.000Z",
          completedAt: "2026-03-27T10:00:02.000Z",
          polledIssueCount: 0,
          plannedIssueCount: 0,
          skippedIssueCount: 0,
          decisions: []
        };
      }
    };
    const dispatcher = {
      intervalMs: 5_000,
      isRunning: true,
      consecutiveFailures: 1,
      lastDispatchResult: null,
      health: {
        status: "degraded",
        startupStatus: "degraded",
        lastCycleStartedAt: "2026-03-27T10:00:03.000Z",
        lastCycleCompletedAt: "2026-03-27T10:00:05.000Z",
        lastCycleDurationMs: 2_000,
        lastError: "startup dispatch failure"
      },
      async start() {},
      async stop() {},
      async dispatchOnce() {
        return {
          startedAt: "2026-03-27T10:00:03.000Z",
          completedAt: "2026-03-27T10:00:05.000Z",
          dispatchedCount: 0,
          results: []
        };
      }
    };
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      {
        repository,
        pollingDaemon: pollingDaemon as never,
        dispatcher: dispatcher as never,
        clock: () => new Date("2026-03-27T10:06:00.000Z")
      }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const health = await operatorGet(port, "/health");
      const polling = (health.body as Record<string, unknown>)["polling"] as Record<string, unknown>;
      const dispatcherHealth = (health.body as Record<string, unknown>)["dispatcher"] as Record<string, unknown>;

      expect(health.status).toBe(200);
      expect(polling["status"]).toBe("degraded");
      expect(polling["runtimeStatus"]).toBe("degraded");
      expect(polling["startupStatus"]).toBe("degraded");
      expect(polling["consecutiveFailures"]).toBe(2);
      expect(polling["lastError"]).toBe("startup poll failure");
      expect(dispatcherHealth["status"]).toBe("degraded");
      expect(dispatcherHealth["startupStatus"]).toBe("degraded");
      expect(dispatcherHealth["consecutiveFailures"]).toBe(1);
      expect(dispatcherHealth["lastError"]).toBe("startup dispatch failure");
    } finally {
      await apiServer.stop();
    }
  });

  it("returns runs and approvals filtered by status after a planning run", async () => {
    const repository = new InMemoryPlanningRepository();
    const planResult = await runPlanningPipeline(
      {
        ...eligibleInput,
        requestedCapabilities: ["can_write_code"],
        affectedPaths: ["src/api.ts"]
      },
      {
        repository,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-26T12:00:00.000Z"),
        idGenerator: () => "op-run-001"
      }
    );

    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const runs = await operatorGet(
        port,
        `/runs?taskId=${planResult.manifest.taskId}`
      );
      expect(runs.status).toBe(200);
      expect((runs.body as Record<string, unknown>)["total"]).toBe(1);

      const blockedRuns = await operatorGet(port, "/runs?statuses=blocked");
      expect(blockedRuns.status).toBe(200);
      expect((blockedRuns.body as Record<string, unknown>)["total"]).toBe(1);

      const completedRuns = await operatorGet(
        port,
        "/runs?statuses=completed"
      );
      expect(completedRuns.status).toBe(200);
      expect((completedRuns.body as Record<string, unknown>)["total"]).toBe(0);

      const approvals = await operatorGet(
        port,
        `/approvals?taskId=${planResult.manifest.taskId}&statuses=pending`
      );
      expect(approvals.status).toBe(200);
      expect((approvals.body as Record<string, unknown>)["total"]).toBe(1);

      const blocked = await operatorGet(port, "/blocked");
      expect(blocked.status).toBe(200);
      expect(
        (blocked.body as Record<string, unknown>)["totalBlockedRuns"]
      ).toBe(1);
      expect(
        (blocked.body as Record<string, unknown>)["totalPendingApprovals"]
      ).toBe(1);
    } finally {
      await apiServer.stop();
    }
  });

  it("surfaces retry-budget-exhausted entries from /blocked", async () => {
    const previousRetryLimit = process.env.REDDWARF_MAX_RETRIES_VALIDATOR;
    process.env.REDDWARF_MAX_RETRIES_VALIDATOR = "1";

    const repository = new InMemoryPlanningRepository();
    const tempRoot = await mkdtemp(join(tmpdir(), "operator-blocked-retry-budget-"));
    const planningResult = await runPlanningPipeline(
      {
        ...eligibleInput,
        requestedCapabilities: ["can_write_code"],
        affectedPaths: ["src/api.ts"]
      },
      {
        repository,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-26T12:10:00.000Z"),
        idGenerator: () => "op-run-retry-budget-plan"
      }
    );

    await resolveApprovalRequest(
      {
        requestId: planningResult.approvalRequest!.requestId,
        decision: "approve",
        decidedBy: "operator",
        decisionSummary: "Approve retry budget blocked summary coverage."
      },
      {
        repository,
        clock: () => new Date("2026-03-26T12:11:00.000Z")
      }
    );

    try {
      await runDeveloperPhase(
        {
          taskId: planningResult.manifest.taskId,
          targetRoot: tempRoot,
          workspaceId: "workspace-operator-blocked-retry-budget"
        },
        {
          repository,
          developer: new DeterministicDeveloperAgent(),
          clock: () => new Date("2026-03-26T12:12:00.000Z"),
          idGenerator: () => "op-run-retry-budget-dev"
        }
      );

      const failingValidator = {
        async createPlan() {
          return {
            summary: "Force retry budget exhaustion.",
            commands: [
              {
                id: "failing-command",
                name: "Failing validation command",
                executable: process.execPath,
                args: ["-e", "process.exit(17)"]
              }
            ]
          };
        }
      };

      await expect(
        runValidationPhase(
          {
            taskId: planningResult.manifest.taskId,
            targetRoot: tempRoot
          },
          {
            repository,
            validator: failingValidator,
            clock: () => new Date("2026-03-26T12:13:00.000Z"),
            idGenerator: () => "op-run-retry-budget-validation-first"
          }
        )
      ).rejects.toBeInstanceOf(Error);

      await expect(
        runValidationPhase(
          {
            taskId: planningResult.manifest.taskId,
            targetRoot: tempRoot
          },
          {
            repository,
            validator: failingValidator,
            clock: () => new Date("2026-03-26T12:14:00.000Z"),
            idGenerator: () => "op-run-retry-budget-validation-second"
          }
        )
      ).rejects.toBeInstanceOf(Error);

      const apiServer = createOperatorApiServer(
        { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
        { repository }
      );

      await apiServer.start();
      const port = apiServer.port;

      try {
        const blocked = await operatorGet(port, "/blocked");
        const entries = (blocked.body as Record<string, unknown>)["retryExhaustedEntries"] as Array<Record<string, unknown>>;

        expect(blocked.status).toBe(200);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          reason: "retry-budget-exhausted",
          phase: "validation",
          attempts: 2,
          retryLimit: 1
        });
        expect(String(entries[0]?.["lastError"] ?? "")).toContain("Validation command");
      } finally {
        await apiServer.stop();
      }
    } finally {
      if (previousRetryLimit === undefined) {
        delete process.env.REDDWARF_MAX_RETRIES_VALIDATOR;
      } else {
        process.env.REDDWARF_MAX_RETRIES_VALIDATOR = previousRetryLimit;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("serves structured eligibility rejection records from /rejected", async () => {
    const repository = new InMemoryPlanningRepository();
    const result = await runPlanningPipeline(
      {
        ...eligibleInput,
        labels: []
      },
      {
        repository,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-26T12:20:00.000Z"),
        idGenerator: () => "op-run-rejected"
      }
    );

    expect(result.nextAction).toBe("task_blocked");

    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const rejected = await operatorGet(port, "/rejected?reason=label-missing");
      const items = (rejected.body as Record<string, unknown>)["items"] as Array<Record<string, unknown>>;
      const byReason = (rejected.body as Record<string, unknown>)["byReason"] as Record<string, number>;

      expect(rejected.status).toBe(200);
      expect((rejected.body as Record<string, unknown>)["total"]).toBe(1);
      expect(items[0]).toMatchObject({
        taskId: result.manifest.taskId,
        reasonCode: "label-missing",
        issueTitle: eligibleInput.title,
        issueUrl: eligibleInput.source.issueUrl
      });
      expect(byReason["label-missing"]).toBe(1);
    } finally {
      await apiServer.stop();
    }
  });

  it("serves a single approval by ID and supports resolve via POST", async () => {
    const repository = new InMemoryPlanningRepository();
    const planResult = await runPlanningPipeline(
      {
        ...eligibleInput,
        requestedCapabilities: ["can_write_code"],
        affectedPaths: ["src/feature.ts"]
      },
      {
        repository,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-26T12:00:00.000Z"),
        idGenerator: () => "op-run-002"
      }
    );

    const requestId = planResult.approvalRequest!.requestId;
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date("2026-03-26T12:05:00.000Z") }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const getApproval = await operatorGet(
        port,
        `/approvals/${requestId}`
      );
      expect(getApproval.status).toBe(200);
      expect(
        (
          (getApproval.body as Record<string, unknown>)[
            "approval"
          ] as Record<string, unknown>
        )["status"]
      ).toBe("pending");

      const missing = await operatorGet(port, "/approvals/nonexistent-id");
      expect(missing.status).toBe(404);

      const badResolve = await operatorPost(
        port,
        `/approvals/${requestId}/resolve`,
        { decision: "approve" }
      );
      expect(badResolve.status).toBe(400);

      const resolved = await operatorPost(
        port,
        `/approvals/${requestId}/resolve`,
        {
          decision: "approve",
          decidedBy: "operator-test",
          decisionSummary: "Approved via operator API test."
        }
      );
      expect(resolved.status).toBe(200);
      expect(
        (
          (resolved.body as Record<string, unknown>)[
            "approval"
          ] as Record<string, unknown>
        )["status"]
      ).toBe("approved");
      expect(
        (
          (resolved.body as Record<string, unknown>)[
            "manifest"
          ] as Record<string, unknown>
        )["lifecycleStatus"]
      ).toBe("ready");
    } finally {
      await apiServer.stop();
    }
  });

  it("rejects oversized operator JSON bodies", async () => {
    const repository = new InMemoryPlanningRepository();
    const planResult = await runPlanningPipeline(
      {
        ...eligibleInput,
        requestedCapabilities: ["can_write_code"],
        affectedPaths: ["src/feature.ts"]
      },
      {
        repository,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-26T12:00:00.000Z"),
        idGenerator: () => "op-run-oversized"
      }
    );

    const apiServer = createOperatorApiServer(
      {
        port: 0,
        host: "127.0.0.1",
        authToken: operatorApiToken,
        maxRequestBodyBytes: 64
      },
      { repository, clock: () => new Date("2026-03-26T12:05:00.000Z") }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const oversized = await operatorPost(
        port,
        `/approvals/${planResult.approvalRequest!.requestId}/resolve`,
        {
          decision: "approve",
          decidedBy: "operator-test",
          decisionSummary: "Approved via operator API test.",
          comment: "x".repeat(256)
        }
      );

      expect(oversized.status).toBe(413);
      expect((oversized.body as Record<string, unknown>)["error"]).toBe("payload_too_large");
    } finally {
      await apiServer.stop();
    }
  });

  it("rejects manual dispatch roots that escape configured managed roots", async () => {
    const repository = new InMemoryPlanningRepository();
    const planResult = await runPlanningPipeline(
      {
        ...eligibleInput,
        requestedCapabilities: ["can_write_code"],
        affectedPaths: ["src/feature.ts"]
      },
      {
        repository,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-26T12:00:00.000Z"),
        idGenerator: () => "op-run-dispatch-roots"
      }
    );

    await resolveApprovalRequest(
      {
        requestId: planResult.approvalRequest!.requestId,
        decision: "approve",
        decidedBy: "operator-test",
        decisionSummary: "Approved for manual dispatch root validation test."
      },
      { repository, clock: () => new Date("2026-03-26T12:05:00.000Z") }
    );

    const managedTargetRoot = await mkdtemp(join(tmpdir(), "operator-managed-target-"));
    const managedEvidenceRoot = await mkdtemp(join(tmpdir(), "operator-managed-evidence-"));
    const escapedTargetRoot = join(managedTargetRoot, "..", "escaped-target-root");
    const escapedEvidenceRoot = join(managedEvidenceRoot, "..", "escaped-evidence-root");
    const apiServer = createOperatorApiServer(
      {
        port: 0,
        host: "127.0.0.1",
        authToken: operatorApiToken,
        managedTargetRoot,
        managedEvidenceRoot
      },
      {
        repository,
        dispatchDependencies: {
          developer: new DeterministicDeveloperAgent(),
          reviewer: new DeterministicArchitectureReviewAgent(),
          validator: new DeterministicValidationAgent(),
          scm: new DeterministicScmAgent(),
          github: new FixtureGitHubAdapter({ candidates: [] })
        }
      }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const response = await operatorPost(
        port,
        `/tasks/${planResult.manifest.taskId}/dispatch`,
        {
          targetRoot: escapedTargetRoot,
          evidenceRoot: escapedEvidenceRoot
        }
      );

      expect(response.status).toBe(400);
      expect((response.body as Record<string, unknown>)["error"]).toBe("bad_request");
      expect(String((response.body as Record<string, unknown>)["message"])).toContain("escapes configured root");
    } finally {
      await apiServer.stop();
      await rm(managedTargetRoot, { recursive: true, force: true });
      await rm(managedEvidenceRoot, { recursive: true, force: true });
    }
  });

  it("injects a structured task directly into the planning pipeline", async () => {
    const repository = new InMemoryPlanningRepository();
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      {
        repository,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-31T10:00:00.000Z")
      }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const injected = await operatorPost(port, "/tasks/inject", {
        repo: "acme/platform",
        title: "Inject a structured planning task",
        summary: "Push a local structured task directly into the planning pipeline.",
        priority: 2,
        acceptanceCriteria: [
          "A planning spec is generated",
          "The task can require human approval when code writing is requested"
        ],
        affectedPaths: ["packages/control-plane/src/operator-api.ts"],
        constraints: ["Keep the operator API contract stable."],
        requestedCapabilities: ["can_write_code"],
        riskClassHint: "medium"
      });

      expect(injected.status).toBe(201);
      expect((injected.body as Record<string, unknown>)["runId"]).toBeDefined();
      expect((injected.body as Record<string, unknown>)["nextAction"]).toBe("await_human");

      const manifest = (injected.body as Record<string, unknown>)["manifest"] as Record<string, unknown>;
      expect(manifest["lifecycleStatus"]).toBe("blocked");
      expect(manifest["source"]).toMatchObject({
        provider: "github",
        repo: "acme/platform"
      });

      const snapshot = await repository.getTaskSnapshot(String(manifest["taskId"]));
      expect(snapshot.manifest?.title).toBe("Inject a structured planning task");
      expect(snapshot.approvalRequests).toHaveLength(1);
      expect(snapshot.memoryRecords.some((record) => record.key === "planning.brief")).toBe(true);
    } finally {
      await apiServer.stop();
    }
  });

  it("returns service_unavailable for /tasks/inject when no planner is configured", async () => {
    const repository = new InMemoryPlanningRepository();
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const response = await operatorPost(port, "/tasks/inject", {
        repo: "acme/platform",
        title: "Injected without planner",
        summary: "This should fail cleanly.",
        acceptanceCriteria: ["The server returns 503."]
      });

      expect(response.status).toBe(503);
      expect((response.body as Record<string, unknown>)["error"]).toBe("service_unavailable");
    } finally {
      await apiServer.stop();
    }
  });

  it("defaults injected planning work to dry-run when configured on the server", async () => {
    const repository = new InMemoryPlanningRepository();
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      {
        repository,
        planner: new DeterministicPlanningAgent(),
        defaultPlanningDryRun: true
      }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const injected = await operatorPost(port, "/tasks/inject", {
        repo: "acme/platform",
        title: "Inject a dry-run planning task",
        summary: "Push a task into planning and default it to dry-run mode.",
        acceptanceCriteria: ["Planning runs in dry-run mode."],
        requestedCapabilities: ["can_write_code"],
        affectedPaths: ["src/dry-run.ts"]
      });

      expect(injected.status).toBe(201);
      const manifest = (injected.body as Record<string, unknown>)["manifest"] as Record<string, unknown>;
      expect(manifest["dryRun"]).toBe(true);

      const runs = await repository.listPipelineRuns();
      expect(runs[0]?.dryRun).toBe(true);
    } finally {
      await apiServer.stop();
    }
  });

  it("injects a grouped task batch and persists dependency metadata for each task", async () => {
    const repository = new InMemoryPlanningRepository();
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      {
        repository,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-31T10:10:00.000Z")
      }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const injected = await operatorPost(port, "/task-groups/inject", {
        groupId: "docs-rollout",
        groupName: "Docs rollout",
        executionMode: "sequential",
        tasks: [
          {
            taskKey: "draft-plan",
            repo: "acme/platform",
            title: "Draft the rollout plan",
            summary: "Create the first planning task for the grouped rollout.",
            acceptanceCriteria: ["The first planning task is queued."],
            affectedPaths: ["docs/plan.md"]
          },
          {
            taskKey: "publish-follow-up",
            repo: "acme/platform",
            title: "Publish the follow-up plan",
            summary: "Create the second planning task after the first one finishes.",
            acceptanceCriteria: ["The second planning task is queued."],
            affectedPaths: ["docs/follow-up.md"]
          }
        ]
      });

      expect(injected.status).toBe(201);
      expect((injected.body as Record<string, unknown>)["groupId"]).toBe("docs-rollout");
      const tasks = (injected.body as Record<string, unknown>)["tasks"] as Array<Record<string, unknown>>;
      expect(tasks).toHaveLength(2);
      expect(tasks[1]?.["dependsOn"]).toEqual(["draft-plan"]);

      const memberships = await repository.listMemoryRecords({
        repo: "acme/platform",
        keyPrefix: "task.group.membership"
      });
      expect(memberships).toHaveLength(2);
      expect(
        memberships.map((record) => (record.value as Record<string, unknown>)["taskKey"])
      ).toEqual(expect.arrayContaining(["draft-plan", "publish-follow-up"]));
    } finally {
      await apiServer.stop();
    }
  });

  it("serves task evidence and snapshot endpoints", async () => {
    const repository = new InMemoryPlanningRepository();
    const planResult = await runPlanningPipeline(eligibleInput, {
      repository,
      planner: new DeterministicPlanningAgent(),
      clock: () => new Date("2026-03-26T12:00:00.000Z"),
      idGenerator: () => "op-run-003"
    });

    const taskId = planResult.manifest.taskId;
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const evidence = await operatorGet(
        port,
        `/tasks/${taskId}/evidence`
      );
      expect(evidence.status).toBe(200);
      expect(
        (evidence.body as Record<string, unknown>)["taskId"]
      ).toBe(taskId);
      expect(
        (evidence.body as Record<string, unknown>)["total"]
      ).toBeGreaterThan(0);

      const snapshot = await operatorGet(
        port,
        `/tasks/${taskId}/snapshot`
      );
      expect(snapshot.status).toBe(200);
      expect(
        (
          (snapshot.body as Record<string, unknown>)[
            "manifest"
          ] as Record<string, unknown>
        )["taskId"]
      ).toBe(taskId);
      expect(
        (snapshot.body as Record<string, unknown>)["phaseRecords"]
      ).toBeDefined();

      const missingTask = await operatorGet(
        port,
        "/tasks/nonexistent-task/evidence"
      );
      expect(missingTask.status).toBe(404);
    } finally {
      await apiServer.stop();
    }
  });

  it("serves per-run token usage details", async () => {
    const previousBudget = process.env.REDDWARF_TOKEN_BUDGET_ARCHITECT;
    const previousAction = process.env.REDDWARF_TOKEN_BUDGET_OVERAGE_ACTION;
    process.env.REDDWARF_TOKEN_BUDGET_ARCHITECT = "1";
    process.env.REDDWARF_TOKEN_BUDGET_OVERAGE_ACTION = "warn";

    const repository = new InMemoryPlanningRepository();
    const planResult = await runPlanningPipeline(eligibleInput, {
      repository,
      planner: new DeterministicPlanningAgent(),
      clock: () => new Date("2026-03-26T12:00:00.000Z"),
      idGenerator: () => "op-run-budget"
    });
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const runDetail = await operatorGet(port, `/runs/${planResult.runId}`);
      expect(runDetail.status).toBe(200);
      expect(
        ((runDetail.body as Record<string, unknown>)["run"] as Record<string, unknown>)[
          "runId"
        ]
      ).toBe(planResult.runId);

      const tokenUsage = (runDetail.body as Record<string, unknown>)[
        "tokenUsage"
      ] as Record<string, unknown>;
      expect((tokenUsage["anyPhaseExceeded"] as boolean)).toBe(true);
      const byPhase = tokenUsage["byPhase"] as Record<string, Record<string, unknown>>;
      expect((byPhase["planning"]?.["budgetLimit"] as number)).toBe(1);
      expect((byPhase["planning"]?.["estimatedTokens"] as number)).toBeGreaterThan(1);
    } finally {
      await apiServer.stop();
      if (previousBudget === undefined) {
        delete process.env.REDDWARF_TOKEN_BUDGET_ARCHITECT;
      } else {
        process.env.REDDWARF_TOKEN_BUDGET_ARCHITECT = previousBudget;
      }
      if (previousAction === undefined) {
        delete process.env.REDDWARF_TOKEN_BUDGET_OVERAGE_ACTION;
      } else {
        process.env.REDDWARF_TOKEN_BUDGET_OVERAGE_ACTION = previousAction;
      }
    }
  });

  it("renders a markdown pipeline run report", async () => {
    const repository = new InMemoryPlanningRepository();
    const planResult = await runPlanningPipeline(eligibleInput, {
      repository,
      planner: new DeterministicPlanningAgent(),
      clock: () => new Date("2026-03-26T12:00:00.000Z"),
      idGenerator: () => "op-run-report"
    });
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const report = await operatorGetRaw(
        port,
        `/runs/${planResult.runId}/report`,
        "text/markdown"
      );
      expect(report.status).toBe(200);
      expect(report.contentType).toContain("text/markdown");
      expect(report.body).toContain("# Pipeline Run Report");
      expect(report.body).toContain(planResult.runId);
      expect(report.body).toContain(planResult.manifest.taskId);
    } finally {
      await apiServer.stop();
    }
  });

  it("includes prompt snapshots in the JSON run report once they are captured", async () => {
    const repository = new InMemoryPlanningRepository();
    const planResult = await runPlanningPipeline(eligibleInput, {
      repository,
      planner: new DeterministicPlanningAgent(),
      clock: () => new Date("2026-03-26T12:00:00.000Z"),
      idGenerator: () => "op-run-report-json"
    });
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const report = await operatorGetRaw(
        port,
        `/runs/${planResult.runId}/report`,
        "application/json"
      );
      expect(report.status).toBe(200);
      const payload = JSON.parse(report.body) as Record<string, unknown>;
      const prompts = payload["prompts"] as Array<
        Record<string, unknown>
      >;
      expect(prompts.length).toBeGreaterThan(0);
      expect(prompts[0]?.["phase"]).toBe("planning");
      expect(prompts[0]?.["promptHash"]).toBeTypeOf("string");
    } finally {
      await apiServer.stop();
    }
  });
});
