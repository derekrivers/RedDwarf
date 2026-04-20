import {
  agentQualityMetricsQuerySchema,
  approvalRequestQuerySchema,
  eligibilityRejectionQuerySchema,
  memoryQuerySchema,
  pipelineRunQuerySchema,
  taskManifestQuerySchema,
  type AgentQualityMetrics,
  type AgentQualityMetricsQuery,
  type ApprovalRequest,
  type ApprovalRequestQuery,
  type EvidenceRecord,
  type EligibilityRejectionQuery,
  type EligibilityRejectionRecord,
  type GitHubIssuePollingCursor,
  type IntentRecord,
  type IntentStatus,
  type MemoryContext,
  type MemoryQuery,
  type MemoryRecord,
  type OperatorConfigEntry,
  type PhaseRecord,
  type PipelineRun,
  type PipelineRunQuery,
  type PlanningSpec,
  type PolicySnapshot,
  type ProjectSpec,
  type ProjectSpecProvenance,
  type PromptSnapshot,
  type RunEvent,
  type RunSummary,
  type TaskManifest,
  type TaskManifestQuery,
  type TicketSpec,
  type TranslationNote
} from "@reddwarf/contracts";

/** Input for an external-injection provenance record. */
export interface SaveProjectSpecProvenanceInput {
  projectId: string;
  contextSpecId: string;
  contextVersion: number;
  adapterVersion: string;
  targetSchemaVersion: string;
  injectedBy: string | null;
  translationNotes: TranslationNote[];
  now: string;
}

export type RepositoryHealthStatus = "healthy" | "degraded";

export interface PostgresPoolHealthSnapshot {
  status: RepositoryHealthStatus;
  maxConnections: number;
  totalConnections: number;
  idleConnections: number;
  waitingRequests: number;
  connectionTimeoutMs: number;
  idleTimeoutMs: number;
  queryTimeoutMs: number | null;
  statementTimeoutMs: number | null;
  maxLifetimeSeconds: number;
  errorCount: number;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
}

export interface RepositoryHealthSnapshot {
  storage: "in_memory" | "postgres";
  status: RepositoryHealthStatus;
  postgresPool: PostgresPoolHealthSnapshot | null;
}
export interface PlanningTransactionRepository {
  saveManifest(manifest: TaskManifest): Promise<void>;
  updateManifest(manifest: TaskManifest): Promise<void>;
  savePhaseRecord(record: PhaseRecord): Promise<void>;
  saveEvidenceRecord(record: EvidenceRecord): Promise<void>;
  saveRunEvent(event: RunEvent): Promise<void>;
  saveMemoryRecord(record: MemoryRecord): Promise<void>;
  savePipelineRun(run: PipelineRun): Promise<void>;
  saveApprovalRequest(request: ApprovalRequest): Promise<void>;
  savePromptSnapshot(snapshot: PromptSnapshot): Promise<PromptSnapshot>;
  saveEligibilityRejection(record: EligibilityRejectionRecord): Promise<void>;
  saveOperatorConfigEntry(entry: OperatorConfigEntry): Promise<void>;
  getProjectSpec(projectId: string): Promise<ProjectSpec | null>;
  saveProjectSpec(project: ProjectSpec): Promise<void>;
  getTicketSpec(ticketId: string): Promise<TicketSpec | null>;
  saveTicketSpec(ticket: TicketSpec): Promise<void>;
  listTicketSpecs(projectId: string): Promise<TicketSpec[]>;
  resolveNextReadyTicket(projectId: string): Promise<TicketSpec | null>;
  getManifest(taskId: string): Promise<TaskManifest | null>;
  getTaskSnapshot(taskId: string): Promise<PersistedTaskSnapshot>;
  savePlanningSpec(spec: PlanningSpec): Promise<void>;
  savePolicySnapshot(taskId: string, snapshot: PolicySnapshot): Promise<void>;
  saveProjectSpecProvenance(
    input: SaveProjectSpecProvenanceInput
  ): Promise<ProjectSpecProvenance>;
  findProjectSpecProvenanceByContext(
    contextSpecId: string,
    contextVersion: number
  ): Promise<ProjectSpecProvenance | null>;
  findProjectSpecProvenanceByProject(
    projectId: string
  ): Promise<ProjectSpecProvenance | null>;
}

