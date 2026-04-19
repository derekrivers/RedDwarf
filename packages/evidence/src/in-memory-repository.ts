import {
  asIsoTimestamp,
  pipelineRunSchema,
  type ApprovalRequest,
  type EvidenceRecord,
  type EligibilityRejectionRecord,
  type GitHubIssuePollingCursor,
  type IntentRecord,
  type IntentStatus,
  type MemoryContext,
  type MemoryRecord,
  type OperatorConfigEntry,
  type PhaseRecord,
  type PipelineRun,
  type PlanningSpec,
  type PolicySnapshot,
  type ProjectSpec,
  type PromptSnapshot,
  type RunEvent,
  type TaskManifest,
  type TicketSpec,
  assertValidProjectStatusTransition,
  assertValidTicketStatusTransition
} from "@reddwarf/contracts";
import { buildMemoryContextForRepository, summarizeRunEvents } from "./summarize.js";
import {
  compareApprovalRequests,
  compareMemoryRecords,
  comparePipelineRuns,
  normalizeEligibilityRejectionQuery,
  normalizeApprovalRequestQuery,
  normalizeMemoryQuery,
  normalizePipelineRunQuery,
  normalizeTaskManifestQuery,
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
  public readonly operatorConfigEntries = new Map<
    OperatorConfigEntry["key"],
    OperatorConfigEntry
  >();
  public readonly promptSnapshots = new Map<string, PromptSnapshot>();
  public readonly eligibilityRejections: EligibilityRejectionRecord[] = [];
  public readonly projectSpecs = new Map<string, ProjectSpec>();
  public readonly ticketSpecs = new Map<string, TicketSpec>();
  public readonly intents = new Map<string, IntentRecord>();

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

  async saveEligibilityRejection(
    record: EligibilityRejectionRecord
  ): Promise<void> {
    const index = this.eligibilityRejections.findIndex(
      (entry) => entry.rejectionId === record.rejectionId
    );

    if (index >= 0) {
      this.eligibilityRejections[index] = record;
      return;
    }

    this.eligibilityRejections.push(record);
  }

  async saveGitHubIssuePollingCursor(
    cursor: GitHubIssuePollingCursor
  ): Promise<void> {
    this.githubIssuePollingCursors.set(cursor.repo, cursor);
  }

  async deleteGitHubIssuePollingCursor(repo: string): Promise<boolean> {
    return this.githubIssuePollingCursors.delete(repo);
  }

  async saveOperatorConfigEntry(entry: OperatorConfigEntry): Promise<void> {
    this.operatorConfigEntries.set(entry.key, entry);
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
    const operatorConfigEntries = cloneInMemoryMap(this.operatorConfigEntries);
    const promptSnapshots = cloneInMemoryMap(this.promptSnapshots);
    const eligibilityRejections = cloneInMemoryArray(this.eligibilityRejections);
    const projectSpecs = cloneInMemoryMap(this.projectSpecs);
    const ticketSpecs = cloneInMemoryMap(this.ticketSpecs);

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

      this.operatorConfigEntries.clear();
      for (const [key, value] of operatorConfigEntries.entries()) {
        this.operatorConfigEntries.set(key, value);
      }

      this.promptSnapshots.clear();
      for (const [key, value] of promptSnapshots.entries()) {
        this.promptSnapshots.set(key, value);
      }

      this.eligibilityRejections.splice(
        0,
        this.eligibilityRejections.length,
        ...eligibilityRejections
      );

      this.projectSpecs.clear();
      for (const [key, value] of projectSpecs.entries()) {
        this.projectSpecs.set(key, value);
      }

      this.ticketSpecs.clear();
      for (const [key, value] of ticketSpecs.entries()) {
        this.ticketSpecs.set(key, value);
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

  async getOperatorConfigEntry(
    key: OperatorConfigEntry["key"]
  ): Promise<OperatorConfigEntry | null> {
    return this.operatorConfigEntries.get(key) ?? null;
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

  async listEligibilityRejections(
    query: Partial<import("@reddwarf/contracts").EligibilityRejectionQuery> = {}
  ): Promise<EligibilityRejectionRecord[]> {
    const parsed = normalizeEligibilityRejectionQuery(query);

    return [...this.eligibilityRejections]
      .filter((record) =>
        parsed.reasonCode ? record.reasonCode === parsed.reasonCode : true
      )
      .filter((record) =>
        parsed.since ? record.rejectedAt >= parsed.since : true
      )
      .sort((left, right) => right.rejectedAt.localeCompare(left.rejectedAt))
      .slice(0, parsed.limit);
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

  async listTaskManifests(
    query: Partial<import("@reddwarf/contracts").TaskManifestQuery> = {}
  ): Promise<TaskManifest[]> {
    const parsed = normalizeTaskManifestQuery(query);

    return [...this.manifests.values()]
      .filter((manifest) => (parsed.repo ? manifest.source.repo === parsed.repo : true))
      .filter((manifest) =>
        parsed.lifecycleStatuses.length > 0
          ? parsed.lifecycleStatuses.includes(manifest.lifecycleStatus)
          : true
      )
      .filter((manifest) =>
        parsed.phases.length > 0 ? parsed.phases.includes(manifest.currentPhase) : true
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, parsed.limit);
  }

  async listPipelineRuns(
    query: Partial<import("@reddwarf/contracts").PipelineRunQuery> = {}
  ): Promise<PipelineRun[]> {
    const parsed = normalizePipelineRunQuery(query);

    return [...this.pipelineRuns.values()]
      .filter((run) => (parsed.taskId ? run.taskId === parsed.taskId : true))
      .filter((run) => {
        if (!parsed.repo) {
          return true;
        }

        const manifest = this.manifests.get(run.taskId);
        return manifest?.source.repo === parsed.repo;
      })
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
      .filter((request) =>
        parsed.since ? request.updatedAt >= parsed.since : true
      )
      .filter((request) =>
        parsed.until ? request.updatedAt <= parsed.until : true
      )
      .sort(compareApprovalRequests)
      .slice(0, parsed.limit);
  }

  async listGitHubIssuePollingCursors(): Promise<GitHubIssuePollingCursor[]> {
    return [...this.githubIssuePollingCursors.values()].sort((left, right) =>
      left.repo.localeCompare(right.repo)
    );
  }

  async listOperatorConfigEntries(): Promise<OperatorConfigEntry[]> {
    return [...this.operatorConfigEntries.values()].sort((left, right) =>
      left.key.localeCompare(right.key)
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

  async saveProjectSpec(project: ProjectSpec): Promise<void> {
    const existing = this.projectSpecs.get(project.projectId);
    if (existing && existing.status !== project.status) {
      assertValidProjectStatusTransition(existing.status, project.status);
    }
    this.projectSpecs.set(project.projectId, project);
  }

  async saveTicketSpec(ticket: TicketSpec): Promise<void> {
    const existing = this.ticketSpecs.get(ticket.ticketId);
    if (existing && existing.status !== ticket.status) {
      assertValidTicketStatusTransition(existing.status, ticket.status);
    }
    this.ticketSpecs.set(ticket.ticketId, ticket);
  }

  async updateProjectStatus(projectId: string, status: ProjectSpec["status"]): Promise<void> {
    const existing = this.projectSpecs.get(projectId);
    if (existing) {
      if (existing.status !== status) {
        assertValidProjectStatusTransition(existing.status, status);
      }
      this.projectSpecs.set(projectId, { ...existing, status, updatedAt: asIsoTimestamp() });
    }
  }

  async updateTicketStatus(ticketId: string, status: TicketSpec["status"]): Promise<void> {
    const existing = this.ticketSpecs.get(ticketId);
    if (existing) {
      if (existing.status !== status) {
        assertValidTicketStatusTransition(existing.status, status);
      }
      this.ticketSpecs.set(ticketId, { ...existing, status, updatedAt: asIsoTimestamp() });
    }
  }

  async getProjectSpec(projectId: string): Promise<ProjectSpec | null> {
    return this.projectSpecs.get(projectId) ?? null;
  }

  async listProjectSpecs(repo?: string): Promise<ProjectSpec[]> {
    const all = [...this.projectSpecs.values()];
    const filtered = repo ? all.filter((p) => p.sourceRepo === repo) : all;
    return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getTicketSpec(ticketId: string): Promise<TicketSpec | null> {
    return this.ticketSpecs.get(ticketId) ?? null;
  }

  async listTicketSpecs(projectId: string): Promise<TicketSpec[]> {
    return [...this.ticketSpecs.values()]
      .filter((t) => t.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async resolveNextReadyTicket(projectId: string): Promise<TicketSpec | null> {
    const tickets = await this.listTicketSpecs(projectId);
    const mergedIds = new Set(
      tickets.filter((t) => t.status === "merged").map((t) => t.ticketId)
    );
    for (const ticket of tickets) {
      if (ticket.status !== "pending") continue;
      if (ticket.dependsOn.every((dep) => mergedIds.has(dep))) return ticket;
    }
    return null;
  }

  async getRepositoryHealth(): Promise<RepositoryHealthSnapshot> {
    return {
      storage: "in_memory",
      status: "healthy",
      postgresPool: null
    };
  }

  // ── R-18: Write-ahead intent log ────────────────────────────────────────

  async saveIntent(intent: IntentRecord): Promise<void> {
    this.intents.set(intent.intentId, structuredClone(intent));
  }

  async updateIntentStatus(
    intentId: string,
    status: IntentStatus,
    patch?: { result?: Record<string, unknown> | null; error?: string | null; completedAt?: string | null }
  ): Promise<void> {
    const existing = this.intents.get(intentId);
    if (!existing) return;
    this.intents.set(intentId, {
      ...existing,
      status,
      result: patch?.result !== undefined ? patch.result : existing.result,
      error: patch?.error !== undefined ? patch.error : existing.error,
      completedAt: patch?.completedAt !== undefined ? patch.completedAt : existing.completedAt,
      updatedAt: asIsoTimestamp(new Date())
    });
  }

  async listPendingIntents(limit = 100): Promise<IntentRecord[]> {
    return [...this.intents.values()]
      .filter((i) => i.status === "pending")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
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
