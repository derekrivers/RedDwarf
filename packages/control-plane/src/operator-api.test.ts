import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import {
  request as httpRequest,
  type IncomingHttpHeaders
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DeterministicArchitectureReviewAgent,
  DeterministicDeveloperAgent,
  DeterministicPlanningAgent,
  DeterministicScmAgent,
  DeterministicValidationAgent,
  OperatorRateLimiter,
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
  createPipelineRun,
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

// M25 F-196 — generic helper for tests that need PATCH/PUT/POST in one path.
function operatorRequest(
  port: number,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  authToken: string | null = operatorApiToken
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : "";
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...buildOperatorHeaders(authToken),
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload)
              }
            : {})
        }
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer) => (raw += chunk.toString()));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null });
          } catch {
            reject(new Error(`Non-JSON response: ${raw}`));
          }
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
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

function operatorOptions(
  port: number,
  path: string,
  headers: Record<string, string>
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "OPTIONS",
        headers
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer) => (raw += chunk.toString()));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: raw
          });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describe("operator API server", () => {
  it("serves CORS preflight responses before auth and route handling", async () => {
    const repository = new InMemoryPlanningRepository();
    const previousDashboardOrigin = process.env.REDDWARF_DASHBOARD_ORIGIN;
    process.env.REDDWARF_DASHBOARD_ORIGIN = "http://localhost:4173";

    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date("2026-04-04T19:00:00.000Z") }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const response = await operatorOptions(port, "/runs", {
        Origin: "http://localhost:4173",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Authorization, Content-Type"
      });

      expect(response.status).toBe(204);
      expect(response.body).toBe("");
      expect(response.headers["access-control-allow-origin"]).toBe(
        "http://localhost:4173"
      );
      expect(response.headers["access-control-allow-methods"]).toContain("GET");
      expect(response.headers["access-control-allow-methods"]).toContain("POST");
      expect(response.headers["access-control-allow-methods"]).toContain("PUT");
      expect(response.headers["access-control-allow-methods"]).toContain("DELETE");
      expect(response.headers["access-control-allow-methods"]).toContain(
        "OPTIONS"
      );
      expect(response.headers["access-control-allow-headers"]).toContain(
        "Authorization"
      );
      expect(response.headers["access-control-allow-headers"]).toContain(
        "Content-Type"
      );
    } finally {
      await apiServer.stop();
      if (previousDashboardOrigin === undefined) {
        delete process.env.REDDWARF_DASHBOARD_ORIGIN;
      } else {
        process.env.REDDWARF_DASHBOARD_ORIGIN = previousDashboardOrigin;
      }
    }
  });

  it("allows the default local dashboard origins without requiring an env override", async () => {
    const repository = new InMemoryPlanningRepository();
    const previousDashboardOrigin = process.env.REDDWARF_DASHBOARD_ORIGIN;
    delete process.env.REDDWARF_DASHBOARD_ORIGIN;

    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date("2026-04-04T19:05:00.000Z") }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const localhostResponse = await operatorOptions(port, "/runs", {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Authorization, Content-Type"
      });
      expect(localhostResponse.status).toBe(204);
      expect(localhostResponse.headers["access-control-allow-origin"]).toBe(
        "http://localhost:5173"
      );

      const loopbackResponse = await operatorOptions(port, "/runs", {
        Origin: "http://127.0.0.1:5173",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Authorization, Content-Type"
      });
      expect(loopbackResponse.status).toBe(204);
      expect(loopbackResponse.headers["access-control-allow-origin"]).toBe(
        "http://127.0.0.1:5173"
      );
    } finally {
      await apiServer.stop();
      if (previousDashboardOrigin === undefined) {
        delete process.env.REDDWARF_DASHBOARD_ORIGIN;
      } else {
        process.env.REDDWARF_DASHBOARD_ORIGIN = previousDashboardOrigin;
      }
    }
  });

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

      const bootstrap = await operatorGet(port, "/ui/bootstrap", null);
      expect(bootstrap.status).toBe(401);

      const ui = await operatorGetRaw(port, "/ui", "text/html", null);
      expect(ui.status).toBe(200);
      expect(ui.contentType).toContain("text/html");
      expect(ui.body).toContain("RedDwarf Operator Panel");
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
    const previousModelProvider = process.env.REDDWARF_MODEL_PROVIDER;
    delete process.env.REDDWARF_POLL_INTERVAL_MS;
    delete process.env.REDDWARF_SKIP_OPENCLAW;
    delete process.env.REDDWARF_MODEL_PROVIDER;

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
      expect(
        (properties["REDDWARF_MODEL_PROVIDER"] as Record<string, unknown>)["enum"]
      ).toEqual(["anthropic", "openai", "openai-codex"]);

      const badUpdate = await operatorPut(port, "/config", {
        entries: [{ key: "REDDWARF_POLL_INTERVAL_MS", value: "not-a-number" }]
      });
      expect(badUpdate.status).toBe(400);
      const badProviderUpdate = await operatorPut(port, "/config", {
        entries: [{ key: "REDDWARF_MODEL_PROVIDER", value: "bedrock" }]
      });
      expect(badProviderUpdate.status).toBe(400);

      const updated = await operatorPut(port, "/config", {
        entries: [
          { key: "REDDWARF_POLL_INTERVAL_MS", value: 45000 },
          { key: "REDDWARF_SKIP_OPENCLAW", value: true },
          { key: "REDDWARF_MODEL_PROVIDER", value: "openai" }
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
      expect(
        updatedItems.find((entry) => entry["key"] === "REDDWARF_MODEL_PROVIDER")
      ).toMatchObject({
        value: "openai",
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
      expect(process.env.REDDWARF_MODEL_PROVIDER).toBe("openai");
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

      if (previousModelProvider === undefined) {
        delete process.env.REDDWARF_MODEL_PROVIDER;
      } else {
        process.env.REDDWARF_MODEL_PROVIDER = previousModelProvider;
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

  it("rotates write-only secrets into a restricted local store", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "reddwarf-operator-secrets-"));
    const secretStorePath = join(tempRoot, ".secrets");
    const previousGitHubToken = process.env.GITHUB_TOKEN;
    const previousOperatorToken = process.env.REDDWARF_OPERATOR_TOKEN;
    const repository = new InMemoryPlanningRepository();
    const apiServer = createOperatorApiServer(
      {
        port: 0,
        host: "127.0.0.1",
        authToken: operatorApiToken,
        localSecretsPath: secretStorePath
      },
      { repository, clock: () => new Date("2026-04-01T10:15:00.000Z") }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const rotatedGitHubToken = await operatorPost(
        port,
        "/secrets/GITHUB_TOKEN/rotate",
        { value: "ghp_rotated_fixture" }
      );
      expect(rotatedGitHubToken.status).toBe(200);
      expect(rotatedGitHubToken.body).toMatchObject({
        key: "GITHUB_TOKEN",
        restartRequired: false,
        rotatedAt: "2026-04-01T10:15:00.000Z"
      });
      expect((rotatedGitHubToken.body as Record<string, unknown>)["value"]).toBeUndefined();
      expect(process.env.GITHUB_TOKEN).toBe("ghp_rotated_fixture");

      const rotatedOperatorToken = await operatorPost(
        port,
        "/secrets/REDDWARF_OPERATOR_TOKEN/rotate",
        { value: "operator-token-next" }
      );
      expect(rotatedOperatorToken.status).toBe(200);
      expect(rotatedOperatorToken.body).toMatchObject({
        key: "REDDWARF_OPERATOR_TOKEN",
        restartRequired: true
      });
      expect(
        ((rotatedOperatorToken.body as Record<string, unknown>)["notes"] as string[]).some(
          (note) => note.includes("previous bearer token until it restarts")
        )
      ).toBe(true);

      const configStillAuthorized = await operatorGet(port, "/config");
      expect(configStillAuthorized.status).toBe(200);

      const secretContent = await readFile(secretStorePath, "utf8");
      expect(secretContent).toContain("GITHUB_TOKEN=ghp_rotated_fixture");
      expect(secretContent).toContain("REDDWARF_OPERATOR_TOKEN=operator-token-next");

      const secretStats = await stat(secretStorePath);
      expect(secretStats.mode & 0o777).toBe(0o600);

      const badSecret = await operatorPost(port, "/secrets/NOT_REAL/rotate", {
        value: "noop"
      });
      expect(badSecret.status).toBe(404);

      const badPayload = await operatorPost(port, "/secrets/GITHUB_TOKEN/rotate", {
        value: "line-one\nline-two"
      });
      expect(badPayload.status).toBe(400);
    } finally {
      if (previousGitHubToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = previousGitHubToken;
      }

      if (previousOperatorToken === undefined) {
        delete process.env.REDDWARF_OPERATOR_TOKEN;
      } else {
        process.env.REDDWARF_OPERATOR_TOKEN = previousOperatorToken;
      }

      await apiServer.stop();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("serves a single-file operator panel and protected bootstrap metadata", async () => {
    const previousOpenClawBaseUrl = process.env.OPENCLAW_BASE_URL;
    process.env.OPENCLAW_BASE_URL = "http://127.0.0.1:9";
    const previousWorkspaceRoot = process.env.REDDWARF_HOST_WORKSPACE_ROOT;
    process.env.REDDWARF_HOST_WORKSPACE_ROOT = "runtime-data/custom-workspaces";
    const previousGitHubToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "ghp_fixture_ui_1234";

    const repository = new InMemoryPlanningRepository();
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date("2026-04-01T11:00:00.000Z") }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const ui = await operatorGetRaw(port, "/ui", "text/html");
      expect(ui.status).toBe(200);
      expect(ui.contentType).toContain("text/html");
      expect(ui.body).toContain("GET /ui");
      expect(ui.body).toContain("RedDwarf Operator Panel");
      expect(ui.body).toContain("Polling & Dispatch");
      expect(ui.body).toContain("Pending Approvals");
      expect(ui.body).toContain("/approvals?statuses=pending");
      expect(ui.body).toContain("data-decision=\"approve\"");

      const bootstrap = await operatorGet(port, "/ui/bootstrap");
      expect(bootstrap.status).toBe(200);
      expect(bootstrap.body).toMatchObject({
        sessionTier: "operator",
        appVersion: expect.any(String)
      });
      expect(
        ((bootstrap.body as Record<string, unknown>)["paths"] as Array<Record<string, unknown>>).some(
          (entry) =>
            entry["key"] === "REDDWARF_HOST_WORKSPACE_ROOT" &&
            entry["value"] === "runtime-data/custom-workspaces"
        )
      ).toBe(true);
      expect(
        ((bootstrap.body as Record<string, unknown>)["secrets"] as Array<Record<string, unknown>>).some(
          (entry) =>
            entry["key"] === "GITHUB_TOKEN" &&
            entry["present"] === true &&
            typeof entry["maskedValue"] === "string"
        )
      ).toBe(true);
      expect(
        (((bootstrap.body as Record<string, unknown>)["openClaw"] as Record<string, unknown>)[
          "reachable"
        ])
      ).toBe(false);
    } finally {
      if (previousOpenClawBaseUrl === undefined) {
        delete process.env.OPENCLAW_BASE_URL;
      } else {
        process.env.OPENCLAW_BASE_URL = previousOpenClawBaseUrl;
      }

      if (previousWorkspaceRoot === undefined) {
        delete process.env.REDDWARF_HOST_WORKSPACE_ROOT;
      } else {
        process.env.REDDWARF_HOST_WORKSPACE_ROOT = previousWorkspaceRoot;
      }

      if (previousGitHubToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = previousGitHubToken;
      }

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

  it("exports audit entries as JSON and CSV joining approvals with manifests", async () => {
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
        clock: () => new Date("2026-04-19T12:00:00.000Z"),
        idGenerator: () => "op-audit-001"
      }
    );

    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const jsonResponse = await operatorGet(port, "/audit/export");
      expect(jsonResponse.status).toBe(200);
      const body = jsonResponse.body as {
        entries: Array<Record<string, unknown>>;
        total: number;
        window: { since: string | null; until: string | null };
        truncated: boolean;
      };
      expect(body.total).toBeGreaterThan(0);
      expect(body.truncated).toBe(false);
      expect(body.window.since).toBeNull();
      expect(body.window.until).toBeNull();
      const entry = body.entries[0]!;
      expect(entry["taskId"]).toBe(planResult.manifest.taskId);
      expect(entry["repo"]).toBe(planResult.manifest.source.repo);
      expect(entry["phase"]).toBe("policy_gate");

      const narrow = await operatorGet(
        port,
        "/audit/export?since=2099-01-01T00:00:00.000Z"
      );
      expect(narrow.status).toBe(200);
      expect((narrow.body as { total: number }).total).toBe(0);

      const wrongRepo = await operatorGet(
        port,
        "/audit/export?repo=someone-else/does-not-exist"
      );
      expect(wrongRepo.status).toBe(200);
      expect((wrongRepo.body as { total: number }).total).toBe(0);

      const csv = await new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>(
        (resolve, reject) => {
          const req = httpRequest(
            {
              hostname: "127.0.0.1",
              port,
              path: "/audit/export?format=csv",
              method: "GET",
              headers: buildOperatorHeaders()
            },
            (res) => {
              let raw = "";
              res.on("data", (chunk: Buffer) => (raw += chunk.toString()));
              res.on("end", () =>
                resolve({ status: res.statusCode ?? 0, body: raw, headers: res.headers })
              );
            }
          );
          req.on("error", reject);
          req.end();
        }
      );
      expect(csv.status).toBe(200);
      expect(String(csv.headers["content-type"])).toContain("text/csv");
      expect(String(csv.headers["content-disposition"])).toContain("attachment");
      const csvLines = csv.body.split("\r\n").filter((l) => l.length > 0);
      expect(csvLines[0]).toContain("requestId,taskId,runId,repo");
      expect(csvLines.length).toBeGreaterThanOrEqual(2);
      expect(csvLines[1]).toContain(planResult.manifest.taskId);
    } finally {
      await apiServer.stop();
    }
  });

  it("exposes agent quality metrics aggregated by phase and policy version", async () => {
    const repository = new InMemoryPlanningRepository();
    await runPlanningPipeline(
      {
        ...eligibleInput,
        requestedCapabilities: ["can_write_code"],
        affectedPaths: ["src/api.ts"]
      },
      {
        repository,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-04-19T12:00:00.000Z"),
        idGenerator: () => "op-metrics-001"
      }
    );

    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository }
    );

    await apiServer.start();
    try {
      const response = await operatorGet(apiServer.port, "/metrics/agents");
      expect(response.status).toBe(200);
      const body = response.body as {
        phaseOutcomes: Array<{ phase: string; total: number; passRate: number; policyVersion: string }>;
        phaseLatencies: unknown[];
        failureClasses: unknown[];
        window: { since: string | null; until: string | null };
      };
      expect(Array.isArray(body.phaseOutcomes)).toBe(true);
      expect(body.phaseOutcomes.length).toBeGreaterThan(0);
      // The deterministic planner produces at least a planning phase record.
      const planning = body.phaseOutcomes.find((r) => r.phase === "planning");
      expect(planning).toBeDefined();
      expect(planning!.total).toBeGreaterThan(0);
      expect(body.window).toEqual({ since: null, until: null });

      const narrow = await operatorGet(
        apiServer.port,
        "/metrics/agents?since=2099-01-01T00:00:00.000Z"
      );
      expect(narrow.status).toBe(200);
      expect(
        (narrow.body as { phaseOutcomes: unknown[] }).phaseOutcomes
      ).toHaveLength(0);
    } finally {
      await apiServer.stop();
    }
  });

  it("quarantines, releases, notes, and kicks a heartbeat (Feature 186)", async () => {
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
        clock: () => new Date("2026-04-19T12:00:00.000Z"),
        idGenerator: () => "op-triage-001"
      }
    );

    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository }
    );
    await apiServer.start();
    const port = apiServer.port;

    try {
      const taskId = planResult.manifest.taskId;

      // ── Quarantine without reason → 400 ───────────────────────────────
      const noReason = await operatorPost(
        port,
        `/tasks/${encodeURIComponent(taskId)}/quarantine`,
        {}
      );
      expect(noReason.status).toBe(400);

      // ── Quarantine with reason → 200, manifest updated ────────────────
      const quarantined = await operatorPost(
        port,
        `/tasks/${encodeURIComponent(taskId)}/quarantine`,
        { reason: "Suspicious pattern in spec; pausing for review." }
      );
      expect(quarantined.status).toBe(200);
      expect(
        (quarantined.body as {
          manifest: { lifecycleStatus: string };
        }).manifest.lifecycleStatus
      ).toBe("quarantined");

      // ── Quarantine again → 409 ────────────────────────────────────────
      const dupQ = await operatorPost(
        port,
        `/tasks/${encodeURIComponent(taskId)}/quarantine`,
        { reason: "again" }
      );
      expect(dupQ.status).toBe(409);

      // ── Release → 200, lifecycleStatus back to ready ──────────────────
      const released = await operatorPost(
        port,
        `/tasks/${encodeURIComponent(taskId)}/release`,
        {}
      );
      expect(released.status).toBe(200);
      expect(
        (released.body as {
          manifest: { lifecycleStatus: string };
        }).manifest.lifecycleStatus
      ).toBe("ready");

      // ── Release a non-quarantined task → 409 ──────────────────────────
      const dupRelease = await operatorPost(
        port,
        `/tasks/${encodeURIComponent(taskId)}/release`,
        {}
      );
      expect(dupRelease.status).toBe(409);

      // ── Notes (empty body → 400) ──────────────────────────────────────
      const noteEmpty = await operatorPost(
        port,
        `/tasks/${encodeURIComponent(taskId)}/notes`,
        { note: "" }
      );
      expect(noteEmpty.status).toBe(400);

      // ── Notes (good) → 200, returns memoryId ──────────────────────────
      const noteOk = await operatorPost(
        port,
        `/tasks/${encodeURIComponent(taskId)}/notes`,
        { note: "On hold pending sec review.", author: "derek" }
      );
      expect(noteOk.status).toBe(200);
      expect(typeof (noteOk.body as { memoryId: string }).memoryId).toBe(
        "string"
      );

      // ── Heartbeat-kick: find an active/blocked run for this task ──────
      const runs = await operatorGet(port, `/runs?taskId=${taskId}`);
      const runList = (runs.body as { runs: Array<{ runId: string; status: string }> })
        .runs;
      const targetRun = runList.find(
        (r) => r.status === "active" || r.status === "blocked"
      );
      expect(targetRun).toBeDefined();
      const kicked = await operatorPost(
        port,
        `/runs/${encodeURIComponent(targetRun!.runId)}/heartbeat-kick`,
        { reason: "checking on it" }
      );
      expect(kicked.status).toBe(200);

      // ── Heartbeat-kick on missing run → 404 ───────────────────────────
      const missing = await operatorPost(
        port,
        `/runs/does-not-exist/heartbeat-kick`,
        {}
      );
      expect(missing.status).toBe(404);
    } finally {
      await apiServer.stop();
    }
  });

  it("returns the daily budget burn-down with no budgets configured", async () => {
    const repository = new InMemoryPlanningRepository();
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository }
    );
    await apiServer.start();
    try {
      const response = await operatorGet(apiServer.port, "/budget/daily");
      expect(response.status).toBe(200);
      const body = response.body as {
        tokensUsed: number;
        costUsdUsed: number;
        tokenBudget: number | null;
        costBudgetUsd: number | null;
        exhausted: boolean;
      };
      expect(body.tokensUsed).toBe(0);
      expect(body.costUsdUsed).toBe(0);
      expect(body.tokenBudget).toBeNull();
      expect(body.costBudgetUsd).toBeNull();
      expect(body.exhausted).toBe(false);
    } finally {
      await apiServer.stop();
    }
  });

  it("requires the operator bearer token on /budget/daily", async () => {
    const repository = new InMemoryPlanningRepository();
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository }
    );
    await apiServer.start();
    try {
      const unauthorized = await operatorGet(
        apiServer.port,
        "/budget/daily",
        null
      );
      expect(unauthorized.status).toBe(401);
    } finally {
      await apiServer.stop();
    }
  });

  it("requires the operator bearer token on /metrics/agents", async () => {
    const repository = new InMemoryPlanningRepository();
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository }
    );
    await apiServer.start();
    try {
      const unauthorized = await operatorGet(
        apiServer.port,
        "/metrics/agents",
        null
      );
      expect(unauthorized.status).toBe(401);
    } finally {
      await apiServer.stop();
    }
  });

  it("requires the operator bearer token on /audit/export", async () => {
    const repository = new InMemoryPlanningRepository();
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository }
    );

    await apiServer.start();
    try {
      const unauthorized = await operatorGet(
        apiServer.port,
        "/audit/export",
        null
      );
      expect(unauthorized.status).toBe(401);
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

  it("supports URL-encoded approval IDs for detail and resolve routes", async () => {
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
        idGenerator: () => "op-run-encoded-approval"
      }
    );

    const requestId = planResult.approvalRequest!.requestId;
    const encodedRequestId = encodeURIComponent(requestId);
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date("2026-03-26T12:05:00.000Z") }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const getApproval = await operatorGet(port, `/approvals/${encodedRequestId}`);
      expect(getApproval.status).toBe(200);
      expect(
        (
          (getApproval.body as Record<string, unknown>)[
            "approval"
          ] as Record<string, unknown>
        )["requestId"]
      ).toBe(requestId);

      const resolved = await operatorPost(
        port,
        `/approvals/${encodedRequestId}/resolve`,
        {
          decision: "approve",
          decidedBy: "operator-test",
          decisionSummary: "Approved via encoded operator API route."
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
    } finally {
      await apiServer.stop();
    }
  });

  it("rejects generic approval resolution when a project-mode plan is awaiting project approval", async () => {
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
        idGenerator: () => "op-run-project-approval-conflict"
      }
    );

    const projectId = `project:${planResult.manifest.taskId}`;
    await repository.saveProjectSpec(
      buildTestProjectSpec({
        projectId,
        sourceIssueId: String(planResult.manifest.source.issueNumber ?? 10),
        sourceRepo: planResult.manifest.source.repo
      })
    );

    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date("2026-03-26T12:05:00.000Z") }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const resolved = await operatorPost(
        port,
        `/approvals/${planResult.approvalRequest!.requestId}/resolve`,
        {
          decision: "approve",
          decidedBy: "operator-test",
          decisionSummary: "Approved via the wrong route."
        }
      );
      expect(resolved.status).toBe(409);
      expect((resolved.body as Record<string, unknown>)["projectId"]).toBe(projectId);
      expect((resolved.body as Record<string, unknown>)["approvalRoute"]).toBe(
        `/projects/${encodeURIComponent(projectId)}/approve`
      );

      const approval = await repository.getApprovalRequest(
        planResult.approvalRequest!.requestId
      );
      expect(approval?.status).toBe("pending");

      const manifest = await repository.getManifest(planResult.manifest.taskId);
      expect(manifest?.lifecycleStatus).toBe("blocked");
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

  it("creates a GitHub issue via POST /issues/submit and returns issue coordinates", async () => {
    const repository = new InMemoryPlanningRepository();
    const githubWriter = new FixtureGitHubAdapter({
      candidates: [],
      mutations: { allowIssueCreation: true, issueNumberStart: 200 }
    });
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, githubWriter }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const response = await operatorPost(port, "/issues/submit", {
        repo: "acme/platform",
        title: "Add structured issue intake via dashboard form",
        summary: "Operators should be able to create GitHub issues directly from the dashboard to inject tasks into the planning pipeline without leaving the UI.",
        acceptanceCriteria: [
          "A GitHub issue is created with the ai-eligible label",
          "The response includes the issue number and URL"
        ],
        affectedPaths: ["packages/dashboard/src/"],
        constraints: ["Must not change the polling daemon"],
        requestedCapabilities: ["can_plan", "can_write_code", "can_run_tests", "can_open_pr", "can_archive_evidence"],
        riskClassHint: "low"
      });

      expect(response.status).toBe(201);
      const body = response.body as Record<string, unknown>;
      expect(body["issueNumber"]).toBe(200);
      expect(body["repo"]).toBe("acme/platform");
      expect(typeof body["issueUrl"]).toBe("string");
      expect(String(body["issueUrl"])).toContain("acme/platform/issues/200");
    } finally {
      await apiServer.stop();
    }
  });

  it("returns 503 for POST /issues/submit when no githubWriter is configured", async () => {
    const repository = new InMemoryPlanningRepository();
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const response = await operatorPost(port, "/issues/submit", {
        repo: "acme/platform",
        title: "This should not reach GitHub",
        summary: "The server has no GitHub writer configured so this must fail with 503.",
        acceptanceCriteria: ["Returns 503 when githubWriter is absent"]
      });

      expect(response.status).toBe(503);
      expect((response.body as Record<string, unknown>)["error"]).toBe("service_unavailable");
    } finally {
      await apiServer.stop();
    }
  });

  it("returns 400 for POST /issues/submit when the payload is invalid", async () => {
    const repository = new InMemoryPlanningRepository();
    const githubWriter = new FixtureGitHubAdapter({
      candidates: [],
      mutations: { allowIssueCreation: true }
    });
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, githubWriter }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const response = await operatorPost(port, "/issues/submit", {
        repo: "acme/platform",
        title: "Hi",
        summary: "Too short."
      });

      expect(response.status).toBe(400);
      expect((response.body as Record<string, unknown>)["error"]).toBe("bad_request");
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

  it("returns 429 when rate limit is exceeded", async () => {
    const repository = new InMemoryPlanningRepository();
    const apiServer = createOperatorApiServer(
      {
        port: 0,
        host: "127.0.0.1",
        authToken: operatorApiToken,
        rateLimitMaxRequests: 2,
        rateLimitWindowMs: 60_000
      },
      { repository, clock: () => new Date("2026-03-26T12:00:00.000Z") }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const first = await operatorGet(port, "/health");
      expect(first.status).toBe(200);
      const second = await operatorGet(port, "/health");
      expect(second.status).toBe(200);
      const third = await operatorGet(port, "/health");
      expect(third.status).toBe(429);
      expect((third.body as Record<string, unknown>)["error"]).toBe("rate_limit_exceeded");
    } finally {
      await apiServer.stop();
    }
  });

  it("updates config entries via PUT /config and reflects changes in GET /config", async () => {
    const repository = new InMemoryPlanningRepository();
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date("2026-03-26T12:00:00.000Z") }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const beforeUpdate = await operatorGet(port, "/config");
      expect(beforeUpdate.status).toBe(200);

      const updateResponse = await operatorPut(port, "/config", {
        entries: [{ key: "REDDWARF_DRY_RUN", value: true }]
      });
      expect(updateResponse.status).toBe(200);
      const config = (updateResponse.body as Record<string, unknown>)["config"] as Array<Record<string, unknown>>;
      const dryRunEntry = config.find((e) => e["key"] === "REDDWARF_DRY_RUN");
      expect(dryRunEntry).toBeDefined();

      const afterUpdate = await operatorGet(port, "/config");
      expect(afterUpdate.status).toBe(200);
      const afterConfig = (afterUpdate.body as Record<string, unknown>)["config"] as Array<Record<string, unknown>>;
      expect(afterConfig.some((e) => e["key"] === "REDDWARF_DRY_RUN")).toBe(true);
    } finally {
      await apiServer.stop();
    }
  });

  it("returns 400 for PUT /config with an invalid payload", async () => {
    const repository = new InMemoryPlanningRepository();
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date("2026-03-26T12:00:00.000Z") }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const response = await operatorPut(port, "/config", {
        entries: [{ key: "NOT_A_VALID_KEY", value: "boom" }]
      });
      expect(response.status).toBe(400);
      expect((response.body as Record<string, unknown>)["error"]).toBe("bad_request");
    } finally {
      await apiServer.stop();
    }
  });

  it("returns 404 for POST /secrets/:key/rotate with an unknown key", async () => {
    const repository = new InMemoryPlanningRepository();
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date("2026-03-26T12:00:00.000Z") }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const response = await operatorPost(port, "/secrets/UNKNOWN_SECRET_KEY/rotate", {
        value: "new-secret-value"
      });
      expect(response.status).toBe(404);
      expect((response.body as Record<string, unknown>)["error"]).toBe("not_found");
    } finally {
      await apiServer.stop();
    }
  });

  it("returns 400 for POST /secrets/:key/rotate with a multi-line value", async () => {
    const repository = new InMemoryPlanningRepository();
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date("2026-03-26T12:00:00.000Z") }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const response = await operatorPost(port, "/secrets/GITHUB_TOKEN/rotate", {
        value: "line1\nline2"
      });
      expect(response.status).toBe(400);
      expect((response.body as Record<string, unknown>)["error"]).toBe("bad_request");
    } finally {
      await apiServer.stop();
    }
  });

  it("returns an empty blocked summary from GET /blocked with an empty repository", async () => {
    const repository = new InMemoryPlanningRepository();
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date("2026-03-26T12:00:00.000Z") }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const response = await operatorGet(port, "/blocked");
      expect(response.status).toBe(200);
      const body = response.body as Record<string, unknown>;
      expect(body["totalBlockedRuns"]).toBe(0);
      expect(body["totalPendingApprovals"]).toBe(0);
      expect(body["blockedRuns"]).toEqual([]);
      expect(body["pendingApprovals"]).toEqual([]);
      expect(body["retryExhaustedEntries"]).toEqual([]);
    } finally {
      await apiServer.stop();
    }
  });

  it("filters GET /runs limit to a positive integer not exceeding 1000", async () => {
    const repository = new InMemoryPlanningRepository();
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date("2026-03-26T12:00:00.000Z") }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      // Negative limit is silently ignored (falls back to repository default)
      const negative = await operatorGet(port, "/runs?limit=-1");
      expect(negative.status).toBe(200);
      // Over-limit is silently clamped (falls back to repository default)
      const overlimit = await operatorGet(port, "/runs?limit=99999");
      expect(overlimit.status).toBe(200);
      // Valid limit is accepted
      const valid = await operatorGet(port, "/runs?limit=10");
      expect(valid.status).toBe(200);
    } finally {
      await apiServer.stop();
    }
  });

  it("ignores unknown status values in GET /runs?statuses=", async () => {
    const repository = new InMemoryPlanningRepository();
    const apiServer = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date("2026-03-26T12:00:00.000Z") }
    );

    await apiServer.start();
    const port = apiServer.port;

    try {
      const response = await operatorGet(port, "/runs?statuses=not_a_real_status&statuses=running");
      expect(response.status).toBe(200);
      // Unknown status is silently dropped; "running" is a valid status
      expect(Array.isArray((response.body as Record<string, unknown>)["runs"])).toBe(true);
    } finally {
      await apiServer.stop();
    }
  });

  describe("POST /runs/:runId/cancel", () => {
    const cancelClock = () => new Date("2026-04-10T15:30:00.000Z");

    async function seedRun(
      repository: InMemoryPlanningRepository,
      runId: string,
      status: "blocked" | "failed" | "stale" | "active" | "completed" | "cancelled"
    ): Promise<void> {
      await repository.savePipelineRun(
        createPipelineRun({
          runId,
          taskId: `task-${runId}`,
          concurrencyKey: `github:acme/platform:${runId}`,
          strategy: "serialize",
          status,
          startedAt: "2026-04-10T15:00:00.000Z",
          lastHeartbeatAt: "2026-04-10T15:00:00.000Z",
          metadata: {}
        })
      );
    }

    it("cancels a blocked pipeline run and returns the updated record", async () => {
      const repository = new InMemoryPlanningRepository();
      await seedRun(repository, "run-blocked", "blocked");
      const apiServer = createOperatorApiServer(
        { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
        { repository, clock: cancelClock }
      );
      await apiServer.start();
      const port = apiServer.port;

      try {
        const response = await operatorPost(port, "/runs/run-blocked/cancel", {});
        expect(response.status).toBe(200);
        const run = (response.body as Record<string, unknown>)["run"] as Record<string, unknown>;
        expect(run["status"]).toBe("cancelled");
        expect(run["completedAt"]).toBe("2026-04-10T15:30:00.000Z");
        expect(run["lastHeartbeatAt"]).toBe("2026-04-10T15:30:00.000Z");

        const persisted = await repository.getPipelineRun("run-blocked");
        expect(persisted?.status).toBe("cancelled");
        expect(persisted?.completedAt).toBe("2026-04-10T15:30:00.000Z");
      } finally {
        await apiServer.stop();
      }
    });

    it.each(["failed" as const, "stale" as const])(
      "cancels a %s pipeline run",
      async (status) => {
        const repository = new InMemoryPlanningRepository();
        await seedRun(repository, `run-${status}`, status);
        const apiServer = createOperatorApiServer(
          { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
          { repository, clock: cancelClock }
        );
        await apiServer.start();
        const port = apiServer.port;

        try {
          const response = await operatorPost(port, `/runs/run-${status}/cancel`, {});
          expect(response.status).toBe(200);
          const persisted = await repository.getPipelineRun(`run-${status}`);
          expect(persisted?.status).toBe("cancelled");
        } finally {
          await apiServer.stop();
        }
      }
    );

    it("returns 404 when the run does not exist", async () => {
      const repository = new InMemoryPlanningRepository();
      const apiServer = createOperatorApiServer(
        { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
        { repository, clock: cancelClock }
      );
      await apiServer.start();
      const port = apiServer.port;

      try {
        const response = await operatorPost(port, "/runs/missing/cancel", {});
        expect(response.status).toBe(404);
        expect((response.body as Record<string, unknown>)["error"]).toBe("not_found");
      } finally {
        await apiServer.stop();
      }
    });

    it("refuses to cancel an active run", async () => {
      const repository = new InMemoryPlanningRepository();
      await seedRun(repository, "run-active", "active");
      const apiServer = createOperatorApiServer(
        { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
        { repository, clock: cancelClock }
      );
      await apiServer.start();
      const port = apiServer.port;

      try {
        const response = await operatorPost(port, "/runs/run-active/cancel", {});
        expect(response.status).toBe(409);
        const persisted = await repository.getPipelineRun("run-active");
        expect(persisted?.status).toBe("active");
      } finally {
        await apiServer.stop();
      }
    });

    it.each(["completed" as const, "cancelled" as const])(
      "returns 409 for a %s run",
      async (status) => {
        const repository = new InMemoryPlanningRepository();
        await seedRun(repository, `run-${status}`, status);
        const apiServer = createOperatorApiServer(
          { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
          { repository, clock: cancelClock }
        );
        await apiServer.start();
        const port = apiServer.port;

        try {
          const response = await operatorPost(port, `/runs/run-${status}/cancel`, {});
          expect(response.status).toBe(409);
        } finally {
          await apiServer.stop();
        }
      }
    );

    it("rejects unauthenticated cancel requests", async () => {
      const repository = new InMemoryPlanningRepository();
      await seedRun(repository, "run-blocked", "blocked");
      const apiServer = createOperatorApiServer(
        { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
        { repository, clock: cancelClock }
      );
      await apiServer.start();
      const port = apiServer.port;

      try {
        const response = await operatorPost(port, "/runs/run-blocked/cancel", {}, null);
        expect(response.status).toBe(401);
        const persisted = await repository.getPipelineRun("run-blocked");
        expect(persisted?.status).toBe("blocked");
      } finally {
        await apiServer.stop();
      }
    });
  });
});

describe("OperatorRateLimiter", () => {
  it("allows requests up to the limit within the window", () => {
    const limiter = new OperatorRateLimiter(3, 60_000);
    expect(limiter.allow("1.2.3.4", 1000)).toBe(true);
    expect(limiter.allow("1.2.3.4", 2000)).toBe(true);
    expect(limiter.allow("1.2.3.4", 3000)).toBe(true);
    expect(limiter.allow("1.2.3.4", 4000)).toBe(false);
  });

  it("resets after the window expires", () => {
    const limiter = new OperatorRateLimiter(2, 1000);
    expect(limiter.allow("1.2.3.4", 0)).toBe(true);
    expect(limiter.allow("1.2.3.4", 100)).toBe(true);
    expect(limiter.allow("1.2.3.4", 200)).toBe(false);
    // Advance past the window
    expect(limiter.allow("1.2.3.4", 1100)).toBe(true);
    expect(limiter.allow("1.2.3.4", 1200)).toBe(true);
  });

  it("tracks different IPs independently", () => {
    const limiter = new OperatorRateLimiter(1, 60_000);
    expect(limiter.allow("1.1.1.1", 1000)).toBe(true);
    expect(limiter.allow("2.2.2.2", 1000)).toBe(true);
    expect(limiter.allow("1.1.1.1", 2000)).toBe(false);
    expect(limiter.allow("2.2.2.2", 2000)).toBe(false);
  });
});

// ============================================================
// Phase 3 — Project Mode operator API routes
// ============================================================

const testTimestamp = "2026-04-06T12:00:00.000Z";

function buildTestProjectSpec(overrides: Partial<import("@reddwarf/contracts").ProjectSpec> = {}): import("@reddwarf/contracts").ProjectSpec {
  return {
    projectId: "project:task-001",
    sourceIssueId: "10",
    sourceRepo: "acme/platform",
    title: "Test project",
    summary: "A test project for operator API endpoints.",
    projectSize: "medium",
    status: "pending_approval",
    complexityClassification: {
      size: "medium",
      reasoning: "Spans 3 packages.",
      signals: ["multi-package"]
    },
    approvalDecision: null,
    decidedBy: null,
    decisionSummary: null,
    amendments: null,
    clarificationQuestions: null,
    clarificationAnswers: null,
    clarificationRequestedAt: null,
    autoMergeEnabled: false,
    autoMergePolicy: null,
    requiredCheckContract: null,
    createdAt: testTimestamp,
    updatedAt: testTimestamp,
    ...overrides
  };
}

function buildTestTicketSpec(overrides: Partial<import("@reddwarf/contracts").TicketSpec> = {}): import("@reddwarf/contracts").TicketSpec {
  return {
    ticketId: "project:task-001:ticket:1",
    projectId: "project:task-001",
    title: "First ticket",
    description: "Implement the first feature.",
    acceptanceCriteria: ["Feature works"],
    dependsOn: [],
    status: "pending",
    complexityClass: "low",
    riskClass: "low",
    githubSubIssueNumber: null,
    githubPrNumber: null,
    requiredCheckContract: null,
    createdAt: testTimestamp,
    updatedAt: testTimestamp,
    ...overrides
  };
}

function buildTestParentManifest(overrides: Partial<import("@reddwarf/contracts").TaskManifest> = {}): import("@reddwarf/contracts").TaskManifest {
  return {
    taskId: "task-001",
    source: {
      provider: "github",
      repo: "acme/platform",
      issueNumber: 10,
      issueUrl: "https://github.com/acme/platform/issues/10"
    },
    title: "Parent project task",
    summary: "Parent task that produced the project.",
    priority: 50,
    dryRun: false,
    riskClass: "medium",
    approvalMode: "human_signoff_required",
    currentPhase: "archive",
    lifecycleStatus: "blocked",
    assignedAgentType: "architect",
    requestedCapabilities: ["can_plan"],
    retryCount: 0,
    evidenceLinks: ["db://project_spec/project:task-001"],
    workspaceId: null,
    branchName: null,
    prNumber: null,
    policyVersion: "test-policy",
    createdAt: testTimestamp,
    updatedAt: testTimestamp,
    ...overrides
  };
}

describe("Project Mode — GET /projects", () => {
  it("returns an empty list when no projects exist", async () => {
    const repository = new InMemoryPlanningRepository();
    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date(testTimestamp) }
    );
    await server.start();
    try {
      const res = await operatorGet(server.port, "/projects");
      expect(res.status).toBe(200);
      const body = res.body as { projects: unknown[]; total: number };
      expect(body.total).toBe(0);
      expect(body.projects).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  it("returns projects with ticket counts", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveProjectSpec(buildTestProjectSpec());
    await repository.saveTicketSpec(buildTestTicketSpec());
    await repository.saveTicketSpec(
      buildTestTicketSpec({
        ticketId: "project:task-001:ticket:2",
        title: "Second ticket",
        status: "merged",
        dependsOn: ["project:task-001:ticket:1"]
      })
    );

    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date(testTimestamp) }
    );
    await server.start();
    try {
      const res = await operatorGet(server.port, "/projects");
      expect(res.status).toBe(200);
      const body = res.body as { projects: { ticketCounts: Record<string, number> }[]; total: number };
      expect(body.total).toBe(1);
      expect(body.projects[0]!.ticketCounts.total).toBe(2);
      expect(body.projects[0]!.ticketCounts.pending).toBe(1);
      expect(body.projects[0]!.ticketCounts.merged).toBe(1);
    } finally {
      await server.stop();
    }
  });

  it("filters projects by repo query parameter", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveProjectSpec(buildTestProjectSpec());
    await repository.saveProjectSpec(
      buildTestProjectSpec({
        projectId: "project:task-002",
        sourceRepo: "other/repo"
      })
    );

    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date(testTimestamp) }
    );
    await server.start();
    try {
      const res = await operatorGet(server.port, "/projects?repo=acme/platform");
      const body = res.body as { projects: { projectId: string }[]; total: number };
      expect(body.total).toBe(1);
      expect(body.projects[0]!.projectId).toBe("project:task-001");
    } finally {
      await server.stop();
    }
  });

  it("returns 401 without auth token", async () => {
    const repository = new InMemoryPlanningRepository();
    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date(testTimestamp) }
    );
    await server.start();
    try {
      const res = await operatorGet(server.port, "/projects", null);
      expect(res.status).toBe(401);
    } finally {
      await server.stop();
    }
  });
});

