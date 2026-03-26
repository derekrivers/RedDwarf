import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import {
  type ApprovalDecision,
  type ApprovalRequest,
  type PipelineRun
} from "@reddwarf/contracts";
import { type PlanningRepository } from "@reddwarf/evidence";
import { resolveApprovalRequest } from "./pipeline.js";

// ============================================================
// Operator API interfaces
// ============================================================

export interface OperatorApiConfig {
  port: number;
  host?: string;
}

export interface OperatorApiDependencies {
  repository: PlanningRepository;
  clock?: () => Date;
}

export interface OperatorBlockedSummary {
  blockedRuns: PipelineRun[];
  pendingApprovals: ApprovalRequest[];
  totalBlockedRuns: number;
  totalPendingApprovals: number;
}

export interface OperatorApiServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly port: number;
  readonly host: string;
}

// ============================================================
// Operator API server factory
// ============================================================

export function createOperatorApiServer(
  config: OperatorApiConfig,
  deps: OperatorApiDependencies
): OperatorApiServer {
  const host = config.host ?? "127.0.0.1";
  const { repository, clock = () => new Date() } = deps;
  let boundPort = config.port;

  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      try {
        await handleOperatorRequest(req, res, repository, clock);
      } catch (err) {
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
      return new Promise((resolve) => {
        server.listen(config.port, host, () => {
          const addr = server.address();
          if (addr !== null && typeof addr === "object") {
            boundPort = addr.port;
          }
          resolve();
        });
      });
    },
    async stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
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

async function readOperatorJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      try {
        resolve(raw.length > 0 ? JSON.parse(raw) : null);
      } catch {
        reject(new Error("Invalid JSON body"));
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

async function handleOperatorRequest(
  req: IncomingMessage,
  res: ServerResponse,
  repository: PlanningRepository,
  clock: () => Date
): Promise<void> {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";
  const urlObj = new URL(url, "http://localhost");
  const path = urlObj.pathname;
  const qp = parseOperatorQueryParams(url);

  // GET /health
  if (method === "GET" && path === "/health") {
    writeOperatorJsonResponse(res, 200, {
      status: "ok",
      timestamp: clock().toISOString()
    });
    return;
  }

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
    const body = (await readOperatorJsonBody(req)) as Record<
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
