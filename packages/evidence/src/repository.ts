import {
  approvalRequestQuerySchema,
  approvalRequestSchema,
  asIsoTimestamp,
  memoryContextSchema,
  memoryQuerySchema,
  memoryRecordSchema,
  pipelineRunQuerySchema,
  pipelineRunSchema,
  runEventSchema,
  runSummarySchema,
  type ApprovalDecision,
  type ApprovalRequest,
  type ApprovalRequestQuery,
  type ConcurrencyStrategy,
  type EvidenceRecord,
  type GitHubIssuePollingCursor,
  type MemoryContext,
  type MemoryQuery,
  type MemoryRecord,
  type PhaseRecord,
  type PipelineRun,
  type PipelineRunQuery,
  type PlanningSpec,
  type PolicySnapshot,
  type RunEvent,
  type RunSummary,
  type TaskManifest
} from "@reddwarf/contracts";
import { buildMemoryContextForRepository, summarizeRunEvents } from "./summarize.js";
export interface PlanningCommandRepository {
  saveManifest(manifest: TaskManifest): Promise<void>;
  updateManifest(manifest: TaskManifest): Promise<void>;
  savePhaseRecord(record: PhaseRecord): Promise<void>;
  savePlanningSpec(spec: PlanningSpec): Promise<void>;
  savePolicySnapshot(taskId: string, snapshot: PolicySnapshot): Promise<void>;
  saveEvidenceRecord(record: EvidenceRecord): Promise<void>;
  saveRunEvent(event: RunEvent): Promise<void>;
  saveMemoryRecord(record: MemoryRecord): Promise<void>;
  savePipelineRun(run: PipelineRun): Promise<void>;
  claimPipelineRun(input: ClaimPipelineRunInput): Promise<ClaimPipelineRunResult>;
  saveApprovalRequest(request: ApprovalRequest): Promise<void>;
  saveGitHubIssuePollingCursor(cursor: GitHubIssuePollingCursor): Promise<void>;
}

export interface PlanningQueryRepository {
  getManifest(taskId: string): Promise<TaskManifest | null>;
  getApprovalRequest(requestId: string): Promise<ApprovalRequest | null>;
  getGitHubIssuePollingCursor(repo: string): Promise<GitHubIssuePollingCursor | null>;
  hasPlanningSpecForSource(source: TaskManifest["source"]): Promise<boolean>;
  getPlanningSpec(taskId: string): Promise<PlanningSpec | null>;
  getPolicySnapshot(taskId: string): Promise<PolicySnapshot | null>;
  getPipelineRun(runId: string): Promise<PipelineRun | null>;
  listPhaseRecords(taskId: string): Promise<PhaseRecord[]>;
  listEvidenceRecords(taskId: string): Promise<EvidenceRecord[]>;
  listRunEvents(taskId: string, runId?: string): Promise<RunEvent[]>;
  listMemoryRecords(query?: Partial<MemoryQuery>): Promise<MemoryRecord[]>;
  listGitHubIssuePollingCursors(): Promise<GitHubIssuePollingCursor[]>;
  listApprovalRequests(
    query?: Partial<ApprovalRequestQuery>
  ): Promise<ApprovalRequest[]>;
  getTaskSnapshot(taskId: string): Promise<PersistedTaskSnapshot>;
  listManifestsByLifecycleStatus(
    status: string,
    limit?: number
  ): Promise<TaskManifest[]>;
  listPipelineRuns(query?: Partial<PipelineRunQuery>): Promise<PipelineRun[]>;
  getRunSummary(taskId: string, runId: string): Promise<RunSummary | null>;
  getMemoryContext(input: {
    taskId: string;
    repo: string;
    organizationId?: string | null;
    limitPerScope?: number;
  }): Promise<MemoryContext>;
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

export class InMemoryPlanningRepository implements PlanningRepository {
  public readonly manifests = new Map<string, TaskManifest>();
  public readonly phaseRecords: PhaseRecord[] = [];
  public readonly planningSpecs = new Map<string, PlanningSpec>();
  public readonly policySnapshots = new Map<string, PolicySnapshot>();
  public readonly evidenceRecords: EvidenceRecord[] = [];
  public readonly runEvents: RunEvent[] = [];
  public readonly memoryRecords: MemoryRecord[] = [];
  public readonly pipelineRuns = new Map<string, PipelineRun>();
  public readonly approvalRequests = new Map<string, ApprovalRequest>();
  public readonly githubIssuePollingCursors = new Map<string, GitHubIssuePollingCursor>();

  async saveManifest(manifest: TaskManifest): Promise<void> {
    this.manifests.set(manifest.taskId, manifest);
  }

