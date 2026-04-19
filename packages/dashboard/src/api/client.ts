import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRequestStatus,
  Capability,
  EvidenceRecord,
  PipelineRun
} from "@reddwarf/contracts";
import type {
  AgentQualityMetricsFilters,
  AgentQualityMetricsResponse,
  ApprovalListFilters,
  ApprovalListResponse,
  AuditExportFilters,
  AuditExportResponse,
  DashboardApiClient,
  ProjectApproveResponse,
  ProjectClarificationsResponse,
  ProjectClarifyResponse,
  ProjectDetailResponse,
  ProjectListFilters,
  ProjectListResponse,
  RunDetailResponse,
  TaskDetailResponse
} from "../types/dashboard";
import { clearOperatorToken, readOperatorToken } from "../lib/session";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface HealthResponse {
  status: "ok";
  repository: {
    status: "healthy" | "degraded";
  };
  polling: {
    status: "idle" | "healthy" | "degraded";
  };
}

export interface PipelineRunFilters {
  repo?: string;
  taskId?: string;
  limit?: number;
  statuses?: PipelineRun["status"][];
}

export interface PipelineRunsResponse {
  runs: PipelineRun[];
  total: number;
}

export interface CancelRunResponse {
  run: PipelineRun;
}

export interface BlockedApprovalsResponse {
  blockedRuns: PipelineRun[];
  pendingApprovals: ApprovalRequest[];
  retryExhaustedEntries: Array<{
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
  }>;
  totalBlockedRuns: number;
  totalPendingApprovals: number;
}

export interface ApprovalResponse {
  approval: ApprovalRequest;
}

export interface RunEvidenceResponse {
  runId: string;
  taskId: string;
  evidenceRecords: EvidenceRecord[];
  total: number;
}

export interface ResolveApprovalResponse {
  approval: ApprovalRequest;
  manifest: {
    taskId: string;
  };
}

export interface ReposResponse {
  repos: Array<{ repo: string }>;
  total: number;
}

export interface RepoMutationResponse {
  repo: { repo: string };
  created: boolean;
}

export interface RepoDeleteResponse {
  repo: string;
  deleted: true;
}

export interface GitHubRepoSummary {
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  updatedAt: string | null;
  language: string | null;
  archived: boolean;
}

export interface GitHubReposResponse {
  repos: GitHubRepoSummary[];
  total: number;
}

export interface SubmitIssueRequest {
  repo: string;
  title: string;
  summary: string;
  acceptanceCriteria: string[];
  affectedPaths: string[];
  constraints: string[];
  labels: string[];
  requestedCapabilities: Capability[];
  riskClassHint?: "low" | "medium" | "high";
}

export interface SubmitIssueResponse {
  issueNumber: number;
  issueUrl: string;
  repo: string;
}

export interface OpenClawPendingPairingRequest {
  requestId: string;
  role: string;
}

export interface OpenClawPairingStatusResponse {
  pending: OpenClawPendingPairingRequest[];
  totalPending: number;
  rawOutput: string;
}

export interface OpenClawFixPairingResponse {
  approved: OpenClawPendingPairingRequest[];
  approvedCount: number;
  alreadyClean: boolean;
  message: string;
  rawOutput: string;
}

export type OpenClawModelProvider = "anthropic" | "openai" | "openai-codex";

export interface OpenClawModelProviderResponse {
  provider: OpenClawModelProvider;
  requiresRestart: boolean;
  message: string;
  rawOutput: string;
}

export interface OpenClawCodexAuthStatusResponse {
  signedIn: boolean;
  oauthProviderCount: number;
  currentProvider: OpenClawModelProvider | null;
  roleBindings: Record<string, string> | null;
  rawOutput: string;
}

export interface OpenClawCodexLoginInputResponse {
  accepted: boolean;
}

/**
 * One frame from the NDJSON stream served by
 * GET /openclaw/codex-login/stream. The stream is consumed via fetch() with
 * a ReadableStream reader in the embedded terminal component.
 */
export type OpenClawCodexLoginStreamFrame =
  | { type: "session"; sessionId: string }
  | { type: "data"; data: string }
  | { type: "exit"; code: number | null }
  | { type: "error"; message: string };

export interface OpenClawRestartResponse {
  restarted: true;
  message: string;
  rawOutput: string;
}

interface ApiClientOptions {
  baseUrl?: string;
  token?: string;
  onUnauthorized?: () => void;
}

function buildQueryString(params: Record<string, string | number | string[] | undefined>): string {
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => searchParams.append(key, item));
      continue;
    }

    searchParams.set(key, String(value));
  }

  const queryString = searchParams.toString();
  return queryString ? `?${queryString}` : "";
}

