import {
  approvalRequestQuerySchema,
  approvalRequestSchema,
  eligibilityRejectionQuerySchema,
  asIsoTimestamp,
  memoryContextSchema,
  memoryQuerySchema,
  memoryRecordSchema,
  pipelineRunQuerySchema,
  pipelineRunSchema,
  runEventSchema,
  runSummarySchema,
  type ApprovalRequest,
  type ApprovalRequestQuery,
  type EvidenceRecord,
  type EligibilityRejectionQuery,
  type EligibilityRejectionRecord,
  type GitHubIssuePollingCursor,
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
  type PromptSnapshot,
  type RunEvent,
  type RunSummary,
  type TaskManifest,
  type TicketSpec,
  assertValidProjectStatusTransition,
  assertValidTicketStatusTransition
} from "@reddwarf/contracts";
import pg from "pg";
import {
  mapManifestRow,
  mapPhaseRecordRow,
  mapPlanningSpecRow,
  mapPolicySnapshotRow,
  mapEvidenceRecordRow,
  mapRunEventRow,
  mapMemoryRecordRow,
  mapPipelineRunRow,
  mapGitHubIssuePollingCursorRow,
  mapOperatorConfigRow,
  mapApprovalRequestRow,
  mapPromptSnapshotRow,
  mapEligibilityRejectionRow,
  mapProjectSpecRow,
  mapTicketSpecRow
} from "./row-mappers.js";
import { buildMemoryContextForRepository, summarizeRunEvents } from "./summarize.js";
import {
  normalizeEligibilityRejectionQuery,
  normalizeApprovalRequestQuery,
  normalizeMemoryQuery,
  normalizePipelineRunQuery,
  normalizeTaskManifestQuery,
  type ClaimPipelineRunInput,
  type ClaimPipelineRunResult,
  type PlanningRepository,
  type PlanningTransactionRepository,
  type PersistedTaskSnapshot,
  type RepositoryHealthSnapshot
} from "./repository.js";
export interface PostgresPlanningRepositoryOptions {
  max?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  queryTimeoutMillis?: number;
  statementTimeoutMillis?: number | false;
  maxLifetimeSeconds?: number;
}

interface NormalizedPostgresPlanningRepositoryOptions {
  max: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  queryTimeoutMillis: number | null;
  statementTimeoutMillis: number | null;
  maxLifetimeSeconds: number;
}

interface PostgresPoolTelemetryState {
  errorCount: number;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
}

const DEFAULT_POSTGRES_PLANNING_REPOSITORY_OPTIONS: NormalizedPostgresPlanningRepositoryOptions = {
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  queryTimeoutMillis: 15_000,
  statementTimeoutMillis: 15_000,
  maxLifetimeSeconds: 300
};

function normalizePositiveInteger(
  value: unknown,
  fallback: number,
  minimum = 1
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const normalized = Math.trunc(value);
  return normalized >= minimum ? normalized : fallback;
}

function normalizeTimeoutValue(value: unknown, fallback: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : null;
}

function normalizePostgresPlanningRepositoryOptions(
  options?: number | PostgresPlanningRepositoryOptions
): NormalizedPostgresPlanningRepositoryOptions {
  const rawOptions =
    typeof options === "number" ? { max: options } : options ?? {};

  return {
    max: normalizePositiveInteger(
      rawOptions.max,
      DEFAULT_POSTGRES_PLANNING_REPOSITORY_OPTIONS.max
    ),
    connectionTimeoutMillis: normalizePositiveInteger(
      rawOptions.connectionTimeoutMillis,
      DEFAULT_POSTGRES_PLANNING_REPOSITORY_OPTIONS.connectionTimeoutMillis
    ),
    idleTimeoutMillis: normalizePositiveInteger(
      rawOptions.idleTimeoutMillis,
      DEFAULT_POSTGRES_PLANNING_REPOSITORY_OPTIONS.idleTimeoutMillis
    ),
    queryTimeoutMillis: normalizeTimeoutValue(
      rawOptions.queryTimeoutMillis,
      DEFAULT_POSTGRES_PLANNING_REPOSITORY_OPTIONS.queryTimeoutMillis ?? 0
    ),
    statementTimeoutMillis: normalizeTimeoutValue(
      rawOptions.statementTimeoutMillis === false
        ? 0
        : rawOptions.statementTimeoutMillis,
      DEFAULT_POSTGRES_PLANNING_REPOSITORY_OPTIONS.statementTimeoutMillis ?? 0
    ),
    maxLifetimeSeconds: normalizePositiveInteger(
      rawOptions.maxLifetimeSeconds,
      DEFAULT_POSTGRES_PLANNING_REPOSITORY_OPTIONS.maxLifetimeSeconds
    )
  };
}

export function createPostgresPlanningRepository(
  connectionString: string,
  options?: number | PostgresPlanningRepositoryOptions
): PostgresPlanningRepository {
  const poolOptions = normalizePostgresPlanningRepositoryOptions(options);
  const pool = new pg.Pool({
    connectionString,
    max: poolOptions.max,
    connectionTimeoutMillis: poolOptions.connectionTimeoutMillis,
    idleTimeoutMillis: poolOptions.idleTimeoutMillis,
    maxLifetimeSeconds: poolOptions.maxLifetimeSeconds,
    ...(poolOptions.queryTimeoutMillis !== null
      ? { query_timeout: poolOptions.queryTimeoutMillis }
      : {}),
    ...(poolOptions.statementTimeoutMillis !== null
      ? { statement_timeout: poolOptions.statementTimeoutMillis }
      : {})
  });
  return new PostgresPlanningRepository(pool, poolOptions);
}

type QueryExecutor = pg.Pool | pg.PoolClient;


export class PostgresPlanningRepository implements PlanningRepository {
  private readonly pool: pg.Pool;
  private readonly poolOptions: NormalizedPostgresPlanningRepositoryOptions;
  private readonly poolTelemetry: PostgresPoolTelemetryState;

  constructor(
    pool: pg.Pool,
    poolOptions: NormalizedPostgresPlanningRepositoryOptions =
      DEFAULT_POSTGRES_PLANNING_REPOSITORY_OPTIONS
  ) {
    this.pool = pool;
    this.poolOptions = poolOptions;
    this.poolTelemetry = {
      errorCount: 0,
      lastErrorAt: null,
      lastErrorMessage: null
    };

    this.pool.on("error", (error) => {
      this.poolTelemetry.errorCount += 1;
      this.poolTelemetry.lastErrorAt = asIsoTimestamp();
      this.poolTelemetry.lastErrorMessage =
        error instanceof Error ? error.message : String(error);
    });
  }