describe("Project Mode — GET /projects/:id", () => {
  it("returns full project with ticket children", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveProjectSpec(buildTestProjectSpec());
    await repository.saveTicketSpec(buildTestTicketSpec());

    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date(testTimestamp) }
    );
    await server.start();
    try {
      const res = await operatorGet(
        server.port,
        `/projects/${encodeURIComponent("project:task-001")}`
      );
      expect(res.status).toBe(200);
      const body = res.body as {
        project: { projectId: string };
        tickets: { ticketId: string }[];
        ticketCounts: Record<string, number>;
      };
      expect(body.project.projectId).toBe("project:task-001");
      expect(body.tickets).toHaveLength(1);
      expect(body.ticketCounts.total).toBe(1);
    } finally {
      await server.stop();
    }
  });

  it("returns 404 for nonexistent project", async () => {
    const repository = new InMemoryPlanningRepository();
    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date(testTimestamp) }
    );
    await server.start();
    try {
      const res = await operatorGet(server.port, "/projects/nonexistent");
      expect(res.status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});

describe("Project Mode — POST /projects/:id/approve", () => {
  it("approves a project, creates sub-issues, and transitions to executing", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveProjectSpec(buildTestProjectSpec());
    await repository.saveTicketSpec(buildTestTicketSpec());

    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date("2026-04-06T13:00:00.000Z") }
    );
    await server.start();
    try {
      const res = await operatorPost(
        server.port,
        `/projects/${encodeURIComponent("project:task-001")}/approve`,
        {
          decision: "approve",
          decidedBy: "derek",
          decisionSummary: "Looks good."
        }
      );
      expect(res.status).toBe(200);
      const body = res.body as {
        project: { status: string; approvalDecision: string; decidedBy: string };
        subIssuesFallback: boolean;
        dispatchedTicket: { ticketId: string } | null;
        dispatchedTaskId: string | null;
        dispatchedTaskCreated: boolean;
      };
      // Project transitions all the way to executing (no adapter = fallback)
      expect(body.project.status).toBe("executing");
      expect(body.project.approvalDecision).toBe("approve");
      expect(body.project.decidedBy).toBe("derek");
      expect(body.subIssuesFallback).toBe(true);
      expect(body.dispatchedTicket?.ticketId).toBe("project:task-001:ticket:1");
      expect(body.dispatchedTaskId).toBe("task-001-ticket-1");
      expect(body.dispatchedTaskCreated).toBe(true);

      const persisted = await repository.getProjectSpec("project:task-001");
      expect(persisted?.status).toBe("executing");
    } finally {
      await server.stop();
    }
  });

  it("creates GitHub sub-issues when adapter is provided", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveProjectSpec(buildTestProjectSpec({ sourceIssueId: "10" }));
    await repository.saveTicketSpec(buildTestTicketSpec());
    await repository.saveTicketSpec(
      buildTestTicketSpec({
        ticketId: "project:task-001:ticket:2",
        title: "Second ticket",
        dependsOn: ["project:task-001:ticket:1"]
      })
    );

    const { FixtureGitHubIssuesAdapter } = await import("@reddwarf/integrations");
    const adapter = new FixtureGitHubIssuesAdapter({ repo: "acme/platform" });

    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      {
        repository,
        clock: () => new Date("2026-04-06T13:00:00.000Z"),
        githubIssuesAdapter: adapter
      }
    );
    await server.start();
    try {
      const res = await operatorPost(
        server.port,
        `/projects/${encodeURIComponent("project:task-001")}/approve`,
        { decision: "approve", decidedBy: "derek" }
      );
      expect(res.status).toBe(200);
      const body = res.body as {
        subIssuesCreated: number;
        subIssuesFallback: boolean;
        tickets: { githubSubIssueNumber: number | null }[];
      };
      expect(body.subIssuesCreated).toBe(2);
      expect(body.subIssuesFallback).toBe(false);
      expect(body.tickets.every((t) => t.githubSubIssueNumber !== null)).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("backfills missing GitHub sub-issues for an already executing project before PRs open", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveProjectSpec(
      buildTestProjectSpec({
        sourceIssueId: "10",
        status: "executing",
        approvalDecision: "approve",
        decidedBy: "derek"
      })
    );
    await repository.saveTicketSpec(
      buildTestTicketSpec({
        status: "dispatched"
      })
    );
    await repository.saveTicketSpec(
      buildTestTicketSpec({
        ticketId: "project:task-001:ticket:2",
        title: "Second ticket",
        dependsOn: ["project:task-001:ticket:1"]
      })
    );

    const { FixtureGitHubIssuesAdapter } = await import("@reddwarf/integrations");
    const adapter = new FixtureGitHubIssuesAdapter({ repo: "fallback/repo" });

    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      {
        repository,
        clock: () => new Date("2026-04-06T13:00:00.000Z"),
        githubIssuesAdapter: adapter
      }
    );
    await server.start();
    try {
      const res = await operatorPost(
        server.port,
        `/projects/${encodeURIComponent("project:task-001")}/approve`,
        { decision: "approve", decidedBy: "operator" }
      );
      expect(res.status).toBe(200);
      const body = res.body as {
        project: { status: string };
        subIssuesCreated: number;
        subIssuesFallback: boolean;
        tickets: { githubSubIssueNumber: number | null; status: string }[];
        dispatchedTicket: { ticketId: string } | null;
        dispatchedTaskId: string | null;
      };
      expect(body.project.status).toBe("executing");
      expect(body.subIssuesCreated).toBe(2);
      expect(body.subIssuesFallback).toBe(false);
      expect(body.tickets.every((t) => t.githubSubIssueNumber !== null)).toBe(true);
      expect(body.tickets.filter((t) => t.status === "dispatched")).toHaveLength(1);
      expect(body.dispatchedTicket?.ticketId).toBe("project:task-001:ticket:1");
      expect(body.dispatchedTaskId).toBe("task-001-ticket-1");
    } finally {
      await server.stop();
    }
  });

  it("recovers an executing project whose dispatched ticket is missing a child task", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveProjectSpec(
      buildTestProjectSpec({
        sourceIssueId: "10",
        status: "executing",
        approvalDecision: "approve",
        decidedBy: "derek"
      })
    );
    await repository.saveTicketSpec(
      buildTestTicketSpec({
        status: "dispatched",
        githubSubIssueNumber: 2000
      })
    );

    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      {
        repository,
        clock: () => new Date("2026-04-06T13:00:00.000Z")
      }
    );
    await server.start();
    try {
      const res = await operatorPost(
        server.port,
        `/projects/${encodeURIComponent("project:task-001")}/approve`,
        { decision: "approve", decidedBy: "operator" }
      );
      expect(res.status).toBe(200);
      const body = res.body as {
        project: { status: string };
        subIssuesCreated: number;
        subIssuesFallback: boolean;
        dispatchedTaskId: string | null;
        dispatchedTaskCreated: boolean;
      };
      expect(body.project.status).toBe("executing");
      expect(body.subIssuesCreated).toBe(0);
      expect(body.subIssuesFallback).toBe(false);
      expect(body.dispatchedTaskId).toBe("task-001-ticket-1");
      expect(body.dispatchedTaskCreated).toBe(true);

      const childSnapshot = await repository.getTaskSnapshot("task-001-ticket-1");
      expect(childSnapshot.manifest?.lifecycleStatus).toBe("ready");
    } finally {
      await server.stop();
    }
  });

  it("retries an incomplete approved project when all tickets are still pending", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveProjectSpec(
      buildTestProjectSpec({
        status: "approved",
        approvalDecision: "approve",
        decidedBy: "derek"
      })
    );
    await repository.saveTicketSpec(
      buildTestTicketSpec({
        githubSubIssueNumber: 2001
      })
    );
    await repository.saveTicketSpec(
      buildTestTicketSpec({
        ticketId: "project:task-001:ticket:2",
        title: "Second ticket",
        dependsOn: ["project:task-001:ticket:1"]
      })
    );

    const { FixtureGitHubIssuesAdapter } = await import("@reddwarf/integrations");
    const adapter = new FixtureGitHubIssuesAdapter({ repo: "acme/platform" });

    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      {
        repository,
        clock: () => new Date("2026-04-06T13:00:00.000Z"),
        githubIssuesAdapter: adapter
      }
    );
    await server.start();
    try {
      const res = await operatorPost(
        server.port,
        `/projects/${encodeURIComponent("project:task-001")}/approve`,
        { decision: "approve", decidedBy: "operator" }
      );
      expect(res.status).toBe(200);
      const body = res.body as {
        project: { status: string };
        subIssuesCreated: number;
        dispatchedTicket: { ticketId: string } | null;
      };
      expect(body.project.status).toBe("executing");
      expect(body.subIssuesCreated).toBe(1);
      expect(body.dispatchedTicket?.ticketId).toBe("project:task-001:ticket:1");
    } finally {
      await server.stop();
    }
  });

  it("amends a project with amendments text", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveProjectSpec(buildTestProjectSpec());

    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date("2026-04-06T13:00:00.000Z") }
    );
    await server.start();
    try {
      const res = await operatorPost(
        server.port,
        `/projects/${encodeURIComponent("project:task-001")}/approve`,
        {
          decision: "amend",
          decidedBy: "derek",
          decisionSummary: "Needs more detail on ticket 2.",
          amendments: "Please add more detail to the second ticket's acceptance criteria."
        }
      );
      expect(res.status).toBe(200);
      const body = res.body as { project: { status: string; amendments: string } };
      expect(body.project.status).toBe("draft");
      expect(body.project.amendments).toContain("more detail");

      const persisted = await repository.getProjectSpec("project:task-001");
      expect(persisted?.status).toBe("draft");
      expect(persisted?.amendments).toContain("more detail");
    } finally {
      await server.stop();
    }
  });

  it("rejects amend without amendments text", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveProjectSpec(buildTestProjectSpec());

    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date(testTimestamp) }
    );
    await server.start();
    try {
      const res = await operatorPost(
        server.port,
        `/projects/${encodeURIComponent("project:task-001")}/approve`,
        { decision: "amend", decidedBy: "derek" }
      );
      expect(res.status).toBe(400);
    } finally {
      await server.stop();
    }
  });

  it("returns 409 when project is not in pending_approval status", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveProjectSpec(buildTestProjectSpec({ status: "draft" }));

    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date(testTimestamp) }
    );
    await server.start();
    try {
      const res = await operatorPost(
        server.port,
        `/projects/${encodeURIComponent("project:task-001")}/approve`,
        { decision: "approve", decidedBy: "derek" }
      );
      expect(res.status).toBe(409);
    } finally {
      await server.stop();
    }
  });

  it("returns 404 for nonexistent project", async () => {
    const repository = new InMemoryPlanningRepository();
    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date(testTimestamp) }
    );
    await server.start();
    try {
      const res = await operatorPost(
        server.port,
        "/projects/nonexistent/approve",
        { decision: "approve", decidedBy: "derek" }
      );
      expect(res.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  it("returns 401 without auth token", async () => {
    const repository = new InMemoryPlanningRepository();
    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date(testTimestamp) }
    );
    await server.start();
    try {
      const res = await operatorPost(
        server.port,
        `/projects/${encodeURIComponent("project:task-001")}/approve`,
        { decision: "approve", decidedBy: "derek" },
        null
      );
      expect(res.status).toBe(401);
    } finally {
      await server.stop();
    }
  });
});