export function createApiClient(options: ApiClientOptions): DashboardApiClient {
  const baseUrl = options.baseUrl ?? "/api";

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = options.token ?? readOperatorToken();
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers
      }
    });

    if (response.status === 401) {
      clearOperatorToken();
      if (options.onUnauthorized) {
        options.onUnauthorized();
      } else {
        window.location.assign("/");
      }
      throw new ApiError(401, "Operator token is no longer valid.");
    }

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as
        | { message?: string }
        | null;
      throw new ApiError(
        response.status,
        payload?.message ?? `Request failed with status ${response.status}.`
      );
    }

    return (await response.json()) as T;
  }

  return {
    getHealth() {
      return request<HealthResponse>("/health");
    },
    getPipelineRuns(filters: PipelineRunFilters = {}) {
      return request<PipelineRunsResponse>(
        `/runs${buildQueryString({
          ...(filters.repo !== undefined ? { repo: filters.repo } : {}),
          ...(filters.taskId !== undefined ? { taskId: filters.taskId } : {}),
          ...(filters.limit !== undefined ? { limit: filters.limit } : {}),
          ...(filters.statuses !== undefined ? { statuses: filters.statuses } : {})
        })}`
      );
    },
    getBlockedApprovals() {
      return request<BlockedApprovalsResponse>("/blocked");
    },
    listApprovals(filters: ApprovalListFilters = {}) {
      return request<ApprovalListResponse>(
        `/approvals${buildQueryString({
          ...(filters.taskId !== undefined ? { taskId: filters.taskId } : {}),
          ...(filters.runId !== undefined ? { runId: filters.runId } : {}),
          ...(filters.limit !== undefined ? { limit: filters.limit } : {}),
          ...(filters.statuses !== undefined ? { statuses: filters.statuses } : {})
        })}`
      );
    },
    getApproval(id: string) {
      return request<ApprovalResponse>(`/approvals/${encodeURIComponent(id)}`);
    },
    getEvidenceForRun(runId: string) {
      return request<RunEvidenceResponse>(`/runs/${encodeURIComponent(runId)}/evidence`);
    },
    getRunDetail(runId: string) {
      return request<RunDetailResponse>(`/runs/${encodeURIComponent(runId)}`);
    },
    cancelRun(runId: string) {
      return request<CancelRunResponse>(
        `/runs/${encodeURIComponent(runId)}/cancel`,
        { method: "POST" }
      );
    },
    getTask(taskId: string) {
      return request<TaskDetailResponse>(`/tasks/${encodeURIComponent(taskId)}`);
    },
    resolveApproval(
      id: string,
      decision: ApprovalDecision,
      decisionSummary: string,
      comment?: string
    ) {
      return request<ResolveApprovalResponse>(
        `/approvals/${encodeURIComponent(id)}/resolve`,
        {
          method: "POST",
          body: JSON.stringify({
            decision,
            decidedBy: "operator",
            decisionSummary,
            ...(comment ? { comment } : {})
          })
        }
      );
    },
    getRepos() {
      return request<ReposResponse>("/repos");
    },
    addRepo(repo: string) {
      return request<RepoMutationResponse>("/repos", {
        method: "POST",
        body: JSON.stringify({ repo })
      });
    },
    removeRepo(owner: string, repo: string) {
      return request<RepoDeleteResponse>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        { method: "DELETE" }
      );
    },
    listGitHubUserRepos(options?: { page?: number; perPage?: number; q?: string }) {
      const params = new URLSearchParams();
      if (options?.page) params.set("page", String(options.page));
      if (options?.perPage) params.set("per_page", String(options.perPage));
      if (options?.q) params.set("q", options.q);
      const qs = params.toString();
      return request<GitHubReposResponse>(`/repos/github${qs ? `?${qs}` : ""}`);
    },
    submitIssue(req: SubmitIssueRequest) {
      return request<SubmitIssueResponse>("/issues/submit", {
        method: "POST",
        body: JSON.stringify(req)
      });
    },
    getProjects(filters: ProjectListFilters = {}) {
      return request<ProjectListResponse>(
        `/projects${buildQueryString({
          ...(filters.repo !== undefined ? { repo: filters.repo } : {}),
          ...(filters.status !== undefined ? { status: filters.status } : {})
        })}`
      );
    },
    getProject(id: string) {
      return request<ProjectDetailResponse>(
        `/projects/${encodeURIComponent(id)}`
      );
    },
    approveProject(
      id: string,
      decision: "approve" | "amend",
      decidedBy: string,
      decisionSummary?: string,
      amendments?: string
    ) {
      return request<ProjectApproveResponse>(
        `/projects/${encodeURIComponent(id)}/approve`,
        {
          method: "POST",
          body: JSON.stringify({
            decision,
            decidedBy,
            ...(decisionSummary ? { decisionSummary } : {}),
            ...(amendments ? { amendments } : {})
          })
        }
      );
    },
    getClarifications(id: string) {
      return request<ProjectClarificationsResponse>(
        `/projects/${encodeURIComponent(id)}/clarifications`
      );
    },
    submitClarifications(id: string, answers: Record<string, string>) {
      return request<ProjectClarifyResponse>(
        `/projects/${encodeURIComponent(id)}/clarify`,
        {
          method: "POST",
          body: JSON.stringify({ answers })
        }
      );
    },
    getOpenClawPairingStatus() {
      return request<OpenClawPairingStatusResponse>("/openclaw/pairing-status");
    },
    fixOpenClawPairing() {
      return request<OpenClawFixPairingResponse>("/openclaw/fix-pairing", {
        method: "POST"
      });
    },
    setOpenClawModelProvider(provider: OpenClawModelProvider) {
      return request<OpenClawModelProviderResponse>("/openclaw/model-provider", {
        method: "POST",
        body: JSON.stringify({ provider })
      });
    },
    getOpenClawCodexStatus() {
      return request<OpenClawCodexAuthStatusResponse>("/openclaw/codex-status");
    },
    sendOpenClawCodexLoginInput(sessionId: string, data: string) {
      return request<OpenClawCodexLoginInputResponse>(
        "/openclaw/codex-login/input",
        {
          method: "POST",
          body: JSON.stringify({ sessionId, data })
        }
      );
    },
    restartOpenClaw() {
      return request<OpenClawRestartResponse>("/openclaw/restart", {
        method: "POST"
      });
    },
    getAuditExport(filters: AuditExportFilters = {}) {
      return request<AuditExportResponse>(
        `/audit/export${buildQueryString({
          ...(filters.since !== undefined ? { since: filters.since } : {}),
          ...(filters.until !== undefined ? { until: filters.until } : {}),
          ...(filters.repo !== undefined ? { repo: filters.repo } : {})
        })}`
      );
    },
    buildAuditCsvUrl(filters: AuditExportFilters = {}) {
      return `${baseUrl}/audit/export${buildQueryString({
        format: "csv",
        ...(filters.since !== undefined ? { since: filters.since } : {}),
        ...(filters.until !== undefined ? { until: filters.until } : {}),
        ...(filters.repo !== undefined ? { repo: filters.repo } : {})
      })}`;
    },
    getAgentQualityMetrics(filters: AgentQualityMetricsFilters = {}) {
      return request<AgentQualityMetricsResponse>(
        `/metrics/agents${buildQueryString({
          ...(filters.since !== undefined ? { since: filters.since } : {}),
          ...(filters.until !== undefined ? { until: filters.until } : {})
        })}`
      );
    }
  };
}

