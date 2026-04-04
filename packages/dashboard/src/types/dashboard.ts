import type {
  ApprovalRequest,
  ApprovalRequestStatus,
  MemoryRecord,
  PhaseRecord,
  RunEvent,
  PipelineRun,
  PlanningSpec,
  PolicySnapshot,
  TaskManifest,
  RunSummary
} from "@reddwarf/contracts";
import type {
  ApprovalResponse,
  BlockedApprovalsResponse,
  HealthResponse,
  PipelineRunsResponse,
  ReposResponse,
  RunEvidenceResponse,
  ResolveApprovalResponse,
  SubmitIssueRequest,
  SubmitIssueResponse
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
  manifest: TaskManifest;
  spec: PlanningSpec | null;
  policySnapshot: PolicySnapshot | null;
  phaseRecords: PhaseRecord[];
  approvalRequests: ApprovalRequest[];
  pipelineRuns: PipelineRun[];
  runSummaries: RunSummary[];
  evidenceTotal: number;
  memoryRecords: MemoryRecord[];
}

export interface RunDetailResponse {
  run: PipelineRun;
  summary: RunSummary | null;
  events: RunEvent[];
  totalEvents: number;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
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
  getRunDetail(runId: string): Promise<RunDetailResponse>;
  getTask(taskId: string): Promise<TaskDetailResponse>;
  resolveApproval(
    id: string,
    decision: "approve" | "reject",
    decisionSummary: string
  ): Promise<ResolveApprovalResponse>;
  getRepos(): Promise<ReposResponse>;
  submitIssue(req: SubmitIssueRequest): Promise<SubmitIssueResponse>;
}