  async updateManifest(manifest: TaskManifest): Promise<void> {
    this.manifests.set(manifest.taskId, manifest);
  }

  async savePhaseRecord(record: PhaseRecord): Promise<void> {
    this.phaseRecords.push(record);
  }

  async savePlanningSpec(spec: PlanningSpec): Promise<void> {
    this.planningSpecs.set(spec.taskId, spec);
  }

  async savePolicySnapshot(
    taskId: string,
    snapshot: PolicySnapshot
  ): Promise<void> {
    this.policySnapshots.set(taskId, snapshot);
  }

  async saveEvidenceRecord(record: EvidenceRecord): Promise<void> {
    this.evidenceRecords.push(record);
  }

  async saveRunEvent(event: RunEvent): Promise<void> {
    this.runEvents.push(event);
  }

  async saveMemoryRecord(record: MemoryRecord): Promise<void> {
    const index = this.memoryRecords.findIndex(
      (entry) => entry.memoryId === record.memoryId
    );

    if (index >= 0) {
      this.memoryRecords[index] = record;
      return;
    }

    this.memoryRecords.push(record);
  }

  async savePipelineRun(run: PipelineRun): Promise<void> {
    this.pipelineRuns.set(run.runId, run);
  }

  async claimPipelineRun(
    input: ClaimPipelineRunInput
  ): Promise<ClaimPipelineRunResult> {
    const activeRuns = [...this.pipelineRuns.values()]
      .filter(
        (run) =>
          run.concurrencyKey === input.run.concurrencyKey &&
          run.status === "active"
      )
      .sort(comparePipelineRuns);
    const staleRunIds: string[] = [];
    let blockedByRun: PipelineRun | null = null;
    const claimedAt = new Date(input.run.startedAt);
    const claimedAtIso = input.run.startedAt;

    for (const overlap of activeRuns) {
      if (overlap.runId === input.run.runId) {
        continue;
      }

      if (claimedAt.getTime() - new Date(overlap.lastHeartbeatAt).getTime() > input.staleAfterMs) {
        this.pipelineRuns.set(
          overlap.runId,
          pipelineRunSchema.parse({
            ...overlap,
            status: "stale",
            lastHeartbeatAt: claimedAtIso,
            completedAt: claimedAtIso,
            staleAt: claimedAtIso,
            overlapReason: `Marked stale by run ${input.run.runId}`,
            metadata: {
              ...overlap.metadata,
              staleDetectedByRunId: input.run.runId
            }
          })
        );
        staleRunIds.push(overlap.runId);
        continue;
      }

      blockedByRun = overlap;
      break;
    }

    if (!blockedByRun) {
      this.pipelineRuns.set(input.run.runId, input.run);
    }

    return { staleRunIds, blockedByRun };
  }

  async saveApprovalRequest(request: ApprovalRequest): Promise<void> {
    this.approvalRequests.set(request.requestId, request);
  }

  async saveGitHubIssuePollingCursor(
    cursor: GitHubIssuePollingCursor
  ): Promise<void> {
    this.githubIssuePollingCursors.set(cursor.repo, cursor);
  }

  async getManifest(taskId: string): Promise<TaskManifest | null> {
    return this.manifests.get(taskId) ?? null;
  }

  async getApprovalRequest(requestId: string): Promise<ApprovalRequest | null> {
    return this.approvalRequests.get(requestId) ?? null;
  }

  async getGitHubIssuePollingCursor(repo: string): Promise<GitHubIssuePollingCursor | null> {
    return this.githubIssuePollingCursors.get(repo) ?? null;
  }

  async hasPlanningSpecForSource(
    source: TaskManifest["source"]
  ): Promise<boolean> {
    for (const manifest of this.manifests.values()) {
      if (
        manifest.source.provider === source.provider &&
        manifest.source.repo === source.repo &&
        manifest.source.issueId === source.issueId &&
        manifest.source.issueNumber === source.issueNumber &&
        this.planningSpecs.has(manifest.taskId)
      ) {
        return true;
      }
    }

    return false;
  }

  async getPlanningSpec(taskId: string): Promise<PlanningSpec | null> {
    return this.planningSpecs.get(taskId) ?? null;
  }

  async getPolicySnapshot(taskId: string): Promise<PolicySnapshot | null> {
    return this.policySnapshots.get(taskId) ?? null;
  }

  async getPipelineRun(runId: string): Promise<PipelineRun | null> {
    return this.pipelineRuns.get(runId) ?? null;
  }

  async listPhaseRecords(taskId: string): Promise<PhaseRecord[]> {
    return this.phaseRecords.filter((record) => record.taskId === taskId);
  }