describe("M25 F-189 — Project Mode auto-merge opt-in", () => {
  it("persists autoMergeEnabled=true when global flag is on and approval body opts in", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveProjectSpec(buildTestProjectSpec());
    await repository.saveTicketSpec(buildTestTicketSpec());

    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      {
        repository,
        clock: () => new Date("2026-04-26T13:00:00.000Z"),
        projectAutoMergeEnabled: true
      }
    );
    await server.start();
    try {
      const res = await operatorPost(
        server.port,
        `/projects/${encodeURIComponent("project:task-001")}/approve`,
        {
          decision: "approve",
          decidedBy: "derek",
          auto_merge: { enabled: true }
        }
      );
      expect(res.status).toBe(200);
      const persisted = await repository.getProjectSpec("project:task-001");
      expect(persisted?.autoMergeEnabled).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("returns 409 auto_merge_globally_disabled and does not mutate when global flag is off", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveProjectSpec(buildTestProjectSpec());
    await repository.saveTicketSpec(buildTestTicketSpec());

    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      {
        repository,
        clock: () => new Date("2026-04-26T13:00:00.000Z"),
        projectAutoMergeEnabled: false
      }
    );
    await server.start();
    try {
      const res = await operatorPost(
        server.port,
        `/projects/${encodeURIComponent("project:task-001")}/approve`,
        {
          decision: "approve",
          decidedBy: "derek",
          auto_merge: { enabled: true }
        }
      );
      expect(res.status).toBe(409);
      expect((res.body as { error: string }).error).toBe(
        "auto_merge_globally_disabled"
      );

      const persisted = await repository.getProjectSpec("project:task-001");
      // Project remained in pending_approval — no state mutation took place.
      expect(persisted?.status).toBe("pending_approval");
      expect(persisted?.autoMergeEnabled).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it("approves without auto-merge when the body omits the auto_merge field", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveProjectSpec(buildTestProjectSpec());
    await repository.saveTicketSpec(buildTestTicketSpec());

    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      {
        repository,
        clock: () => new Date("2026-04-26T13:00:00.000Z"),
        projectAutoMergeEnabled: true
      }
    );
    await server.start();
    try {
      const res = await operatorPost(
        server.port,
        `/projects/${encodeURIComponent("project:task-001")}/approve`,
        { decision: "approve", decidedBy: "derek" }
      );
      expect(res.status).toBe(200);
      const persisted = await repository.getProjectSpec("project:task-001");
      expect(persisted?.autoMergeEnabled).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it("/projects/inject returns 409 when injecting an auto-merge-enabled project while the global flag is off", async () => {
    const repository = new InMemoryPlanningRepository();
    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      {
        repository,
        clock: () => new Date("2026-04-26T13:00:00.000Z"),
        projectAutoMergeEnabled: false
      }
    );
    await server.start();
    try {
      const res = await operatorPost(server.port, "/projects/inject", {
        projectSpec: {
          ...buildTestProjectSpec(),
          autoMergeEnabled: true
        },
        provenance: {
          context_spec_id: "ctx-automerge-1",
          context_version: 1,
          adapter_version: "1.0.0",
          target_schema_version: "1.0.0",
          translation_notes: []
        }
      });
      expect(res.status).toBe(409);
      expect((res.body as { error: string }).error).toBe(
        "auto_merge_globally_disabled"
      );
      // Nothing was inserted — list reflects an empty repository.
      expect(await repository.getProjectSpec("project:task-001")).toBeNull();
    } finally {
      await server.stop();
    }
  });
});

describe("M25 F-196 — PATCH /projects/:id (auto-merge toggle)", () => {
  it("toggles autoMergeEnabled when the global flag is on", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveProjectSpec(buildTestProjectSpec());
    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      {
        repository,
        clock: () => new Date("2026-04-26T13:00:00.000Z"),
        projectAutoMergeEnabled: true
      }
    );
    await server.start();
    try {
      const res = await operatorRequest(
        server.port,
        "PATCH",
        `/projects/${encodeURIComponent("project:task-001")}`,
        { autoMergeEnabled: true }
      );
      expect(res.status).toBe(200);
      expect((res.body as { project: { autoMergeEnabled: boolean } }).project.autoMergeEnabled).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("returns 409 when enabling auto-merge while global flag is off", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveProjectSpec(buildTestProjectSpec());
    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      {
        repository,
        clock: () => new Date("2026-04-26T13:00:00.000Z"),
        projectAutoMergeEnabled: false
      }
    );
    await server.start();
    try {
      const res = await operatorRequest(
        server.port,
        "PATCH",
        `/projects/${encodeURIComponent("project:task-001")}`,
        { autoMergeEnabled: true }
      );
      expect(res.status).toBe(409);
      const persisted = await repository.getProjectSpec("project:task-001");
      expect(persisted?.autoMergeEnabled).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it("allows disabling auto-merge regardless of global flag (kill-switch path)", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveProjectSpec(
      buildTestProjectSpec({ autoMergeEnabled: true })
    );
    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      {
        repository,
        clock: () => new Date("2026-04-26T13:00:00.000Z"),
        projectAutoMergeEnabled: false
      }
    );
    await server.start();
    try {
      const res = await operatorRequest(
        server.port,
        "PATCH",
        `/projects/${encodeURIComponent("project:task-001")}`,
        { autoMergeEnabled: false }
      );
      expect(res.status).toBe(200);
      const persisted = await repository.getProjectSpec("project:task-001");
      expect(persisted?.autoMergeEnabled).toBe(false);
    } finally {
      await server.stop();
    }
  });
});

describe("Project Mode — GET /projects/:id/clarifications", () => {
  it("returns pending clarification questions", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveProjectSpec(
      buildTestProjectSpec({
        status: "clarification_pending",
        clarificationQuestions: [
          "What framework should the frontend use?",
          "Is there a preferred database?"
        ],
        clarificationRequestedAt: testTimestamp
      })
    );

    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date(testTimestamp) }
    );
    await server.start();
    try {
      const res = await operatorGet(
        server.port,
        `/projects/${encodeURIComponent("project:task-001")}/clarifications`
      );
      expect(res.status).toBe(200);
      const body = res.body as {
        questions: string[];
        status: string;
        timedOut: boolean;
        timeoutMs: number;
      };
      expect(body.questions).toHaveLength(2);
      expect(body.status).toBe("clarification_pending");
      expect(body.timedOut).toBe(false);
      expect(body.timeoutMs).toBe(1800000);
    } finally {
      await server.stop();
    }
  });

  it("reports timeout when clarification has expired", async () => {
    const repository = new InMemoryPlanningRepository();
    const longAgo = "2026-04-05T10:00:00.000Z";
    await repository.saveProjectSpec(
      buildTestProjectSpec({
        status: "clarification_pending",
        clarificationQuestions: ["What framework?"],
        clarificationRequestedAt: longAgo
      })
    );

    // Clock is well past the 30-minute timeout
    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date("2026-04-06T12:00:00.000Z") }
    );
    await server.start();
    try {
      const res = await operatorGet(
        server.port,
        `/projects/${encodeURIComponent("project:task-001")}/clarifications`
      );
      expect(res.status).toBe(200);
      const body = res.body as { timedOut: boolean };
      expect(body.timedOut).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it("returns empty questions for project not in clarification_pending", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveProjectSpec(buildTestProjectSpec());

    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date(testTimestamp) }
    );
    await server.start();
    try {
      const res = await operatorGet(
        server.port,
        `/projects/${encodeURIComponent("project:task-001")}/clarifications`
      );
      expect(res.status).toBe(200);
      const body = res.body as { questions: string[] };
      expect(body.questions).toEqual([]);
    } finally {
      await server.stop();
    }
  });
});

