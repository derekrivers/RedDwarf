import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import cors from "cors";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  buildOperatorConfigJsonSchema,
  groupedTaskInjectionRequestSchema,
  eligibilityRejectionReasonCodeSchema,
  operatorRepoCreateRequestSchema,
  operatorRepoDeleteResponseSchema,
  operatorRepoListResponseSchema,
  operatorRepoMutationResponseSchema,
  operatorConfigDefaults,
  operatorConfigDescriptions,
  operatorConfigKeys,
  operatorConfigResponseSchema,
  operatorConfigSchemaResponseSchema,
  operatorConfigUpdateRequestSchema,
  openClawModelProviderSchema,
  operatorSecretKeySchema,
  operatorSecretMetadata,
  operatorSecretRotationRequestSchema,
  operatorSecretRotationResponseSchema,
  operatorUiBootstrapResponseSchema,
  parseOperatorConfigEnvValue,
  parseOperatorConfigValue,
  pipelineRunStatusSchema,
  serializeOperatorConfigValue,
  taskGroupInjectionRequestSchema,
  taskLifecycleStatusSchema,
  taskPhaseSchema,
  directTaskInjectionRequestSchema,
  githubIssueSubmitSchema,
  projectInjectionRequestSchema,
  type ApprovalDecision,
  type ApprovalRequest,
  type GitHubIssuePollingCursor,
  type OperatorConfigEntry,
  type OperatorConfigField,
  type PlanningAgent,
  type PlanningTaskInput,
  type PipelineRun,
  type ProjectSpec
} from "@reddwarf/contracts";
import { MODEL_PROVIDER_ROLE_MAP } from "@reddwarf/execution-plane";
import type { GitHubWriter, GitHubIssuesAdapter, GitHubRepoDiscovery, OpenClawTaskFlowAdapter } from "@reddwarf/integrations";
import {
  buildOpenClawIssueSessionKeyFromManifest,
  normalizeOpenClawSessionKey
} from "./openclaw-session-key.js";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile
} from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { promisify } from "node:util";
import type { Writable, Readable } from "node:stream";

const execFileAsync = promisify(execFile);
import {
  createApprovalRequest,
  createGitHubIssuePollingCursor,
  createMemoryRecord,
  createRunEvent,
  type PlanningRepository,
  type RepositoryHealthSnapshot
} from "@reddwarf/evidence";
import { assertTaskLifecycleTransition } from "./lifecycle.js";
import { EventCodes } from "./pipeline/types.js";
import type { TaskManifest } from "@reddwarf/contracts";
import {
  assembleRunReport,
  dispatchReadyTask,
  ProjectApprovalRequiredError,
  renderRunReportMarkdown,
  resolveApprovalRequest,
  runPlanningPipeline,
  summarizeRunTokenUsage,
  sweepOrphanedDispatcherState,
  type DispatchReadyTaskDependencies,
  type SweepOrphanedStateResult
} from "./pipeline.js";
import { classifyComplexity } from "./rimmer/index.js";
import {
  advanceProjectTicket,
  createProjectTicketTaskId,
  executeProjectApproval
} from "./pipeline/project-approval.js";
import { readPhaseRetryBudgetState } from "./pipeline/retry-budget.js";
import { createDiscordNotifier } from "./notifications/discord-notifier.js";
import {
  buildAuditEntries,
  filterAuditEntriesByRepo,
  renderAuditCsv
} from "./audit-export.js";
import { checkDailyBudgetGate } from "./pipeline/daily-budget.js";
import { saveTaskGroupMemberships } from "./task-groups.js";
import type {
  GitHubIssuePollingDaemon,
  PollingLoopHealthSnapshot,
  ReadyTaskDispatcher
} from "./polling.js";
import {
  describeIntakeMode,
  handleGitHubWebhook,
  readRawBody,
  type WebhookHandlerDependencies
} from "./github-webhook.js";

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
  localSecretsPath?: string;
  /** Maximum requests per IP per window. Defaults to 120 req / 60 s. */
  rateLimitMaxRequests?: number;
  /** Rate-limit window duration in milliseconds. Defaults to 60_000 ms. */
  rateLimitWindowMs?: number;
  /** GitHub webhook secret for HMAC-SHA256 verification. When set, the webhook receiver route is activated. */
  webhookSecret?: string;
  /** Webhook route path. Defaults to `/webhooks/github`. */
  webhookPath?: string;
  /** Intake mode description for the health endpoint, resolved by the caller. */
  intakeMode?: string;
}

// ============================================================
// In-memory rate limiter
// ============================================================

/**
 * Simple sliding-window rate limiter keyed by IP address.
 * Returns true when the request should be allowed, false when it exceeds the limit.
 */
export class OperatorRateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly buckets = new Map<string, number[]>();

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  allow(ip: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const timestamps = (this.buckets.get(ip) ?? []).filter((t) => t > cutoff);
    if (timestamps.length >= this.maxRequests) {
      this.buckets.set(ip, timestamps);
      return false;
    }
    timestamps.push(now);
    this.buckets.set(ip, timestamps);
    return true;
  }
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
  /** When provided, enables POST /issues/submit to create GitHub issues for polling to intercept. */
  githubWriter?: GitHubWriter;
  /** When provided, enables GET /repos/github to discover repos accessible to the GitHub token. */
  githubRepoDiscovery?: GitHubRepoDiscovery;
  /** When provided, enables sub-issue creation on project approval. */
  githubIssuesAdapter?: GitHubIssuesAdapter;
  /** When provided and REDDWARF_TASKFLOW_ENABLED=true, creates/advances Task Flows on project approval/advance. */
  taskFlowAdapter?: OpenClawTaskFlowAdapter | null;
  /** Downstream connectivity probes for the health endpoint (R-07). */
  downstreamHealthProbes?: DownstreamHealthProbe[];
  /** Callback returning circuit breaker snapshots for health reporting (R-05, R-06). */
  circuitBreakerSnapshots?: () => Record<string, { state: string; consecutiveFailures: number }>;
  /** GitHub adapter reader for webhook intake — required when webhookSecret is configured. */
  github?: import("@reddwarf/integrations").GitHubAdapter;
  /** OpenClaw dispatch adapter, forwarded to webhook-triggered pipelines. */
  webhookOpenClawDispatch?: import("@reddwarf/integrations").OpenClawDispatchAdapter;
  /** Target root for architect workspace, forwarded to webhook-triggered pipelines. */
  webhookArchitectTargetRoot?: string;
  /** When false, POST /projects/inject responds 404. Controlled via
   *  REDDWARF_PROJECTS_INJECT_ENABLED env var by the top-level
   *  bootstrap; defaults to true if unset. */
  projectsInjectEnabled?: boolean;
}

export interface OperatorBlockedSummary {
  blockedRuns: PipelineRun[];
  pendingApprovals: ApprovalRequest[];
  retryExhaustedEntries: {
    approvalId: string;
    taskId: string;
    taskTitle: string;
    runId: string;
    reason: "retry-budget-exhausted";
    phase: string;
    attempts: number;
    retryLimit: number;
    humanReadable: string;
    lastError: string | null;
    dryRun: boolean;
  }[];
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

export type DownstreamStatus = "ok" | "degraded" | "unreachable";

export interface DownstreamHealthProbeResult {
  name: string;
  status: DownstreamStatus;
  latencyMs: number | null;
  error: string | null;
  checkedAt: string;
}

export interface DownstreamHealthProbe {
  name: string;
  probe(): Promise<DownstreamHealthProbeResult>;
}

export interface OperatorHealthResponse {
  status: "ok";
  timestamp: string;
  repository: RepositoryHealthSnapshot;
  polling: OperatorPollingHealthSummary;
  /** Active intake mode: "webhook", "polling", "webhook+polling", or "disabled". */
  intakeMode?: string;
  dispatcher?: OperatorDispatcherHealthSummary;
  downstream?: DownstreamHealthProbeResult[] | undefined;
  readiness?: DownstreamStatus | undefined;
  circuitBreakers?: Record<string, { state: string; consecutiveFailures: number }> | undefined;
}

export interface OperatorApiServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly port: number;
  readonly host: string;
}

export interface OperatorRunDetailResponse {
  run: PipelineRun;
  summary: Awaited<ReturnType<PlanningRepository["getRunSummary"]>>;
  events: Awaited<ReturnType<PlanningRepository["listRunEvents"]>>;
  totalEvents: number;
  tokenUsage: ReturnType<typeof summarizeRunTokenUsage>;
}

/**
 * Represents an in-flight tool-level approval request raised by the
 * reddwarf-operator plugin's before_tool_call hook (Feature 152).
 * Stored in memory — not persisted to Postgres. Expires when the session ends.
 */
export interface ToolApprovalRequest {
  id: string;
  sessionKey: string;
  taskId: string | null;
  toolName: string;
  targetPath: string | null;
  reason: string;
  status: "pending" | "approved" | "denied";
  decidedBy: string | null;
  decidedAt: string | null;
  requestedAt: string;
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
  const rateLimiter = new OperatorRateLimiter(
    config.rateLimitMaxRequests ?? 120,
    config.rateLimitWindowMs ?? 60_000
  );
  const managedTargetRoot =
    config.managedTargetRoot !== undefined
      ? resolve(config.managedTargetRoot)
      : undefined;
  const managedEvidenceRoot =
    config.managedEvidenceRoot !== undefined
      ? resolve(config.managedEvidenceRoot)
      : undefined;
  const localSecretsPath =
    config.localSecretsPath !== undefined
      ? resolve(config.localSecretsPath)
      : resolve(process.cwd(), ".secrets");
  const {
    repository,
    planner,
    defaultPlanningDryRun = false,
    clock = () => new Date(),
    dispatcher,
    pollingDaemon,
    dispatchDependencies,
    githubWriter,
    githubIssuesAdapter,
    githubRepoDiscovery,
    taskFlowAdapter,
    downstreamHealthProbes,
    circuitBreakerSnapshots,
    github: webhookGitHub,
    webhookOpenClawDispatch,
    webhookArchitectTargetRoot,
    projectsInjectEnabled = true
  } = deps;
  /** In-memory store for pending tool-level approval requests (Feature 152). */
  const toolApprovals = new Map<string, ToolApprovalRequest>();
  let boundPort = config.port;
  const webhookSecret = config.webhookSecret?.trim() ?? null;
  const webhookPath = config.webhookPath ?? "/webhooks/github";
  const intakeMode = config.intakeMode ?? (webhookSecret ? "webhook" : "polling");
  const webhookDeps: WebhookHandlerDependencies | null =
    webhookSecret && webhookGitHub && planner
      ? {
          repository,
          github: webhookGitHub,
          planner,
          clock,
          dryRun: defaultPlanningDryRun,
          ...(webhookOpenClawDispatch ? { openClawDispatch: webhookOpenClawDispatch } : {}),
          ...(webhookArchitectTargetRoot ? { architectTargetRoot: webhookArchitectTargetRoot } : {}),
          githubIssuesAdapter: githubIssuesAdapter ?? null,
          taskFlowAdapter: taskFlowAdapter ?? null
        }
      : null;

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
        await runCorsMiddleware(req, res);
        if (res.writableEnded) {
          return;
        }

        const clientIp = req.socket.remoteAddress ?? "unknown";
        if (!rateLimiter.allow(clientIp)) {
          writeOperatorJsonResponse(res, 429, {
            error: "rate_limit_exceeded",
            message: "Too many requests. Please slow down."
          });
          return;
        }

        // Webhook route is handled before the operator auth gate — it uses
        // its own HMAC-based verification via X-Hub-Signature-256.
        const reqMethod = req.method ?? "GET";
        const reqUrl = req.url ?? "/";
        const reqPath = new URL(reqUrl, "http://localhost").pathname;
        if (reqMethod === "POST" && reqPath === webhookPath && webhookSecret && webhookDeps) {
          const rawBody = await readRawBody(req, maxRequestBodyBytes);
          const signatureHeader = typeof req.headers["x-hub-signature-256"] === "string"
            ? req.headers["x-hub-signature-256"]
            : undefined;
          const eventType = typeof req.headers["x-github-event"] === "string"
            ? req.headers["x-github-event"]
            : undefined;
          const result = await handleGitHubWebhook(
            rawBody,
            signatureHeader,
            eventType,
            webhookSecret,
            webhookDeps
          );
          writeOperatorJsonResponse(res, result.status, result.body);
          return;
        }

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
          managedEvidenceRoot,
          localSecretsPath,
          githubWriter,
          githubIssuesAdapter,
          githubRepoDiscovery,
          toolApprovals,
          taskFlowAdapter,
          downstreamHealthProbes,
          circuitBreakerSnapshots,
          intakeMode,
          projectsInjectEnabled
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
          message: safeErrorMessage(err, "Unexpected error")
        });
      }
    }
  );

  const runCorsMiddleware = createCorsMiddlewareRunner();

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

function createCorsMiddlewareRunner(): (
  req: IncomingMessage,
  res: ServerResponse
) => Promise<void> {
  const allowedOrigins = resolveAllowedDashboardOrigins();
  const middleware = cors({
    origin(origin, callback) {
      if (origin === undefined || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`CORS origin not allowed: ${origin}`));
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"]
  });

  return (req, res) =>
    new Promise<void>((resolve) => {
      middleware(req, res, (error?: unknown) => {
        if (error) {
          writeOperatorJsonResponse(res, 403, {
            error: "cors_rejected",
            message: "Origin not allowed by CORS policy."
          });
          resolve();
          return;
        }

        resolve();
      });
    });
}

function resolveAllowedDashboardOrigins(): string[] {
  const configuredOrigins = process.env.REDDWARF_DASHBOARD_ORIGIN
    ?.split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (configuredOrigins && configuredOrigins.length > 0) {
    return configuredOrigins;
  }

  return [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173"
  ];
}

// ============================================================
// Internal helpers
// ============================================================

/**
 * Extracts a safe error message for HTTP responses. Strips stack traces,
 * file paths, and internal details that could leak implementation info
 * to callers (CodeQL: information-exposure-through-stack-trace).
 */
function safeErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  // Take only the first line of the message to strip Zod's multi-line
  // validation output and any embedded stack frames.
  const firstLine = error.message.split("\n")[0] ?? fallback;
  // Cap length to avoid dumping huge payloads into responses.
  return firstLine.length > 200 ? firstLine.slice(0, 200) + "…" : firstLine;
}

// CodeQL flags any flow that might let a caller's `error.message` leak a
// multi-line stack trace to the operator API client. Sanitise the `message`
// field on outbound JSON bodies: keep only the first line and truncate at
// 500 chars. Server-side logs still see the full error.
function sanitizeResponseBodyForClient(body: unknown): unknown {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }
  const record = body as Record<string, unknown>;
  if (typeof record["message"] !== "string") {
    return body;
  }
  const original = record["message"] as string;
  const firstLine = original.split(/\r?\n/, 1)[0] ?? "";
  const trimmed =
    firstLine.length > 500 ? `${firstLine.slice(0, 500)}…` : firstLine;
  if (trimmed === original) {
    return body;
  }
  return { ...record, message: trimmed };
}

function writeOperatorJsonResponse(
  res: ServerResponse,
  status: number,
  body: unknown
): void {
  const safeBody = sanitizeResponseBodyForClient(body);
  const json = JSON.stringify(safeBody);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json)
  });
  res.end(json);
}

function writeOperatorTextResponse(
  res: ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8"
): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
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
        // Stop accumulating bytes — discard the rest of the stream in memory.
        // The promise is already rejected on the first oversized chunk; we
        // cannot destroy the socket here because the 413 response has not
        // been written yet and destruction would prevent it from being sent.
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

  return null;
}

