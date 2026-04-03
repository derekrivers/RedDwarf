import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRequestStatus,
  EvidenceRecord,
  PipelineRun
} from "@reddwarf/contracts";

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

interface ApiClientOptions {
  baseUrl?: string;
  token: string;
  onUnauthorized: () => void;
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

export function createApiClient(options: ApiClientOptions) {
  const baseUrl = options.baseUrl ?? "/api";

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${options.token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers
      }
    });

    if (response.status === 401) {
      options.onUnauthorized();
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
    getApproval(id: string) {
      return request<ApprovalResponse>(`/approvals/${encodeURIComponent(id)}`);
    },
    getEvidenceForRun(runId: string) {
      return request<RunEvidenceResponse>(`/runs/${encodeURIComponent(runId)}/evidence`);
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
    }
  };
}

export function getPendingApprovalCount(
  approvals: Array<{ status: ApprovalRequestStatus }>
): number {
  return approvals.filter((approval) => approval.status === "pending").length;
}
