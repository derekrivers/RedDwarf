import type {
  ApprovalRequest,
  ApprovalRequestStatus,
  PipelineRun
} from "@reddwarf/contracts";
import type {
  ApprovalResponse,
  BlockedApprovalsResponse,
  HealthResponse,
  PipelineRunsResponse,
  RunEvidenceResponse,
  ResolveApprovalResponse
} from "../api/client";

export interface ApprovalListResponse {
  approvals: ApprovalRequest[];
  total: number;
}

export interface ApprovalListFilters {
  statuses?: ApprovalRequestStatus[];
  taskId?: string;
  runId?: string;
  limit?: number;
}

export interface TaskDetailResponse {
  manifest: {
    taskId: string;
    title: string;
    source: {
      provider: "github";
      repo: string;
      issueId?: number;
      issueNumber?: number;
    };
  };
}

export interface DashboardApiClient {
  getHealth(): Promise<HealthResponse>;
  getPipelineRuns(filters?: {
    repo?: string;
    taskId?: string;
    limit?: number;
    statuses?: PipelineRun["status"][];
  }): Promise<PipelineRunsResponse>;
  getBlockedApprovals(): Promise<BlockedApprovalsResponse>;
  listApprovals(filters?: ApprovalListFilters): Promise<ApprovalListResponse>;
  getApproval(id: string): Promise<ApprovalResponse>;
  getEvidenceForRun(runId: string): Promise<RunEvidenceResponse>;
  getTask(taskId: string): Promise<TaskDetailResponse>;
  resolveApproval(
    id: string,
    decision: "approve" | "reject",
    decisionSummary: string
  ): Promise<ResolveApprovalResponse>;
}