  async listEvidenceRecords(taskId: string): Promise<EvidenceRecord[]> {
    return this.evidenceRecords.filter((record) => record.taskId === taskId);
  }

  async listRunEvents(taskId: string, runId?: string): Promise<RunEvent[]> {
    return this.runEvents.filter(
      (event) =>
        event.taskId === taskId &&
        (runId === undefined || event.runId === runId)
    );
  }

  async listMemoryRecords(
    query: Partial<MemoryQuery> = {}
  ): Promise<MemoryRecord[]> {
    const parsed = normalizeMemoryQuery(query);

    return this.memoryRecords
      .filter(
        (record) =>
          (!parsed.scope || record.scope === parsed.scope) &&
          (!parsed.taskId || record.taskId === parsed.taskId) &&
          (!parsed.repo || record.repo === parsed.repo) &&
          (!parsed.organizationId ||
            record.organizationId === parsed.organizationId) &&
          (!parsed.sourceUri || record.sourceUri === parsed.sourceUri) &&
          (!parsed.keyPrefix || record.key.startsWith(parsed.keyPrefix)) &&
          (parsed.tags.length === 0 ||
            parsed.tags.every((tag) => record.tags.includes(tag)))
      )
      .sort(compareMemoryRecords)
      .slice(0, parsed.limit);
  }

  async listManifestsByLifecycleStatus(
    status: string,
    limit = 100
  ): Promise<TaskManifest[]> {
    return [...this.manifests.values()]
      .filter((m) => m.lifecycleStatus === status)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, limit);
  }

  async listPipelineRuns(
    query: Partial<PipelineRunQuery> = {}
  ): Promise<PipelineRun[]> {
    const parsed = normalizePipelineRunQuery(query);

    return [...this.pipelineRuns.values()]
      .filter((run) => (parsed.taskId ? run.taskId === parsed.taskId : true))
      .filter((run) =>
        parsed.concurrencyKey
          ? run.concurrencyKey === parsed.concurrencyKey
          : true
      )
      .filter((run) =>
        parsed.statuses.length > 0 ? parsed.statuses.includes(run.status) : true
      )
      .sort(comparePipelineRuns)
      .slice(0, parsed.limit);
  }

  async listApprovalRequests(
    query: Partial<ApprovalRequestQuery> = {}
  ): Promise<ApprovalRequest[]> {
    const parsed = normalizeApprovalRequestQuery(query);

    return [...this.approvalRequests.values()]
      .filter((request) =>
        parsed.taskId ? request.taskId === parsed.taskId : true
      )
      .filter((request) =>
        parsed.runId ? request.runId === parsed.runId : true
      )
      .filter((request) =>
        parsed.statuses.length > 0
          ? parsed.statuses.includes(request.status)
          : true
      )
      .sort(compareApprovalRequests)
      .slice(0, parsed.limit);
  }

  async listGitHubIssuePollingCursors(): Promise<GitHubIssuePollingCursor[]> {
    return [...this.githubIssuePollingCursors.values()].sort((left, right) =>
      left.repo.localeCompare(right.repo)
    );
  }

  async getTaskSnapshot(taskId: string): Promise<PersistedTaskSnapshot> {
    const [
      manifest,
      spec,
      policySnapshot,
      phaseRecords,
      evidenceRecords,
      runEvents,
      memoryRecords,
      pipelineRuns,
      approvalRequests
    ] = await Promise.all([
      this.getManifest(taskId),
      this.getPlanningSpec(taskId),
      this.getPolicySnapshot(taskId),
      this.listPhaseRecords(taskId),
      this.listEvidenceRecords(taskId),
      this.listRunEvents(taskId),
      this.listMemoryRecords({ taskId, scope: "task", limit: 100 }),
      this.listPipelineRuns({ taskId, limit: 100 }),
      this.listApprovalRequests({ taskId, limit: 100 })
    ]);

    return {
      manifest,
      spec,
      policySnapshot,
      phaseRecords,
      evidenceRecords,
      runEvents,
      memoryRecords,
      pipelineRuns,
      approvalRequests
    };
  }

  async getRunSummary(
    taskId: string,
    runId: string
  ): Promise<RunSummary | null> {
    return summarizeRunEvents(
      taskId,
      runId,
      await this.listRunEvents(taskId, runId)
    );
  }

  async getMemoryContext(input: {
    taskId: string;
    repo: string;
    organizationId?: string | null;
    limitPerScope?: number;
  }): Promise<MemoryContext> {
    return buildMemoryContextForRepository(this, input);
  }
}


export function normalizeMemoryQuery(query: Partial<MemoryQuery>): MemoryQuery {
  return memoryQuerySchema.parse(query);
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

