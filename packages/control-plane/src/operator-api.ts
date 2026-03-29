import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { isAbsolute, relative, resolve } from "node:path";
import {
  type ApprovalDecision,
  type ApprovalRequest,
  type GitHubIssuePollingCursor,
  type PipelineRun
} from "@reddwarf/contracts";
import {
  type PlanningRepository,
  type RepositoryHealthSnapshot
} from "@reddwarf/evidence";
import {
  dispatchReadyTask,
  resolveApprovalRequest,
  type DispatchReadyTaskDependencies
} from "./pipeline.js";
import type { ReadyTaskDispatcher } from "./polling.js";

// ============================================================
// Operator API interfaces
// ============================================================

export interface OperatorApiConfig {
  port: number;
  host?: string;
  authToken: string;
  maxRequestBodyBytes?: number;
  managedTargetRoot?: string;
  managedEvidenceRoot?: string;
}

export interface OperatorApiDependencies {
  repository: PlanningRepository;
  clock?: () => Date;
  /** When provided, enables POST /tasks/:taskId/dispatch and dispatcher health reporting. */
  dispatcher?: ReadyTaskDispatcher;
  /** Dependencies for manual dispatch via POST /tasks/:taskId/dispatch. */
  dispatchDependencies?: Omit<DispatchReadyTaskDependencies, "repository" | "logger" | "clock" | "concurrency">;
}

export interface OperatorBlockedSummary {
  blockedRuns: PipelineRun[];
  pendingApprovals: ApprovalRequest[];
  totalBlockedRuns: number;
  totalPendingApprovals: number;
}

export interface OperatorPollingHealthSummary {
  status: "idle" | "healthy" | "degraded";
  repositories: GitHubIssuePollingCursor[];
  totalRepositories: number;
  failingRepositories: number;
}

export interface OperatorDispatcherHealthSummary {
  status: "idle" | "running" | "degraded";
  consecutiveFailures: number;
  lastDispatchOutcome: string | null;
  lastDispatchTaskId: string | null;
}

export interface OperatorHealthResponse {
  status: "ok";
  timestamp: string;
  repository: RepositoryHealthSnapshot;
  polling: OperatorPollingHealthSummary;
  dispatcher?: OperatorDispatcherHealthSummary;
}

export interface OperatorApiServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly port: number;
  readonly host: string;
}

class OperatorApiRequestError extends Error {
  readonly status: number;
  readonly error: string;

  constructor(status: number, error: string, message: string) {
    super(message);
    this.name = "OperatorApiRequestError";
    this.status = status;
    this.error = error;
  }
}

// ============================================================
// Operator API server factory
// ============================================================

export function createOperatorApiServer(
  config: OperatorApiConfig,
  deps: OperatorApiDependencies
): OperatorApiServer {
  const host = config.host ?? "127.0.0.1";
  const authToken = config.authToken.trim();
  const maxRequestBodyBytes = config.maxRequestBodyBytes ?? 64 * 1024;
  const managedTargetRoot =
    config.managedTargetRoot !== undefined
      ? resolve(config.managedTargetRoot)
      : undefined;
  const managedEvidenceRoot =
    config.managedEvidenceRoot !== undefined
      ? resolve(config.managedEvidenceRoot)
      : undefined;
  const {
    repository,
    clock = () => new Date(),
    dispatcher,
    dispatchDependencies
  } = deps;
  let boundPort = config.port;

  if (authToken.length === 0) {
    throw new Error("Operator API authToken is required.");
  }

  if (dispatchDependencies && !managedTargetRoot) {
    throw new Error(
      "managedTargetRoot is required when dispatchDependencies are configured."
    );
  }

  if (dispatchDependencies && !managedEvidenceRoot) {
    throw new Error(
      "managedEvidenceRoot is required when dispatchDependencies are configured."
    );
  }

  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      try {
        await handleOperatorRequest(
          req,
          res,
          repository,
          clock,
          authToken,
          maxRequestBodyBytes,
          dispatcher,
          dispatchDependencies,
          managedTargetRoot,
          managedEvidenceRoot
        );
      } catch (err) {
        if (err instanceof OperatorApiRequestError) {
          writeOperatorJsonResponse(res, err.status, {
            error: err.error,
            message: err.message
          });
          return;
        }

        writeOperatorJsonResponse(res, 500, {
          error: "internal_error",
          message: err instanceof Error ? err.message : "Unexpected error"
        });
      }
    }
  );

  return {
    get port() {
      return boundPort;
    },
    get host() {
      return host;
    },
    async start(): Promise<void> {
      return new Promise((resolvePromise) => {
        server.listen(config.port, host, () => {
          const addr = server.address();
          if (addr !== null && typeof addr === "object") {
            boundPort = addr.port;
          }
          resolvePromise();
        });
      });
    },
    async stop(): Promise<void> {
      return new Promise((resolvePromise, reject) => {
        server.close((err) => (err ? reject(err) : resolvePromise()));
      });
    }
  };
}