describe("Project Mode — POST /projects/:id/clarify", () => {
  it("accepts clarification answers and transitions project to draft", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveProjectSpec(
      buildTestProjectSpec({
        status: "clarification_pending",
        clarificationQuestions: ["What framework?", "What database?"],
        clarificationRequestedAt: testTimestamp
      })
    );

    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date("2026-04-06T13:00:00.000Z") }
    );
    await server.start();
    try {
      const res = await operatorPost(
        server.port,
        `/projects/${encodeURIComponent("project:task-001")}/clarify`,
        {
          answers: {
            "What framework?": "React with Vite",
            "What database?": "PostgreSQL"
          }
        }
      );
      expect(res.status).toBe(200);
      const body = res.body as { project: { status: string; clarificationAnswers: Record<string, string> } };
      expect(body.project.status).toBe("draft");
      expect(body.project.clarificationAnswers).toEqual({
        "What framework?": "React with Vite",
        "What database?": "PostgreSQL"
      });

      const persisted = await repository.getProjectSpec("project:task-001");
      expect(persisted?.status).toBe("draft");
      expect(persisted?.clarificationAnswers).toEqual({
        "What framework?": "React with Vite",
        "What database?": "PostgreSQL"
      });
    } finally {
      await server.stop();
    }
  });

  it("returns 409 when project is not in clarification_pending", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveProjectSpec(buildTestProjectSpec());

    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date(testTimestamp) }
    );
    await server.start();
    try {
      const res = await operatorPost(
        server.port,
        `/projects/${encodeURIComponent("project:task-001")}/clarify`,
        { answers: { q1: "a1" } }
      );
      expect(res.status).toBe(409);
    } finally {
      await server.stop();
    }
  });

  it("returns 400 with missing answers field", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveProjectSpec(
      buildTestProjectSpec({ status: "clarification_pending" })
    );

    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date(testTimestamp) }
    );
    await server.start();
    try {
      const res = await operatorPost(
        server.port,
        `/projects/${encodeURIComponent("project:task-001")}/clarify`,
        { notAnswers: "wrong field" }
      );
      expect(res.status).toBe(400);
    } finally {
      await server.stop();
    }
  });

  it("returns 404 for nonexistent project", async () => {
    const repository = new InMemoryPlanningRepository();
    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date(testTimestamp) }
    );
    await server.start();
    try {
      const res = await operatorPost(
        server.port,
        "/projects/nonexistent/clarify",
        { answers: { q1: "a1" } }
      );
      expect(res.status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});

