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
  // Mirrors RunTokenUsageSummary from @reddwarf/control-plane. Pre-F-197
  // this type used `inputTokens` / `outputTokens` which never matched the
  // actual server response, so "X in / Y out" rendered as `undefined`.
  // Feature 197 aligns the names and adds the cost rollup.
  tokenUsage: {
    totalEstimatedTokens: number;
    totalActualInputTokens: number;
    totalActualOutputTokens: number;
    totalActualTokens: number;
    /** Total USD across phases that reported a model id; 0 when none did. */
    totalCostUsd: number;
    anyPhaseExceeded: boolean;
    /** True if any phase in the run exceeded its per-task cost budget. */
    anyCostBudgetExceeded: boolean;
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
  /** M25 F-196 — flip a project's autoMergeEnabled flag. Server returns 409
   *  if global REDDWARF_PROJECT_AUTOMERGE_ENABLED is false and `enabled`=true. */
  patchProjectAutoMerge(
    id: string,
    enabled: boolean
  ): Promise<{ project: ProjectSpec }>;
  approveProject(
    id: string,
    decision: "approve" | "amend",
    decidedBy: string,
    decisionSummary?: string,
    amendments?: string,
    /** M25 — optional auto-merge opt-in. Server 409s when global flag is off. */
    options?: { autoMerge?: boolean }
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
  getAuditExport(filters?: AuditExportFilters): Promise<AuditExportResponse>;
  buildAuditCsvUrl(filters?: AuditExportFilters): string;
  getAgentQualityMetrics(filters?: AgentQualityMetricsFilters): Promise<AgentQualityMetricsResponse>;
  getDailyBudgetStatus(): Promise<DailyBudgetStatusResponse>;
  // Feature 186 — operator triage verbs.
  listTasks(filters?: { lifecycleStatuses?: string[]; repo?: string; limit?: number }): Promise<{ tasks: TaskSummary[]; total: number }>;
  quarantineTask(taskId: string, reason: string): Promise<{ manifest: TaskDetailResponse["manifest"] }>;
  releaseTask(taskId: string, reason?: string): Promise<{ manifest: TaskDetailResponse["manifest"] }>;
  addTaskNote(taskId: string, note: string, author?: string): Promise<{ memoryId: string }>;
  kickRunHeartbeat(runId: string, reason?: string): Promise<{ run: { runId: string; lastHeartbeatAt: string } }>;
}

export interface TaskSummary {
  taskId: string;
  title: string;
  source: TaskDetailResponse["manifest"]["source"];
  lifecycleStatus: string;
  currentPhase: string;
  riskClass: string;
  approvalMode: string;
  updatedAt: string;
  createdAt: string;
}

// Feature 183 — Org-level daily autonomy budget (M24 F-183).
export interface DailyBudgetStatusResponse {
  windowStart: string;
  windowEnd: string;
  tokensUsed: number;
  costUsdUsed: number;
  tokenBudget: number | null;
  costBudgetUsd: number | null;
  tokensRemaining: number | null;
  costUsdRemaining: number | null;
  tokenBudgetExhausted: boolean;
  costBudgetExhausted: boolean;
  exhausted: boolean;
}

// Feature 179 — Agent quality telemetry aggregates (M24 F-179).
export interface AgentQualityMetricsFilters {
  since?: string;
  until?: string;
}

export interface AgentPhaseOutcomeRow {
  phase: string;
  policyVersion: string;
  passed: number;
  failed: number;
  escalated: number;
  total: number;
  passRate: number;
}

export interface AgentPhaseLatencyRow {
  phase: string;
  policyVersion: string;
  sampleCount: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
}

export interface AgentFailureClassRow {
  failureClass: string;
  phase: string;
  count: number;
}

export interface AgentQualityMetricsResponse {
  phaseOutcomes: AgentPhaseOutcomeRow[];
  phaseLatencies: AgentPhaseLatencyRow[];
  failureClasses: AgentFailureClassRow[];
  window: {
    since: string | null;
    until: string | null;
  };
}

// Feature 185 — Audit-log export (M24 F-185).
export interface AuditExportFilters {
  since?: string;
  until?: string;
  repo?: string;
}

export interface AuditEntry {
  requestId: string;
  taskId: string;
  runId: string;
  repo: string | null;
  issueNumber: number | null;
  phase: string;
  status: string;
  decision: "approve" | "reject" | "rework" | null;
  decidedBy: string | null;
  decisionSummary: string | null;
  riskClass: string;
  policyVersion: string | null;
  prNumber: number | null;
  prUrl: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface AuditExportResponse {
  entries: AuditEntry[];
  total: number;
  window: {
    since: string | null;
    until: string | null;
  };
  repo: string | null;
  truncated: boolean;
}