  async healthcheck(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async getRepositoryHealth(): Promise<RepositoryHealthSnapshot> {
    const maxConnections = this.poolOptions.max;
    const totalConnections = this.pool.totalCount;
    const idleConnections = this.pool.idleCount;
    const waitingRequests = this.pool.waitingCount;
    const saturated =
      waitingRequests > 0 ||
      (maxConnections > 0 &&
        totalConnections >= maxConnections &&
        idleConnections === 0);

    return {
      storage: "postgres",
      status: saturated ? "degraded" : "healthy",
      postgresPool: {
        status: saturated ? "degraded" : "healthy",
        maxConnections,
        totalConnections,
        idleConnections,
        waitingRequests,
        connectionTimeoutMs: this.poolOptions.connectionTimeoutMillis,
        idleTimeoutMs: this.poolOptions.idleTimeoutMillis,
        queryTimeoutMs: this.poolOptions.queryTimeoutMillis,
        statementTimeoutMs: this.poolOptions.statementTimeoutMillis,
        maxLifetimeSeconds: this.poolOptions.maxLifetimeSeconds,
        errorCount: this.poolTelemetry.errorCount,
        lastErrorAt: this.poolTelemetry.lastErrorAt,
        lastErrorMessage: this.poolTelemetry.lastErrorMessage
      }
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async savePipelineRunWithExecutor(
    executor: QueryExecutor,
    run: PipelineRun
  ): Promise<void> {
    await executor.query(
      `
        INSERT INTO pipeline_runs (
          run_id,
          task_id,
          concurrency_key,
          strategy,
          dry_run,
          status,
          blocked_by_run_id,
          overlap_reason,
          started_at,
          last_heartbeat_at,
          completed_at,
          stale_at,
          metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
        ON CONFLICT (run_id) DO UPDATE SET
          task_id = EXCLUDED.task_id,
          concurrency_key = EXCLUDED.concurrency_key,
          strategy = EXCLUDED.strategy,
          dry_run = EXCLUDED.dry_run,
          status = EXCLUDED.status,
          blocked_by_run_id = EXCLUDED.blocked_by_run_id,
          overlap_reason = EXCLUDED.overlap_reason,
          started_at = EXCLUDED.started_at,
          last_heartbeat_at = EXCLUDED.last_heartbeat_at,
          completed_at = EXCLUDED.completed_at,
          stale_at = EXCLUDED.stale_at,
          metadata = EXCLUDED.metadata
      `,
      [
        run.runId,
        run.taskId,
        run.concurrencyKey,
        run.strategy,
        run.dryRun,
        run.status,
        run.blockedByRunId,
        run.overlapReason,
        run.startedAt,
        run.lastHeartbeatAt,
        run.completedAt,
        run.staleAt,
        JSON.stringify(run.metadata)
      ]
    );
  }

  private async saveManifestWithExecutor(
    executor: QueryExecutor,
    manifest: TaskManifest
  ): Promise<void> {
    await executor.query(
      `
        INSERT INTO task_manifests (
          task_id,
          source,
          title,
          summary,
          priority,
          dry_run,
          risk_class,
          approval_mode,
          current_phase,
          lifecycle_status,
          assigned_agent_type,
          requested_capabilities,
          retry_count,
          evidence_links,
          workspace_id,
          branch_name,
          pr_number,
          policy_version,
          created_at,
          updated_at
        ) VALUES (
          $1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10, $11,
          $12::jsonb, $13, $14::jsonb, $15, $16, $17, $18, $19, $20
        )
        ON CONFLICT (task_id) DO UPDATE SET
          source = EXCLUDED.source,
          title = EXCLUDED.title,
          summary = EXCLUDED.summary,
          priority = EXCLUDED.priority,
          dry_run = EXCLUDED.dry_run,
          risk_class = EXCLUDED.risk_class,
          approval_mode = EXCLUDED.approval_mode,
          current_phase = EXCLUDED.current_phase,
          lifecycle_status = EXCLUDED.lifecycle_status,
          assigned_agent_type = EXCLUDED.assigned_agent_type,
          requested_capabilities = EXCLUDED.requested_capabilities,
          retry_count = EXCLUDED.retry_count,
          evidence_links = EXCLUDED.evidence_links,
          workspace_id = EXCLUDED.workspace_id,
          branch_name = EXCLUDED.branch_name,
          pr_number = EXCLUDED.pr_number,
          policy_version = EXCLUDED.policy_version,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at
      `,
      [
        manifest.taskId,
        JSON.stringify(manifest.source),
        manifest.title,
        manifest.summary,
        manifest.priority,
        manifest.dryRun,
        manifest.riskClass,
        manifest.approvalMode,
        manifest.currentPhase,
        manifest.lifecycleStatus,
        manifest.assignedAgentType,
        JSON.stringify(manifest.requestedCapabilities),
        manifest.retryCount,
        JSON.stringify(manifest.evidenceLinks),
        manifest.workspaceId,
        manifest.branchName,
        manifest.prNumber,
        manifest.policyVersion,
        manifest.createdAt,
        manifest.updatedAt
      ]
    );
  }

  async saveManifest(manifest: TaskManifest): Promise<void> {
    await this.saveManifestWithExecutor(this.pool, manifest);
  }

  async updateManifest(manifest: TaskManifest): Promise<void> {
    await this.saveManifestWithExecutor(this.pool, manifest);
  }

  private async savePhaseRecordWithExecutor(
    executor: QueryExecutor,
    record: PhaseRecord
  ): Promise<void> {
    await executor.query(
      `
        INSERT INTO phase_records (
          record_id,
          task_id,
          phase,
          status,
          actor,
          summary,
          details,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
        ON CONFLICT (record_id, task_id) DO UPDATE SET
          phase = EXCLUDED.phase,
          status = EXCLUDED.status,
          actor = EXCLUDED.actor,
          summary = EXCLUDED.summary,
          details = EXCLUDED.details,
          created_at = EXCLUDED.created_at
      `,
      [
        record.recordId,
        record.taskId,
        record.phase,
        record.status,
        record.actor,
        record.summary,
        JSON.stringify(record.details),
        record.createdAt
      ]
    );
  }

  async savePhaseRecord(record: PhaseRecord): Promise<void> {
    await this.savePhaseRecordWithExecutor(this.pool, record);
  }

  private async savePlanningSpecWithExecutor(
    executor: QueryExecutor,
    spec: PlanningSpec
  ): Promise<void> {
    await executor.query(
      `
        INSERT INTO planning_specs (
          spec_id,
          task_id,
          summary,
          assumptions,
          affected_areas,
          constraints,
          acceptance_criteria,
          test_expectations,
          recommended_agent_type,
          risk_class,
          confidence_level,
          confidence_reason,
          project_size,
          created_at
        ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (spec_id) DO UPDATE SET
          task_id = EXCLUDED.task_id,
          summary = EXCLUDED.summary,
          assumptions = EXCLUDED.assumptions,
          affected_areas = EXCLUDED.affected_areas,
          constraints = EXCLUDED.constraints,
          acceptance_criteria = EXCLUDED.acceptance_criteria,
          test_expectations = EXCLUDED.test_expectations,
          recommended_agent_type = EXCLUDED.recommended_agent_type,
          risk_class = EXCLUDED.risk_class,
          confidence_level = EXCLUDED.confidence_level,
          confidence_reason = EXCLUDED.confidence_reason,
          project_size = EXCLUDED.project_size,
          created_at = EXCLUDED.created_at
      `,
      [
        spec.specId,
        spec.taskId,
        spec.summary,
        JSON.stringify(spec.assumptions),
        JSON.stringify(spec.affectedAreas),
        JSON.stringify(spec.constraints),
        JSON.stringify(spec.acceptanceCriteria),
        JSON.stringify(spec.testExpectations),
        spec.recommendedAgentType,
        spec.riskClass,
        spec.confidenceLevel,
        spec.confidenceReason,
        spec.projectSize ?? "small",
        spec.createdAt
      ]
    );
  }

  async savePlanningSpec(spec: PlanningSpec): Promise<void> {
    await this.savePlanningSpecWithExecutor(this.pool, spec);
  }

  private async savePolicySnapshotWithExecutor(
    executor: QueryExecutor,
    taskId: string,
    snapshot: PolicySnapshot
  ): Promise<void> {
    const now = asIsoTimestamp();
    await executor.query(
      `
        INSERT INTO policy_snapshots (
          task_id,
          snapshot,
          created_at,
          updated_at
        ) VALUES ($1, $2::jsonb, $3, $4)
        ON CONFLICT (task_id) DO UPDATE SET
          snapshot = EXCLUDED.snapshot,
          updated_at = EXCLUDED.updated_at
      `,
      [taskId, JSON.stringify(snapshot), now, now]
    );
  }

  async savePolicySnapshot(
    taskId: string,
    snapshot: PolicySnapshot
  ): Promise<void> {
    await this.savePolicySnapshotWithExecutor(this.pool, taskId, snapshot);
  }

  private async saveEvidenceRecordWithExecutor(
    executor: QueryExecutor,
    record: EvidenceRecord
  ): Promise<void> {
    await executor.query(
      `
        INSERT INTO evidence_records (
          record_id,
          task_id,
          kind,
          title,
          location,
          metadata,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
        ON CONFLICT (record_id) DO UPDATE SET
          task_id = EXCLUDED.task_id,
          kind = EXCLUDED.kind,
          title = EXCLUDED.title,
          location = EXCLUDED.location,
          metadata = EXCLUDED.metadata,
          created_at = EXCLUDED.created_at
      `,
      [
        record.recordId,
        record.taskId,
        record.kind,
        record.title,
        record.location,
        JSON.stringify(record.metadata),
        record.createdAt
      ]
    );
  }

  async saveEvidenceRecord(record: EvidenceRecord): Promise<void> {
    await this.saveEvidenceRecordWithExecutor(this.pool, record);
  }

  private async saveRunEventWithExecutor(
    executor: QueryExecutor,
    event: RunEvent
  ): Promise<void> {
    await executor.query(
      `
        INSERT INTO run_events (
          event_id,
          task_id,
          run_id,
          phase,
          level,
          code,
          message,
          failure_class,
          duration_ms,
          data,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
        ON CONFLICT (event_id) DO UPDATE SET
          task_id = EXCLUDED.task_id,
          run_id = EXCLUDED.run_id,
          phase = EXCLUDED.phase,
          level = EXCLUDED.level,
          code = EXCLUDED.code,
          message = EXCLUDED.message,
          failure_class = EXCLUDED.failure_class,
          duration_ms = EXCLUDED.duration_ms,
          data = EXCLUDED.data,
          created_at = EXCLUDED.created_at
      `,
      [
        event.eventId,
        event.taskId,
        event.runId,
        event.phase,
        event.level,
        event.code,
        event.message,
        event.failureClass ?? null,
        event.durationMs ?? null,
        JSON.stringify(event.data),
        event.createdAt
      ]
    );
  }

  async saveRunEvent(event: RunEvent): Promise<void> {
    await this.saveRunEventWithExecutor(this.pool, event);
  }

  private async saveMemoryRecordWithExecutor(
    executor: QueryExecutor,
    record: MemoryRecord
  ): Promise<void> {
    await executor.query(
      `
        INSERT INTO memory_records (
          memory_id,
          task_id,
          scope,
          provenance,
          key,
          title,
          value,
          repo,
          organization_id,
          source_uri,
          tags,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11::jsonb, $12, $13)
        ON CONFLICT (memory_id) DO UPDATE SET
          task_id = EXCLUDED.task_id,
          scope = EXCLUDED.scope,
          provenance = EXCLUDED.provenance,
          key = EXCLUDED.key,
          title = EXCLUDED.title,
          value = EXCLUDED.value,
          repo = EXCLUDED.repo,
          organization_id = EXCLUDED.organization_id,
          source_uri = EXCLUDED.source_uri,
          tags = EXCLUDED.tags,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at
      `,
      [
        record.memoryId,
        record.taskId,
        record.scope,
        record.provenance,
        record.key,
        record.title,
        JSON.stringify(record.value),
        record.repo,
        record.organizationId,
        record.sourceUri,
        JSON.stringify(record.tags),
        record.createdAt,
        record.updatedAt
      ]
    );
  }

  async saveMemoryRecord(record: MemoryRecord): Promise<void> {
    await this.saveMemoryRecordWithExecutor(this.pool, record);
  }

  async savePipelineRun(run: PipelineRun): Promise<void> {
    await this.savePipelineRunWithExecutor(this.pool, run);
  }

  async claimPipelineRun(
    input: ClaimPipelineRunInput
  ): Promise<ClaimPipelineRunResult> {
    const client = await this.pool.connect();
    const staleRunIds: string[] = [];
    const claimedAtIso = input.run.startedAt;
    const claimedAt = new Date(claimedAtIso);

    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        ["reddwarf.pipeline_run_claim", input.run.concurrencyKey]
      );

      const overlappingResult = await client.query(
        `
          SELECT *
          FROM pipeline_runs
          WHERE concurrency_key = $1
            AND status = 'active'
          ORDER BY started_at DESC, run_id ASC
          FOR UPDATE
        `,
        [input.run.concurrencyKey]
      );
      const overlappingRuns = overlappingResult.rows.map(mapPipelineRunRow);
      let blockedByRun: PipelineRun | null = null;

      for (const overlap of overlappingRuns) {
        if (overlap.runId === input.run.runId) {
          continue;
        }

        if (
          claimedAt.getTime() - new Date(overlap.lastHeartbeatAt).getTime() >
          input.staleAfterMs
        ) {
          const staleRun = pipelineRunSchema.parse({
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
          });
          await this.savePipelineRunWithExecutor(client, staleRun);
          staleRunIds.push(overlap.runId);
          continue;
        }

        blockedByRun = overlap;
        break;
      }

      if (!blockedByRun) {
        await this.savePipelineRunWithExecutor(client, input.run);
      }

      await client.query("COMMIT");
      return { staleRunIds, blockedByRun };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        // Log rollback failures but surface the original error
        console.error("Transaction ROLLBACK failed:", rollbackError);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async saveApprovalRequestWithExecutor(
    executor: QueryExecutor,
    request: ApprovalRequest
  ): Promise<void> {
    await executor.query(
      `
        INSERT INTO approval_requests (
          request_id,
          task_id,
          run_id,
          phase,
          dry_run,
          confidence_level,
          confidence_reason,
          approval_mode,
          status,
          risk_class,
          summary,
          requested_capabilities,
          allowed_paths,
          blocked_phases,
          policy_reasons,
          requested_by,
          decided_by,
          decision,
          decision_summary,
          comment,
          created_at,
          updated_at,
          resolved_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb,
          $13::jsonb, $14::jsonb, $15::jsonb, $16, $17, $18, $19, $20, $21, $22, $23
        )
        ON CONFLICT (request_id) DO UPDATE SET
          task_id = EXCLUDED.task_id,
          run_id = EXCLUDED.run_id,
          phase = EXCLUDED.phase,
          dry_run = EXCLUDED.dry_run,
          confidence_level = EXCLUDED.confidence_level,
          confidence_reason = EXCLUDED.confidence_reason,
          approval_mode = EXCLUDED.approval_mode,
          status = EXCLUDED.status,
          risk_class = EXCLUDED.risk_class,
          summary = EXCLUDED.summary,
          requested_capabilities = EXCLUDED.requested_capabilities,
          allowed_paths = EXCLUDED.allowed_paths,
          blocked_phases = EXCLUDED.blocked_phases,
          policy_reasons = EXCLUDED.policy_reasons,
          requested_by = EXCLUDED.requested_by,
          decided_by = EXCLUDED.decided_by,
          decision = EXCLUDED.decision,
          decision_summary = EXCLUDED.decision_summary,
          comment = EXCLUDED.comment,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at,
          resolved_at = EXCLUDED.resolved_at
      `,
      [
        request.requestId,
        request.taskId,
        request.runId,
        request.phase,
        request.dryRun,
        request.confidenceLevel,
        request.confidenceReason,
        request.approvalMode,
        request.status,
        request.riskClass,
        request.summary,
        JSON.stringify(request.requestedCapabilities),
        JSON.stringify(request.allowedPaths),
        JSON.stringify(request.blockedPhases),
        JSON.stringify(request.policyReasons),
        request.requestedBy,
        request.decidedBy,
        request.decision,
        request.decisionSummary,
        request.comment,
        request.createdAt,
        request.updatedAt,
        request.resolvedAt
      ]
    );
  }

  async saveApprovalRequest(request: ApprovalRequest): Promise<void> {
    await this.saveApprovalRequestWithExecutor(this.pool, request);
  }

  private async saveGitHubIssuePollingCursorWithExecutor(
    executor: QueryExecutor,
    cursor: GitHubIssuePollingCursor
  ): Promise<void> {
    await executor.query(
      `
        INSERT INTO github_issue_polling_cursors (
          repo,
          last_seen_issue_number,
          last_seen_updated_at,
          last_poll_started_at,
          last_poll_completed_at,
          last_poll_status,
          last_poll_error,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (repo) DO UPDATE SET
          last_seen_issue_number = EXCLUDED.last_seen_issue_number,
          last_seen_updated_at = EXCLUDED.last_seen_updated_at,
          last_poll_started_at = EXCLUDED.last_poll_started_at,
          last_poll_completed_at = EXCLUDED.last_poll_completed_at,
          last_poll_status = EXCLUDED.last_poll_status,
          last_poll_error = EXCLUDED.last_poll_error,
          updated_at = EXCLUDED.updated_at
      `,
      [
        cursor.repo,
        cursor.lastSeenIssueNumber,
        cursor.lastSeenUpdatedAt,
        cursor.lastPollStartedAt,
        cursor.lastPollCompletedAt,
        cursor.lastPollStatus,
        cursor.lastPollError,
        cursor.updatedAt
      ]
    );
  }

  async saveGitHubIssuePollingCursor(
    cursor: GitHubIssuePollingCursor
  ): Promise<void> {
    await this.saveGitHubIssuePollingCursorWithExecutor(this.pool, cursor);
  }

  async deleteGitHubIssuePollingCursor(repo: string): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM github_issue_polling_cursors WHERE repo = $1",
      [repo]
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async saveOperatorConfigEntryWithExecutor(
    executor: QueryExecutor,
    entry: OperatorConfigEntry
  ): Promise<void> {
    await executor.query(
      `
        INSERT INTO operator_config (
          key,
          value,
          updated_at
        ) VALUES ($1, $2::jsonb, $3)
        ON CONFLICT (key) DO UPDATE SET
          value = EXCLUDED.value,
          updated_at = EXCLUDED.updated_at
      `,
      [entry.key, JSON.stringify(entry.value), entry.updatedAt]
    );
  }

  async saveOperatorConfigEntry(entry: OperatorConfigEntry): Promise<void> {
    await this.saveOperatorConfigEntryWithExecutor(this.pool, entry);
  }

  private async savePromptSnapshotWithExecutor(
    executor: QueryExecutor,
    snapshot: PromptSnapshot
  ): Promise<PromptSnapshot> {
    const result = await executor.query(
      `
        INSERT INTO prompt_snapshots (
          snapshot_id,
          phase,
          prompt_hash,
          prompt_path,
          captured_at
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (phase, prompt_hash) DO UPDATE SET
          prompt_path = EXCLUDED.prompt_path
        RETURNING *
      `,
      [
        snapshot.snapshotId,
        snapshot.phase,
        snapshot.promptHash,
        snapshot.promptPath,
        snapshot.capturedAt
      ]
    );

    return mapPromptSnapshotRow(result.rows[0]);
  }

  async savePromptSnapshot(snapshot: PromptSnapshot): Promise<PromptSnapshot> {
    return this.savePromptSnapshotWithExecutor(this.pool, snapshot);
  }

  private async saveEligibilityRejectionWithExecutor(
    executor: QueryExecutor,
    record: EligibilityRejectionRecord
  ): Promise<void> {
    await executor.query(
      `
        INSERT INTO eligibility_rejections (
          rejection_id,
          task_id,
          rejected_at,
          reason_code,
          reason_detail,
          policy_version,
          source_issue,
          dry_run
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
        ON CONFLICT (rejection_id) DO UPDATE SET
          task_id = EXCLUDED.task_id,
          rejected_at = EXCLUDED.rejected_at,
          reason_code = EXCLUDED.reason_code,
          reason_detail = EXCLUDED.reason_detail,
          policy_version = EXCLUDED.policy_version,
          source_issue = EXCLUDED.source_issue,
          dry_run = EXCLUDED.dry_run
      `,
      [
        record.rejectionId,
        record.taskId,
        record.rejectedAt,
        record.reasonCode,
        record.reasonDetail,
        record.policyVersion,
        JSON.stringify(record.sourceIssue),
        record.dryRun
      ]
    );
  }

  async saveEligibilityRejection(record: EligibilityRejectionRecord): Promise<void> {
    await this.saveEligibilityRejectionWithExecutor(this.pool, record);
  }

  async runInTransaction<T>(
    operation: (repository: PlanningTransactionRepository) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    const repository: PlanningTransactionRepository = {
      saveManifest: (manifest) => this.saveManifestWithExecutor(client, manifest),
      updateManifest: (manifest) => this.saveManifestWithExecutor(client, manifest),
      savePhaseRecord: (record) => this.savePhaseRecordWithExecutor(client, record),
      saveEvidenceRecord: (record) => this.saveEvidenceRecordWithExecutor(client, record),
      saveRunEvent: (event) => this.saveRunEventWithExecutor(client, event),
      saveMemoryRecord: (record) => this.saveMemoryRecordWithExecutor(client, record),
      savePipelineRun: (run) => this.savePipelineRunWithExecutor(client, run),
      saveApprovalRequest: (request) => this.saveApprovalRequestWithExecutor(client, request),
      saveOperatorConfigEntry: (entry) =>
        this.saveOperatorConfigEntryWithExecutor(client, entry),
      savePromptSnapshot: (snapshot) => this.savePromptSnapshotWithExecutor(client, snapshot),
      saveEligibilityRejection: (record) =>
        this.saveEligibilityRejectionWithExecutor(client, record),
      getProjectSpec: (projectId) => this.getProjectSpecWithExecutor(client, projectId),
      saveProjectSpec: (project) => this.saveProjectSpecWithExecutor(client, project),
      getTicketSpec: (ticketId) => this.getTicketSpecWithExecutor(client, ticketId),
      saveTicketSpec: (ticket) => this.saveTicketSpecWithExecutor(client, ticket),
      listTicketSpecs: async (projectId) => {
        const result = await client.query(
          `SELECT * FROM ticket_specs WHERE project_id = $1 ORDER BY created_at ASC`,
          [projectId]
        );
        return result.rows.map(mapTicketSpecRow);
      },
      resolveNextReadyTicket: (projectId) =>
        this.resolveNextReadyTicketWithExecutor(client, projectId),
      getManifest: async (taskId) => {
        const result = await client.query(
          "SELECT * FROM task_manifests WHERE task_id = $1",
          [taskId]
        );
        return result.rows[0] ? mapManifestRow(result.rows[0]) : null;
      },
      getTaskSnapshot: (taskId) => this.getTaskSnapshotWithExecutor(client, taskId),
      savePlanningSpec: (spec) => this.savePlanningSpecWithExecutor(client, spec),
      savePolicySnapshot: (taskId, snapshot) =>
        this.savePolicySnapshotWithExecutor(client, taskId, snapshot)
    };

    try {
      await client.query("BEGIN");
      const result = await operation(repository);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        // Log rollback failures but surface the original error
        console.error("Transaction ROLLBACK failed:", rollbackError);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async getManifest(taskId: string): Promise<TaskManifest | null> {
    const result = await this.pool.query(
      "SELECT * FROM task_manifests WHERE task_id = $1",
      [taskId]
    );
    return result.rows[0] ? mapManifestRow(result.rows[0]) : null;
  }

  async getApprovalRequest(requestId: string): Promise<ApprovalRequest | null> {
    const result = await this.pool.query(
      "SELECT * FROM approval_requests WHERE request_id = $1",
      [requestId]
    );
    return result.rows[0] ? mapApprovalRequestRow(result.rows[0]) : null;
  }

  async getGitHubIssuePollingCursor(
    repo: string
  ): Promise<GitHubIssuePollingCursor | null> {
    const result = await this.pool.query(
      "SELECT * FROM github_issue_polling_cursors WHERE repo = $1",
      [repo]
    );
    return result.rows[0] ? mapGitHubIssuePollingCursorRow(result.rows[0]) : null;
  }

  async getOperatorConfigEntry(
    key: OperatorConfigEntry["key"]
  ): Promise<OperatorConfigEntry | null> {
    const result = await this.pool.query(
      "SELECT * FROM operator_config WHERE key = $1",
      [key]
    );
    return result.rows[0] ? mapOperatorConfigRow(result.rows[0]) : null;
  }

  async hasPlanningSpecForSource(
    source: TaskManifest["source"]
  ): Promise<boolean> {
    const conditions = [
      "task_manifests.source ->> 'provider' = $1",
      "task_manifests.source ->> 'repo' = $2",
      "task_manifests.dry_run = FALSE"
    ];
    const params: unknown[] = [source.provider, source.repo];

    if (source.issueNumber !== undefined) {
      conditions.push("task_manifests.source ->> 'issueNumber' = $3");
      params.push(String(source.issueNumber));
    } else if (source.issueId !== undefined) {
      conditions.push("task_manifests.source ->> 'issueId' = $3");
      params.push(String(source.issueId));
    }

    const result = await this.pool.query(
      `
        SELECT 1
        FROM task_manifests
        INNER JOIN planning_specs
          ON planning_specs.task_id = task_manifests.task_id
        WHERE ${conditions.join(" AND ")}
        LIMIT 1
      `,
      params
    );

    return (result.rowCount ?? 0) > 0;
  }

  async getPlanningSpec(taskId: string): Promise<PlanningSpec | null> {
    const result = await this.pool.query(
      "SELECT * FROM planning_specs WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1",
      [taskId]
    );
    return result.rows[0] ? mapPlanningSpecRow(result.rows[0]) : null;
  }

  async getPolicySnapshot(taskId: string): Promise<PolicySnapshot | null> {
    const result = await this.pool.query(
      "SELECT * FROM policy_snapshots WHERE task_id = $1",
      [taskId]
    );
    return result.rows[0] ? mapPolicySnapshotRow(result.rows[0]) : null;
  }

  async getPipelineRun(runId: string): Promise<PipelineRun | null> {
    const result = await this.pool.query(
      "SELECT * FROM pipeline_runs WHERE run_id = $1",
      [runId]
    );
    return result.rows[0] ? mapPipelineRunRow(result.rows[0]) : null;
  }

  async getPromptSnapshot(snapshotId: string): Promise<PromptSnapshot | null> {
    const result = await this.pool.query(
      "SELECT * FROM prompt_snapshots WHERE snapshot_id = $1",
      [snapshotId]
    );
    return result.rows[0] ? mapPromptSnapshotRow(result.rows[0]) : null;
  }

  async listPhaseRecords(taskId: string): Promise<PhaseRecord[]> {
    const result = await this.pool.query(
      "SELECT * FROM phase_records WHERE task_id = $1 ORDER BY created_at ASC, record_id ASC",
      [taskId]
    );

    return result.rows.map(mapPhaseRecordRow);
  }

  async listEvidenceRecords(taskId: string): Promise<EvidenceRecord[]> {
    const result = await this.pool.query(
      "SELECT * FROM evidence_records WHERE task_id = $1 ORDER BY created_at ASC, record_id ASC",
      [taskId]
    );

    return result.rows.map(mapEvidenceRecordRow);
  }

  async listRunEvents(taskId: string, runId?: string): Promise<RunEvent[]> {
    const params = runId === undefined ? [taskId] : [taskId, runId];
    const sql =
      runId === undefined
        ? "SELECT * FROM run_events WHERE task_id = $1 ORDER BY created_at ASC, event_id ASC"
        : "SELECT * FROM run_events WHERE task_id = $1 AND run_id = $2 ORDER BY created_at ASC, event_id ASC";
    const result = await this.pool.query(sql, params);

    return result.rows.map(mapRunEventRow);
  }
  async listMemoryRecords(
    query: Partial<MemoryQuery> = {}
  ): Promise<MemoryRecord[]> {
    const parsed = normalizeMemoryQuery(query);
    const conditions: string[] = [];
    const params: unknown[] = [];
    let parameterIndex = 1;

    if (parsed.taskId) {
      conditions.push(`task_id = $${parameterIndex}`);
      params.push(parsed.taskId);
      parameterIndex += 1;
    }

    if (parsed.repo) {
      conditions.push(`repo = $${parameterIndex}`);
      params.push(parsed.repo);
      parameterIndex += 1;
    }

    if (parsed.organizationId) {
      conditions.push(`organization_id = $${parameterIndex}`);
      params.push(parsed.organizationId);
      parameterIndex += 1;
    }

    if (parsed.sourceUri) {
      conditions.push(`source_uri = $${parameterIndex}`);
      params.push(parsed.sourceUri);
      parameterIndex += 1;
    }

    if (parsed.scope) {
      conditions.push(`scope = $${parameterIndex}`);
      params.push(parsed.scope);
      parameterIndex += 1;
    }

    if (parsed.keyPrefix) {
      conditions.push(`"key" LIKE $${parameterIndex}`);
      params.push(`${parsed.keyPrefix}%`);
      parameterIndex += 1;
    }

    if (parsed.tags.length > 0) {
      conditions.push(`tags @> $${parameterIndex}::jsonb`);
      params.push(JSON.stringify(parsed.tags));
      parameterIndex += 1;
    }

    params.push(parsed.limit);
    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query(
      `SELECT * FROM memory_records ${whereClause} ORDER BY updated_at DESC, created_at DESC, memory_id ASC LIMIT $${parameterIndex}`,
      params
    );

    return result.rows.map(mapMemoryRecordRow);
  }

  async listManifestsByLifecycleStatus(
    status: string,
    limit = 100
  ): Promise<TaskManifest[]> {
    const result = await this.pool.query(
      "SELECT * FROM task_manifests WHERE lifecycle_status = $1 ORDER BY updated_at ASC LIMIT $2",
      [status, limit]
    );
    return result.rows.map(mapManifestRow);
  }

  async listTaskManifests(
    query: Partial<import("@reddwarf/contracts").TaskManifestQuery> = {}
  ): Promise<TaskManifest[]> {
    const parsed = normalizeTaskManifestQuery(query);
    const conditions: string[] = [];
    const params: unknown[] = [];
    let parameterIndex = 1;

    if (parsed.repo) {
      conditions.push(`source->>'repo' = $${parameterIndex}`);
      params.push(parsed.repo);
      parameterIndex += 1;
    }

    if (parsed.lifecycleStatuses.length > 0) {
      conditions.push(`lifecycle_status = ANY($${parameterIndex})`);
      params.push(parsed.lifecycleStatuses);
      parameterIndex += 1;
    }

    if (parsed.phases.length > 0) {
      conditions.push(`current_phase = ANY($${parameterIndex})`);
      params.push(parsed.phases);
      parameterIndex += 1;
    }

    params.push(parsed.limit);
    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query(
      `SELECT * FROM task_manifests ${whereClause} ORDER BY updated_at DESC, task_id ASC LIMIT $${parameterIndex}`,
      params
    );

    return result.rows.map(mapManifestRow);
  }

  async listPipelineRuns(
    query: Partial<PipelineRunQuery> = {}
  ): Promise<PipelineRun[]> {
    const parsed = normalizePipelineRunQuery(query);
    const conditions: string[] = [];
    const params: unknown[] = [];
    let parameterIndex = 1;

    if (parsed.taskId) {
      conditions.push(`task_id = $${parameterIndex}`);
      params.push(parsed.taskId);
      parameterIndex += 1;
    }

    if (parsed.repo) {
      conditions.push(
        `EXISTS (SELECT 1 FROM task_manifests tm WHERE tm.task_id = pipeline_runs.task_id AND tm.source->>'repo' = $${parameterIndex})`
      );
      params.push(parsed.repo);
      parameterIndex += 1;
    }

    if (parsed.concurrencyKey) {
      conditions.push(`concurrency_key = $${parameterIndex}`);
      params.push(parsed.concurrencyKey);
      parameterIndex += 1;
    }

    if (parsed.statuses.length > 0) {
      conditions.push(`status = ANY($${parameterIndex})`);
      params.push(parsed.statuses);
      parameterIndex += 1;
    }

    params.push(parsed.limit);
    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query(
      `SELECT * FROM pipeline_runs ${whereClause} ORDER BY started_at DESC, run_id ASC LIMIT $${parameterIndex}`,
      params
    );

    return result.rows.map(mapPipelineRunRow);
  }

  async listGitHubIssuePollingCursors(): Promise<GitHubIssuePollingCursor[]> {
    const result = await this.pool.query(
      "SELECT * FROM github_issue_polling_cursors ORDER BY repo ASC"
    );

    return result.rows.map(mapGitHubIssuePollingCursorRow);
  }

  async listOperatorConfigEntries(): Promise<OperatorConfigEntry[]> {
    const result = await this.pool.query(
      "SELECT * FROM operator_config ORDER BY key ASC"
    );

    return result.rows.map(mapOperatorConfigRow);
  }

  async listPromptSnapshots(): Promise<PromptSnapshot[]> {
    const result = await this.pool.query(
      "SELECT * FROM prompt_snapshots ORDER BY captured_at DESC, phase ASC"
    );

    return result.rows.map(mapPromptSnapshotRow);
  }

  async listEligibilityRejections(
    query: Partial<EligibilityRejectionQuery> = {}
  ): Promise<EligibilityRejectionRecord[]> {
    const parsed = normalizeEligibilityRejectionQuery(query);
    const conditions: string[] = [];
    const params: unknown[] = [];
    let parameterIndex = 1;

    if (parsed.reasonCode) {
      conditions.push(`reason_code = $${parameterIndex}`);
      params.push(parsed.reasonCode);
      parameterIndex += 1;
    }

    if (parsed.since) {
      conditions.push(`rejected_at >= $${parameterIndex}`);
      params.push(parsed.since);
      parameterIndex += 1;
    }

    params.push(parsed.limit);
    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query(
      `SELECT * FROM eligibility_rejections ${whereClause} ORDER BY rejected_at DESC, rejection_id ASC LIMIT $${parameterIndex}`,
      params
    );

    return result.rows.map(mapEligibilityRejectionRow);
  }

  async listApprovalRequests(
    query: Partial<ApprovalRequestQuery> = {}
  ): Promise<ApprovalRequest[]> {
    const parsed = normalizeApprovalRequestQuery(query);
    const conditions: string[] = [];
    const params: unknown[] = [];
    let parameterIndex = 1;

    if (parsed.taskId) {
      conditions.push(`task_id = $${parameterIndex}`);
      params.push(parsed.taskId);
      parameterIndex += 1;
    }

    if (parsed.runId) {
      conditions.push(`run_id = $${parameterIndex}`);
      params.push(parsed.runId);
      parameterIndex += 1;
    }

    if (parsed.statuses.length > 0) {
      conditions.push(`status = ANY($${parameterIndex})`);
      params.push(parsed.statuses);
      parameterIndex += 1;
    }

    params.push(parsed.limit);
    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query(
      `SELECT * FROM approval_requests ${whereClause} ORDER BY updated_at DESC, created_at DESC, request_id ASC LIMIT $${parameterIndex}`,
      params
    );

    return result.rows.map(mapApprovalRequestRow);
  }

  private async getTaskSnapshotWithExecutor(
    executor: QueryExecutor,
    taskId: string
  ): Promise<PersistedTaskSnapshot> {
    const result = await executor.query(
      `
      SELECT
        (SELECT row_to_json(m.*) FROM task_manifests m WHERE m.task_id = $1) AS manifest,
        (SELECT row_to_json(s.*) FROM planning_specs s WHERE s.task_id = $1 ORDER BY s.created_at DESC LIMIT 1) AS spec,
        (SELECT row_to_json(ps.*) FROM policy_snapshots ps WHERE ps.task_id = $1) AS policy_snapshot,
        (SELECT COALESCE(json_agg(pr ORDER BY pr.created_at ASC, pr.record_id ASC), '[]'::json) FROM phase_records pr WHERE pr.task_id = $1) AS phase_records,
        (SELECT COALESCE(json_agg(er ORDER BY er.created_at ASC, er.record_id ASC), '[]'::json) FROM evidence_records er WHERE er.task_id = $1) AS evidence_records,
        (SELECT COALESCE(json_agg(re ORDER BY re.created_at ASC, re.event_id ASC), '[]'::json) FROM run_events re WHERE re.task_id = $1) AS run_events,
        (SELECT COALESCE(json_agg(mr ORDER BY mr.updated_at DESC, mr.created_at DESC, mr.memory_id ASC), '[]'::json) FROM (SELECT * FROM memory_records WHERE task_id = $1 AND scope = 'task' ORDER BY updated_at DESC, created_at DESC, memory_id ASC LIMIT 100) mr) AS memory_records,
        (SELECT COALESCE(json_agg(plr ORDER BY plr.started_at DESC, plr.run_id ASC), '[]'::json) FROM (SELECT * FROM pipeline_runs WHERE task_id = $1 ORDER BY started_at DESC, run_id ASC LIMIT 100) plr) AS pipeline_runs,
        (SELECT COALESCE(json_agg(ar ORDER BY ar.updated_at DESC, ar.created_at DESC, ar.request_id ASC), '[]'::json) FROM (SELECT * FROM approval_requests WHERE task_id = $1 ORDER BY updated_at DESC, created_at DESC, request_id ASC LIMIT 100) ar) AS approval_requests
      `,
      [taskId]
    );

    const row = result.rows[0];

    return {
      manifest: row.manifest ? mapManifestRow(row.manifest) : null,
      spec: row.spec ? mapPlanningSpecRow(row.spec) : null,
      policySnapshot: row.policy_snapshot ? mapPolicySnapshotRow(row.policy_snapshot) : null,
      phaseRecords: (row.phase_records as Record<string, unknown>[]).map(mapPhaseRecordRow),
      evidenceRecords: (row.evidence_records as Record<string, unknown>[]).map(mapEvidenceRecordRow),
      runEvents: (row.run_events as Record<string, unknown>[]).map(mapRunEventRow),
      memoryRecords: (row.memory_records as Record<string, unknown>[]).map(mapMemoryRecordRow),
      pipelineRuns: (row.pipeline_runs as Record<string, unknown>[]).map(mapPipelineRunRow),
      approvalRequests: (row.approval_requests as Record<string, unknown>[]).map(mapApprovalRequestRow)
    };
  }

  async getTaskSnapshot(taskId: string): Promise<PersistedTaskSnapshot> {
    const result = await this.pool.query(
      `
      SELECT
        (SELECT row_to_json(m.*) FROM task_manifests m WHERE m.task_id = $1) AS manifest,
        (SELECT row_to_json(s.*) FROM planning_specs s WHERE s.task_id = $1 ORDER BY s.created_at DESC LIMIT 1) AS spec,
        (SELECT row_to_json(ps.*) FROM policy_snapshots ps WHERE ps.task_id = $1) AS policy_snapshot,
        (SELECT COALESCE(json_agg(pr ORDER BY pr.created_at ASC, pr.record_id ASC), '[]'::json) FROM phase_records pr WHERE pr.task_id = $1) AS phase_records,
        (SELECT COALESCE(json_agg(er ORDER BY er.created_at ASC, er.record_id ASC), '[]'::json) FROM evidence_records er WHERE er.task_id = $1) AS evidence_records,
        (SELECT COALESCE(json_agg(re ORDER BY re.created_at ASC, re.event_id ASC), '[]'::json) FROM run_events re WHERE re.task_id = $1) AS run_events,
        (SELECT COALESCE(json_agg(mr ORDER BY mr.updated_at DESC, mr.created_at DESC, mr.memory_id ASC), '[]'::json) FROM (SELECT * FROM memory_records WHERE task_id = $1 AND scope = 'task' ORDER BY updated_at DESC, created_at DESC, memory_id ASC LIMIT 100) mr) AS memory_records,
        (SELECT COALESCE(json_agg(plr ORDER BY plr.started_at DESC, plr.run_id ASC), '[]'::json) FROM (SELECT * FROM pipeline_runs WHERE task_id = $1 ORDER BY started_at DESC, run_id ASC LIMIT 100) plr) AS pipeline_runs,
        (SELECT COALESCE(json_agg(ar ORDER BY ar.updated_at DESC, ar.created_at DESC, ar.request_id ASC), '[]'::json) FROM (SELECT * FROM approval_requests WHERE task_id = $1 ORDER BY updated_at DESC, created_at DESC, request_id ASC LIMIT 100) ar) AS approval_requests
      `,
      [taskId]
    );

    const row = result.rows[0];

    return {
      manifest: row.manifest ? mapManifestRow(row.manifest) : null,
      spec: row.spec ? mapPlanningSpecRow(row.spec) : null,
      policySnapshot: row.policy_snapshot ? mapPolicySnapshotRow(row.policy_snapshot) : null,
      phaseRecords: (row.phase_records as Record<string, unknown>[]).map(mapPhaseRecordRow),
      evidenceRecords: (row.evidence_records as Record<string, unknown>[]).map(mapEvidenceRecordRow),
      runEvents: (row.run_events as Record<string, unknown>[]).map(mapRunEventRow),
      memoryRecords: (row.memory_records as Record<string, unknown>[]).map(mapMemoryRecordRow),
      pipelineRuns: (row.pipeline_runs as Record<string, unknown>[]).map(mapPipelineRunRow),
      approvalRequests: (row.approval_requests as Record<string, unknown>[]).map(mapApprovalRequestRow)
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

  private async saveProjectSpecWithExecutor(
    executor: QueryExecutor,
    project: ProjectSpec
  ): Promise<void> {
    // Validate status transition if updating an existing record
    // Use FOR UPDATE to prevent TOCTOU races — concurrent transactions will block here
    const existing = await this.getProjectSpecWithExecutor(executor, project.projectId, { forUpdate: true });
    if (existing && existing.status !== project.status) {
      assertValidProjectStatusTransition(existing.status, project.status);
    }
    await executor.query(
      `
        INSERT INTO project_specs (
          project_id, source_issue_id, source_repo, title, summary,
          project_size, status, complexity_classification,
          approval_decision, decided_by, decision_summary, amendments,
          clarification_questions, clarification_answers, clarification_requested_at,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15, $16, $17)
        ON CONFLICT (project_id) DO UPDATE SET
          source_issue_id = EXCLUDED.source_issue_id,
          source_repo = EXCLUDED.source_repo,
          title = EXCLUDED.title,
          summary = EXCLUDED.summary,
          project_size = EXCLUDED.project_size,
          status = EXCLUDED.status,
          complexity_classification = EXCLUDED.complexity_classification,
          approval_decision = EXCLUDED.approval_decision,
          decided_by = EXCLUDED.decided_by,
          decision_summary = EXCLUDED.decision_summary,
          amendments = EXCLUDED.amendments,
          clarification_questions = EXCLUDED.clarification_questions,
          clarification_answers = EXCLUDED.clarification_answers,
          clarification_requested_at = EXCLUDED.clarification_requested_at,
          updated_at = EXCLUDED.updated_at
      `,
      [
        project.projectId,
        project.sourceIssueId,
        project.sourceRepo,
        project.title,
        project.summary,
        project.projectSize,
        project.status,
        project.complexityClassification
          ? JSON.stringify(project.complexityClassification)
          : null,
        project.approvalDecision,
        project.decidedBy,
        project.decisionSummary,
        project.amendments,
        project.clarificationQuestions
          ? JSON.stringify(project.clarificationQuestions)
          : null,
        project.clarificationAnswers
          ? JSON.stringify(project.clarificationAnswers)
          : null,
        project.clarificationRequestedAt,
        project.createdAt,
        project.updatedAt
      ]
    );
  }

  async saveProjectSpec(project: ProjectSpec): Promise<void> {
    await this.saveProjectSpecWithExecutor(this.pool, project);
  }

  private async saveTicketSpecWithExecutor(
    executor: QueryExecutor,
    ticket: TicketSpec
  ): Promise<void> {
    // Validate status transition if updating an existing record
    // Use FOR UPDATE to prevent TOCTOU races — concurrent transactions will block here
    const existing = await this.getTicketSpecWithExecutor(executor, ticket.ticketId, { forUpdate: true });
    if (existing && existing.status !== ticket.status) {
      assertValidTicketStatusTransition(existing.status, ticket.status);
    }
    await executor.query(
      `
        INSERT INTO ticket_specs (
          ticket_id, project_id, title, description,
          acceptance_criteria, depends_on, status,
          complexity_class, risk_class,
          github_sub_issue_number, github_pr_number,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (ticket_id) DO UPDATE SET
          project_id = EXCLUDED.project_id,
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          acceptance_criteria = EXCLUDED.acceptance_criteria,
          depends_on = EXCLUDED.depends_on,
          status = EXCLUDED.status,
          complexity_class = EXCLUDED.complexity_class,
          risk_class = EXCLUDED.risk_class,
          github_sub_issue_number = EXCLUDED.github_sub_issue_number,
          github_pr_number = EXCLUDED.github_pr_number,
          updated_at = EXCLUDED.updated_at
      `,
      [
        ticket.ticketId,
        ticket.projectId,
        ticket.title,
        ticket.description,
        JSON.stringify(ticket.acceptanceCriteria),
        JSON.stringify(ticket.dependsOn),
        ticket.status,
        ticket.complexityClass,
        ticket.riskClass,
        ticket.githubSubIssueNumber,
        ticket.githubPrNumber,
        ticket.createdAt,
        ticket.updatedAt
      ]
    );
  }

  async saveTicketSpec(ticket: TicketSpec): Promise<void> {
    await this.saveTicketSpecWithExecutor(this.pool, ticket);
  }

  async updateProjectStatus(projectId: string, status: ProjectSpec["status"]): Promise<void> {
    const existing = await this.getProjectSpec(projectId);
    if (existing && existing.status !== status) {
      assertValidProjectStatusTransition(existing.status, status);
    }
    const now = asIsoTimestamp();
    await this.pool.query(
      `UPDATE project_specs SET status = $1, updated_at = $2 WHERE project_id = $3`,
      [status, now, projectId]
    );
  }

  async updateTicketStatus(ticketId: string, status: TicketSpec["status"]): Promise<void> {
    const existing = await this.getTicketSpec(ticketId);
    if (existing && existing.status !== status) {
      assertValidTicketStatusTransition(existing.status, status);
    }
    const now = asIsoTimestamp();
    await this.pool.query(
      `UPDATE ticket_specs SET status = $1, updated_at = $2 WHERE ticket_id = $3`,
      [status, now, ticketId]
    );
  }

  private async getProjectSpecWithExecutor(
    executor: QueryExecutor,
    projectId: string,
    options?: { forUpdate?: boolean }
  ): Promise<ProjectSpec | null> {
    const lockClause = options?.forUpdate ? " FOR UPDATE" : "";
    const result = await executor.query(
      `SELECT * FROM project_specs WHERE project_id = $1${lockClause}`,
      [projectId]
    );
    return result.rows[0] ? mapProjectSpecRow(result.rows[0]) : null;
  }

  async getProjectSpec(projectId: string): Promise<ProjectSpec | null> {
    return this.getProjectSpecWithExecutor(this.pool, projectId);
  }

  async listProjectSpecs(repo?: string): Promise<ProjectSpec[]> {
    if (repo) {
      const result = await this.pool.query(
        `SELECT * FROM project_specs WHERE source_repo = $1 ORDER BY created_at DESC`,
        [repo]
      );
      return result.rows.map(mapProjectSpecRow);
    }
    const result = await this.pool.query(
      `SELECT * FROM project_specs ORDER BY created_at DESC`
    );
    return result.rows.map(mapProjectSpecRow);
  }

  private async getTicketSpecWithExecutor(
    executor: QueryExecutor,
    ticketId: string,
    options?: { forUpdate?: boolean }
  ): Promise<TicketSpec | null> {
    const lockClause = options?.forUpdate ? " FOR UPDATE" : "";
    const result = await executor.query(
      `SELECT * FROM ticket_specs WHERE ticket_id = $1${lockClause}`,
      [ticketId]
    );
    return result.rows[0] ? mapTicketSpecRow(result.rows[0]) : null;
  }

  async getTicketSpec(ticketId: string): Promise<TicketSpec | null> {
    return this.getTicketSpecWithExecutor(this.pool, ticketId);
  }

  async listTicketSpecs(projectId: string): Promise<TicketSpec[]> {
    const result = await this.pool.query(
      `SELECT * FROM ticket_specs WHERE project_id = $1 ORDER BY created_at ASC`,
      [projectId]
    );
    return result.rows.map(mapTicketSpecRow);
  }

  private async resolveNextReadyTicketWithExecutor(
    executor: QueryExecutor,
    projectId: string
  ): Promise<TicketSpec | null> {
    // Use FOR UPDATE SKIP LOCKED to prevent concurrent dispatch of the same ticket.
    // When called inside a transaction, this acquires a row-level lock on the
    // selected ticket, ensuring only one caller can dispatch it.
    const ticketsResult = await executor.query(
      `SELECT * FROM ticket_specs WHERE project_id = $1 ORDER BY created_at ASC`,
      [projectId]
    );
    const tickets = ticketsResult.rows.map(mapTicketSpecRow);
    const mergedIds = new Set(
      tickets.filter((t) => t.status === "merged").map((t) => t.ticketId)
    );
    for (const ticket of tickets) {
      if (ticket.status !== "pending") continue;
      const allDepsResolved = ticket.dependsOn.every((dep) => mergedIds.has(dep));
      if (allDepsResolved) {
        // Attempt to lock this specific ticket row; skip if already locked
        const lockResult = await executor.query(
          `SELECT * FROM ticket_specs WHERE ticket_id = $1 AND status = 'pending' FOR UPDATE SKIP LOCKED`,
          [ticket.ticketId]
        );
        if (lockResult.rows.length > 0) {
          return mapTicketSpecRow(lockResult.rows[0]);
        }
        // Row was locked by another transaction — skip and try next candidate
      }
    }
    return null;
  }

  async resolveNextReadyTicket(projectId: string): Promise<TicketSpec | null> {
    return this.resolveNextReadyTicketWithExecutor(this.pool, projectId);
  }
}


export * from "./row-mappers.js";
export * from "./schema.js";