describe("Project Mode — POST /projects/advance", () => {
  it("merges ticket, dispatches next, and returns advanced outcome", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveProjectSpec(buildTestProjectSpec({ status: "executing" }));
    await repository.saveTicketSpec(
      buildTestTicketSpec({
        status: "dispatched",
        githubSubIssueNumber: 2000
      })
    );
    await repository.saveTicketSpec(
      buildTestTicketSpec({
        ticketId: "project:task-001:ticket:2",
        title: "Second ticket",
        dependsOn: ["project:task-001:ticket:1"],
        githubSubIssueNumber: 2001
      })
    );

    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date(testTimestamp) }
    );
    await server.start();
    try {
      const res = await operatorPost(server.port, "/projects/advance", {
        ticket_id: "project:task-001:ticket:1",
        github_pr_number: 55
      });
      expect(res.status).toBe(200);
      const body = res.body as { outcome: string; ticket: { status: string; githubPrNumber: number }; nextDispatchedTicket: { ticketId: string } | null };
      expect(body.outcome).toBe("advanced");
      expect(body.ticket.status).toBe("merged");
      expect(body.ticket.githubPrNumber).toBe(55);
      expect(body.nextDispatchedTicket).not.toBeNull();
      expect(body.nextDispatchedTicket!.ticketId).toBe("project:task-001:ticket:2");
      expect((res.body as { nextDispatchedTaskId: string | null }).nextDispatchedTaskId).toBe(
        "task-001-ticket-2"
      );

      const childSnapshot = await repository.getTaskSnapshot("task-001-ticket-2");
      expect(childSnapshot.manifest?.lifecycleStatus).toBe("ready");
    } finally {
      await server.stop();
    }
  });

  it("completes project when all tickets are merged", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveProjectSpec(buildTestProjectSpec({ status: "executing" }));
    await repository.saveManifest(buildTestParentManifest());
    await repository.saveTicketSpec(
      buildTestTicketSpec({ status: "merged" })
    );
    await repository.saveTicketSpec(
      buildTestTicketSpec({
        ticketId: "project:task-001:ticket:2",
        title: "Last ticket",
        status: "dispatched",
        dependsOn: ["project:task-001:ticket:1"]
      })
    );

    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date(testTimestamp) }
    );
    await server.start();
    try {
      const res = await operatorPost(server.port, "/projects/advance", {
        ticket_id: "project:task-001:ticket:2",
        github_pr_number: 56
      });
      expect(res.status).toBe(200);
      const body = res.body as { outcome: string; project: { status: string } };
      expect(body.outcome).toBe("completed");
      expect(body.project.status).toBe("complete");
      const parentManifest = await repository.getManifest("task-001");
      expect(parentManifest?.lifecycleStatus).toBe("completed");
      expect(parentManifest?.currentPhase).toBe("archive");
    } finally {
      await server.stop();
    }
  });

  it("returns already_merged for idempotent re-advance", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveProjectSpec(buildTestProjectSpec({ status: "executing" }));
    await repository.saveTicketSpec(
      buildTestTicketSpec({ status: "merged", githubPrNumber: 55 })
    );

    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date(testTimestamp) }
    );
    await server.start();
    try {
      const res = await operatorPost(server.port, "/projects/advance", {
        ticket_id: "project:task-001:ticket:1",
        github_pr_number: 55
      });
      expect(res.status).toBe(200);
      const body = res.body as { outcome: string };
      expect(body.outcome).toBe("already_merged");
    } finally {
      await server.stop();
    }
  });

  it("returns 404 for nonexistent ticket", async () => {
    const repository = new InMemoryPlanningRepository();
    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date(testTimestamp) }
    );
    await server.start();
    try {
      const res = await operatorPost(server.port, "/projects/advance", {
        ticket_id: "nonexistent",
        github_pr_number: 1
      });
      expect(res.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  it("returns 409 when advancing a ticket that is not dispatched or pr_open", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.saveProjectSpec(buildTestProjectSpec({ status: "executing" }));
    await repository.saveTicketSpec(
      buildTestTicketSpec({ status: "pending" })
    );

    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date(testTimestamp) }
    );
    await server.start();
    try {
      const res = await operatorPost(server.port, "/projects/advance", {
        ticket_id: "project:task-001:ticket:1",
        github_pr_number: 55
      });
      expect(res.status).toBe(409);
      expect((res.body as { error: string }).error).toBe("conflict");
    } finally {
      await server.stop();
    }
  });

  it("returns 400 for invalid payload", async () => {
    const repository = new InMemoryPlanningRepository();
    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date(testTimestamp) }
    );
    await server.start();
    try {
      const res = await operatorPost(server.port, "/projects/advance", {
        wrong_field: "bad"
      });
      expect(res.status).toBe(400);
    } finally {
      await server.stop();
    }
  });

  it("returns 400 for a non-integer PR number", async () => {
    const repository = new InMemoryPlanningRepository();
    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date(testTimestamp) }
    );
    await server.start();
    try {
      const res = await operatorPost(server.port, "/projects/advance", {
        ticket_id: "project:task-001:ticket:1",
        github_pr_number: 55.5
      });
      expect(res.status).toBe(400);
    } finally {
      await server.stop();
    }
  });

  it("returns 401 without auth token", async () => {
    const repository = new InMemoryPlanningRepository();
    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date(testTimestamp) }
    );
    await server.start();
    try {
      const res = await operatorPost(server.port, "/projects/advance", {
        ticket_id: "project:task-001:ticket:1",
        github_pr_number: 55
      }, null);
      expect(res.status).toBe(401);
    } finally {
      await server.stop();
    }
  });
});