export function getPendingApprovalCount(
  approvals: Array<{ status: ApprovalRequestStatus }>
): number {
  return approvals.filter((approval) => approval.status === "pending").length;
}

/**
 * Open a long-lived NDJSON stream that drives the embedded Codex login
 * terminal. Yields one parsed frame at a time until the connection closes
 * or the caller aborts via `signal`. The first frame carries the sessionId
 * the caller must pass back to `sendOpenClawCodexLoginInput` to forward
 * keystrokes to the container CLI.
 */
export async function* openOpenClawCodexLoginStream(
  signal: AbortSignal,
  baseUrl = "/api"
): AsyncGenerator<OpenClawCodexLoginStreamFrame, void, unknown> {
  const token = readOperatorToken();
  const response = await fetch(`${baseUrl}/openclaw/codex-login/stream`, {
    method: "GET",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: "application/x-ndjson"
    },
    signal
  });

  if (response.status === 401) {
    clearOperatorToken();
    throw new ApiError(401, "Operator token is no longer valid.");
  }
  if (!response.ok || !response.body) {
    const payload = (await response.json().catch(() => null)) as
      | { message?: string }
      | null;
    throw new ApiError(
      response.status,
      payload?.message ?? `Codex login stream failed with status ${response.status}.`
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx >= 0) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line.length > 0) {
          try {
            yield JSON.parse(line) as OpenClawCodexLoginStreamFrame;
          } catch {
            // Skip malformed frames rather than killing the whole stream.
          }
        }
        newlineIdx = buffer.indexOf("\n");
      }
    }
    const trailing = buffer.trim();
    if (trailing.length > 0) {
      try {
        yield JSON.parse(trailing) as OpenClawCodexLoginStreamFrame;
      } catch {
        // ignore
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}