function assertOperatorAuthorized(
  req: IncomingMessage,
  authToken: string
): void {
  const suppliedToken = readOperatorAuthToken(req);

  // Use a timing-safe comparison to prevent token enumeration via response-time
  // side-channels. Buffers must be the same byte length for timingSafeEqual, so
  // we derive equality from both the length guard and the buffer comparison.
  const suppliedBuf = Buffer.from(suppliedToken ?? "");
  const expectedBuf = Buffer.from(authToken);
  const authorized =
    suppliedBuf.length === expectedBuf.length &&
    timingSafeEqual(suppliedBuf, expectedBuf);

  if (!authorized) {
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

function buildOperatorConfigResponse(
  persistedEntries: OperatorConfigEntry[]
): import("@reddwarf/contracts").OperatorConfigResponse {
  const persistedByKey = new Map(persistedEntries.map((entry) => [entry.key, entry]));
  const config: OperatorConfigField[] = operatorConfigKeys.map((key) => {
    const persisted = persistedByKey.get(key);
    const defaultValue = operatorConfigDefaults[key];
    const value =
      persisted?.value ?? parseOperatorConfigEnvValue(key, process.env[key]);

    return {
      key,
      value,
      defaultValue,
      description: operatorConfigDescriptions[key],
      updatedAt: persisted?.updatedAt ?? null,
      source: persisted ? "database" : process.env[key] !== undefined ? "env" : "default"
    };
  });

  return operatorConfigResponseSchema.parse({
    config,
    total: config.length
  });
}

const operatorUiPathFields = [
  {
    key: "REDDWARF_POLICY_SOURCE_ROOT",
    description: "Source tree root used when packaging the policy pack.",
    defaultValue: "../../"
  },
  {
    key: "REDDWARF_POLICY_ROOT",
    description: "Runtime-visible policy-pack root inside managed environments.",
    defaultValue: "/opt/reddwarf"
  },
  {
    key: "REDDWARF_WORKSPACE_ROOT",
    description: "Runtime-visible managed workspace root.",
    defaultValue: "/var/lib/reddwarf/workspaces"
  },
  {
    key: "REDDWARF_EVIDENCE_ROOT",
    description: "Runtime-visible evidence archive root.",
    defaultValue: "/var/lib/reddwarf/evidence"
  },
  {
    key: "REDDWARF_HOST_WORKSPACE_ROOT",
    description: "Host-side workspace root used by local scripts and E2E runs.",
    defaultValue: "runtime-data/workspaces"
  },
  {
    key: "REDDWARF_HOST_EVIDENCE_ROOT",
    description: "Host-side evidence archive root.",
    defaultValue: "runtime-data/evidence"
  },
  {
    key: "REDDWARF_POLICY_PACKAGE_OUTPUT_ROOT",
    description: "Output directory for packaged policy assets.",
    defaultValue: "artifacts/policy-packs"
  },
  {
    key: "REDDWARF_OPENCLAW_WORKSPACE_ROOT",
    description: "Host-mounted OpenClaw session workspace root.",
    defaultValue: "runtime-data/openclaw-workspaces"
  },
  {
    key: "REDDWARF_OPENCLAW_CONFIG_PATH",
    description: "Generated OpenClaw runtime config path.",
    defaultValue: "runtime-data/openclaw-home/openclaw.json"
  }
] as const;

function maskSecretValue(value: string | undefined): string | null {
  if (value === undefined || value.length === 0) {
    return null;
  }

  if (value.length <= 8) {
    return `${"•".repeat(Math.max(4, value.length))}`;
  }

  const prefixLength = value.startsWith("sk-") ? Math.min(6, value.length - 4) : 4;
  return `${value.slice(0, prefixLength)}••••${value.slice(-4)}`;
}

const OPENCLAW_HEALTH_CACHE_TTL_MS = 15_000;
let openClawHealthCache: {
  result: import("@reddwarf/contracts").OperatorUiOpenClawStatus;
  cachedAt: number;
} | null = null;

async function resolveOpenClawUiStatus(
  clock: () => Date
): Promise<import("@reddwarf/contracts").OperatorUiOpenClawStatus> {
  // Return cached result if still fresh — prevents every bootstrap call from
  // blocking on an OpenClaw health check round trip.
  if (openClawHealthCache && Date.now() - openClawHealthCache.cachedAt < OPENCLAW_HEALTH_CACHE_TTL_MS) {
    return openClawHealthCache.result;
  }

  const baseUrl = stripTrailingSlashes(process.env.OPENCLAW_BASE_URL?.trim() || "http://127.0.0.1:3578");
  const checkedAt = clock().toISOString();

  try {
    const response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(2_000)
    });

    const result: import("@reddwarf/contracts").OperatorUiOpenClawStatus = {
      baseUrl,
      reachable: response.ok,
      checkedAt,
      statusCode: response.status,
      message: response.ok ? "ok" : `HTTP ${response.status}`
    };
    openClawHealthCache = { result, cachedAt: Date.now() };
    return result;
  } catch (error) {
    const result: import("@reddwarf/contracts").OperatorUiOpenClawStatus = {
      baseUrl,
      reachable: false,
      checkedAt,
      statusCode: null,
      message: safeErrorMessage(error, "OpenClaw health check failed")
    };
    openClawHealthCache = { result, cachedAt: Date.now() };
    return result;
  }
}

async function resolveOperatorUiBootstrap(
  clock: () => Date
): Promise<import("@reddwarf/contracts").OperatorUiBootstrapResponse> {
  let appVersion = "unknown";
  try {
    const packageJson = JSON.parse(await readFile(resolve(process.cwd(), "package.json"), "utf8")) as {
      version?: unknown;
    };
    if (typeof packageJson.version === "string" && packageJson.version.trim().length > 0) {
      appVersion = packageJson.version;
    }
  } catch {
    // fall back to "unknown" when the root package.json is not available
  }

  return operatorUiBootstrapResponseSchema.parse({
    appVersion,
    uptimeSeconds: Math.round(process.uptime()),
    sessionTier: "operator",
    paths: operatorUiPathFields.map((field) => ({
      key: field.key,
      value: process.env[field.key] ?? field.defaultValue,
      description: field.description,
      source: process.env[field.key] !== undefined ? "env" : "default"
    })),
    secrets: Object.entries(operatorSecretMetadata).map(([key, metadata]) => ({
      key,
      description: metadata.description,
      restartRequired: metadata.restartRequired,
      present: Boolean(process.env[key]),
      maskedValue: maskSecretValue(process.env[key])
    })),
    openClaw: await resolveOpenClawUiStatus(clock)
  });
}

function renderOperatorUiHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>RedDwarf Operator Panel</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4efe6;
        --bg-alt: #fffaf3;
        --panel: rgba(255, 250, 243, 0.92);
        --panel-strong: #fffdf8;
        --line: rgba(39, 36, 32, 0.14);
        --text: #241f1a;
        --muted: #6d6357;
        --accent: #b3472b;
        --accent-strong: #8f2f17;
        --accent-soft: rgba(179, 71, 43, 0.12);
        --success: #1d6b4f;
        --warn: #a06211;
        --danger: #ab2f3f;
        --shadow: 0 24px 70px rgba(58, 35, 18, 0.12);
        --radius: 24px;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Avenir Next", "Trebuchet MS", "Segoe UI", sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(179, 71, 43, 0.18), transparent 32%),
          radial-gradient(circle at top right, rgba(29, 107, 79, 0.14), transparent 26%),
          linear-gradient(180deg, #fcf7ef 0%, var(--bg) 100%);
        min-height: 100vh;
      }
      .shell {
        width: min(1380px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 28px 0 40px;
      }
      .hero, .panel {
        backdrop-filter: blur(18px);
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: var(--radius);
        box-shadow: var(--shadow);
      }
      .hero {
        padding: 28px;
        display: grid;
        gap: 16px;
      }
      .hero-top {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: start;
        flex-wrap: wrap;
      }
      h1, h2, h3 { margin: 0; font-weight: 700; letter-spacing: -0.03em; }
      h1 { font-size: clamp(2rem, 4vw, 3.5rem); }
      h2 { font-size: 1.15rem; }
      h3 { font-size: 0.95rem; }
      p { margin: 0; line-height: 1.5; color: var(--muted); }
      .hero-copy { max-width: 760px; display: grid; gap: 10px; }
      .chip-row, .stats-grid, .layout, .form-grid, .list-grid {
        display: grid;
        gap: 14px;
      }
      .chip-row {
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      }
      .chip {
        padding: 14px 16px;
        border-radius: 18px;
        background: rgba(255,255,255,0.74);
        border: 1px solid var(--line);
      }
      .chip label, .label {
        display: block;
        font-size: 0.76rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
        margin-bottom: 6px;
      }
      .chip strong { font-size: 1.1rem; }
      .auth-bar {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        align-items: end;
      }
      .auth-field {
        min-width: 280px;
        flex: 1 1 320px;
      }
      .layout {
        margin-top: 18px;
        grid-template-columns: repeat(12, minmax(0, 1fr));
      }
      .panel {
        padding: 22px;
        display: grid;
        gap: 16px;
      }
      .span-12 { grid-column: span 12; }
      .span-8 { grid-column: span 8; }
      .span-6 { grid-column: span 6; }
      .span-4 { grid-column: span 4; }
      .stats-grid {
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      }
      .metric {
        padding: 16px;
        border-radius: 18px;
        background: var(--panel-strong);
        border: 1px solid var(--line);
      }
      .metric .value {
        font-size: 1.45rem;
        font-weight: 700;
        letter-spacing: -0.04em;
      }
      .status-pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-radius: 999px;
        font-size: 0.84rem;
        background: rgba(255,255,255,0.76);
        border: 1px solid var(--line);
      }
      .status-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: var(--muted);
      }
      .status-ok .status-dot { background: var(--success); }
      .status-warn .status-dot { background: var(--warn); }
      .status-bad .status-dot { background: var(--danger); }
      .status-idle .status-dot { background: #5576b5; }
      .section-head {
        display: flex;
        align-items: start;
        justify-content: space-between;
        gap: 14px;
        flex-wrap: wrap;
      }
      .form-grid {
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      }
      input, select, button {
        font: inherit;
      }
      input, select {
        width: 100%;
        border: 1px solid rgba(38, 32, 24, 0.16);
        border-radius: 14px;
        padding: 12px 14px;
        background: rgba(255,255,255,0.88);
        color: var(--text);
      }
      input:focus, select:focus {
        outline: 2px solid rgba(179, 71, 43, 0.22);
        border-color: rgba(179, 71, 43, 0.4);
      }
      button {
        border: 0;
        border-radius: 14px;
        padding: 12px 16px;
        cursor: pointer;
        transition: transform 140ms ease, opacity 140ms ease, background 140ms ease;
      }
      button:hover { transform: translateY(-1px); }
      button:disabled { opacity: 0.6; cursor: wait; transform: none; }
      .button-primary { background: var(--accent); color: #fff9f4; }
      .button-primary:hover { background: var(--accent-strong); }
      .button-secondary { background: rgba(36, 31, 26, 0.08); color: var(--text); }
      .button-danger { background: rgba(171, 47, 63, 0.12); color: var(--danger); }
      .button-warning { background: rgba(200, 150, 50, 0.15); color: #b58a20; }
      .button-row {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }
      .notice {
        min-height: 24px;
        font-size: 0.92rem;
      }
      .notice.ok { color: var(--success); }
      .notice.warn { color: var(--warn); }
      .notice.error { color: var(--danger); }
      .list-grid {
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      }
      .record {
        padding: 16px;
        border-radius: 18px;
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.72);
        display: grid;
        gap: 10px;
      }
      .record strong {
        display: block;
        font-size: 1rem;
      }
      .record code, .path-value {
        font-family: "IBM Plex Mono", "SFMono-Regular", Consolas, monospace;
        font-size: 0.85rem;
      }
      .path-list, .secret-list, .recent-list {
        display: grid;
        gap: 10px;
      }
      .row {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
        flex-wrap: wrap;
      }
      .empty {
        padding: 14px 16px;
        border-radius: 16px;
        background: rgba(255,255,255,0.6);
        border: 1px dashed rgba(38, 32, 24, 0.18);
        color: var(--muted);
      }
      .inline-code {
        display: inline-block;
        padding: 4px 8px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent-strong);
        font-family: "IBM Plex Mono", "SFMono-Regular", Consolas, monospace;
        font-size: 0.78rem;
      }
      @media (max-width: 980px) {
        .span-8, .span-6, .span-4 {
          grid-column: span 12;
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="hero">
        <div class="hero-top">
          <div class="hero-copy">
            <div class="inline-code">GET /ui</div>
            <h1>RedDwarf Operator Panel</h1>
            <p>Local-first control for polling, pool tuning, runtime status, repo roster, and secret rotation. This page stores your bearer token only in the current browser tab.</p>
          </div>
          <div class="status-pill status-idle" id="session-tier">
            <span class="status-dot"></span>
            <span>Awaiting operator token</span>
          </div>
        </div>
        <div class="auth-bar">
          <label class="auth-field">
            <span class="label">Operator Token</span>
            <input id="token-input" type="password" placeholder="Paste REDDWARF_OPERATOR_TOKEN">
          </label>
          <div class="button-row">
            <button id="connect-button" class="button-primary" type="button">Connect</button>
            <button id="refresh-button" class="button-secondary" type="button">Refresh</button>
            <button id="forget-button" class="button-secondary" type="button">Forget Token</button>
          </div>
        </div>
        <div class="chip-row">
          <div class="chip"><label>Version</label><strong id="meta-version">Not loaded</strong></div>
          <div class="chip"><label>Uptime</label><strong id="meta-uptime">Not loaded</strong></div>
          <div class="chip"><label>OpenClaw</label><strong id="meta-openclaw">Not loaded</strong></div>
          <div class="chip"><label>Last Refresh</label><strong id="meta-refresh">Never</strong></div>
        </div>
        <div id="global-notice" class="notice"></div>
      </section>
      <section class="layout">
        <article class="panel span-8">
          <div class="section-head">
            <div>
              <h2>Status</h2>
              <p>Live stack health plus recent runs and tasks.</p>
            </div>
          </div>
          <div id="status-metrics" class="stats-grid"></div>
          <div class="list-grid">
            <div>
              <h3>Recent Runs</h3>
              <div id="recent-runs" class="recent-list"></div>
            </div>
            <div>
              <h3>Recent Tasks</h3>
              <div id="recent-tasks" class="recent-list"></div>
            </div>
          </div>
        </article>
        <article class="panel span-4">
          <div class="section-head">
            <div>
              <h2>Paths</h2>
              <p>Boot-time paths stay read-only here so operators can see where artifacts land.</p>
            </div>
          </div>
          <div id="path-list" class="path-list"></div>
        </article>
        <article class="panel span-4">
          <div class="section-head">
            <div>
              <h2>Pending Approvals</h2>
              <p>Review queued human gates without leaving the operator panel.</p>
            </div>
          </div>
          <div id="approval-list" class="recent-list"></div>
          <div id="approvals-notice" class="notice"></div>
        </article>
        <article class="panel span-8">
          <div class="section-head">
            <div>
              <h2>Polling & Dispatch</h2>
              <p>Manage repo intake and the main loop cadence without editing a comma string.</p>
            </div>
            <div class="button-row">
              <button id="save-polling-button" class="button-primary" type="button">Save Polling Settings</button>
            </div>
          </div>
          <div class="form-grid" id="polling-form"></div>
          <div>
            <div class="row">
              <h3>Managed Repositories</h3>
              <span class="label">Validated as owner/repo</span>
            </div>
            <div class="button-row" style="margin: 10px 0 14px;">
              <input id="repo-input" type="text" placeholder="owner/repo">
              <button id="add-repo-button" class="button-secondary" type="button">Add Repo</button>
            </div>
            <div id="repo-list" class="list-grid"></div>
          </div>
          <div id="polling-notice" class="notice"></div>
        </article>
        <article class="panel span-4">
          <div class="section-head">
            <div>
              <h2>Logging</h2>
              <p>Keep signal tight without restarting the stack.</p>
            </div>
            <button id="save-logging-button" class="button-primary" type="button">Save Logging</button>
          </div>
          <div class="form-grid" id="logging-form"></div>
          <div id="logging-notice" class="notice"></div>
        </article>
        <article class="panel span-6">
          <div class="section-head">
            <div>
              <h2>Database Pool</h2>
              <p>Runtime knobs for local pressure, latency, and client recycling.</p>
            </div>
            <button id="save-db-button" class="button-primary" type="button">Save DB Pool</button>
          </div>
          <div class="form-grid" id="db-form"></div>
          <div id="db-notice" class="notice"></div>
        </article>
        <article class="panel span-6">
          <div class="section-head">
            <div>
              <h2>Secrets Rotation</h2>
              <p>Masked indicators only. New values are written to <code>.secrets</code> and never echoed back.</p>
            </div>
          </div>
          <div id="secret-list" class="secret-list"></div>
          <div id="secrets-notice" class="notice"></div>
        </article>
      </section>
    </main>
    <script>
      const CONFIG_GROUPS = {
        polling: [
          "REDDWARF_POLL_INTERVAL_MS",
          "REDDWARF_DISPATCH_INTERVAL_MS",
          "REDDWARF_SKIP_OPENCLAW",
          "REDDWARF_DRY_RUN"
        ],
        logging: ["REDDWARF_LOG_LEVEL"],
        db: [
          "REDDWARF_DB_POOL_MAX",
          "REDDWARF_DB_POOL_CONNECTION_TIMEOUT_MS",
          "REDDWARF_DB_POOL_IDLE_TIMEOUT_MS",
          "REDDWARF_DB_POOL_QUERY_TIMEOUT_MS",
          "REDDWARF_DB_POOL_STATEMENT_TIMEOUT_MS",
          "REDDWARF_DB_POOL_MAX_LIFETIME_SECONDS"
        ]
      };
      const BOOLEAN_KEYS = new Set(["REDDWARF_SKIP_OPENCLAW", "REDDWARF_DRY_RUN"]);
      const TOKEN_STORAGE_KEY = "reddwarf-operator-token";
      const state = {
        token: sessionStorage.getItem(TOKEN_STORAGE_KEY) || "",
        bootstrap: null,
        config: [],
        repos: [],
        health: null,
        runs: [],
        tasks: [],
        approvals: []
      };

      const tokenInput = document.getElementById("token-input");
      const globalNotice = document.getElementById("global-notice");
      tokenInput.value = state.token;

      function setNotice(targetId, tone, message) {
        const node = document.getElementById(targetId);
        node.className = tone ? "notice " + tone : "notice";
        node.textContent = message || "";
      }

      function formatDuration(seconds) {
        if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return "Unknown";
        if (seconds < 60) return seconds + "s";
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        if (minutes < 60) return minutes + "m " + remainingSeconds + "s";
        const hours = Math.floor(minutes / 60);
        return hours + "h " + (minutes % 60) + "m";
      }

      function formatTimestamp(value) {
        if (!value) return "Never";
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
      }

      function toneForHealth(status) {
        if (status === "ok" || status === "healthy") return "status-ok";
        if (status === "idle") return "status-idle";
        return "status-bad";
      }

      async function api(path, options = {}) {
        const headers = new Headers(options.headers || {});
        if (state.token) {
          headers.set("Authorization", "Bearer " + state.token);
        }
        if (options.body && !headers.has("Content-Type")) {
          headers.set("Content-Type", "application/json");
        }
        const response = await fetch(path, {
          method: options.method || "GET",
          headers,
          body: options.body ? JSON.stringify(options.body) : undefined
        });
        if (!response.ok) {
          let message = "Request failed";
          try {
            const payload = await response.json();
            message = payload.message || payload.error || message;
          } catch {
            message = response.status + " " + response.statusText;
          }
          throw new Error(message);
        }
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          return response.json();
        }
        return response.text();
      }

      function renderBootstrapMeta() {
        const bootstrap = state.bootstrap;
        document.getElementById("meta-version").textContent = bootstrap ? bootstrap.appVersion : "Not loaded";
        document.getElementById("meta-uptime").textContent = bootstrap ? formatDuration(bootstrap.uptimeSeconds) : "Not loaded";
        document.getElementById("meta-openclaw").textContent = bootstrap
          ? (bootstrap.openClaw.reachable ? "Reachable" : "Unavailable")
          : "Not loaded";
        document.getElementById("meta-refresh").textContent = new Date().toLocaleTimeString();
        const sessionTier = document.getElementById("session-tier");
        if (!bootstrap) {
          sessionTier.className = "status-pill status-idle";
          sessionTier.innerHTML = '<span class="status-dot"></span><span>Awaiting operator token</span>';
          return;
        }
        sessionTier.className = "status-pill status-ok";
        sessionTier.innerHTML = '<span class="status-dot"></span><span>Connected as ' + bootstrap.sessionTier + '</span>';
      }

      function renderPaths() {
        const list = document.getElementById("path-list");
        const paths = state.bootstrap ? state.bootstrap.paths : [];
        list.innerHTML = paths.length === 0
          ? '<div class="empty">Connect to load path metadata.</div>'
          : paths.map((path) => (
              '<div class="record">' +
                '<div><strong>' + path.key + '</strong><p>' + path.description + '</p></div>' +
                '<div class="path-value">' + path.value + '</div>' +
                '<div class="label">Source: ' + path.source + '</div>' +
              '</div>'
            )).join("");
      }

      function configEntryMap() {
        return new Map(state.config.map((entry) => [entry.key, entry]));
      }

      function renderConfigForm(containerId, keys) {
        const container = document.getElementById(containerId);
        const entries = configEntryMap();
        container.innerHTML = keys.map((key) => {
          const entry = entries.get(key);
          if (!entry) return "";
          const inputId = "field-" + key;
          if (BOOLEAN_KEYS.has(key)) {
            return '<label><span class="label">' + key + '</span><select id="' + inputId + '">' +
              '<option value="true"' + (entry.value === true ? " selected" : "") + '>true</option>' +
              '<option value="false"' + (entry.value === false ? " selected" : "") + '>false</option>' +
              '</select><p>' + entry.description + '</p><p class="label">Default: ' + entry.defaultValue + ' · Source: ' + entry.source + '</p></label>';
          }
          if (key === "REDDWARF_LOG_LEVEL") {
            return '<label><span class="label">' + key + '</span><select id="' + inputId + '">' +
              ["debug", "info", "warn", "error"].map((option) =>
                '<option value="' + option + '"' + (entry.value === option ? " selected" : "") + '>' + option + '</option>'
              ).join("") +
              '</select><p>' + entry.description + '</p><p class="label">Default: ' + entry.defaultValue + ' · Source: ' + entry.source + '</p></label>';
          }
          return '<label><span class="label">' + key + '</span><input id="' + inputId + '" type="number" value="' + entry.value + '"><p>' + entry.description + '</p><p class="label">Default: ' + entry.defaultValue + ' · Source: ' + entry.source + '</p></label>';
        }).join("");
      }

      function parseConfigValue(key, value) {
        if (BOOLEAN_KEYS.has(key)) {
          return value === "true";
        }
        if (key === "REDDWARF_LOG_LEVEL") {
          return value;
        }
        return Number.parseInt(value, 10);
      }

      async function saveConfigGroup(groupName, noticeId) {
        try {
          const entries = CONFIG_GROUPS[groupName].map((key) => {
            const input = document.getElementById("field-" + key);
            return { key, value: parseConfigValue(key, input.value) };
          });
          await api("/config", { method: "PUT", body: { entries } });
          setNotice(noticeId, "ok", "Saved " + groupName + " settings.");
          await refreshData();
        } catch (error) {
          setNotice(noticeId, "error", error instanceof Error ? error.message : String(error));
        }
      }

      function renderRepos() {
        const list = document.getElementById("repo-list");
        if (!state.repos.length) {
          list.innerHTML = '<div class="empty">No managed repos yet.</div>';
          return;
        }
        list.innerHTML = state.repos.map((repo) => {
          const tone = repo.lastPollStatus === "failed" ? "status-bad" : (repo.lastPollStatus === "succeeded" ? "status-ok" : "status-idle");
          const statusLabel = repo.lastPollStatus || "never";
          return '<div class="record">' +
            '<div><strong>' + repo.repo + '</strong><p>Last seen issue: ' + (repo.lastSeenIssueNumber ?? "none") + '</p></div>' +
            '<div class="status-pill ' + tone + '"><span class="status-dot"></span><span>' + statusLabel + '</span></div>' +
            '<p>Updated ' + formatTimestamp(repo.updatedAt) + '</p>' +
            '<div class="button-row"><button class="button-danger" data-repo="' + repo.repo + '">Remove</button></div>' +
          '</div>';
        }).join("");
        list.querySelectorAll("button[data-repo]").forEach((button) => {
          button.addEventListener("click", async () => {
            const repo = button.getAttribute("data-repo");
            try {
              await api("/repos/" + repo, { method: "DELETE" });
              setNotice("polling-notice", "ok", "Removed " + repo + ".");
              await refreshData();
            } catch (error) {
              setNotice("polling-notice", "error", error instanceof Error ? error.message : String(error));
            }
          });
        });
      }

      function renderSecrets() {
        const list = document.getElementById("secret-list");
        const secrets = state.bootstrap ? state.bootstrap.secrets : [];
        list.innerHTML = secrets.length === 0
          ? '<div class="empty">Connect to load secret rotation controls.</div>'
          : secrets.map((secret) =>
              '<div class="record">' +
                '<div><strong>' + secret.key + '</strong><p>' + secret.description + '</p></div>' +
                '<div class="row"><span class="inline-code">' + (secret.maskedValue || "Not configured") + '</span><span class="label">' + (secret.restartRequired ? "Restart required" : "Hot reload for new processes") + '</span></div>' +
                '<div class="button-row">' +
                  '<input id="rotate-' + secret.key + '" type="password" placeholder="New value for ' + secret.key + '">' +
                  '<button class="button-secondary" data-secret="' + secret.key + '">Rotate</button>' +
                '</div>' +
              '</div>'
            ).join("");
        list.querySelectorAll("button[data-secret]").forEach((button) => {
          button.addEventListener("click", async () => {
            const key = button.getAttribute("data-secret");
            const input = document.getElementById("rotate-" + key);
            if (!input.value) {
              setNotice("secrets-notice", "warn", "Enter a new value before rotating " + key + ".");
              return;
            }
            try {
              const response = await api("/secrets/" + key + "/rotate", {
                method: "POST",
                body: { value: input.value }
              });
              input.value = "";
              setNotice("secrets-notice", response.restartRequired ? "warn" : "ok", response.notes.join(" "));
              await refreshData();
            } catch (error) {
              setNotice("secrets-notice", "error", error instanceof Error ? error.message : String(error));
            }
          });
        });
      }

      function renderStatus() {
        const metrics = document.getElementById("status-metrics");
        const recentRuns = document.getElementById("recent-runs");
        const recentTasks = document.getElementById("recent-tasks");
        if (!state.health || !state.bootstrap) {
          metrics.innerHTML = '<div class="empty">Connect to load live status.</div>';
          recentRuns.innerHTML = '<div class="empty">No runs loaded.</div>';
          recentTasks.innerHTML = '<div class="empty">No tasks loaded.</div>';
          return;
        }
        const health = state.health;
        const bootstrap = state.bootstrap;
        const items = [
          { label: "Repository", value: health.repository.status, tone: toneForHealth(health.repository.status) },
          { label: "Polling", value: health.polling.status, tone: toneForHealth(health.polling.status) },
          { label: "Dispatcher", value: health.dispatcher ? health.dispatcher.status : "not configured", tone: toneForHealth(health.dispatcher ? health.dispatcher.status : "idle") },
          { label: "OpenClaw", value: bootstrap.openClaw.reachable ? "reachable" : "unreachable", tone: bootstrap.openClaw.reachable ? "status-ok" : "status-bad" },
          { label: "Managed Repos", value: String(health.polling.totalRepositories), tone: "status-idle" },
          { label: "Uptime", value: formatDuration(bootstrap.uptimeSeconds), tone: "status-idle" }
        ];
        metrics.innerHTML = items.map((item) =>
          '<div class="metric"><span class="label">' + item.label + '</span><div class="row"><div class="value">' + item.value + '</div><span class="status-pill ' + item.tone + '"><span class="status-dot"></span></span></div></div>'
        ).join("");
        recentRuns.innerHTML = state.runs.length === 0
          ? '<div class="empty">No recent runs.</div>'
          : state.runs.map((run) =>
              '<div class="record"><div><strong>' + run.runId + '</strong><p>' + run.taskId + '</p></div><div class="status-pill ' + toneForHealth(run.status) + '"><span class="status-dot"></span><span>' + run.status + '</span></div></div>'
            ).join("");
        recentTasks.innerHTML = state.tasks.length === 0
          ? '<div class="empty">No recent tasks.</div>'
          : state.tasks.map((task) =>
              '<div class="record"><div><strong>' + task.manifest.title + '</strong><p>' + task.manifest.taskId + '</p></div><div class="status-pill ' + toneForHealth(task.manifest.lifecycleStatus === "blocked" ? "degraded" : "healthy") + '"><span class="status-dot"></span><span>' + task.manifest.lifecycleStatus + '</span></div></div>'
            ).join("");
      }

      function renderApprovals() {
        const list = document.getElementById("approval-list");
        if (!state.approvals.length) {
          list.innerHTML = '<div class="empty">No pending approvals.</div>';
          return;
        }
        list.innerHTML = state.approvals.map((approval) =>
          '<div class="record">' +
            '<div><strong>' + approval.taskId + '</strong><p>' + (approval.summary || "Human approval required.") + '</p></div>' +
            '<div class="row"><span class="inline-code">' + approval.phase + '</span><span class="label">' + approval.riskClass + ' risk</span></div>' +
            '<div class="label">' + approval.requestId + '</div>' +
            '<div class="button-row">' +
              '<button class="button-primary" data-approval="' + approval.requestId + '" data-decision="approve">Approve</button>' +
              (approval.requestedBy === "failure-automation" ? '<button class="button-warning" data-approval="' + approval.requestId + '" data-decision="rework">Rework</button>' : '') +
              '<button class="button-danger" data-approval="' + approval.requestId + '" data-decision="reject">Reject</button>' +
            '</div>' +
          '</div>'
        ).join("");
        list.querySelectorAll("button[data-approval]").forEach((button) => {
          button.addEventListener("click", async () => {
            const approvalId = button.getAttribute("data-approval");
            const decision = button.getAttribute("data-decision");
            let comment = null;
            if (decision === "rework") {
              comment = prompt("Describe what the agent should fix:");
              if (!comment || comment.trim().length === 0) return;
            }
            button.disabled = true;
            try {
              await api("/approvals/" + encodeURIComponent(approvalId) + "/resolve", {
                method: "POST",
                body: {
                  decision,
                  decidedBy: "operator",
                  decisionSummary: decision === "approve"
                    ? "Approved from the operator panel."
                    : decision === "rework"
                      ? "Rework requested from the operator panel."
                      : "Rejected from the operator panel.",
                  ...(comment ? { comment } : {})
                }
              });
              setNotice("approvals-notice", "ok",
                decision === "approve" ? "Approval approved."
                : decision === "rework" ? "Rework requested."
                : "Approval rejected."
              );
              await refreshData();
            } catch (error) {
              button.disabled = false;
              setNotice("approvals-notice", "error", error instanceof Error ? error.message : String(error));
            }
          });
        });
      }

      async function refreshData() {
        if (!state.token) {
          renderBootstrapMeta();
          renderPaths();
          renderStatus();
          renderApprovals();
          renderRepos();
          renderSecrets();
          renderConfigForm("polling-form", CONFIG_GROUPS.polling);
          renderConfigForm("logging-form", CONFIG_GROUPS.logging);
          renderConfigForm("db-form", CONFIG_GROUPS.db);
          return;
        }
        try {
          const [bootstrap, health, config, repos, runs, tasks, approvals] = await Promise.all([
            api("/ui/bootstrap"),
            api("/health"),
            api("/config"),
            api("/repos"),
            api("/runs?limit=6"),
            api("/tasks?limit=6"),
            api("/approvals?statuses=pending")
          ]);
          state.bootstrap = bootstrap;
          state.health = health;
          state.config = config.config || [];
          state.repos = repos.repos || [];
          state.runs = runs.runs || [];
          state.tasks = tasks.tasks || [];
          state.approvals = approvals.approvals || [];
          renderBootstrapMeta();
          renderPaths();
          renderStatus();
          renderApprovals();
          renderRepos();
          renderSecrets();
          renderConfigForm("polling-form", CONFIG_GROUPS.polling);
          renderConfigForm("logging-form", CONFIG_GROUPS.logging);
          renderConfigForm("db-form", CONFIG_GROUPS.db);
          setNotice("global-notice", "ok", "Operator panel refreshed.");
        } catch (error) {
          setNotice("global-notice", "error", error instanceof Error ? error.message : String(error));
        }
      }

      document.getElementById("connect-button").addEventListener("click", async () => {
        state.token = tokenInput.value.trim();
        sessionStorage.setItem(TOKEN_STORAGE_KEY, state.token);
        await refreshData();
      });
      document.getElementById("refresh-button").addEventListener("click", refreshData);
      document.getElementById("forget-button").addEventListener("click", () => {
        state.token = "";
        state.bootstrap = null;
        state.config = [];
        state.repos = [];
        state.health = null;
        state.runs = [];
        state.tasks = [];
        state.approvals = [];
        tokenInput.value = "";
        sessionStorage.removeItem(TOKEN_STORAGE_KEY);
        setNotice("global-notice", "warn", "Cleared the operator token from this tab.");
        refreshData();
      });
      document.getElementById("save-polling-button").addEventListener("click", () => saveConfigGroup("polling", "polling-notice"));
      document.getElementById("save-logging-button").addEventListener("click", () => saveConfigGroup("logging", "logging-notice"));
      document.getElementById("save-db-button").addEventListener("click", () => saveConfigGroup("db", "db-notice"));
      document.getElementById("add-repo-button").addEventListener("click", async () => {
        const input = document.getElementById("repo-input");
        const repo = input.value.trim();
        if (!repo) {
          setNotice("polling-notice", "warn", "Enter an owner/repo value first.");
          return;
        }
        try {
          await api("/repos", { method: "POST", body: { repo } });
          input.value = "";
          setNotice("polling-notice", "ok", "Added " + repo + ".");
          await refreshData();
        } catch (error) {
          setNotice("polling-notice", "error", error instanceof Error ? error.message : String(error));
        }
      });

      refreshData();
    </script>
  </body>
</html>`;
}

function matchesEvidenceRecordToRun(
  record: import("@reddwarf/contracts").EvidenceRecord,
  runId: string
): boolean {
  const metadataRunId =
    typeof record.metadata["runId"] === "string" ? record.metadata["runId"] : null;

  return metadataRunId === runId || record.recordId.includes(`:${runId}`);
}

async function buildOperatorTaskSummary(
  repository: PlanningRepository,
  manifest: import("@reddwarf/contracts").TaskManifest
): Promise<{
  manifest: import("@reddwarf/contracts").TaskManifest;
  latestRun: PipelineRun | null;
  pendingApprovalCount: number;
  totalApprovals: number;
  totalRuns: number;
  totalEvidenceRecords: number;
  totalPhaseRecords: number;
}> {
  const snapshot = await repository.getTaskSnapshot(manifest.taskId);

  return {
    manifest,
    latestRun: snapshot.pipelineRuns[0] ?? null,
    pendingApprovalCount: snapshot.approvalRequests.filter(
      (request) => request.status === "pending"
    ).length,
    totalApprovals: snapshot.approvalRequests.length,
    totalRuns: snapshot.pipelineRuns.length,
    totalEvidenceRecords: snapshot.evidenceRecords.length,
    totalPhaseRecords: snapshot.phaseRecords.length
  };
}

function parseSimpleEnvFileContent(content: string): Map<string, string> {
  const entries = new Map<string, string>();

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator < 1) {
      continue;
    }

    entries.set(trimmed.slice(0, separator).trim(), trimmed.slice(separator + 1).trim());
  }

  return entries;
}

async function writeOperatorSecret(
  secretStorePath: string,
  key: import("@reddwarf/contracts").OperatorSecretKey,
  value: string
): Promise<void> {
  await mkdir(dirname(secretStorePath), { recursive: true });

  let entries = new Map<string, string>();
  try {
    const current = await readFile(secretStorePath, "utf8");
    entries = parseSimpleEnvFileContent(current);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  entries.set(key, value);
  const content =
    [...entries.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([entryKey, entryValue]) => `${entryKey}=${entryValue}`)
      .join("\n") + "\n";
  const tempPath = `${secretStorePath}.${randomUUID()}.tmp`;

  await writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
  await chmod(tempPath, 0o600);
  await rename(tempPath, secretStorePath);
  await chmod(secretStorePath, 0o600);
}

// ============================================================
// OpenClaw pairing helpers
// ============================================================

export interface OpenClawPendingPairingRequest {
  requestId: string;
  role: string;
}

export interface OpenClawPairingStatus {
  pending: OpenClawPendingPairingRequest[];
  rawOutput: string;
}

export interface OpenClawFixPairingResult {
  approved: OpenClawPendingPairingRequest[];
  alreadyClean: boolean;
  rawOutput: string;
}

const OPENCLAW_COMPOSE_FILE = "infra/docker/docker-compose.yml";

function parseOpenClawDevicesListOutput(output: string): OpenClawPendingPairingRequest[] {
  const pending: OpenClawPendingPairingRequest[] = [];
  // Only inspect the "Pending" section. The CLI emits a header line like
  // `Pending (1)` or `Pending (0)` followed by a table of pending requests.
  const pendingMatch = output.match(/Pending\s*\((\d+)\)([\s\S]*?)(?:\n\s*\n|$)/);
  if (!pendingMatch) {
    return pending;
  }
  const pendingCount = parseInt(pendingMatch[1] ?? "0", 10);
  if (!pendingCount || pendingCount === 0) {
    return pending;
  }
  const section = pendingMatch[2] ?? "";
  // Each row looks like: │ <uuid> │ <device label> │ <role> │ ...
  const rowRegex = /│\s*([0-9a-f-]{36})\s*│[^\n]*?│\s*([a-zA-Z0-9_-]+)\s*│/gi;
  let row: RegExpExecArray | null;
  while ((row = rowRegex.exec(section)) !== null) {
    pending.push({
      requestId: row[1]!,
      role: row[2]!
    });
  }
  return pending;
}

async function runOpenClawDevicesCommand(
  args: readonly string[]
): Promise<{ stdout: string; stderr: string }> {
  // We always exec inside the running `openclaw` compose service so that the
  // CLI uses the same `runtime-data/openclaw-home` state the gateway is bound
  // to. We invoke `docker compose` via a fixed argv (no shell), then forward
  // a fixed argv to `node dist/index.js`. The only caller-supplied values are
  // the device CLI sub-args, which we restrict to a hard-coded allow list.
  const dockerArgs = [
    "compose",
    "-f",
    OPENCLAW_COMPOSE_FILE,
    "--profile",
    "openclaw",
    "exec",
    "-T",
    "openclaw",
    "node",
    "dist/index.js",
    "devices",
    ...args
  ];
  return execFileAsync("docker", dockerArgs, {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024
  });
}

async function readOpenClawPairingStatus(): Promise<OpenClawPairingStatus> {
  const { stdout, stderr } = await runOpenClawDevicesCommand(["list"]);
  const combined = `${stdout}\n${stderr}`;
  return {
    pending: parseOpenClawDevicesListOutput(combined),
    rawOutput: combined
  };
}

async function fixOpenClawPairing(): Promise<OpenClawFixPairingResult> {
  const status = await readOpenClawPairingStatus();
  // Only auto-approve operator-role requests; other roles require human review.
  const operatorPending = status.pending.filter(
    (entry) => entry.role.toLowerCase() === "operator"
  );
  if (operatorPending.length === 0) {
    return {
      approved: [],
      alreadyClean: true,
      rawOutput: status.rawOutput
    };
  }

  const approved: OpenClawPendingPairingRequest[] = [];
  const transcript: string[] = [status.rawOutput];
  for (const entry of operatorPending) {
    if (!/^[0-9a-f-]{36}$/i.test(entry.requestId)) {
      // Defensive: parser should never produce a malformed id, but skip if it does.
      continue;
    }
    const { stdout, stderr } = await runOpenClawDevicesCommand([
      "approve",
      entry.requestId
    ]);
    transcript.push(`approve ${entry.requestId}\n${stdout}${stderr}`);
    approved.push(entry);
  }

  return {
    approved,
    alreadyClean: false,
    rawOutput: transcript.join("\n---\n")
  };
}

export interface OpenClawRestartResult {
  restarted: true;
  rawOutput: string;
}

async function restartOpenClawContainer(): Promise<OpenClawRestartResult> {
  const dockerArgs = [
    "compose",
    "-f",
    OPENCLAW_COMPOSE_FILE,
    "--profile",
    "openclaw",
    "restart",
    "openclaw"
  ];
  const { stdout, stderr } = await execFileAsync("docker", dockerArgs, {
    cwd: process.cwd(),
    env: process.env,
    maxBuffer: 1024 * 1024
  });
  return {
    restarted: true,
    rawOutput: `${stdout}\n${stderr}`.trim()
  };
}

// ============================================================
// OpenClaw Codex OAuth login helpers
// ============================================================

export interface OpenClawCodexAuthStatus {
  /** True when an OAuth/token entry for openai-codex is registered. */
  signedIn: boolean;
  /** Count of providers with active OAuth/token entries. */
  oauthProviderCount: number;
  /** Current REDDWARF_MODEL_PROVIDER from the running process env. */
  currentProvider: "anthropic" | "openai" | "openai-codex" | null;
  /** Per-role model bindings for the currently selected provider. */
  roleBindings: Record<string, string> | null;
  /** Raw combined stdout/stderr from the models status command. */
  rawOutput: string;
}

interface CodexLoginStreamSession {
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  createdAt: number;
  /** Response currently streaming output chunks to the dashboard. */
  response: ServerResponse | null;
  /** Resolved once the child exits so stream handlers can await it. */
  exitPromise: Promise<number | null>;
  exited: boolean;
  exitCode: number | null;
}

/** Hard upper bound on how long a stream session can live. */
const CODEX_LOGIN_STREAM_TTL_MS = 15 * 60 * 1000;

// Module-level registry. Each /openclaw/codex-login/stream connection spawns
// one live openclaw-models child; /openclaw/codex-login/input targets it by
// sessionId so the dashboard can forward the pasted redirect URL.
const codexLoginStreamSessions = new Map<string, CodexLoginStreamSession>();

/**
 * Python PTY wrapper: forks a pseudo-terminal for the openclaw CLI so it
 * receives a real TTY (required by `models auth login`), then relays this
 * process's stdin/stdout through the PTY. A fixed 200x50 window size stops
 * the CLI's TUI from wrapping the auth URL character-by-character.
 */
const CODEX_LOGIN_PYTHON_WRAPPER = `
import pty, os, sys, select, signal, fcntl, termios, struct
pid, fd = pty.fork()
if pid == 0:
    os.execvp("node", ["node", "dist/index.js", "models", "auth", "login",
                        "--provider", "openai-codex", "--set-default"])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 200, 0, 0))