describe("Project Mode — POST /projects/inject", () => {
  const validProjectSpec = () =>
    buildTestProjectSpec({
      projectId: "project:context-inject-1",
      sourceIssueId: null,
      sourceRepo: "acme/platform",
      title: "Context-injected project",
      summary: "A project injected from Context with well-formed ProjectSpec data for testing.",
      status: "draft"
    });

  const validProvenance = () => ({
    context_spec_id: "11111111-1111-4111-8111-111111111111",
    context_version: 7,
    adapter_version: "0.1.0",
    target_schema_version: "0.1.0@9648d893a55b",
    translation_notes: [
      {
        kind: "grouped" as const,
        canonicalPath: "capabilities[0]",
        projectSpecPath: "summary",
        reason: "Capability folded into summary.",
        severity: "info" as const
      }
    ]
  });

  it("201s on first inject and lands the project in pending_approval", async () => {
    const repository = new InMemoryPlanningRepository();
    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date(testTimestamp) }
    );
    await server.start();
    try {
      const res = await operatorPost(server.port, "/projects/inject", {
        projectSpec: validProjectSpec(),
        provenance: validProvenance()
      });
      expect(res.status).toBe(201);
      const body = res.body as {
        project_id: string;
        state: string;
        provenance_id: string;
        deduplicated: boolean;
      };
      expect(body.state).toBe("pending_approval");
      expect(body.deduplicated).toBe(false);
      const stored = await repository.getProjectSpec(body.project_id);
      expect(stored?.status).toBe("pending_approval");
      const prov = await repository.findProjectSpecProvenanceByContext(
        validProvenance().context_spec_id,
        validProvenance().context_version
      );
      expect(prov?.adapter_version).toBe("0.1.0");
      expect(prov?.translation_notes).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it("200s with deduplicated: true on idempotent re-post", async () => {
    const repository = new InMemoryPlanningRepository();
    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date(testTimestamp) }
    );
    await server.start();
    try {
      const first = await operatorPost(server.port, "/projects/inject", {
        projectSpec: validProjectSpec(),
        provenance: validProvenance()
      });
      expect(first.status).toBe(201);
      const second = await operatorPost(server.port, "/projects/inject", {
        projectSpec: validProjectSpec(),
        provenance: validProvenance()
      });
      expect(second.status).toBe(200);
      const body = second.body as { deduplicated: boolean; project_id: string };
      expect(body.deduplicated).toBe(true);
      expect(body.project_id).toBe((first.body as { project_id: string }).project_id);
    } finally {
      await server.stop();
    }
  });

  it("422s on an invalid ProjectSpec payload", async () => {
    const repository = new InMemoryPlanningRepository();
    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date(testTimestamp) }
    );
    await server.start();
    try {
      const res = await operatorPost(server.port, "/projects/inject", {
        projectSpec: { projectId: "x" }, // missing required fields
        provenance: validProvenance()
      });
      expect(res.status).toBe(422);
    } finally {
      await server.stop();
    }
  });

  it("401s without the operator token", async () => {
    const repository = new InMemoryPlanningRepository();
    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date(testTimestamp) }
    );
    await server.start();
    try {
      const res = await operatorPost(
        server.port,
        "/projects/inject",
        { projectSpec: validProjectSpec(), provenance: validProvenance() },
        null
      );
      expect(res.status).toBe(401);
    } finally {
      await server.stop();
    }
  });

  it("404s when REDDWARF_PROJECTS_INJECT_ENABLED is false", async () => {
    const repository = new InMemoryPlanningRepository();
    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      {
        repository,
        clock: () => new Date(testTimestamp),
        projectsInjectEnabled: false
      }
    );
    await server.start();
    try {
      const res = await operatorPost(server.port, "/projects/inject", {
        projectSpec: validProjectSpec(),
        provenance: validProvenance()
      });
      expect(res.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  it("accepts an adapter schema-version mismatch as informational — does not block injection", async () => {
    const repository = new InMemoryPlanningRepository();
    const server = createOperatorApiServer(
      { port: 0, host: "127.0.0.1", authToken: operatorApiToken },
      { repository, clock: () => new Date(testTimestamp) }
    );
    await server.start();
    try {
      const res = await operatorPost(server.port, "/projects/inject", {
        projectSpec: validProjectSpec(),
        provenance: {
          ...validProvenance(),
          target_schema_version: "99.0.0@deadbeef"
        }
      });
      expect(res.status).toBe(201);
    } finally {
      await server.stop();
    }
  });
});
