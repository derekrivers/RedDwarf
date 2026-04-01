import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { isAbsolute, relative, resolve } from "node:path";
import {
  groupedTaskInjectionRequestSchema,
  taskGroupInjectionRequestSchema,
  directTaskInjectionRequestSchema,
  type ApprovalDecision,
  type ApprovalRequest,
  type GitHubIssuePollingCursor,
  type PlanningAgent,
  type PlanningTaskInput,
  type PipelineRun
} from "@reddwarf/contracts";
import {
  type PlanningRepository,
  type RepositoryHealthSnapshot
} from "@reddwarf/evidence";
import {
  dispatchReadyTask,
  resolveApprovalRequest,
  runPlanningPipeline,
  sweepOrphanedDispatcherState,
  type DispatchReadyTaskDependencies,
  type SweepOrphanedStateResult
} from "./pipeline.js";
import { saveTaskGroupMemberships } from "./task-groups.js";
import type {
  GitHubIssuePollingDaemon,
  PollingLoopHealthSnapshot,
  ReadyTaskDispatcher
} from "./polling.js";

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
  planner?: PlanningAgent;
  defaultPlanningDryRun?: boolean;
  clock?: () => Date;
  /** When provided, enables POST /tasks/:taskId/dispatch and dispatcher health reporting. */
  dispatcher?: ReadyTaskDispatcher;
  pollingDaemon?: GitHubIssuePollingDaemon;
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
  runtimeStatus: PollingLoopHealthSnapshot["status"];
  startupStatus: PollingLoopHealthSnapshot["startupStatus"];
  consecutiveFailures: number;
  lastCycleStartedAt: string | null;
  lastCycleCompletedAt: string | null;
  lastCycleDurationMs: number | null;
  lastError: string | null;
}