// ============================================================
// Internal helpers
// ============================================================

function writeOperatorJsonResponse(
  res: ServerResponse,
  status: number,
  body: unknown
): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json)
  });
  res.end(json);
}

async function readOperatorJsonBody(
  req: IncomingMessage,
  maxRequestBodyBytes: number
): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let raw = "";
    let rawBytes = 0;
    let tooLarge = false;

    req.on("data", (chunk: Buffer) => {
      rawBytes += chunk.length;

      if (rawBytes > maxRequestBodyBytes) {
        tooLarge = true;
        return;
      }

      raw += chunk.toString();
    });

    req.on("end", () => {
      if (tooLarge) {
        reject(
          new OperatorApiRequestError(
            413,
            "payload_too_large",
            `Request body exceeds ${maxRequestBodyBytes} bytes.`
          )
        );
        return;
      }

      try {
        resolveBody(raw.length > 0 ? JSON.parse(raw) : null);
      } catch {
        reject(new OperatorApiRequestError(400, "bad_request", "Invalid JSON body."));
      }
    });

    req.on("error", reject);
  });
}

function parseOperatorQueryParams(
  url: string
): Record<string, string | string[]> {
  const u = new URL(url, "http://localhost");
  const params: Record<string, string | string[]> = {};
  for (const [key, value] of u.searchParams) {
    const existing = params[key];
    if (existing === undefined) {
      params[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      params[key] = [existing, value];
    }
  }
  return params;
}

function readOperatorAuthToken(req: IncomingMessage): string | null {
  const authorization = req.headers["authorization"];

  if (typeof authorization === "string") {
    const match = /^Bearer\s+(.+)$/.exec(authorization.trim());
    if (match) {
      return match[1] ?? null;
    }
  }

  const tokenHeader = req.headers["x-reddwarf-operator-token"];
  if (typeof tokenHeader === "string" && tokenHeader.trim().length > 0) {
    return tokenHeader.trim();
  }

  return null;
}

function assertOperatorAuthorized(
  req: IncomingMessage,
  authToken: string
): void {
  const suppliedToken = readOperatorAuthToken(req);

  if (suppliedToken !== authToken) {
    throw new OperatorApiRequestError(
      401,
      "unauthorized",
      "Valid operator token required. Supply Authorization: Bearer <token>."
    );
  }
}

function resolveManagedDispatchRoot(
  requestedRoot: string | undefined,
  managedRoot: string,
  label: "targetRoot" | "evidenceRoot"
): string {
  const resolvedRoot = resolve(requestedRoot ?? managedRoot);
  const relativePath = relative(managedRoot, resolvedRoot);

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new OperatorApiRequestError(
      400,
      "bad_request",
      `${label} ${resolvedRoot} escapes configured root ${managedRoot}.`
    );
  }

  return resolvedRoot;
}

