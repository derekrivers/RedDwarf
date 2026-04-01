import {
  pipelineRunSchema,
  type ApprovalRequest,
  type EvidenceRecord,
  type GitHubIssuePollingCursor,
  type MemoryContext,
  type MemoryRecord,
  type PhaseRecord,
  type PipelineRun,
  type PlanningSpec,
  type PolicySnapshot,
  type PromptSnapshot,
  type RunEvent,
  type TaskManifest
} from "@reddwarf/contracts";
import { buildMemoryContextForRepository, summarizeRunEvents } from "./summarize.js";
import {
  compareApprovalRequests,
  compareMemoryRecords,
  comparePipelineRuns,
  normalizeApprovalRequestQuery,
  normalizeMemoryQuery,
  normalizePipelineRunQuery,
  type ClaimPipelineRunInput,
  type ClaimPipelineRunResult,
  type PersistedTaskSnapshot,
  type PlanningRepository,
  type PlanningTransactionRepository,
  type RepositoryHealthSnapshot
} from "./repository.js";

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
  public readonly promptSnapshots = new Map<string, PromptSnapshot>();

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

  async savePromptSnapshot(snapshot: PromptSnapshot): Promise<PromptSnapshot> {
    const existing = [...this.promptSnapshots.values()].find(
      (entry) =>
        entry.phase === snapshot.phase &&
        entry.promptHash === snapshot.promptHash
    );

    if (existing) {
      return existing;
    }

    this.promptSnapshots.set(snapshot.snapshotId, snapshot);
    return snapshot;
  }

  async saveGitHubIssuePollingCursor(
    cursor: GitHubIssuePollingCursor
  ): Promise<void> {
    this.githubIssuePollingCursors.set(cursor.repo, cursor);
  }

  async runInTransaction<T>(
    operation: (repository: PlanningTransactionRepository) => Promise<T>
  ): Promise<T> {
    const manifests = cloneInMemoryMap(this.manifests);
    const phaseRecords = cloneInMemoryArray(this.phaseRecords);
    const planningSpecs = cloneInMemoryMap(this.planningSpecs);
    const policySnapshots = cloneInMemoryMap(this.policySnapshots);
    const evidenceRecords = cloneInMemoryArray(this.evidenceRecords);
    const runEvents = cloneInMemoryArray(this.runEvents);
    const memoryRecords = cloneInMemoryArray(this.memoryRecords);
    const pipelineRuns = cloneInMemoryMap(this.pipelineRuns);
    const approvalRequests = cloneInMemoryMap(this.approvalRequests);
    const githubIssuePollingCursors = cloneInMemoryMap(
      this.githubIssuePollingCursors
    );
    const promptSnapshots = cloneInMemoryMap(this.promptSnapshots);

    try {
      return await operation(this);
    } catch (error) {
      this.manifests.clear();
      for (const [key, value] of manifests.entries()) {
        this.manifests.set(key, value);
      }

      this.phaseRecords.splice(0, this.phaseRecords.length, ...phaseRecords);

      this.planningSpecs.clear();
      for (const [key, value] of planningSpecs.entries()) {
        this.planningSpecs.set(key, value);
      }

      this.policySnapshots.clear();
      for (const [key, value] of policySnapshots.entries()) {
        this.policySnapshots.set(key, value);
      }

      this.evidenceRecords.splice(0, this.evidenceRecords.length, ...evidenceRecords);
      this.runEvents.splice(0, this.runEvents.length, ...runEvents);
      this.memoryRecords.splice(0, this.memoryRecords.length, ...memoryRecords);

      this.pipelineRuns.clear();
      for (const [key, value] of pipelineRuns.entries()) {
        this.pipelineRuns.set(key, value);
      }

      this.approvalRequests.clear();
      for (const [key, value] of approvalRequests.entries()) {
        this.approvalRequests.set(key, value);
      }

      this.githubIssuePollingCursors.clear();
      for (const [key, value] of githubIssuePollingCursors.entries()) {
        this.githubIssuePollingCursors.set(key, value);
      }

      this.promptSnapshots.clear();
      for (const [key, value] of promptSnapshots.entries()) {
        this.promptSnapshots.set(key, value);
      }

      throw error;
    }
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
        manifest.dryRun === false &&
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

  async getPromptSnapshot(snapshotId: string): Promise<PromptSnapshot | null> {
    return this.promptSnapshots.get(snapshotId) ?? null;
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

  async listPromptSnapshots(): Promise<PromptSnapshot[]> {
    return [...this.promptSnapshots.values()].sort((left, right) =>
      right.capturedAt.localeCompare(left.capturedAt)
    );
  }

  async listMemoryRecords(
    query: Partial<import("@reddwarf/contracts").MemoryQuery> = {}
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
    query: Partial<import("@reddwarf/contracts").PipelineRunQuery> = {}
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
    query: Partial<import("@reddwarf/contracts").ApprovalRequestQuery> = {}
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
  ): Promise<import("@reddwarf/contracts").RunSummary | null> {
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

  async getRepositoryHealth(): Promise<RepositoryHealthSnapshot> {
    return {
      storage: "in_memory",
      status: "healthy",
      postgresPool: null
    };
  }
}

function cloneInMemoryMap<TKey, TValue>(
  input: Map<TKey, TValue>
): Map<TKey, TValue> {
  return new Map(structuredClone([...input.entries()]));
}

function cloneInMemoryArray<T>(input: T[]): T[] {
  return structuredClone(input);
}