stdin_fd = sys.stdin.buffer.fileno() if hasattr(sys.stdin, "buffer") else sys.stdin.fileno()
stdout_fd = sys.stdout.buffer.fileno() if hasattr(sys.stdout, "buffer") else sys.stdout.fileno()
exit_code = 1
try:
    while True:
        r, _, _ = select.select([fd, stdin_fd], [], [], 1.0)
        if fd in r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            os.write(stdout_fd, data)
        if stdin_fd in r:
            try:
                data = os.read(stdin_fd, 4096)
            except OSError:
                break
            if not data:
                # Closing stdin is OK — the child may still be running.
                pass
            else:
                os.write(fd, data)
        try:
            wpid, status = os.waitpid(pid, os.WNOHANG)
            if wpid != 0:
                if os.WIFEXITED(status):
                    exit_code = os.WEXITSTATUS(status)
                break
        except ChildProcessError:
            break
finally:
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
sys.stdout.flush()
sys.exit(exit_code)
`;

function stripAnsiControlSequences(text: string): string {
  // Strip ANSI CSI/OSC sequences + carriage returns so the parsed output is
  // readable and regex matches are stable.
  return text
    .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\r/g, "");
}

function parseOpenClawModelsStatus(rawOutput: string): OpenClawCodexAuthStatus {
  const cleaned = stripAnsiControlSequences(rawOutput);
  const lines = cleaned.split(/\n/);

  let oauthProviderCount = 0;
  const countLine = lines.find((line) =>
    /Providers w\/ OAuth\/tokens\s*\((\d+)\)/i.test(line)
  );
  if (countLine) {
    const m = countLine.match(/\((\d+)\)/);
    if (m && m[1]) {
      oauthProviderCount = Number.parseInt(m[1], 10) || 0;
    }
  }

  // The detailed OAuth/token status section follows the header
  // "OAuth/token status". A signed-in codex profile appears as a bullet line
  // mentioning `openai-codex`. When no providers are signed in the CLI prints
  // a literal `- none` line.
  const oauthStatusIdx = lines.findIndex((line) =>
    /OAuth\/token status/i.test(line)
  );
  let codexMentioned = false;
  if (oauthStatusIdx >= 0) {
    for (let i = oauthStatusIdx + 1; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (/openai-codex/i.test(line)) {
        codexMentioned = true;
        break;
      }
      if (line.trim().length === 0 && i > oauthStatusIdx + 1) {
        break;
      }
    }
  }

  const signedIn = codexMentioned || oauthProviderCount > 0;

  const envProviderRaw = process.env.REDDWARF_MODEL_PROVIDER?.trim();
  const currentProvider =
    envProviderRaw === "anthropic" ||
    envProviderRaw === "openai" ||
    envProviderRaw === "openai-codex"
      ? envProviderRaw
      : null;

  const roleBindings = currentProvider
    ? { ...MODEL_PROVIDER_ROLE_MAP[currentProvider] }
    : null;

  return {
    signedIn,
    oauthProviderCount,
    currentProvider,
    roleBindings,
    rawOutput: cleaned
  };
}

/**
 * Check the bind-mounted workspace agent dirs for an openai-codex OAuth
 * profile with an unexpired access token. The openclaw login CLI writes
 * these per-role files but `openclaw models status` only inspects the
 * default agent dir, so it reports 0 OAuth providers even when the
 * runtime agents are fully authenticated.
 */
async function hasCodexAuthInWorkspaceAgents(): Promise<boolean> {
  const agentsRoot = join(
    process.cwd(),
    "runtime-data",
    "workspaces",
    ".agents"
  );
  let roleDirs: string[];
  try {
    const entries = await readdir(agentsRoot, { withFileTypes: true });
    roleDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return false;
  }
  const nowSeconds = Date.now();
  for (const role of roleDirs) {
    const profilePath = join(
      agentsRoot,
      role,
      "agent",
      "auth-profiles.json"
    );
    let raw: string;
    try {
      raw = await readFile(profilePath, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") {
      continue;
    }
    const profiles = (parsed as { profiles?: Record<string, unknown> })
      .profiles;
    if (!profiles || typeof profiles !== "object") {
      continue;
    }
    for (const entry of Object.values(profiles)) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const e = entry as {
        provider?: unknown;
        access?: unknown;
        expires?: unknown;
      };
      if (e.provider !== "openai-codex") {
        continue;
      }
      if (typeof e.access !== "string" || e.access.length === 0) {
        continue;
      }
      if (typeof e.expires === "number" && e.expires > 0 && e.expires < nowSeconds) {
        continue;
      }
      return true;
    }
  }
  return false;
}

async function readOpenClawCodexAuthStatus(): Promise<OpenClawCodexAuthStatus> {
  const dockerArgs = [
    "compose",
    "-f",
    OPENCLAW_COMPOSE_FILE,
    "--profile",
    "openclaw",
    "exec",
    "-T",
    "openclaw",
    "node",
    "dist/index.js",
    "models",
    "status"
  ];
  const { stdout, stderr } = await execFileAsync("docker", dockerArgs, {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024
  });
  const status = parseOpenClawModelsStatus(`${stdout}\n${stderr}`);
  if (!status.signedIn) {
    // `openclaw models status` only checks the default agent dir; the login
    // CLI persists tokens to every workspace-scoped role dir instead. Fall
    // back to scanning those so the dashboard reflects reality.
    const hasWorkspaceAuth = await hasCodexAuthInWorkspaceAgents();
    if (hasWorkspaceAuth) {
      return { ...status, signedIn: true };
    }
  }
  return status;
}

/**
 * Reap orphaned openclaw Codex login processes inside the openclaw container.
 *
 * The login CLI binds 127.0.0.1:1455 inside the container for its OAuth
 * callback listener. If a prior control-plane process crashed or was
 * restarted mid-flow, its python3 PTY wrapper and openclaw-models child
 * survive and keep the port held — every subsequent login attempt then
 * EADDRINUSEs and falls back to the manual-paste flow with no session to
 * match. Only safe to call when no live session is tracked in-process.
 */
async function reapStaleCodexLoginProcesses(): Promise<void> {
  const dockerArgs = [
    "compose",
    "-f",
    OPENCLAW_COMPOSE_FILE,
    "--profile",
    "openclaw",
    "exec",
    "-T",
    "openclaw",
    "sh",
    "-c",
    "pkill -KILL -f 'models[[:space:]]\\+auth[[:space:]]\\+login.*openai-codex' 2>/dev/null; pkill -KILL -f 'pty\\.fork' 2>/dev/null; exit 0"
  ];
  await new Promise<void>((resolve) => {
    const child = spawn("docker", dockerArgs, { stdio: "ignore" });
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
}

function writeCodexStreamFrame(
  res: ServerResponse,
  frame:
    | { type: "session"; sessionId: string }
    | { type: "data"; data: string }
    | { type: "exit"; code: number | null }
    | { type: "error"; message: string }
): void {
  if (res.writableEnded) {
    return;
  }
  try {
    res.write(`${JSON.stringify(frame)}\n`);
  } catch {
    // downstream socket may already be closed
  }
}

function destroyCodexLoginSession(sessionId: string): void {
  const session = codexLoginStreamSessions.get(sessionId);
  if (!session) {
    return;
  }
  codexLoginStreamSessions.delete(sessionId);
  if (!session.exited) {
    try {
      session.child.kill("SIGTERM");
    } catch {
      // child may already be gone
    }
  }
}

/**
 * Spawn the openclaw Codex login CLI and stream its output to the dashboard
 * as newline-delimited JSON frames on a single long-lived response. The
 * caller sends stdin back via POST /openclaw/codex-login/input using the
 * sessionId emitted in the first frame.
 *
 * Closing the response (client navigated away / closed modal) SIGTERMs the
 * child so we never leak processes the way the old REST flow did.
 */
async function streamOpenClawCodexLogin(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (codexLoginStreamSessions.size === 0) {
    await reapStaleCodexLoginProcesses();
  }

  const dockerArgs = [
    "compose",
    "-f",
    OPENCLAW_COMPOSE_FILE,
    "--profile",
    "openclaw",
    "exec",
    "-T",
    "openclaw",
    "python3",
    "-u",
    "-c",
    CODEX_LOGIN_PYTHON_WRAPPER
  ];

  const child = spawn("docker", dockerArgs, {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"]
  }) as ChildProcessByStdio<Writable, Readable, Readable>;

  const sessionId = randomUUID();

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive"
  });

  const session: CodexLoginStreamSession = {
    child,
    createdAt: Date.now(),
    response: res,
    exited: false,
    exitCode: null,
    exitPromise: new Promise<number | null>((resolve) => {
      child.once("exit", (code) => {
        session.exited = true;
        session.exitCode = code;
        resolve(code);
      });
    })
  };
  codexLoginStreamSessions.set(sessionId, session);

  writeCodexStreamFrame(res, { type: "session", sessionId });

  const relay = (chunk: Buffer) => {
    if (chunk.length === 0) {
      return;
    }
    writeCodexStreamFrame(res, {
      type: "data",
      data: chunk.toString("base64")
    });
  };
  child.stdout.on("data", relay);
  child.stderr.on("data", relay);

  child.once("error", (error) => {
    writeCodexStreamFrame(res, {
      type: "error",
      message: safeErrorMessage(error, "openclaw CLI spawn error")
    });
  });

  const ttlHandle = setTimeout(() => {
    destroyCodexLoginSession(sessionId);
  }, CODEX_LOGIN_STREAM_TTL_MS);
  ttlHandle.unref?.();

  const closeResponse = () => {
    clearTimeout(ttlHandle);
    if (!res.writableEnded) {
      try {
        res.end();
      } catch {
        // response may already be closed
      }
    }
  };

  // When the client disconnects (closes the modal, navigates away) kill the
  // live openclaw-models child so port 1455 is released immediately.
  req.once("close", () => {
    if (!session.exited) {
      destroyCodexLoginSession(sessionId);
    }
    closeResponse();
  });

  const exitCode = await session.exitPromise;
  writeCodexStreamFrame(res, { type: "exit", code: exitCode });
  codexLoginStreamSessions.delete(sessionId);
  closeResponse();
}

function writeOpenClawCodexLoginInput(
  sessionId: string,
  data: string
): { accepted: boolean; reason?: string } {
  const session = codexLoginStreamSessions.get(sessionId);
  if (!session) {
    return { accepted: false, reason: "session_not_found" };
  }
  if (session.exited) {
    return { accepted: false, reason: "session_exited" };
  }
  try {
    session.child.stdin.write(data);
    return { accepted: true };
  } catch {
    return { accepted: false, reason: "stdin_write_failed" };
  }
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
  managedEvidenceRoot?: string,
  localSecretsPath?: string,
  githubWriter?: GitHubWriter,
  githubIssuesAdapter?: GitHubIssuesAdapter,
  githubRepoDiscovery?: GitHubRepoDiscovery,
  toolApprovals?: Map<string, ToolApprovalRequest>,
  taskFlowAdapter?: OpenClawTaskFlowAdapter | null,
  downstreamHealthProbes?: DownstreamHealthProbe[],
  circuitBreakerSnapshots?: () => Record<string, { state: string; consecutiveFailures: number }>,
  intakeMode?: string,
  projectsInjectEnabled?: boolean
): Promise<void> {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";
  const urlObj = new URL(url, "http://localhost");
  const path = urlObj.pathname;
  const qp = parseOperatorQueryParams(url);

  // GET /health remains unauthenticated for liveness checks.
  if (method === "GET" && path === "/health") {
    const downstreamResults = downstreamHealthProbes && downstreamHealthProbes.length > 0
      ? await Promise.all(downstreamHealthProbes.map((p) => p.probe().catch((err): DownstreamHealthProbeResult => ({
          name: p.name,
          status: "unreachable",
          latencyMs: null,
          error: err instanceof Error ? err.message : String(err),
          checkedAt: clock().toISOString()
        }))))
      : undefined;
    const readiness: DownstreamStatus | undefined = downstreamResults
      ? downstreamResults.every((r) => r.status === "ok")
        ? "ok"
        : downstreamResults.some((r) => r.status === "unreachable")
          ? "unreachable"
          : "degraded"
      : undefined;
    const cbSnapshots = circuitBreakerSnapshots?.();
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
        : {}),
      ...(intakeMode ? { intakeMode } : {}),
      ...(downstreamResults ? { downstream: downstreamResults, readiness } : {}),
      ...(cbSnapshots && Object.keys(cbSnapshots).length > 0 ? { circuitBreakers: cbSnapshots } : {})
    };
    writeOperatorJsonResponse(res, 200, response);
    return;
  }

  if (method === "GET" && path === "/ui") {
    writeOperatorTextResponse(res, 200, renderOperatorUiHtml(), "text/html; charset=utf-8");
    return;
  }

  assertOperatorAuthorized(req, authToken);

  if (method === "GET" && path === "/ui/bootstrap") {
    writeOperatorJsonResponse(res, 200, await resolveOperatorUiBootstrap(clock));
    return;
  }

  if (method === "GET" && path === "/config") {
    writeOperatorJsonResponse(
      res,
      200,
      buildOperatorConfigResponse(await repository.listOperatorConfigEntries())
    );
    return;
  }

  if (method === "GET" && path === "/config/schema") {
    writeOperatorJsonResponse(
      res,
      200,
      operatorConfigSchemaResponseSchema.parse({
        schema: buildOperatorConfigJsonSchema()
      })
    );
    return;
  }

  if (method === "PUT" && path === "/config") {
    const rawBody = await readOperatorJsonBody(req, maxRequestBodyBytes);
    let updateRequest: import("@reddwarf/contracts").OperatorConfigUpdateRequest;

    try {
      updateRequest = operatorConfigUpdateRequestSchema.parse(rawBody ?? {});
    } catch (error) {
      writeOperatorJsonResponse(res, 400, {
        error: "bad_request",
        message: safeErrorMessage(error, "Invalid operator config payload.")
      });
      return;
    }

    const updatedAt = clock().toISOString();
    for (const entry of updateRequest.entries) {
      const parsedValue = parseOperatorConfigValue(entry.key, entry.value);
      const persistedEntry = {
        key: entry.key,
        value: parsedValue,
        updatedAt
      } as OperatorConfigEntry;

      await repository.saveOperatorConfigEntry(persistedEntry);
      process.env[entry.key] = serializeOperatorConfigValue(entry.key, parsedValue);
    }

    writeOperatorJsonResponse(
      res,
      200,
      buildOperatorConfigResponse(await repository.listOperatorConfigEntries())
    );
    return;
  }

  const rotateSecretMatch = /^\/secrets\/([^/]+)\/rotate$/.exec(path);
  if (method === "POST" && rotateSecretMatch) {
    const keyCandidate = decodeURIComponent(rotateSecretMatch[1]!);
    const parsedKey = operatorSecretKeySchema.safeParse(keyCandidate);
    if (!parsedKey.success) {
      writeOperatorJsonResponse(res, 404, {
        error: "not_found",
        message: `Secret ${keyCandidate} is not rotatable.`
      });
      return;
    }

    const rawBody = await readOperatorJsonBody(req, maxRequestBodyBytes);
    const parsedBody = operatorSecretRotationRequestSchema.safeParse(rawBody ?? {});
    if (!parsedBody.success) {
      writeOperatorJsonResponse(res, 400, {
        error: "bad_request",
        message: parsedBody.error.message
      });
      return;
    }

    const key = parsedKey.data;
    const rotatedAt = clock().toISOString();
    await writeOperatorSecret(
      localSecretsPath ?? resolve(process.cwd(), ".secrets"),
      key,
      parsedBody.data.value
    );
    process.env[key] = parsedBody.data.value;

    const metadata = operatorSecretMetadata[key];
    const notes = metadata.restartRequired
      ? [
          "Persisted to the local .secrets store.",
          "Restart the affected service stack to apply this secret to already-running processes."
        ]
      : [
          "Persisted to the local .secrets store.",
          "New child processes and future startups will use the rotated value immediately."
        ];
    if (key === "REDDWARF_OPERATOR_TOKEN") {
      notes.push("The current operator API process keeps using the previous bearer token until it restarts.");
    }

    writeOperatorJsonResponse(
      res,
      200,
      operatorSecretRotationResponseSchema.parse({
        key,
        rotatedAt,
        restartRequired: metadata.restartRequired,
        notes
      })
    );
    return;
  }

  if (method === "GET" && path === "/repos") {
    const repos = await repository.listGitHubIssuePollingCursors();
    writeOperatorJsonResponse(
      res,
      200,
      operatorRepoListResponseSchema.parse({
        repos,
        total: repos.length
      })
    );
    return;
  }

  if (method === "POST" && path === "/repos") {
    const rawBody = await readOperatorJsonBody(req, maxRequestBodyBytes);
    let createRequest: import("@reddwarf/contracts").OperatorRepoCreateRequest;

    try {
      createRequest = operatorRepoCreateRequestSchema.parse(rawBody ?? {});
    } catch (error) {
      writeOperatorJsonResponse(res, 400, {
        error: "bad_request",
        message: safeErrorMessage(error, "Invalid repository payload.")
      });
      return;
    }

    const existing = await repository.getGitHubIssuePollingCursor(createRequest.repo);
    const repo =
      existing ??
      createGitHubIssuePollingCursor({
        repo: createRequest.repo,
        updatedAt: clock().toISOString()
      });
    await repository.saveGitHubIssuePollingCursor(repo);

    writeOperatorJsonResponse(
      res,
      existing ? 200 : 201,
      operatorRepoMutationResponseSchema.parse({
        repo,
        created: existing === null
      })
    );
    return;
  }

  const deleteRepoMatch = /^\/repos\/([^/]+)\/([^/]+)$/.exec(path);
  if (method === "DELETE" && deleteRepoMatch) {
    const repo = `${decodeURIComponent(deleteRepoMatch[1]!)}\/${decodeURIComponent(
      deleteRepoMatch[2]!
    )}`;
    const deleted = await repository.deleteGitHubIssuePollingCursor(repo);
    if (!deleted) {
      writeOperatorJsonResponse(res, 404, {
        error: "not_found",
        message: `Polling repository ${repo} not found.`
      });
      return;
    }

    writeOperatorJsonResponse(
      res,
      200,
      operatorRepoDeleteResponseSchema.parse({
        repo,
        deleted: true
      })
    );
    return;
  }

  // GET /repos/github — discover repos accessible to the GitHub token
  if (method === "GET" && path === "/repos/github") {
    if (!githubRepoDiscovery) {
      writeOperatorJsonResponse(res, 501, {
        error: "not_implemented",
        message: "GitHub repo discovery is not available. Ensure GITHUB_TOKEN is configured."
      });
      return;
    }
    const perPage = qp["per_page"] ? parseInt(String(qp["per_page"]), 10) : undefined;
    const page = qp["page"] ? parseInt(String(qp["page"]), 10) : undefined;
    const sort = typeof qp["sort"] === "string" ? qp["sort"] as "updated" | "full_name" | "created" | "pushed" : undefined;
    const direction = typeof qp["direction"] === "string" ? qp["direction"] as "asc" | "desc" : undefined;
    const query = typeof qp["q"] === "string" ? qp["q"] : undefined;
    try {
      const result = await githubRepoDiscovery.listUserRepos({
        ...(perPage !== undefined && !isNaN(perPage) ? { perPage } : {}),
        ...(page !== undefined && !isNaN(page) ? { page } : {}),
        ...(sort ? { sort } : {}),
        ...(direction ? { direction } : {}),
        ...(query ? { query } : {})
      });
      writeOperatorJsonResponse(res, 200, result);
    } catch (error) {
      writeOperatorJsonResponse(res, 502, {
        error: "github_error",
        message: safeErrorMessage(error, "Failed to list GitHub repositories.")
      });
    }
    return;
  }

  // GET /openclaw/pairing-status — list pending OpenClaw device pairing requests
  if (method === "GET" && path === "/openclaw/pairing-status") {
    try {
      const status = await readOpenClawPairingStatus();
      writeOperatorJsonResponse(res, 200, {
        pending: status.pending,
        totalPending: status.pending.length,
        rawOutput: status.rawOutput
      });
    } catch (error) {
      writeOperatorJsonResponse(res, 502, {
        error: "openclaw_unreachable",
        message: safeErrorMessage(
          error,
          "Failed to read OpenClaw pairing status. Is the openclaw container running?"
        )
      });
    }
    return;
  }

  // GET /openclaw/codex-status — auth status for the openai-codex provider
  if (method === "GET" && path === "/openclaw/codex-status") {
    try {
      const status = await readOpenClawCodexAuthStatus();
      writeOperatorJsonResponse(res, 200, status);
    } catch (error) {
      writeOperatorJsonResponse(res, 502, {
        error: "openclaw_unreachable",
        message: safeErrorMessage(
          error,
          "Failed to read OpenClaw Codex auth status. Is the openclaw container running?"
        )
      });
    }
    return;
  }

  // POST /openclaw/model-provider — atomically switch REDDWARF_MODEL_PROVIDER
  // across the operator config DB, the running process env, and the generated
  // openclaw.json. The openclaw container must still be restarted for the
  // new agent model bindings to take effect.
  if (method === "POST" && path === "/openclaw/model-provider") {
    try {
      const body = (await readOperatorJsonBody(req, maxRequestBodyBytes)) as
        | { provider?: unknown }
        | null;
      const parsed = openClawModelProviderSchema.safeParse(body?.provider);
      if (!parsed.success) {
        writeOperatorJsonResponse(res, 400, {
          error: "invalid_request",
          message: "provider must be one of: anthropic, openai, openai-codex"
        });
        return;
      }
      const provider = parsed.data;
      const updatedAt = clock().toISOString();
      await repository.saveOperatorConfigEntry({
        key: "REDDWARF_MODEL_PROVIDER",
        value: provider,
        updatedAt
      });
      process.env.REDDWARF_MODEL_PROVIDER = provider;

      // Regenerate openclaw.json by running the existing script so the runtime
      // config matches the new provider. The script reads the same env we just
      // updated.
      const scriptOutput = await execFileAsync(
        "node",
        ["scripts/generate-openclaw-config.mjs"],
        {
          cwd: process.cwd(),
          env: process.env,
          maxBuffer: 1024 * 1024
        }
      );

      writeOperatorJsonResponse(res, 200, {
        provider,
        requiresRestart: true,
        message: `Model provider set to ${provider}. Restart the openclaw container for the new agent model bindings to take effect.`,
        rawOutput: `${scriptOutput.stdout}\n${scriptOutput.stderr}`.trim()
      });
    } catch (error) {
      writeOperatorJsonResponse(res, 500, {
        error: "model_provider_update_failed",
        message: safeErrorMessage(
          error,
          "Failed to update OpenClaw model provider."
        )
      });
    }
    return;
  }

  // GET /openclaw/codex-login/stream — long-lived NDJSON stream that spawns
  // the openclaw Codex login CLI and relays its output back to the dashboard
  // terminal. The first frame carries the sessionId the client must use to
  // POST keystrokes back via /openclaw/codex-login/input.
  if (method === "GET" && path === "/openclaw/codex-login/stream") {
    try {
      await streamOpenClawCodexLogin(req, res);
    } catch (error) {
      if (!res.headersSent) {
        writeOperatorJsonResponse(res, 502, {
          error: "openclaw_codex_login_failed",
          message: safeErrorMessage(
            error,
            "Failed to start OpenClaw Codex login stream. Is the openclaw container running?"
          )
        });
      } else if (!res.writableEnded) {
        writeCodexStreamFrame(res, {
          type: "error",
          message: safeErrorMessage(error, "openclaw Codex login stream error")
        });
        try {
          res.end();
        } catch {
          // already closed
        }
      }
    }
    return;
  }

  // POST /openclaw/codex-login/input — write the pasted callback URL (or any
  // other keystroke sequence the dashboard terminal captures) into the live
  // login session's stdin. Body: { sessionId: string, data: string }.
  if (method === "POST" && path === "/openclaw/codex-login/input") {
    try {
      const body = (await readOperatorJsonBody(req, maxRequestBodyBytes)) as
        | { sessionId?: unknown; data?: unknown }
        | null;
      const sessionId =
        typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
      const data = typeof body?.data === "string" ? body.data : "";
      if (sessionId.length === 0) {
        writeOperatorJsonResponse(res, 400, {
          error: "invalid_request",
          message: "sessionId is required"
        });
        return;
      }
      const result = writeOpenClawCodexLoginInput(sessionId, data);
      if (!result.accepted) {
        writeOperatorJsonResponse(res, 409, {
          error: result.reason ?? "input_rejected",
          message:
            result.reason === "session_not_found"
              ? "Codex login session not found or already closed."
              : result.reason === "session_exited"
                ? "Codex login session already exited."
                : "Failed to write to Codex login session stdin."
        });
        return;
      }
      writeOperatorJsonResponse(res, 200, { accepted: true });
    } catch (error) {
      writeOperatorJsonResponse(res, 502, {
        error: "openclaw_codex_login_failed",
        message: safeErrorMessage(
          error,
          "Failed to forward input to Codex login session."
        )
      });
    }
    return;
  }

  // POST /openclaw/fix-pairing — approve any pending operator pairing requests
  if (method === "POST" && path === "/openclaw/fix-pairing") {
    try {
      const result = await fixOpenClawPairing();
      writeOperatorJsonResponse(res, 200, {
        approved: result.approved,
        approvedCount: result.approved.length,
        alreadyClean: result.alreadyClean,
        message: result.alreadyClean
          ? "No pending operator pairing requests. Reload the OpenClaw Control UI."
          : `Approved ${result.approved.length} pending operator pairing request(s). Reload the OpenClaw Control UI to reconnect.`,
        rawOutput: result.rawOutput
      });
    } catch (error) {
      writeOperatorJsonResponse(res, 502, {
        error: "openclaw_unreachable",
        message: safeErrorMessage(
          error,
          "Failed to fix OpenClaw pairing. Is the openclaw container running?"
        )
      });
    }
    return;
  }

  // POST /openclaw/restart — restart the openclaw compose service so new
  // openclaw.json bindings (e.g. after a provider switch) take effect.
  if (method === "POST" && path === "/openclaw/restart") {
    try {
      const result = await restartOpenClawContainer();
      writeOperatorJsonResponse(res, 200, {
        restarted: true,
        message:
          "OpenClaw container restarted. New agent model bindings are now active.",
        rawOutput: result.rawOutput
      });
    } catch (error) {
      writeOperatorJsonResponse(res, 502, {
        error: "openclaw_restart_failed",
        message: safeErrorMessage(
          error,
          "Failed to restart OpenClaw container."
        )
      });
    }
    return;
  }

  // GET /runs
  if (method === "GET" && path === "/runs") {
    const repo = typeof qp["repo"] === "string" ? qp["repo"] : undefined;
    const taskId = typeof qp["taskId"] === "string" ? qp["taskId"] : undefined;
    const rawLimit = qp["limit"] ? parseInt(String(qp["limit"]), 10) : undefined;
    const limit =
      rawLimit !== undefined && !isNaN(rawLimit) && rawLimit > 0 && rawLimit <= 1000
        ? rawLimit
        : undefined;
    const rawStatuses = qp["statuses"] ?? qp["status"];
    const rawStatusList = rawStatuses
      ? (Array.isArray(rawStatuses) ? rawStatuses : [rawStatuses])
      : undefined;
    const statuses = rawStatusList?.flatMap((s) => {
      const parsed = pipelineRunStatusSchema.safeParse(s);
      return parsed.success ? [parsed.data] : [];
    });
    const runs = await repository.listPipelineRuns({
      ...(repo !== undefined ? { repo } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(statuses !== undefined && statuses.length > 0 ? { statuses } : {})
    });
    writeOperatorJsonResponse(res, 200, { runs, total: runs.length });
    return;
  }

  const runMatch = /^\/runs\/([^/]+)$/.exec(path);
  if (method === "GET" && runMatch) {
    const runId = decodeURIComponent(runMatch[1]!);
    const run = await repository.getPipelineRun(runId);
    if (!run) {
      writeOperatorJsonResponse(res, 404, {
        error: "not_found",
        message: `Pipeline run ${runId} not found.`
      });
      return;
    }

    const [summary, events] = await Promise.all([
      repository.getRunSummary(run.taskId, runId),
      repository.listRunEvents(run.taskId, runId)
    ]);
    const response: OperatorRunDetailResponse = {
      run,
      summary,
      events,
      totalEvents: events.length,
      tokenUsage: summarizeRunTokenUsage(events)
    };
    writeOperatorJsonResponse(res, 200, response);
    return;
  }

  const runEvidenceMatch = /^\/runs\/([^/]+)\/evidence$/.exec(path);
  if (method === "GET" && runEvidenceMatch) {
    const runId = decodeURIComponent(runEvidenceMatch[1]!);
    const run = await repository.getPipelineRun(runId);
    if (!run) {
      writeOperatorJsonResponse(res, 404, {
        error: "not_found",
        message: `Pipeline run ${runId} not found.`
      });
      return;
    }

    const snapshot = await repository.getTaskSnapshot(run.taskId);
    const evidenceRecords = snapshot.evidenceRecords.filter((record) =>
      matchesEvidenceRecordToRun(record, runId)
    );
    writeOperatorJsonResponse(res, 200, {
      runId,
      taskId: run.taskId,
      evidenceRecords,
      total: evidenceRecords.length
    });
    return;
  }

  const runReportMatch = /^\/runs\/([^/]+)\/report$/.exec(path);
  if (method === "GET" && runReportMatch) {
    const runId = decodeURIComponent(runReportMatch[1]!);
    const report = await assembleRunReport(repository, runId);
    if (!report) {
      writeOperatorJsonResponse(res, 404, {
        error: "not_found",
        message: `Pipeline run ${runId} not found.`
      });
      return;
    }

    const accept = String(req.headers["accept"] ?? "text/markdown");
    if (accept.includes("application/json")) {
      writeOperatorJsonResponse(res, 200, report);
      return;
    }

    writeOperatorTextResponse(
      res,
      200,
      renderRunReportMarkdown(report),
      "text/markdown; charset=utf-8"
    );
    return;
  }

  // POST /runs/:runId/heartbeat-kick — Feature 186 (operator triage).
  // Refreshes lastHeartbeatAt on a stuck run so the dispatcher reconsiders
  // it without a full cancel-and-retry. Active or blocked runs only.
  const runHeartbeatKickMatch =
    /^\/runs\/([^/]+)\/heartbeat-kick$/.exec(path);
  if (method === "POST" && runHeartbeatKickMatch) {
    const runId = decodeURIComponent(runHeartbeatKickMatch[1]!);
    const run = await repository.getPipelineRun(runId);
    if (!run) {
      writeOperatorJsonResponse(res, 404, {
        error: "not_found",
        message: `Pipeline run ${runId} not found.`
      });
      return;
    }
    if (run.status !== "active" && run.status !== "blocked") {
      writeOperatorJsonResponse(res, 409, {
        error: "conflict",
        message: `Cannot kick heartbeat on a ${run.status} run.`
      });
      return;
    }
    const body = (await readOperatorJsonBody(req, maxRequestBodyBytes)) as
      | Record<string, unknown>
      | null;
    const reason =
      body && typeof body["reason"] === "string"
        ? body["reason"].trim().slice(0, 500)
        : null;
    const now = clock().toISOString();
    const kicked: PipelineRun = { ...run, lastHeartbeatAt: now };
    await repository.savePipelineRun(kicked);
    await repository.saveRunEvent(
      createRunEvent({
        eventId: `${run.taskId}:heartbeat-kick:${runId}:${randomUUID()}`,
        taskId: run.taskId,
        runId,
        phase: "intake",
        level: "info",
        code: EventCodes.HEARTBEAT_KICKED,
        message: `Operator kicked heartbeat for run ${runId}.`,
        data: {
          previousHeartbeatAt: run.lastHeartbeatAt,
          newHeartbeatAt: now,
          ...(reason ? { reason } : {})
        },
        createdAt: now
      })
    );
    writeOperatorJsonResponse(res, 200, { run: kicked });
    return;
  }

  // POST /tasks/:taskId/quarantine — Feature 186.
  const taskQuarantineMatch = /^\/tasks\/([^/]+)\/quarantine$/.exec(path);
  if (method === "POST" && taskQuarantineMatch) {
    const taskId = decodeURIComponent(taskQuarantineMatch[1]!);
    const manifest = await repository.getManifest(taskId);
    if (!manifest) {
      writeOperatorJsonResponse(res, 404, {
        error: "not_found",
        message: `Task ${taskId} not found.`
      });
      return;
    }
    const body = (await readOperatorJsonBody(req, maxRequestBodyBytes)) as
      | Record<string, unknown>
      | null;
    const reason =
      body && typeof body["reason"] === "string"
        ? body["reason"].trim()
        : "";
    if (reason.length === 0) {
      writeOperatorJsonResponse(res, 400, {
        error: "bad_request",
        message: "A non-empty `reason` is required for quarantine."
      });
      return;
    }
    if (manifest.lifecycleStatus === "quarantined") {
      writeOperatorJsonResponse(res, 409, {
        error: "conflict",
        message: `Task ${taskId} is already quarantined.`
      });
      return;
    }
    try {
      assertTaskLifecycleTransition(
        manifest.lifecycleStatus,
        "quarantined"
      );
    } catch (error) {
      writeOperatorJsonResponse(res, 409, {
        error: "conflict",
        message: error instanceof Error ? error.message : String(error)
      });
      return;
    }
    const now = clock().toISOString();
    const updated: TaskManifest = {
      ...manifest,
      lifecycleStatus: "quarantined",
      updatedAt: now
    };
    await repository.updateManifest(updated);
    await repository.saveRunEvent(
      createRunEvent({
        eventId: `${taskId}:quarantine:${randomUUID()}`,
        taskId,
        runId: "operator-action",
        phase: "intake",
        level: "warn",
        code: EventCodes.TASK_QUARANTINED,
        message: `Task ${taskId} quarantined: ${reason.slice(0, 200)}`,
        data: {
          previousLifecycleStatus: manifest.lifecycleStatus,
          reason
        },
        createdAt: now
      })
    );
    writeOperatorJsonResponse(res, 200, { manifest: updated });
    return;
  }

  // POST /tasks/:taskId/release — Feature 186 (release from quarantine).
  const taskReleaseMatch = /^\/tasks\/([^/]+)\/release$/.exec(path);
  if (method === "POST" && taskReleaseMatch) {
    const taskId = decodeURIComponent(taskReleaseMatch[1]!);
    const manifest = await repository.getManifest(taskId);
    if (!manifest) {
      writeOperatorJsonResponse(res, 404, {
        error: "not_found",
        message: `Task ${taskId} not found.`
      });
      return;
    }
    if (manifest.lifecycleStatus !== "quarantined") {
      writeOperatorJsonResponse(res, 409, {
        error: "conflict",
        message: `Task ${taskId} is not quarantined (current: ${manifest.lifecycleStatus}).`
      });
      return;
    }
    const body = (await readOperatorJsonBody(req, maxRequestBodyBytes)) as
      | Record<string, unknown>
      | null;
    const reason =
      body && typeof body["reason"] === "string"
        ? body["reason"].trim()
        : null;
    const now = clock().toISOString();
    const updated: TaskManifest = {
      ...manifest,
      lifecycleStatus: "ready",
      updatedAt: now
    };
    await repository.updateManifest(updated);
    await repository.saveRunEvent(
      createRunEvent({
        eventId: `${taskId}:release:${randomUUID()}`,
        taskId,
        runId: "operator-action",
        phase: "intake",
        level: "info",
        code: EventCodes.TASK_RELEASED,
        message: `Task ${taskId} released from quarantine.`,
        data: { ...(reason ? { reason } : {}) },
        createdAt: now
      })
    );
    writeOperatorJsonResponse(res, 200, { manifest: updated });
    return;
  }

  // POST /tasks/:taskId/notes — Feature 186 (operator note as memory record).
  const taskNotesMatch = /^\/tasks\/([^/]+)\/notes$/.exec(path);
  if (method === "POST" && taskNotesMatch) {
    const taskId = decodeURIComponent(taskNotesMatch[1]!);
    const manifest = await repository.getManifest(taskId);
    if (!manifest) {
      writeOperatorJsonResponse(res, 404, {
        error: "not_found",
        message: `Task ${taskId} not found.`
      });
      return;
    }
    const body = (await readOperatorJsonBody(req, maxRequestBodyBytes)) as
      | Record<string, unknown>
      | null;
    const note =
      body && typeof body["note"] === "string" ? body["note"].trim() : "";
    if (note.length === 0) {
      writeOperatorJsonResponse(res, 400, {
        error: "bad_request",
        message: "A non-empty `note` is required."
      });
      return;
    }
    const author =
      body && typeof body["author"] === "string"
        ? body["author"].trim()
        : "operator";
    const now = clock().toISOString();
    const memoryId = `${taskId}:operator-note:${randomUUID()}`;
    await repository.saveMemoryRecord(
      createMemoryRecord({
        memoryId,
        taskId,
        scope: "task",
        provenance: "operator_provided",
        key: `operator.note:${now}`,
        title: `Operator note from ${author}`,
        value: { note, author, recordedAt: now },
        repo: manifest.source.repo,
        tags: ["operator", "note"],
        createdAt: now,
        updatedAt: now
      })
    );
    await repository.saveRunEvent(
      createRunEvent({
        eventId: `${taskId}:operator-note:${randomUUID()}`,
        taskId,
        runId: "operator-action",
        phase: "intake",
        level: "info",
        code: EventCodes.OPERATOR_NOTE_ADDED,
        message: `Operator (${author}) added a note to ${taskId}.`,
        data: { memoryId, author },
        createdAt: now
      })
    );
    writeOperatorJsonResponse(res, 200, { memoryId });
    return;
  }

  // POST /runs/:runId/cancel
  const runCancelMatch = /^\/runs\/([^/]+)\/cancel$/.exec(path);
  if (method === "POST" && runCancelMatch) {
    const runId = decodeURIComponent(runCancelMatch[1]!);
    const run = await repository.getPipelineRun(runId);
    if (!run) {
      writeOperatorJsonResponse(res, 404, {
        error: "not_found",
        message: `Pipeline run ${runId} not found.`
      });
      return;
    }

    if (run.status === "active") {
      writeOperatorJsonResponse(res, 409, {
        error: "conflict",
        message:
          "Active pipeline runs cannot be cancelled from the dashboard. Wait for the run to block, fail, or become stale before cancelling."
      });
      return;
    }

    if (run.status === "completed" || run.status === "cancelled") {
      writeOperatorJsonResponse(res, 409, {
        error: "conflict",
        message: `Pipeline run ${runId} is already ${run.status}.`
      });
      return;
    }

    const now = clock().toISOString();
    const cancelledRun: PipelineRun = {
      ...run,
      status: "cancelled",
      completedAt: now,
      lastHeartbeatAt: now
    };
    await repository.savePipelineRun(cancelledRun);
    writeOperatorJsonResponse(res, 200, { run: cancelledRun });
    return;
  }

  // GET /approvals
  if (method === "GET" && path === "/rejected") {
    const limit = qp["limit"] ? parseInt(String(qp["limit"]), 10) : undefined;
    const rawReason = typeof qp["reason"] === "string" ? qp["reason"] : undefined;
    const since = typeof qp["since"] === "string" ? qp["since"] : undefined;

    let reasonCode:
      | import("@reddwarf/contracts").EligibilityRejectionReasonCode
      | undefined;
    if (rawReason !== undefined) {
      const parsedReason = eligibilityRejectionReasonCodeSchema.safeParse(rawReason);
      if (!parsedReason.success) {
        writeOperatorJsonResponse(res, 400, {
          error: "bad_request",
          message: `Unknown rejection reason "${rawReason}".`
        });
        return;
      }
      reasonCode = parsedReason.data;
    }

    const items = await repository.listEligibilityRejections({
      ...(limit !== undefined && !Number.isNaN(limit) ? { limit } : {}),
      ...(reasonCode !== undefined ? { reasonCode } : {}),
      ...(since !== undefined ? { since } : {})
    });
    const byReason = items.reduce<Record<string, number>>((acc, item) => {
      acc[item.reasonCode] = (acc[item.reasonCode] ?? 0) + 1;
      return acc;
    }, {});

    writeOperatorJsonResponse(res, 200, {
      items: items.map((item) => {
        const sourceIssue =
          item.sourceIssue && typeof item.sourceIssue === "object"
            ? (item.sourceIssue as Record<string, unknown>)
            : {};
        const sourceRef =
          sourceIssue["source"] && typeof sourceIssue["source"] === "object"
            ? (sourceIssue["source"] as Record<string, unknown>)
            : {};

        return {
          taskId: item.taskId,
          rejectedAt: item.rejectedAt,
          reasonCode: item.reasonCode,
          reasonDetail: item.reasonDetail,
          issueTitle:
            typeof sourceIssue["title"] === "string" ? sourceIssue["title"] : null,
          issueUrl:
            typeof sourceRef["issueUrl"] === "string"
              ? sourceRef["issueUrl"]
              : null,
          dryRun: item.dryRun
        };
      }),
      total: items.length,
      byReason
    });
    return;
  }

  // GET /budget/daily — Feature 183 (org-level daily autonomy budget).
  // Returns the current burn-down — read-only, computed from
  // TOKEN_USAGE_RECORDED events for today's UTC window. Surfaces the same
  // status the dispatcher gate uses, so the dashboard ribbon and the gate
  // never disagree.
  if (method === "GET" && path === "/budget/daily") {
    try {
      const result = await checkDailyBudgetGate({ repository });
      writeOperatorJsonResponse(res, 200, result.status);
    } catch (error) {
      writeOperatorJsonResponse(res, 500, {
        error: "internal_error",
        message: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }

  // GET /metrics/agents — Feature 179 (agent quality telemetry aggregates).
  // Pure aggregation over existing phase_records + run_events joined with
  // task_manifests for policy_version. No new events captured; the caller
  // pays no ingest-time cost — aggregation happens at read time.
  if (method === "GET" && path === "/metrics/agents") {
    const since = typeof qp["since"] === "string" ? qp["since"] : undefined;
    const until = typeof qp["until"] === "string" ? qp["until"] : undefined;
    try {
      const metrics = await repository.getAgentQualityMetrics({
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {})
      });
      writeOperatorJsonResponse(res, 200, metrics);
    } catch (error) {
      writeOperatorJsonResponse(res, 400, {
        error: "bad_request",
        message:
          error instanceof Error ? error.message : "Invalid metrics query."
      });
    }
    return;
  }

  // GET /audit/export — Feature 185 (audit-log export).
  // Returns a flat join of approval_requests × task_manifests so operators can
  // answer compliance questions like "every autonomous change that touched
  // packages/billing in Q2" without bespoke SQL. Supports CSV download or
  // JSON. Paginated behind the shared QUERY_LIMIT_MAX (100) — callers who hit
  // the cap should narrow the time window.
  if (method === "GET" && path === "/audit/export") {
    const since = typeof qp["since"] === "string" ? qp["since"] : undefined;
    const until = typeof qp["until"] === "string" ? qp["until"] : undefined;
    const repoFilter =
      typeof qp["repo"] === "string" && qp["repo"].length > 0
        ? qp["repo"]
        : null;
    const format =
      typeof qp["format"] === "string" && qp["format"].toLowerCase() === "csv"
        ? "csv"
        : "json";

    let approvals;
    try {
      approvals = await repository.listApprovalRequests({
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {}),
        limit: 100
      });
    } catch (error) {
      writeOperatorJsonResponse(res, 400, {
        error: "bad_request",
        message:
          error instanceof Error ? error.message : "Invalid audit query."
      });
      return;
    }

    const uniqueTaskIds = [...new Set(approvals.map((a) => a.taskId))];
    const manifestEntries = await Promise.all(
      uniqueTaskIds.map(async (taskId) => {
        const manifest = await repository.getManifest(taskId);
        return manifest ? ([taskId, manifest] as const) : null;
      })
    );
    const manifestsByTaskId = new Map(
      manifestEntries.filter((entry): entry is readonly [string, import("@reddwarf/contracts").TaskManifest] => entry !== null)
    );

    const allEntries = buildAuditEntries(approvals, manifestsByTaskId);
    const entries = filterAuditEntriesByRepo(allEntries, repoFilter);
    const truncated = approvals.length >= 100;

    if (format === "csv") {
      const fileStamp = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="reddwarf-audit-${fileStamp}.csv"`
      });
      res.end(renderAuditCsv(entries));
      return;
    }

    writeOperatorJsonResponse(res, 200, {
      entries,
      total: entries.length,
      window: {
        since: since ?? null,
        until: until ?? null
      },
      repo: repoFilter,
      truncated
    });
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
    const requestId = decodeURIComponent(resolveMatch[1]!);
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
    let resolveResult;
    try {
      resolveResult = await resolveApprovalRequest(
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
    } catch (error) {
      if (error instanceof ProjectApprovalRequiredError) {
        writeOperatorJsonResponse(res, 409, {
          error: "conflict",
          message: error.message,
          projectId: error.projectId,
          approvalRoute: `/projects/${encodeURIComponent(error.projectId)}/approve`
        });
        return;
      }
      throw error;
    }
    writeOperatorJsonResponse(res, 200, {
      approval: resolveResult.approvalRequest,
      manifest: resolveResult.manifest
    });
    return;
  }

  // GET /approvals/:requestId
  const approvalMatch = /^\/approvals\/([^/]+)$/.exec(path);
  if (method === "GET" && approvalMatch) {
    const requestId = decodeURIComponent(approvalMatch[1]!);
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
      writeOperatorJsonResponse(res, 400, {
        error: "bad_request",
        message: safeErrorMessage(error, "Invalid injection payload.")
      });
      return;
    }

    const planningInput = buildPlanningTaskInputFromInjection(
      injected,
      defaultPlanningDryRun
    );
    const classification = classifyComplexity(planningInput);
    const result = await runPlanningPipeline(
      {
        ...planningInput,
        metadata: { ...planningInput.metadata, complexityClassification: classification }
      },
      {
        repository,
        planner,
        ...(dispatchDependencies && managedTargetRoot
          ? {
              openClawDispatch: dispatchDependencies.openClawDispatch,
              architectTargetRoot: managedTargetRoot
            }
          : {}),
        clock
      }
    );

    writeOperatorJsonResponse(res, 201, {
      runId: result.runId,
      nextAction: result.nextAction,
      manifest: result.manifest,
      complexityClassification: classification,
      ...(result.spec ? { spec: result.spec } : {}),
      ...(result.policySnapshot ? { policySnapshot: result.policySnapshot } : {}),
      ...(result.approvalRequest ? { approvalRequest: result.approvalRequest } : {})
    });
    return;
  }

  // POST /projects/inject — deposit a pre-built ProjectSpec from Context (T-10).
  if (method === "POST" && path === "/projects/inject") {
    if (projectsInjectEnabled === false) {
      writeOperatorJsonResponse(res, 404, {
        error: "not_found",
        message: "Project injection is disabled on this deployment."
      });
      return;
    }

    const rawBody = (await readOperatorJsonBody(
      req,
      maxRequestBodyBytes
    )) as Record<string, unknown> | null;

    let parsed;
    try {
      parsed = projectInjectionRequestSchema.parse(rawBody ?? {});
    } catch (error) {
      writeOperatorJsonResponse(res, 422, {
        error: "unprocessable_entity",
        message: safeErrorMessage(error, "Invalid ProjectSpec or provenance payload."),
        ...(error instanceof Error && "issues" in error
          ? { issues: (error as unknown as { issues: unknown }).issues }
          : {})
      });
      return;
    }

    const injectedProject: ProjectSpec = {
      ...parsed.projectSpec,
      status: "pending_approval"
    };

    // Idempotency: look for an existing provenance row for this
    // (context_spec_id, context_version).
    const existing = await repository.findProjectSpecProvenanceByContext(
      parsed.provenance.context_spec_id,
      parsed.provenance.context_version
    );

    if (existing) {
      const existingProject = await repository.getProjectSpec(existing.project_id);
      writeOperatorJsonResponse(res, 200, {
        project_id: existing.project_id,
        state: existingProject?.status ?? "unknown",
        provenance_id: existing.id,
        deduplicated: true
      });
      return;
    }

    try {
      await repository.saveProjectSpec(injectedProject);
    } catch (error) {
      writeOperatorJsonResponse(res, 422, {
        error: "unprocessable_entity",
        message: safeErrorMessage(error, "Project could not be persisted.")
      });
      return;
    }

    let provenance;
    try {
      provenance = await repository.saveProjectSpecProvenance({
        projectId: injectedProject.projectId,
        contextSpecId: parsed.provenance.context_spec_id,
        contextVersion: parsed.provenance.context_version,
        adapterVersion: parsed.provenance.adapter_version,
        targetSchemaVersion: parsed.provenance.target_schema_version,
        injectedBy: null,
        translationNotes: parsed.provenance.translation_notes,
        now: clock().toISOString()
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        // Race: another request won. Return the winner's record.
        const winner = await repository.findProjectSpecProvenanceByContext(
          parsed.provenance.context_spec_id,
          parsed.provenance.context_version
        );
        if (winner) {
          const winnerProject = await repository.getProjectSpec(winner.project_id);
          writeOperatorJsonResponse(res, 200, {
            project_id: winner.project_id,
            state: winnerProject?.status ?? "unknown",
            provenance_id: winner.id,
            deduplicated: true
          });
          return;
        }
      }
      writeOperatorJsonResponse(res, 500, {
        error: "internal_error",
        message: safeErrorMessage(error, "Failed to persist provenance.")
      });
      return;
    }

    writeOperatorJsonResponse(res, 201, {
      project_id: injectedProject.projectId,
      state: injectedProject.status,
      provenance_id: provenance.id,
      deduplicated: false
    });
    return;
  }

  if (method === "POST" && path === "/issues/submit") {
    if (!githubWriter) {
      writeOperatorJsonResponse(res, 503, {
        error: "service_unavailable",
        message: "GitHub writer is not configured on this server."
      });
      return;
    }

    const rawBody = (await readOperatorJsonBody(
      req,
      maxRequestBodyBytes
    )) as Record<string, unknown> | null;
    let submission;
    try {
      submission = githubIssueSubmitSchema.parse(rawBody ?? {});
    } catch (error) {
      writeOperatorJsonResponse(res, 400, {
        error: "bad_request",
        message: safeErrorMessage(error, "Invalid issue submission payload.")
      });
      return;
    }

    const bodyParts: string[] = [];
    bodyParts.push(`## Summary\n\n${submission.summary}`);
    bodyParts.push(
      `## Acceptance Criteria\n\n${submission.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`
    );
    if (submission.affectedPaths.length > 0) {
      bodyParts.push(
        `## Affected Paths\n\n${submission.affectedPaths.map((p) => `- ${p}`).join("\n")}`
      );
    }
    if (submission.constraints.length > 0) {
      bodyParts.push(
        `## Constraints\n\n${submission.constraints.map((c) => `- ${c}`).join("\n")}`
      );
    }
    bodyParts.push(
      `## Requested Capabilities\n\n${submission.requestedCapabilities.join(", ")}`
    );
    if (submission.riskClassHint) {
      bodyParts.push(`## Risk Hint\n\n${submission.riskClassHint}`);
    }
    const issueBody = bodyParts.join("\n\n");

    const created = await githubWriter.createIssue({
      repo: submission.repo,
      title: submission.title,
      body: issueBody,
      labels: ["ai-eligible", ...submission.labels]
    });

    writeOperatorJsonResponse(res, 201, {
      issueNumber: created.issueNumber,
      issueUrl: created.url,
      repo: created.repo
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
      writeOperatorJsonResponse(res, 400, {
        error: "bad_request",
        message: safeErrorMessage(error, "Invalid task-group payload.")
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
      const classification = classifyComplexity(planningInput);
      const result = await runPlanningPipeline(
        {
          ...planningInput,
          metadata: { ...planningInput.metadata, complexityClassification: classification }
        },
        {
          repository,
          planner,
          ...(dispatchDependencies && managedTargetRoot
            ? {
                openClawDispatch: dispatchDependencies.openClawDispatch,
                architectTargetRoot: managedTargetRoot
              }
            : {}),
          clock
        }
      );
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

  if (method === "GET" && path === "/tasks") {
    const repo = typeof qp["repo"] === "string" ? qp["repo"] : undefined;
    const rawLimit = qp["limit"] ? parseInt(String(qp["limit"]), 10) : undefined;
    const limit =
      rawLimit !== undefined && !isNaN(rawLimit) && rawLimit > 0 && rawLimit <= 1000
        ? rawLimit
        : undefined;
    const rawStatuses = qp["statuses"] ?? qp["status"];
    const rawPhases = qp["phases"] ?? qp["phase"];
    const lifecycleStatuses = rawStatuses
      ? (Array.isArray(rawStatuses) ? rawStatuses : [rawStatuses]).flatMap((s) => {
          const parsed = taskLifecycleStatusSchema.safeParse(s);
          return parsed.success ? [parsed.data] : [];
        })
      : undefined;
    const phases = rawPhases
      ? (Array.isArray(rawPhases) ? rawPhases : [rawPhases]).flatMap((p) => {
          const parsed = taskPhaseSchema.safeParse(p);
          return parsed.success ? [parsed.data] : [];
        })
      : undefined;
    const manifests = await repository.listTaskManifests({
      ...(repo !== undefined ? { repo } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(lifecycleStatuses !== undefined && lifecycleStatuses.length > 0
        ? { lifecycleStatuses }
        : {}),
      ...(phases !== undefined && phases.length > 0 ? { phases } : {})
    });
    const tasks = await Promise.all(
      manifests.map((manifest) => buildOperatorTaskSummary(repository, manifest))
    );
    writeOperatorJsonResponse(res, 200, {
      tasks,
      total: tasks.length
    });
    return;
  }

  const taskMatch = /^\/tasks\/([^/]+)$/.exec(path);
  if (method === "GET" && taskMatch) {
    const taskId = decodeURIComponent(taskMatch[1]!);
    const snapshot = await repository.getTaskSnapshot(taskId);
    if (!snapshot.manifest) {
      writeOperatorJsonResponse(res, 404, {
        error: "not_found",
        message: `Task ${taskId} not found.`
      });
      return;
    }

    const runSummaries = (
      await Promise.all(
        snapshot.pipelineRuns.map((run) => repository.getRunSummary(taskId, run.runId))
      )
    ).filter((summary): summary is NonNullable<typeof summary> => summary !== null);

    writeOperatorJsonResponse(res, 200, {
      manifest: snapshot.manifest,
      spec: snapshot.spec,
      policySnapshot: snapshot.policySnapshot,
      phaseRecords: snapshot.phaseRecords,
      approvalRequests: snapshot.approvalRequests,
      pipelineRuns: snapshot.pipelineRuns,
      runSummaries,
      evidenceTotal: snapshot.evidenceRecords.length,
      memoryRecords: snapshot.memoryRecords
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

    const onProjectFailed = taskFlowAdapter
      ? async (projectId: string, _ticketId: string) => {
          const flowMemory = await repository.listMemoryRecords({
            keyPrefix: `project.taskflow.flowId:${projectId}`
          });
          const flowId = flowMemory.length > 0
            ? (flowMemory[0]!.value as Record<string, unknown>)["flowId"] as string | null
            : null;
          if (flowId) {
            await taskFlowAdapter.cancelFlow(flowId, "Project failed — phase failure escalated.");
          }
        }
      : undefined;

    const result = await dispatchReadyTask(
      { taskId, targetRoot, evidenceRoot },
      { repository, ...dispatchDependencies, ...(onProjectFailed ? { onProjectFailed } : {}) }
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
    const retryExhaustedEntries: OperatorBlockedSummary["retryExhaustedEntries"] = [];

    for (const approval of pendingApprovals) {
      if (
        approval.requestedBy !== "failure-automation" ||
        (approval.phase !== "development" &&
          approval.phase !== "architecture_review" &&
          approval.phase !== "validation" &&
          approval.phase !== "scm")
      ) {
        continue;
      }

      const snapshot = await repository.getTaskSnapshot(approval.taskId);
      const retryState = readPhaseRetryBudgetState(snapshot, approval.phase);
      if (!retryState?.retryExhausted) {
        continue;
      }

      retryExhaustedEntries.push({
        approvalId: approval.requestId,
        taskId: approval.taskId,
        taskTitle: snapshot.manifest?.title ?? approval.taskId,
        runId: approval.runId,
        reason: "retry-budget-exhausted",
        phase: approval.phase,
        attempts: retryState.attempts,
        retryLimit: retryState.retryLimit,
        humanReadable: approval.summary,
        lastError: retryState.lastError,
        dryRun: approval.dryRun
      });
    }
    const summary: OperatorBlockedSummary = {
      blockedRuns,
      pendingApprovals,
      retryExhaustedEntries,
      totalBlockedRuns: blockedRuns.length,
      totalPendingApprovals: pendingApprovals.length
    };
    writeOperatorJsonResponse(res, 200, summary);
    return;
  }

  // ============================================================
  // Project Mode routes (Phase 3)
  // ============================================================

  // GET /projects — list projects with ticket counts
  if (method === "GET" && path === "/projects") {
    const repoFilter = typeof qp["repo"] === "string" ? qp["repo"] : undefined;
    const statusFilter = typeof qp["status"] === "string" ? qp["status"] : undefined;

    let projects = await repository.listProjectSpecs(repoFilter);
    if (statusFilter) {
      projects = projects.filter((p) => p.status === statusFilter);
    }

    const projectSummaries = await Promise.all(
      projects.map(async (project) => {
        const tickets = await repository.listTicketSpecs(project.projectId);
        return {
          ...project,
          ticketCounts: {
            total: tickets.length,
            pending: tickets.filter((t) => t.status === "pending").length,
            dispatched: tickets.filter((t) => t.status === "dispatched").length,
            in_progress: tickets.filter((t) => t.status === "in_progress").length,
            pr_open: tickets.filter((t) => t.status === "pr_open").length,
            merged: tickets.filter((t) => t.status === "merged").length,
            failed: tickets.filter((t) => t.status === "failed").length
          }
        };
      })
    );

    writeOperatorJsonResponse(res, 200, {
      projects: projectSummaries,
      total: projectSummaries.length
    });
    return;
  }

  // GET /projects/:id — full project with ticket children
  const projectDetailMatch = /^\/projects\/([^/]+)$/.exec(path);
  if (method === "GET" && projectDetailMatch) {
    const projectId = decodeURIComponent(projectDetailMatch[1]!);
    const project = await repository.getProjectSpec(projectId);
    if (!project) {
      writeOperatorJsonResponse(res, 404, {
        error: "not_found",
        message: `Project ${projectId} not found.`
      });
      return;
    }

    const tickets = await repository.listTicketSpecs(projectId);
    writeOperatorJsonResponse(res, 200, {
      project,
      tickets,
      ticketCounts: {
        total: tickets.length,
        pending: tickets.filter((t) => t.status === "pending").length,
        dispatched: tickets.filter((t) => t.status === "dispatched").length,
        in_progress: tickets.filter((t) => t.status === "in_progress").length,
        pr_open: tickets.filter((t) => t.status === "pr_open").length,
        merged: tickets.filter((t) => t.status === "merged").length,
        failed: tickets.filter((t) => t.status === "failed").length
      }
    });
    return;
  }

  // POST /projects/:id/approve — approve or amend a project plan
  const projectApproveMatch = /^\/projects\/([^/]+)\/approve$/.exec(path);
  if (method === "POST" && projectApproveMatch) {
    const projectId = decodeURIComponent(projectApproveMatch[1]!);
    const project = await repository.getProjectSpec(projectId);
    if (!project) {
      writeOperatorJsonResponse(res, 404, {
        error: "not_found",
        message: `Project ${projectId} not found.`
      });
      return;
    }

    const rawBody = await readOperatorJsonBody(req, maxRequestBodyBytes);
    if (
      !rawBody ||
      typeof rawBody !== "object" ||
      !("decision" in rawBody) ||
      !("decidedBy" in rawBody)
    ) {
      writeOperatorJsonResponse(res, 400, {
        error: "bad_request",
        message:
          "Request body must include { decision: 'approve' | 'amend', decidedBy: string, decisionSummary?: string, amendments?: string }."
      });
      return;
    }

    const body = rawBody as {
      decision: string;
      decidedBy: string;
      decisionSummary?: string;
      amendments?: string;
    };

    if (body.decision !== "approve" && body.decision !== "amend") {
      writeOperatorJsonResponse(res, 400, {
        error: "bad_request",
        message: "decision must be 'approve' or 'amend'."
      });
      return;
    }

    if (
      project.status !== "pending_approval" &&
      !(
        body.decision === "approve" &&
        (project.status === "approved" || project.status === "executing")
      )
    ) {
      writeOperatorJsonResponse(res, 409, {
        error: "conflict",
        message: `Project ${projectId} is in status '${project.status}' and cannot be approved. Only projects in 'pending_approval' status can be approved, unless an already-approved project is being resumed before any ticket dispatch or an executing project is backfilling missing GitHub sub-issues before any PR opens.`
      });
      return;
    }

    const now = clock().toISOString();

    if (body.decision === "approve") {
      if (project.status === "approved") {
        const tickets = await repository.listTicketSpecs(projectId);
        const resumable = tickets.every(
          (ticket) => ticket.status === "pending" && ticket.githubPrNumber === null
        );
        if (!resumable) {
          writeOperatorJsonResponse(res, 409, {
            error: "conflict",
            message: `Project ${projectId} is in status 'approved' but cannot be resumed because at least one ticket has already advanced beyond pending.`
          });
          return;
        }
      }
      if (project.status === "executing") {
        const tickets = await repository.listTicketSpecs(projectId);
        let hasDispatchedTicketWithoutTask = false;
        for (const ticket of tickets) {
          if (ticket.status !== "dispatched" || ticket.githubPrNumber !== null) {
            continue;
          }
          const taskId = createProjectTicketTaskId(ticket.ticketId);
          const snapshot = await repository.getTaskSnapshot(taskId);
          if (!snapshot.manifest) {
            hasDispatchedTicketWithoutTask = true;
            break;
          }
        }
        const backfillable = (
          tickets.length > 0 &&
          (
            tickets.some((ticket) => ticket.githubSubIssueNumber === null) ||
            hasDispatchedTicketWithoutTask
          ) &&
          tickets.some((ticket) => ticket.status !== "pending") &&
          tickets.every((ticket) => ticket.githubPrNumber === null)
        );
        if (!backfillable) {
          writeOperatorJsonResponse(res, 409, {
            error: "conflict",
            message: `Project ${projectId} is in status 'executing' but cannot be recovered because no GitHub sub-issues or dispatched child tasks are missing, or at least one ticket already has a PR.`
          });
          return;
        }
      }

      const result = await executeProjectApproval(
        {
          projectId,
          decidedBy: body.decidedBy,
          decisionSummary: body.decisionSummary
        },
        {
          repository,
          githubIssuesAdapter: githubIssuesAdapter ?? null,
          taskFlowAdapter: taskFlowAdapter ?? null,
          github: githubWriter ?? null,
          clock
        }
      );

      writeOperatorJsonResponse(res, 200, {
        project: result.project,
        tickets: result.tickets,
        subIssuesCreated: result.subIssuesCreated,
        subIssuesFallback: result.subIssuesFallback,
        dispatchedTicket: result.dispatchedTicket,
        dispatchedTaskId: result.dispatchedTaskId,
        dispatchedTaskCreated: result.dispatchedTaskCreated,
        message: result.subIssuesFallback
          ? "Project approved and executing (Postgres-only — GitHub sub-issues not created)."
          : `Project approved. ${result.subIssuesCreated} sub-issue(s) created. Executing.`
      });
      return;
    }

    // Amend decision — return project to draft for re-planning
    if (!body.amendments || body.amendments.trim().length === 0) {
      writeOperatorJsonResponse(res, 400, {
        error: "bad_request",
        message: "amendments text is required when decision is 'amend'."
      });
      return;
    }

    const existingAmendments = project.amendments
      ? `${project.amendments}\n\n---\n\n${body.amendments}`
      : body.amendments;

    const updatedProject = {
      ...project,
      status: "draft" as const,
      approvalDecision: "amend",
      decidedBy: body.decidedBy,
      decisionSummary: body.decisionSummary ?? null,
      amendments: existingAmendments,
      updatedAt: now
    };
    await repository.saveProjectSpec(updatedProject);

    // Invalidate any pending policy-gate approval before re-planning.
    const amendTaskId = projectId.startsWith("project:")
      ? projectId.slice("project:".length)
      : projectId;
    const amendPendingApprovals = await repository.listApprovalRequests({
      taskId: amendTaskId,
      statuses: ["pending"]
    });
    for (const approval of amendPendingApprovals) {
      if (approval.phase === "policy_gate") {
        await repository.saveApprovalRequest(
          createApprovalRequest({
            ...approval,
            status: "rejected",
            decidedBy: "system",
            decision: "reject",
            decisionSummary: "Superseded: project amended; re-planning required.",
            updatedAt: now,
            resolvedAt: now
          })
        );
      }
    }

    // Re-trigger the planning pipeline so Holly re-plans with amendments.
    const amendOpenClawDispatch = dispatchDependencies?.openClawDispatch;
    if (amendOpenClawDispatch && managedTargetRoot && planner) {
      const manifest = await repository.getManifest(amendTaskId);
      const planningSpec = await repository.getPlanningSpec(amendTaskId);
      if (manifest && planningSpec) {
        const replanInput: PlanningTaskInput = {
          source: manifest.source,
          title: manifest.title,
          summary: manifest.summary,
          priority: manifest.priority,
          dryRun: manifest.dryRun,
          labels: [],
          acceptanceCriteria: planningSpec.acceptanceCriteria,
          affectedPaths: planningSpec.affectedAreas,
          requestedCapabilities: manifest.requestedCapabilities,
          metadata: {
            replanReason: "project_amended",
            originalProjectId: projectId
          }
        };
        const classification = classifyComplexity(replanInput);
        try {
          const replanResult = await runPlanningPipeline(
            {
              ...replanInput,
              metadata: {
                ...replanInput.metadata,
                complexityClassification: classification
              }
            },
            {
              repository,
              planner,
              openClawDispatch: amendOpenClawDispatch,
              architectTargetRoot: managedTargetRoot,
              clock
            }
          );
          const replanProject = await repository.getProjectSpec(projectId);
          writeOperatorJsonResponse(res, 200, {
            project: replanProject ?? updatedProject,
            replanRunId: replanResult.runId,
            replanNextAction: replanResult.nextAction,
            message:
              "Project amended. Re-planning dispatched with amendments included in the planning context."
          });
        } catch (replanError) {
          writeOperatorJsonResponse(res, 200, {
            project: updatedProject,
            replanError: replanError instanceof Error ? replanError.message : String(replanError),
            message:
              "Project amended. Automatic re-planning failed; use POST /tasks/inject to retry."
          });
        }
        return;
      }
    }

    writeOperatorJsonResponse(res, 200, {
      project: updatedProject,
      message:
        "Project amended. Re-planning could not be triggered automatically — dispatch dependencies not available."
    });
    return;
  }

  // GET /projects/:id/clarifications — pending clarification questions
  const projectClarificationsMatch =
    /^\/projects\/([^/]+)\/clarifications$/.exec(path);
  if (method === "GET" && projectClarificationsMatch) {
    const projectId = decodeURIComponent(projectClarificationsMatch[1]!);
    const project = await repository.getProjectSpec(projectId);
    if (!project) {
      writeOperatorJsonResponse(res, 404, {
        error: "not_found",
        message: `Project ${projectId} not found.`
      });
      return;
    }

    const clarificationTimeoutMs = Number(
      process.env.REDDWARF_CLARIFICATION_TIMEOUT_MS ?? "1800000"
    );
    const timedOut =
      project.status === "clarification_pending" &&
      project.clarificationRequestedAt !== null &&
      clock().getTime() - new Date(project.clarificationRequestedAt).getTime() >
        clarificationTimeoutMs;

    writeOperatorJsonResponse(res, 200, {
      projectId: project.projectId,
      status: project.status,
      questions: project.clarificationQuestions ?? [],
      answers: project.clarificationAnswers ?? null,
      clarificationRequestedAt: project.clarificationRequestedAt,
      timeoutMs: clarificationTimeoutMs,
      timedOut
    });
    return;
  }

  // POST /projects/:id/clarify — submit clarification answers
  const projectClarifyMatch = /^\/projects\/([^/]+)\/clarify$/.exec(path);
  if (method === "POST" && projectClarifyMatch) {
    const projectId = decodeURIComponent(projectClarifyMatch[1]!);
    const project = await repository.getProjectSpec(projectId);
    if (!project) {
      writeOperatorJsonResponse(res, 404, {
        error: "not_found",
        message: `Project ${projectId} not found.`
      });
      return;
    }

    if (project.status !== "clarification_pending") {
      writeOperatorJsonResponse(res, 409, {
        error: "conflict",
        message: `Project ${projectId} is in status '${project.status}'. Clarification answers can only be submitted when status is 'clarification_pending'.`
      });
      return;
    }

    const rawBody = await readOperatorJsonBody(req, maxRequestBodyBytes);
    if (
      !rawBody ||
      typeof rawBody !== "object" ||
      !("answers" in rawBody) ||
      typeof (rawBody as Record<string, unknown>).answers !== "object"
    ) {
      writeOperatorJsonResponse(res, 400, {
        error: "bad_request",
        message:
          "Request body must include { answers: Record<string, string> }."
      });
      return;
    }

    const body = rawBody as { answers: Record<string, string> };

    // Validate that answers are non-empty and correspond to the pending questions
    const answerValues = Object.values(body.answers);
    if (answerValues.length === 0) {
      writeOperatorJsonResponse(res, 400, {
        error: "bad_request",
        message: "Answers must not be empty."
      });
      return;
    }
    if (answerValues.some((v) => typeof v !== "string" || v.trim().length === 0)) {
      writeOperatorJsonResponse(res, 400, {
        error: "bad_request",
        message: "All answer values must be non-empty strings."
      });
      return;
    }

    const now = clock().toISOString();

    const updatedProject = {
      ...project,
      status: "draft" as const,
      clarificationAnswers: body.answers,
      updatedAt: now
    };
    await repository.saveProjectSpec(updatedProject);

    // Invalidate any pending policy-gate approval for this task so it cannot be
    // resolved before re-planning completes.  The taskId is derived from the
    // projectId by stripping the "project:" prefix.
    const clarifyTaskId = projectId.startsWith("project:")
      ? projectId.slice("project:".length)
      : projectId;
    const pendingApprovals = await repository.listApprovalRequests({
      taskId: clarifyTaskId,
      statuses: ["pending"]
    });
    for (const approval of pendingApprovals) {
      if (approval.phase === "policy_gate") {
        await repository.saveApprovalRequest(
          createApprovalRequest({
            ...approval,
            status: "rejected",
            decidedBy: "system",
            decision: "reject",
            decisionSummary: "Superseded: clarification answers submitted; re-planning required.",
            updatedAt: now,
            resolvedAt: now
          })
        );
      }
    }

    // Re-trigger the planning pipeline so Holly runs again with clarification
    // answers included in the prompt context.  Project-mode re-planning
    // requires OpenClaw dispatch; skip automatic re-trigger when unavailable.
    const replanOpenClawDispatch = dispatchDependencies?.openClawDispatch;
    if (replanOpenClawDispatch && managedTargetRoot && planner) {
      const manifest = await repository.getManifest(clarifyTaskId);
      const planningSpec = await repository.getPlanningSpec(clarifyTaskId);
      if (manifest && planningSpec) {
        const replanInput: PlanningTaskInput = {
          source: manifest.source,
          title: manifest.title,
          summary: manifest.summary,
          priority: manifest.priority,
          dryRun: manifest.dryRun,
          labels: [],
          acceptanceCriteria: planningSpec.acceptanceCriteria,
          affectedPaths: planningSpec.affectedAreas,
          requestedCapabilities: manifest.requestedCapabilities,
          metadata: {
            replanReason: "clarification_answers_submitted",
            originalProjectId: projectId
          }
        };
        const classification = classifyComplexity(replanInput);
        try {
          const replanResult = await runPlanningPipeline(
            {
              ...replanInput,
              metadata: {
                ...replanInput.metadata,
                complexityClassification: classification
              }
            },
            {
              repository,
              planner,
              openClawDispatch: replanOpenClawDispatch,
              architectTargetRoot: managedTargetRoot,
              clock
            }
          );
          // Return the latest project state after re-planning (may have
          // transitioned to pending_approval or back to clarification_pending).
          const replanProject = await repository.getProjectSpec(projectId);
          writeOperatorJsonResponse(res, 200, {
            project: replanProject ?? updatedProject,
            replanRunId: replanResult.runId,
            replanNextAction: replanResult.nextAction,
            message:
              "Clarification answers recorded. Re-planning dispatched with answers included in the planning context."
          });
        } catch (replanError) {
          // Re-planning failed — still return success for the clarification submission
          // but include the error so the operator knows re-planning needs manual retry.
          writeOperatorJsonResponse(res, 200, {
            project: updatedProject,
            replanError: replanError instanceof Error ? replanError.message : String(replanError),
            message:
              "Clarification answers recorded. Automatic re-planning failed; use POST /tasks/inject to retry."
          });
        }
        return;
      }
    }

    writeOperatorJsonResponse(res, 200, {
      project: updatedProject,
      message:
        "Clarification answers recorded. Project returned to draft. Re-planning could not be triggered automatically — dispatch dependencies not available."
    });
    return;
  }

  // POST /projects/advance — advance ticket queue after PR merge
  if (method === "POST" && path === "/projects/advance") {
    const rawBody = await readOperatorJsonBody(req, maxRequestBodyBytes);
    if (
      !rawBody ||
      typeof rawBody !== "object" ||
      !("ticket_id" in rawBody) ||
      !("github_pr_number" in rawBody)
    ) {
      writeOperatorJsonResponse(res, 400, {
        error: "bad_request",
        message:
          "Request body must include { ticket_id: string, github_pr_number: number }."
      });
      return;
    }

    const body = rawBody as { ticket_id: string; github_pr_number: number };

    if (typeof body.ticket_id !== "string" || body.ticket_id.length === 0) {
      writeOperatorJsonResponse(res, 400, {
        error: "bad_request",
        message: "ticket_id must be a non-empty string."
      });
      return;
    }

    if (
      typeof body.github_pr_number !== "number" ||
      !Number.isInteger(body.github_pr_number) ||
      body.github_pr_number <= 0
    ) {
      writeOperatorJsonResponse(res, 400, {
        error: "bad_request",
        message: "github_pr_number must be a positive integer."
      });
      return;
    }

    try {
      const result = await advanceProjectTicket(
        {
          ticketId: body.ticket_id,
          githubPrNumber: body.github_pr_number
        },
        {
          repository,
          githubIssuesAdapter: githubIssuesAdapter ?? null,
          taskFlowAdapter: taskFlowAdapter ?? null,
          clock
        }
      );

      const statusCode = result.outcome === "already_merged" ? 200 : 200;
      writeOperatorJsonResponse(res, statusCode, {
        outcome: result.outcome,
        ticket: result.ticket,
        project: result.project,
        nextDispatchedTicket: result.nextDispatchedTicket,
        nextDispatchedTaskId: result.nextDispatchedTaskId,
        nextDispatchedTaskCreated: result.nextDispatchedTaskCreated,
        message:
          result.outcome === "already_merged"
            ? `Ticket ${body.ticket_id} is already merged. No state change.`
            : result.outcome === "completed"
              ? `Ticket ${body.ticket_id} merged. All tickets complete. Project marked as complete.`
              : result.nextDispatchedTicket
                ? `Ticket ${body.ticket_id} merged. Next ticket ${result.nextDispatchedTicket.ticketId} dispatched.`
                : `Ticket ${body.ticket_id} merged. No next ticket ready.`
      });
      return;
    } catch (err) {
      if (err instanceof Error && err.message.includes("not found")) {
        writeOperatorJsonResponse(res, 404, {
          error: "not_found",
          message: err.message
        });
        return;
      }
      if (
        err instanceof Error &&
        (err.message.includes("cannot advance ticket") ||
          err.message.includes("cannot be advanced from a PR merge callback"))
      ) {
        writeOperatorJsonResponse(res, 409, {
          error: "conflict",
          message: err.message
        });
        return;
      }
      throw err;
    }
  }

  // ── Feature 152: Plugin approval hook endpoints ─────────────────────────────

  // GET /sessions/policy?sessionKey=<key>
  // Returns the policy snapshot for the active task whose session key matches.
  // Used by the reddwarf-operator before_tool_call hook to check allowed/denied paths.
  if (method === "GET" && path === "/sessions/policy") {
    const rawKey = typeof qp["sessionKey"] === "string" ? qp["sessionKey"] : "";
    const normalizedKey = normalizeOpenClawSessionKey(rawKey);
    if (!normalizedKey) {
      writeOperatorJsonResponse(res, 400, {
        error: "bad_request",
        message: "sessionKey query parameter is required."
      });
      return;
    }
    const activeManifests = await repository.listManifestsByLifecycleStatus("active", 50);
    const matched = activeManifests.find(
      (m) => normalizeOpenClawSessionKey(buildOpenClawIssueSessionKeyFromManifest(m)) === normalizedKey
    );
    if (!matched) {
      writeOperatorJsonResponse(res, 404, {
        error: "not_found",
        message: "No active task found for the given session key."
      });
      return;
    }
    const policySnapshot = await repository.getPolicySnapshot(matched.taskId);
    writeOperatorJsonResponse(res, 200, {
      taskId: matched.taskId,
      sessionKey: normalizedKey,
      policySnapshot
    });
    return;
  }

  // GET /tool-approvals — list tool approval requests (Feature 152)
  if (method === "GET" && path === "/tool-approvals") {
    const statusFilter = typeof qp["status"] === "string" ? qp["status"] : undefined;
    const store = toolApprovals ?? new Map<string, ToolApprovalRequest>();
    const items = Array.from(store.values()).filter(
      (a) => !statusFilter || a.status === statusFilter
    );
    writeOperatorJsonResponse(res, 200, { toolApprovals: items, total: items.length });
    return;
  }

  // GET /tool-approvals/:id — get a single tool approval by ID (Feature 164)
  const toolApprovalByIdMatch = /^\/tool-approvals\/([^/]+)$/.exec(path);
  if (method === "GET" && toolApprovalByIdMatch) {
    const approvalId = decodeURIComponent(toolApprovalByIdMatch[1]!);
    const store = toolApprovals ?? new Map<string, ToolApprovalRequest>();
    const approval = store.get(approvalId);
    if (!approval) {
      writeOperatorJsonResponse(res, 404, {
        error: "not_found",
        message: `Tool approval ${approvalId} not found.`
      });
      return;
    }
    writeOperatorJsonResponse(res, 200, { toolApproval: approval });
    return;
  }

  // POST /tool-approvals — create a pending tool approval request (Feature 152)
  if (method === "POST" && path === "/tool-approvals") {
    const parsed = (await readOperatorJsonBody(req, maxRequestBodyBytes)) as Record<string, unknown> | null ?? {};
    const sessionKey = typeof parsed.sessionKey === "string" ? parsed.sessionKey.trim() : "";
    const toolName = typeof parsed.toolName === "string" ? parsed.toolName.trim() : "";
    const targetPath = typeof parsed.targetPath === "string" ? parsed.targetPath : null;
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "requires approval";
    const taskId = typeof parsed.taskId === "string" ? parsed.taskId : null;
    if (!sessionKey || !toolName) {
      writeOperatorJsonResponse(res, 400, {
        error: "bad_request",
        message: "sessionKey and toolName are required."
      });
      return;
    }
    const store = toolApprovals ?? new Map<string, ToolApprovalRequest>();
    const id = randomUUID();
    const approval: ToolApprovalRequest = {
      id,
      sessionKey,
      taskId,
      toolName,
      targetPath,
      reason,
      status: "pending",
      decidedBy: null,
      decidedAt: null,
      requestedAt: clock().toISOString()
    };
    store.set(id, approval);
    await createDiscordNotifier().notifyApprovalCreated({
      kind: "tool",
      approval
    });
    writeOperatorJsonResponse(res, 201, { toolApproval: approval });
    return;
  }

  // POST /tool-approvals/:id/decide — approve or deny a tool approval (Feature 152)
  const toolApprovalDecideMatch = /^\/tool-approvals\/([^/]+)\/decide$/.exec(path);
  if (method === "POST" && toolApprovalDecideMatch) {
    const approvalId = decodeURIComponent(toolApprovalDecideMatch[1]!);
    const store = toolApprovals ?? new Map<string, ToolApprovalRequest>();
    const approval = store.get(approvalId);
    if (!approval) {
      writeOperatorJsonResponse(res, 404, {
        error: "not_found",
        message: `Tool approval ${approvalId} not found.`
      });
      return;
    }
    if (approval.status !== "pending") {
      writeOperatorJsonResponse(res, 409, {
        error: "conflict",
        message: `Tool approval ${approvalId} is already ${approval.status}.`
      });
      return;
    }
    const parsedDecide = (await readOperatorJsonBody(req, maxRequestBodyBytes)) as Record<string, unknown> | null ?? {};
    const decision = parsedDecide.decision === "deny" ? "denied" : "approved";
    const decidedBy = typeof parsedDecide.decidedBy === "string" ? parsedDecide.decidedBy : "operator";
    approval.status = decision;
    approval.decidedBy = decidedBy;
    approval.decidedAt = clock().toISOString();
    store.set(approvalId, approval);
    writeOperatorJsonResponse(res, 200, { toolApproval: approval });
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
    ...(input.proposedSubTasks && input.proposedSubTasks.length > 0
      ? { proposedSubTasks: input.proposedSubTasks }
      : {}),
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

// ── Downstream health probe factories (R-07) ──────────────────────────────

const DOWNSTREAM_PROBE_TIMEOUT_MS = 5_000;
const DOWNSTREAM_PROBE_CACHE_TTL_MS = 15_000;

function createCachedProbe(probe: DownstreamHealthProbe): DownstreamHealthProbe {
  let cached: DownstreamHealthProbeResult | null = null;
  let cachedAt = 0;
  return {
    name: probe.name,
    async probe(): Promise<DownstreamHealthProbeResult> {
      const now = Date.now();
      if (cached && now - cachedAt < DOWNSTREAM_PROBE_CACHE_TTL_MS) {
        return cached;
      }
      cached = await probe.probe();
      cachedAt = now;
      return cached;
    }
  };
}

/** Strip trailing slashes without a regex quantifier that can backtrack
 *  on strings of many forward slashes (CodeQL: polynomial-redos). */
function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") {
    end--;
  }
  return url.slice(0, end);
}

export function createOpenClawHealthProbe(baseUrl: string): DownstreamHealthProbe {
  const cleanBaseUrl = stripTrailingSlashes(baseUrl);
  return createCachedProbe({
    name: "openclaw",
    async probe(): Promise<DownstreamHealthProbeResult> {
      const start = Date.now();
      try {
        const response = await fetch(`${cleanBaseUrl}/health`, {
          signal: AbortSignal.timeout(DOWNSTREAM_PROBE_TIMEOUT_MS)
        });
        const latencyMs = Date.now() - start;
        return {
          name: "openclaw",
          status: response.ok ? "ok" : "degraded",
          latencyMs,
          error: response.ok ? null : `HTTP ${response.status}`,
          checkedAt: new Date().toISOString()
        };
      } catch (err) {
        return {
          name: "openclaw",
          status: "unreachable",
          latencyMs: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
          checkedAt: new Date().toISOString()
        };
      }
    }
  });
}

export function createGitHubHealthProbe(token: string, baseUrl = "https://api.github.com"): DownstreamHealthProbe {
  return createCachedProbe({
    name: "github",
    async probe(): Promise<DownstreamHealthProbeResult> {
      const start = Date.now();
      try {
        const response = await fetch(`${baseUrl}/rate_limit`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "reddwarf/0.1.0"
          },
          signal: AbortSignal.timeout(DOWNSTREAM_PROBE_TIMEOUT_MS)
        });
        const latencyMs = Date.now() - start;
        return {
          name: "github",
          status: response.ok ? "ok" : "degraded",
          latencyMs,
          error: response.ok ? null : `HTTP ${response.status}`,
          checkedAt: new Date().toISOString()
        };
      } catch (err) {
        return {
          name: "github",
          status: "unreachable",
          latencyMs: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
          checkedAt: new Date().toISOString()
        };
      }
    }
  });
}