export interface PlanningCommandRepository extends PlanningTransactionRepository {
  savePlanningSpec(spec: PlanningSpec): Promise<void>;
  savePolicySnapshot(taskId: string, snapshot: PolicySnapshot): Promise<void>;
  claimPipelineRun(input: ClaimPipelineRunInput): Promise<ClaimPipelineRunResult>;
  saveGitHubIssuePollingCursor(cursor: GitHubIssuePollingCursor): Promise<void>;
  deleteGitHubIssuePollingCursor(repo: string): Promise<boolean>;
  saveProjectSpec(project: ProjectSpec): Promise<void>;
  saveTicketSpec(ticket: TicketSpec): Promise<void>;
  updateProjectStatus(projectId: string, status: ProjectSpec["status"]): Promise<void>;
  updateTicketStatus(ticketId: string, status: TicketSpec["status"]): Promise<void>;
  runInTransaction<T>(
    operation: (repository: PlanningTransactionRepository) => Promise<T>
  ): Promise<T>;
  // R-18: Write-ahead intent log
  saveIntent(intent: IntentRecord): Promise<void>;
  updateIntentStatus(
    intentId: string,
    status: IntentStatus,
    patch?: { result?: Record<string, unknown> | null; error?: string | null; completedAt?: string | null }
  ): Promise<void>;
}

export interface PlanningQueryRepository {
  getManifest(taskId: string): Promise<TaskManifest | null>;
  getApprovalRequest(requestId: string): Promise<ApprovalRequest | null>;
  getGitHubIssuePollingCursor(repo: string): Promise<GitHubIssuePollingCursor | null>;
  getOperatorConfigEntry(key: OperatorConfigEntry["key"]): Promise<OperatorConfigEntry | null>;
  hasPlanningSpecForSource(source: TaskManifest["source"]): Promise<boolean>;
  getPlanningSpec(taskId: string): Promise<PlanningSpec | null>;
  getPolicySnapshot(taskId: string): Promise<PolicySnapshot | null>;
  getPipelineRun(runId: string): Promise<PipelineRun | null>;
  getPromptSnapshot(snapshotId: string): Promise<PromptSnapshot | null>;
  listPhaseRecords(taskId: string): Promise<PhaseRecord[]>;
  listEvidenceRecords(taskId: string): Promise<EvidenceRecord[]>;
  listEligibilityRejections(
    query?: Partial<EligibilityRejectionQuery>
  ): Promise<EligibilityRejectionRecord[]>;
  listRunEvents(taskId: string, runId?: string): Promise<RunEvent[]>;
  /**
   * Feature 183: return every run event with the given `code` that was
   * created at or after `sinceIso`, across all tasks, up to `limit` rows.
   * Used by the dispatcher's daily-budget gate.
   */
  listRunEventsByCodeSince(
    code: string,
    sinceIso: string,
    limit?: number
  ): Promise<RunEvent[]>;
  listPromptSnapshots(): Promise<PromptSnapshot[]>;
  listMemoryRecords(query?: Partial<MemoryQuery>): Promise<MemoryRecord[]>;
  listGitHubIssuePollingCursors(): Promise<GitHubIssuePollingCursor[]>;
  listOperatorConfigEntries(): Promise<OperatorConfigEntry[]>;
  listApprovalRequests(
    query?: Partial<ApprovalRequestQuery>
  ): Promise<ApprovalRequest[]>;
  getTaskSnapshot(taskId: string): Promise<PersistedTaskSnapshot>;
  listManifestsByLifecycleStatus(
    status: string,
    limit?: number
  ): Promise<TaskManifest[]>;
  listTaskManifests(query?: Partial<TaskManifestQuery>): Promise<TaskManifest[]>;
  listPipelineRuns(query?: Partial<PipelineRunQuery>): Promise<PipelineRun[]>;
  getRunSummary(taskId: string, runId: string): Promise<RunSummary | null>;
  getMemoryContext(input: {
    taskId: string;
    repo: string;
    organizationId?: string | null;
    limitPerScope?: number;
  }): Promise<MemoryContext>;
  getRepositoryHealth(): Promise<RepositoryHealthSnapshot>;
  /** Feature 179: per-phase + per-policy-pack-version outcome aggregates. */
  getAgentQualityMetrics(
    query?: Partial<AgentQualityMetricsQuery>
  ): Promise<AgentQualityMetrics>;
  getProjectSpec(projectId: string): Promise<ProjectSpec | null>;
  listProjectSpecs(repo?: string): Promise<ProjectSpec[]>;
  getTicketSpec(ticketId: string): Promise<TicketSpec | null>;
  listTicketSpecs(projectId: string): Promise<TicketSpec[]>;
  resolveNextReadyTicket(projectId: string): Promise<TicketSpec | null>;
  // R-18: Write-ahead intent log
  listPendingIntents(limit?: number): Promise<IntentRecord[]>;
}