export interface OperatorDispatcherHealthSummary {
  status: PollingLoopHealthSnapshot["status"];
  startupStatus: PollingLoopHealthSnapshot["startupStatus"];
  consecutiveFailures: number;
  lastDispatchOutcome: string | null;
  lastDispatchTaskId: string | null;
  lastCycleStartedAt: string | null;
  lastCycleCompletedAt: string | null;
  lastCycleDurationMs: number | null;
  lastError: string | null;
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
    planner,
    defaultPlanningDryRun = false,
    clock = () => new Date(),
    dispatcher,
    pollingDaemon,
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
          pollingDaemon,
          planner,
          defaultPlanningDryRun,
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
  pollingDaemon?: GitHubIssuePollingDaemon,
  planner?: PlanningAgent,
  defaultPlanningDryRun?: boolean,
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
        await repository.listGitHubIssuePollingCursors(),
        pollingDaemon
      ),
      ...(dispatcher
        ? {
            dispatcher: {
              status: dispatcher.health.status,
              startupStatus: dispatcher.health.startupStatus,
              consecutiveFailures: dispatcher.consecutiveFailures,
              lastDispatchOutcome: dispatcher.lastDispatchResult?.outcome ?? null,
              lastDispatchTaskId: dispatcher.lastDispatchResult?.taskId ?? null,
              lastCycleStartedAt: dispatcher.health.lastCycleStartedAt,
              lastCycleCompletedAt: dispatcher.health.lastCycleCompletedAt,
              lastCycleDurationMs: dispatcher.health.lastCycleDurationMs,
              lastError: dispatcher.health.lastError
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
  if (method === "POST" && path === "/tasks/inject") {
    if (!planner) {
      writeOperatorJsonResponse(res, 503, {
        error: "service_unavailable",
        message: "Planner is not configured on this server."
      });
      return;
    }

    const rawBody = (await readOperatorJsonBody(
      req,
      maxRequestBodyBytes
    )) as Record<string, unknown> | null;
    let injected;
    try {
      injected = directTaskInjectionRequestSchema.parse(rawBody ?? {});
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Invalid injection payload.";
      writeOperatorJsonResponse(res, 400, {
        error: "bad_request",
        message
      });
      return;
    }

    const planningInput = buildPlanningTaskInputFromInjection(
      injected,
      defaultPlanningDryRun
    );
    const result = await runPlanningPipeline(planningInput, {
      repository,
      planner,
      clock
    });

    writeOperatorJsonResponse(res, 201, {
      runId: result.runId,
      nextAction: result.nextAction,
      manifest: result.manifest,
      ...(result.spec ? { spec: result.spec } : {}),
      ...(result.policySnapshot ? { policySnapshot: result.policySnapshot } : {}),
      ...(result.approvalRequest ? { approvalRequest: result.approvalRequest } : {})
    });
    return;
  }

  if (method === "POST" && path === "/task-groups/inject") {
    if (!planner) {
      writeOperatorJsonResponse(res, 503, {
        error: "service_unavailable",
        message: "Planning dependencies are not configured on this server."
      });
      return;
    }

    const rawBody = await readOperatorJsonBody(req, maxRequestBodyBytes);
    let injectedGroup;
    try {
      injectedGroup = taskGroupInjectionRequestSchema.parse(rawBody ?? {});
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Invalid task-group payload.";
      writeOperatorJsonResponse(res, 400, {
        error: "bad_request",
        message
      });
      return;
    }

    assertValidTaskGroupRequest(injectedGroup);

    const groupId =
      injectedGroup.groupId ?? `task-group-${clock().getTime().toString(36)}`;
    const groupTasks = resolveGroupedTaskDependencies(injectedGroup.tasks, injectedGroup.executionMode);
    const results = [];
    const taskIdByKey = new Map<string, string>();

    for (const task of groupTasks) {
      const planningInput = buildPlanningTaskInputFromInjection(
        task,
        defaultPlanningDryRun
      );
      const result = await runPlanningPipeline(planningInput, {
        repository,
        planner,
        clock
      });
      taskIdByKey.set(task.taskKey, result.manifest.taskId);
      results.push({
        taskKey: task.taskKey,
        dependsOn: task.dependsOn,
        runId: result.runId,
        nextAction: result.nextAction,
        manifest: result.manifest,
        ...(result.spec ? { spec: result.spec } : {}),
        ...(result.policySnapshot ? { policySnapshot: result.policySnapshot } : {}),
        ...(result.approvalRequest ? { approvalRequest: result.approvalRequest } : {})
      });
    }

    await saveTaskGroupMemberships({
      repository,
      repo: groupTasks[0]!.repo,
      groupId,
      executionMode: injectedGroup.executionMode,
      memberships: groupTasks.map((task, index) => ({
        taskId: taskIdByKey.get(task.taskKey)!,
        taskKey: task.taskKey,
        sequence: index,
        dependsOnTaskKeys: task.dependsOn,
        dependsOnTaskIds: task.dependsOn.map((key) => taskIdByKey.get(key)!)
      })),
      createdAt: clock().toISOString(),
      ...(injectedGroup.groupName !== undefined
        ? { groupName: injectedGroup.groupName }
        : {})
    });

    writeOperatorJsonResponse(res, 201, {
      groupId,
      executionMode: injectedGroup.executionMode,
      groupName: injectedGroup.groupName ?? null,
      totalTasks: results.length,
      tasks: results
    });
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

  // POST /maintenance/reconcile-orphaned-state
  if (method === "POST" && path === "/maintenance/reconcile-orphaned-state") {
    const body = (await readOperatorJsonBody(req, maxRequestBodyBytes)) as Record<string, unknown> | null;
    const scanLimit =
      body && typeof body["scanLimit"] === "number" ? (body["scanLimit"] as number) : undefined;

    const result: SweepOrphanedStateResult = await sweepOrphanedDispatcherState(
      repository,
      scanLimit !== undefined ? { scanLimit } : undefined
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

function buildPlanningTaskInputFromInjection(
  input:
    | import("@reddwarf/contracts").DirectTaskInjectionRequest
    | import("@reddwarf/contracts").GroupedTaskInjectionRequest,
  defaultDryRun = false
): PlanningTaskInput {
  const intakeMetadata = {
    mode: "direct_injection",
    ...(input.constraints.length > 0 ? { constraints: input.constraints } : {}),
    ...(input.riskClassHint ? { riskClassHint: input.riskClassHint } : {})
  };

  return {
    source: {
      provider: "github",
      repo: input.repo,
      ...(input.issueNumber !== undefined ? { issueNumber: input.issueNumber } : {}),
      ...(input.issueUrl ? { issueUrl: input.issueUrl } : {})
    },
    title: input.title,
    summary: input.summary,
    priority: input.priority,
    dryRun: input.dryRun ?? defaultDryRun,
    labels: [...new Set(["ai-eligible", ...input.labels])],
    acceptanceCriteria: input.acceptanceCriteria,
    affectedPaths: input.affectedPaths,
    requestedCapabilities: input.requestedCapabilities,
    metadata: {
      ...input.metadata,
      intake: intakeMetadata
    }
  };
}

function assertValidTaskGroupRequest(
  input: import("@reddwarf/contracts").TaskGroupInjectionRequest
): void {
  const seenTaskKeys = new Set<string>();
  const expectedRepo = input.tasks[0]?.repo;

  for (const task of input.tasks) {
    if (expectedRepo && task.repo !== expectedRepo) {
      throw new OperatorApiRequestError(
        400,
        "bad_request",
        "Grouped task intake currently requires every task to target the same repository."
      );
    }
    if (seenTaskKeys.has(task.taskKey)) {
      throw new OperatorApiRequestError(
        400,
        "bad_request",
        `Task group contains duplicate taskKey "${task.taskKey}".`
      );
    }
    seenTaskKeys.add(task.taskKey);
  }

  for (const task of input.tasks) {
    for (const dependencyKey of task.dependsOn) {
      if (!seenTaskKeys.has(dependencyKey)) {
        throw new OperatorApiRequestError(
          400,
          "bad_request",
          `Task "${task.taskKey}" depends on unknown taskKey "${dependencyKey}".`
        );
      }
      if (dependencyKey === task.taskKey) {
        throw new OperatorApiRequestError(
          400,
          "bad_request",
          `Task "${task.taskKey}" cannot depend on itself.`
        );
      }
    }
  }
}

function resolveGroupedTaskDependencies(
  tasks: import("@reddwarf/contracts").GroupedTaskInjectionRequest[],
  executionMode: import("@reddwarf/contracts").TaskGroupExecutionMode
): import("@reddwarf/contracts").GroupedTaskInjectionRequest[] {
  if (executionMode !== "sequential") {
    return tasks;
  }

  return tasks.map((task, index) => ({
    ...task,
    dependsOn:
      task.dependsOn.length > 0
        ? task.dependsOn
        : index === 0
          ? []
          : [tasks[index - 1]!.taskKey]
  }));
}

function summarizePollingHealth(
  repositories: GitHubIssuePollingCursor[],
  pollingDaemon?: GitHubIssuePollingDaemon
): OperatorPollingHealthSummary {
  const failingRepositories = repositories.filter(
    (record) => record.lastPollStatus === "failed"
  ).length;
  const runtimeHealth = pollingDaemon?.health ?? {
    status: "idle",
    startupStatus: "idle",
    lastCycleStartedAt: null,
    lastCycleCompletedAt: null,
    lastCycleDurationMs: null,
    lastError: null
  };

  return {
    status:
      failingRepositories > 0 || runtimeHealth.status === "degraded"
        ? "degraded"
        : repositories.length === 0 && runtimeHealth.status === "idle"
          ? "idle"
          : "healthy",
    repositories,
    totalRepositories: repositories.length,
    failingRepositories,
    runtimeStatus: runtimeHealth.status,
    startupStatus: runtimeHealth.startupStatus,
    consecutiveFailures: pollingDaemon?.consecutiveFailures ?? 0,
    lastCycleStartedAt: runtimeHealth.lastCycleStartedAt,
    lastCycleCompletedAt: runtimeHealth.lastCycleCompletedAt,
    lastCycleDurationMs: runtimeHealth.lastCycleDurationMs,
    lastError: runtimeHealth.lastError
  };
}
