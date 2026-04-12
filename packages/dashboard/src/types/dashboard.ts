import type {
  ApprovalRequest,
  ApprovalRequestStatus,
  MemoryRecord,
  PhaseRecord,
  ProjectSpec,
  ProjectStatus,
  RunEvent,
  PipelineRun,
  PlanningSpec,
  PolicySnapshot,
  TaskManifest,
  RunSummary,
  TicketSpec
} from "@reddwarf/contracts";
import type {
  ApprovalResponse,
  BlockedApprovalsResponse,
  CancelRunResponse,
  GitHubReposResponse,
  HealthResponse,
  OpenClawCodexAuthStatusResponse,
  OpenClawCodexLoginInputResponse,
  OpenClawFixPairingResponse,
  OpenClawModelProvider,
  OpenClawModelProviderResponse,
  OpenClawPairingStatusResponse,
  OpenClawRestartResponse,
  PipelineRunsResponse,
  RepoDeleteResponse,
  RepoMutationResponse,
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

export interface TicketCounts {
  total: number;
  pending: number;
  dispatched: number;
  in_progress: number;
  pr_open: number;
  merged: number;
  failed: number;
}

export interface ProjectSummary extends ProjectSpec {
  ticketCounts: TicketCounts;
}

export interface ProjectListFilters {
  repo?: string;
  status?: ProjectStatus;
}

export interface ProjectListResponse {
  projects: ProjectSummary[];
  total: number;
}

export interface ProjectDetailResponse {
  project: ProjectSpec;
  tickets: TicketSpec[];
  ticketCounts: TicketCounts;
}

export interface ProjectApproveResponse {
  project: ProjectSpec;
  tickets?: TicketSpec[];
  subIssuesCreated?: number;
  subIssuesFallback?: boolean;
  dispatchedTicket?: TicketSpec | null;
  message: string;
}

export interface ProjectClarificationsResponse {
  projectId: string;
  status: string;
  questions: string[];
  answers: Record<string, string> | null;
  clarificationRequestedAt: string | null;
  timeoutMs: number;
  timedOut: boolean;
}

export interface ProjectClarifyResponse {
  project: ProjectSpec;
  message: string;
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
  cancelRun(runId: string): Promise<CancelRunResponse>;
  getTask(taskId: string): Promise<TaskDetailResponse>;
  resolveApproval(
    id: string,
    decision: "approve" | "reject" | "rework",
    decisionSummary: string,
    comment?: string
  ): Promise<ResolveApprovalResponse>;
  getRepos(): Promise<ReposResponse>;
  addRepo(repo: string): Promise<RepoMutationResponse>;
  removeRepo(owner: string, repo: string): Promise<RepoDeleteResponse>;
  listGitHubUserRepos(options?: { page?: number; perPage?: number; q?: string }): Promise<GitHubReposResponse>;
  submitIssue(req: SubmitIssueRequest): Promise<SubmitIssueResponse>;
  getProjects(filters?: ProjectListFilters): Promise<ProjectListResponse>;
  getProject(id: string): Promise<ProjectDetailResponse>;
  approveProject(
    id: string,
    decision: "approve" | "amend",
    decidedBy: string,
    decisionSummary?: string,
    amendments?: string
  ): Promise<ProjectApproveResponse>;
  getClarifications(id: string): Promise<ProjectClarificationsResponse>;
  submitClarifications(
    id: string,
    answers: Record<string, string>
  ): Promise<ProjectClarifyResponse>;
  getOpenClawPairingStatus(): Promise<OpenClawPairingStatusResponse>;
  fixOpenClawPairing(): Promise<OpenClawFixPairingResponse>;
  setOpenClawModelProvider(
    provider: OpenClawModelProvider
  ): Promise<OpenClawModelProviderResponse>;
  getOpenClawCodexStatus(): Promise<OpenClawCodexAuthStatusResponse>;
  sendOpenClawCodexLoginInput(
    sessionId: string,
    data: string
  ): Promise<OpenClawCodexLoginInputResponse>;
  restartOpenClaw(): Promise<OpenClawRestartResponse>;
}
