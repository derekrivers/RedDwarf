import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRequestStatus,
  Capability,
  EvidenceRecord,
  PipelineRun
} from "@reddwarf/contracts";
import type {
  ApprovalListFilters,
  ApprovalListResponse,
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
    getTask(taskId: string) {
      return request<TaskDetailResponse>(`/tasks/${encodeURIComponent(taskId)}`);
    },
    resolveApproval(
      id: string,
      decision: ApprovalDecision,
      decisionSummary: string
    ) {
      return request<ResolveApprovalResponse>(
        `/approvals/${encodeURIComponent(id)}/resolve`,
        {
          method: "POST",
          body: JSON.stringify({
            decision,
            decidedBy: "operator",
            decisionSummary
          })
        }
      );
    },
    getRepos() {
      return request<ReposResponse>("/repos");
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
    }
  };
}

export function getPendingApprovalCount(
  approvals: Array<{ status: ApprovalRequestStatus }>
): number {
  return approvals.filter((approval) => approval.status === "pending").length;
}