export type PlanningRepository = PlanningCommandRepository & PlanningQueryRepository;

export interface PersistedTaskSnapshot {
  manifest: TaskManifest | null;
  spec: PlanningSpec | null;
  policySnapshot: PolicySnapshot | null;
  phaseRecords: PhaseRecord[];
  evidenceRecords: EvidenceRecord[];
  runEvents: RunEvent[];
  memoryRecords: MemoryRecord[];
  pipelineRuns: PipelineRun[];
  approvalRequests: ApprovalRequest[];
}

export interface ClaimPipelineRunInput {
  run: PipelineRun;
  staleAfterMs: number;
}

export interface ClaimPipelineRunResult {
  staleRunIds: string[];
  blockedByRun: PipelineRun | null;
}

export function normalizeMemoryQuery(query: Partial<MemoryQuery>): MemoryQuery {
  return memoryQuerySchema.parse(query);
}

export function normalizeEligibilityRejectionQuery(
  query: Partial<EligibilityRejectionQuery>
): EligibilityRejectionQuery {
  return eligibilityRejectionQuerySchema.parse(query);
}

export function normalizePipelineRunQuery(
  query: Partial<PipelineRunQuery>
): PipelineRunQuery {
  return pipelineRunQuerySchema.parse(query);
}

export function normalizeApprovalRequestQuery(
  query: Partial<ApprovalRequestQuery>
): ApprovalRequestQuery {
  return approvalRequestQuerySchema.parse(query);
}

export function normalizeTaskManifestQuery(
  query: Partial<TaskManifestQuery>
): TaskManifestQuery {
  return taskManifestQuerySchema.parse(query);
}

export function normalizeAgentQualityMetricsQuery(
  query: Partial<AgentQualityMetricsQuery>
): AgentQualityMetricsQuery {
  return agentQualityMetricsQuerySchema.parse(query);
}

export function dedupeMemoryRecords(records: MemoryRecord[]): MemoryRecord[] {
  const seen = new Set<string>();
  const deduped: MemoryRecord[] = [];

  for (const record of records.sort(compareMemoryRecords)) {
    if (seen.has(record.memoryId)) {
      continue;
    }

    seen.add(record.memoryId);
    deduped.push(record);
  }

  return deduped;
}

export function compareMemoryRecords(left: MemoryRecord, right: MemoryRecord): number {
  const updated = right.updatedAt.localeCompare(left.updatedAt);

  if (updated !== 0) {
    return updated;
  }

  const created = right.createdAt.localeCompare(left.createdAt);
  return created !== 0 ? created : left.memoryId.localeCompare(right.memoryId);
}

export function comparePipelineRuns(left: PipelineRun, right: PipelineRun): number {
  const started = right.startedAt.localeCompare(left.startedAt);
  return started !== 0 ? started : left.runId.localeCompare(right.runId);
}

export function compareApprovalRequests(
  left: ApprovalRequest,
  right: ApprovalRequest
): number {
  const updated = right.updatedAt.localeCompare(left.updatedAt);

  if (updated !== 0) {
    return updated;
  }

  const created = right.createdAt.localeCompare(left.createdAt);
  return created !== 0
    ? created
    : left.requestId.localeCompare(right.requestId);
}