async function handleOperatorRequest(
  req: IncomingMessage,
  res: ServerResponse,
  repository: PlanningRepository,
  clock: () => Date,
  authToken: string,
  maxRequestBodyBytes: number,
  dispatcher?: ReadyTaskDispatcher,
  dispatchDependencies?: Omit<DispatchReadyTaskDependencies, "repository" | "logger" | "clock" | "concurrency">,
  managedTargetRoot?: string,
  managedEvidenceRoot?: string
): Promise<void> {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";
  const urlObj = new URL(url, "http://localhost");
  const path = urlObj.pathname;
  const qp = parseOperatorQueryParams(url);

  // GET /health remains unauthenticated for liveness checks.
  if (method === "GET" && path === "/health") {
    const response: OperatorHealthResponse = {
      status: "ok",
      timestamp: clock().toISOString(),
      repository: await repository.getRepositoryHealth(),
      polling: summarizePollingHealth(
        await repository.listGitHubIssuePollingCursors()
      ),
      ...(dispatcher
        ? {
            dispatcher: {
              status: dispatcher.isRunning
                ? dispatcher.consecutiveFailures > 0
                  ? "degraded"
                  : "running"
                : "idle",
              consecutiveFailures: dispatcher.consecutiveFailures,
              lastDispatchOutcome: dispatcher.lastDispatchResult?.outcome ?? null,
              lastDispatchTaskId: dispatcher.lastDispatchResult?.taskId ?? null
            }
          }
        : {})
    };
    writeOperatorJsonResponse(res, 200, response);
    return;
  }

  assertOperatorAuthorized(req, authToken);

  // GET /runs
  if (method === "GET" && path === "/runs") {
    const taskId = typeof qp["taskId"] === "string" ? qp["taskId"] : undefined;
    const limit = qp["limit"] ? parseInt(String(qp["limit"]), 10) : undefined;
    const rawStatuses = qp["statuses"];
    const statuses = rawStatuses
      ? (Array.isArray(rawStatuses) ? rawStatuses : [rawStatuses])
      : undefined;
    const runs = await repository.listPipelineRuns({
      ...(taskId !== undefined ? { taskId } : {}),
      ...(limit !== undefined && !isNaN(limit) ? { limit } : {}),
      ...(statuses !== undefined ? { statuses: statuses as PipelineRun["status"][] } : {})
    });
    writeOperatorJsonResponse(res, 200, { runs, total: runs.length });
    return;
  }

  // GET /approvals
  if (method === "GET" && path === "/approvals") {
    const taskId = typeof qp["taskId"] === "string" ? qp["taskId"] : undefined;
    const runId = typeof qp["runId"] === "string" ? qp["runId"] : undefined;
    const limit = qp["limit"] ? parseInt(String(qp["limit"]), 10) : undefined;
    const rawStatuses = qp["statuses"];
    const statuses = rawStatuses
      ? (Array.isArray(rawStatuses) ? rawStatuses : [rawStatuses])
      : undefined;
    const approvals = await repository.listApprovalRequests({
      ...(taskId !== undefined ? { taskId } : {}),
      ...(runId !== undefined ? { runId } : {}),
      ...(limit !== undefined && !isNaN(limit) ? { limit } : {}),
      ...(statuses !== undefined
        ? { statuses: statuses as ApprovalRequest["status"][] }
        : {})
    });
    writeOperatorJsonResponse(res, 200, {
      approvals,
      total: approvals.length
    });
    return;
  }

  // POST /approvals/:requestId/resolve  (must be checked before GET /approvals/:requestId)
  const resolveMatch = /^\/approvals\/([^/]+)\/resolve$/.exec(path);
  if (method === "POST" && resolveMatch) {
    const requestId = resolveMatch[1]!;
    const body = (await readOperatorJsonBody(req, maxRequestBodyBytes)) as Record<
      string,
      unknown
    > | null;
    if (
      !body ||
      typeof body["decision"] !== "string" ||
      typeof body["decidedBy"] !== "string" ||
      typeof body["decisionSummary"] !== "string"
    ) {
      writeOperatorJsonResponse(res, 400, {
        error: "bad_request",
        message: "decision, decidedBy, and decisionSummary are required."
      });
      return;
    }
    const resolveResult = await resolveApprovalRequest(
      {
        requestId,
        decision: body["decision"] as ApprovalDecision,
        decidedBy: body["decidedBy"],
        decisionSummary: body["decisionSummary"],
        comment:
          typeof body["comment"] === "string" ? body["comment"] : null
      },
      { repository, clock }
    );
    writeOperatorJsonResponse(res, 200, {
      approval: resolveResult.approvalRequest,
      manifest: resolveResult.manifest
    });
    return;
  }

  // GET /approvals/:requestId
  const approvalMatch = /^\/approvals\/([^/]+)$/.exec(path);
  if (method === "GET" && approvalMatch) {
    const requestId = approvalMatch[1]!;
    const approval = await repository.getApprovalRequest(requestId);
    if (!approval) {
      writeOperatorJsonResponse(res, 404, {
        error: "not_found",
        message: `Approval request ${requestId} not found.`
      });
      return;
    }
    writeOperatorJsonResponse(res, 200, { approval });
    return;
  }

  // GET /tasks/:taskId/evidence
  const evidenceMatch = /^\/tasks\/([^/]+)\/evidence$/.exec(path);
  if (method === "GET" && evidenceMatch) {
    const taskId = evidenceMatch[1]!;
    const snapshot = await repository.getTaskSnapshot(taskId);
    if (!snapshot.manifest) {
      writeOperatorJsonResponse(res, 404, {
        error: "not_found",
        message: `Task ${taskId} not found.`
      });
      return;
    }
    writeOperatorJsonResponse(res, 200, {
      taskId,
      evidenceRecords: snapshot.evidenceRecords,
      total: snapshot.evidenceRecords.length
    });
    return;
  }

  // GET /tasks/:taskId/snapshot
  const snapshotMatch = /^\/tasks\/([^/]+)\/snapshot$/.exec(path);
  if (method === "GET" && snapshotMatch) {
    const taskId = snapshotMatch[1]!;
    const snapshot = await repository.getTaskSnapshot(taskId);
    if (!snapshot.manifest) {
      writeOperatorJsonResponse(res, 404, {
        error: "not_found",
        message: `Task ${taskId} not found.`
      });
      return;
    }
    writeOperatorJsonResponse(res, 200, snapshot);
    return;
  }

  // POST /tasks/:taskId/dispatch
  const dispatchMatch = /^\/tasks\/([^/]+)\/dispatch$/.exec(path);
  if (method === "POST" && dispatchMatch) {
    const taskId = decodeURIComponent(dispatchMatch[1]!);

    if (!dispatchDependencies || !managedTargetRoot || !managedEvidenceRoot) {
      writeOperatorJsonResponse(res, 503, {
        error: "service_unavailable",
        message: "Dispatch dependencies are not configured on this server."
      });
      return;
    }

    const body = (await readOperatorJsonBody(req, maxRequestBodyBytes)) as Record<string, unknown> | null;
    const requestedTargetRoot =
      body && typeof body["targetRoot"] === "string"
        ? body["targetRoot"]
        : undefined;
    const requestedEvidenceRoot =
      body && typeof body["evidenceRoot"] === "string"
        ? body["evidenceRoot"]
        : undefined;
    const targetRoot = resolveManagedDispatchRoot(
      requestedTargetRoot,
      managedTargetRoot,
      "targetRoot"
    );
    const evidenceRoot = resolveManagedDispatchRoot(
      requestedEvidenceRoot,
      managedEvidenceRoot,
      "evidenceRoot"
    );

    const result = await dispatchReadyTask(
      { taskId, targetRoot, evidenceRoot },
      { repository, ...dispatchDependencies }
    );

    writeOperatorJsonResponse(res, 200, result);
    return;
  }

  // GET /blocked
  if (method === "GET" && path === "/blocked") {
    const [blockedRuns, pendingApprovals] = await Promise.all([
      repository.listPipelineRuns({ statuses: ["blocked"] }),
      repository.listApprovalRequests({ statuses: ["pending"] })
    ]);
    const summary: OperatorBlockedSummary = {
      blockedRuns,
      pendingApprovals,
      totalBlockedRuns: blockedRuns.length,
      totalPendingApprovals: pendingApprovals.length
    };
    writeOperatorJsonResponse(res, 200, summary);
    return;
  }

  writeOperatorJsonResponse(res, 404, {
    error: "not_found",
    message: "Route not found."
  });
}

function summarizePollingHealth(
  repositories: GitHubIssuePollingCursor[]
): OperatorPollingHealthSummary {
  const failingRepositories = repositories.filter(
    (record) => record.lastPollStatus === "failed"
  ).length;

  return {
    status:
      repositories.length === 0
        ? "idle"
        : failingRepositories > 0
          ? "degraded"
          : "healthy",
    repositories,
    totalRepositories: repositories.length,
    failingRepositories
  };
}
