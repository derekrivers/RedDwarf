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
  type FailureClass,
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
import pg from "pg";
import {
  createApprovalRequest,
  createMemoryRecord,
  createPipelineRun,
  createRunEvent
} from "./factories.js";
import { buildMemoryContextForRepository, summarizeRunEvents } from "./summarize.js";
import {
  normalizeApprovalRequestQuery,
  normalizeMemoryQuery,
  normalizePipelineRunQuery,
  type PlanningRepository,
  type PersistedTaskSnapshot
} from "./repository.js";
export class PostgresPlanningRepository implements PlanningRepository {
  private readonly pool: pg.Pool;

  constructor(options: { connectionString: string; max?: number }) {
    this.pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.max ?? 10
    });
  }

  async healthcheck(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async saveManifest(manifest: TaskManifest): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO task_manifests (
          task_id,
          source,
          title,
          summary,
          priority,
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
          $1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10,
          $11::jsonb, $12, $13::jsonb, $14, $15, $16, $17, $18, $19
        )
        ON CONFLICT (task_id) DO UPDATE SET
          source = EXCLUDED.source,
          title = EXCLUDED.title,
          summary = EXCLUDED.summary,
          priority = EXCLUDED.priority,
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

  async updateManifest(manifest: TaskManifest): Promise<void> {
    await this.saveManifest(manifest);
  }

  async savePhaseRecord(record: PhaseRecord): Promise<void> {
    await this.pool.query(
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

  async savePlanningSpec(spec: PlanningSpec): Promise<void> {
    await this.pool.query(
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
          created_at
        ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11)
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
        spec.createdAt
      ]
    );
  }
  async savePolicySnapshot(
    taskId: string,
    snapshot: PolicySnapshot
  ): Promise<void> {
    const now = asIsoTimestamp();
    await this.pool.query(
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

  async saveEvidenceRecord(record: EvidenceRecord): Promise<void> {
    await this.pool.query(
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

  async saveRunEvent(event: RunEvent): Promise<void> {
    await this.pool.query(
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

  async saveMemoryRecord(record: MemoryRecord): Promise<void> {
    await this.pool.query(
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

  async savePipelineRun(run: PipelineRun): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO pipeline_runs (
          run_id,
          task_id,
          concurrency_key,
          strategy,
          status,
          blocked_by_run_id,
          overlap_reason,
          started_at,
          last_heartbeat_at,
          completed_at,
          stale_at,
          metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
        ON CONFLICT (run_id) DO UPDATE SET
          task_id = EXCLUDED.task_id,
          concurrency_key = EXCLUDED.concurrency_key,
          strategy = EXCLUDED.strategy,
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

  async saveApprovalRequest(request: ApprovalRequest): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO approval_requests (
          request_id,
          task_id,
          run_id,
          phase,
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
          $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb,
          $11::jsonb, $12::jsonb, $13, $14, $15, $16, $17, $18, $19, $20
        )
        ON CONFLICT (request_id) DO UPDATE SET
          task_id = EXCLUDED.task_id,
          run_id = EXCLUDED.run_id,
          phase = EXCLUDED.phase,
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


function mapManifestRow(row: Record<string, unknown>): TaskManifest {
  return {
    taskId: row.task_id as string,
    source: row.source as TaskManifest["source"],
    title: row.title as string,
    summary: row.summary as string,
    priority: row.priority as number,
    riskClass: row.risk_class as TaskManifest["riskClass"],
    approvalMode: row.approval_mode as TaskManifest["approvalMode"],
    currentPhase: row.current_phase as TaskManifest["currentPhase"],
    lifecycleStatus: row.lifecycle_status as TaskManifest["lifecycleStatus"],
    assignedAgentType:
      row.assigned_agent_type as TaskManifest["assignedAgentType"],
    requestedCapabilities:
      row.requested_capabilities as TaskManifest["requestedCapabilities"],
    retryCount: row.retry_count as number,
    evidenceLinks: row.evidence_links as string[],
    workspaceId: (row.workspace_id as string | null) ?? null,
    branchName: (row.branch_name as string | null) ?? null,
    prNumber: (row.pr_number as number | null) ?? null,
    policyVersion: row.policy_version as string,
    createdAt: asIsoTimestamp(new Date(row.created_at as string | Date)),
    updatedAt: asIsoTimestamp(new Date(row.updated_at as string | Date))
  };
}

function mapPhaseRecordRow(row: Record<string, unknown>): PhaseRecord {
  return {
    recordId: row.record_id as string,
    taskId: row.task_id as string,
    phase: row.phase as PhaseRecord["phase"],
    status: row.status as PhaseRecord["status"],
    actor: row.actor as string,
    summary: row.summary as string,
    details: (row.details as Record<string, unknown>) ?? {},
    createdAt: asIsoTimestamp(new Date(row.created_at as string | Date))
  };
}

function mapPlanningSpecRow(row: Record<string, unknown>): PlanningSpec {
  return {
    specId: row.spec_id as string,
    taskId: row.task_id as string,
    summary: row.summary as string,
    assumptions: row.assumptions as string[],
    affectedAreas: row.affected_areas as string[],
    constraints: row.constraints as string[],
    acceptanceCriteria: row.acceptance_criteria as string[],
    testExpectations: row.test_expectations as string[],
    recommendedAgentType:
      row.recommended_agent_type as PlanningSpec["recommendedAgentType"],
    riskClass: row.risk_class as PlanningSpec["riskClass"],
    createdAt: asIsoTimestamp(new Date(row.created_at as string | Date))
  };
}
function mapPolicySnapshotRow(row: Record<string, unknown>): PolicySnapshot {
  return row.snapshot as PolicySnapshot;
}

function mapEvidenceRecordRow(row: Record<string, unknown>): EvidenceRecord {
  return {
    recordId: row.record_id as string,
    taskId: row.task_id as string,
    kind: row.kind as EvidenceRecord["kind"],
    title: row.title as string,
    location: row.location as string,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: asIsoTimestamp(new Date(row.created_at as string | Date))
  };
}

function mapRunEventRow(row: Record<string, unknown>): RunEvent {
  return createRunEvent({
    eventId: row.event_id as string,
    taskId: row.task_id as string,
    runId: row.run_id as string,
    phase: row.phase as RunEvent["phase"],
    level: row.level as RunEvent["level"],
    code: row.code as string,
    message: row.message as string,
    ...(row.failure_class === null || row.failure_class === undefined
      ? {}
      : { failureClass: row.failure_class as FailureClass }),
    ...(row.duration_ms === null || row.duration_ms === undefined
      ? {}
      : { durationMs: row.duration_ms as number }),
    data: (row.data as Record<string, unknown>) ?? {},
    createdAt: asIsoTimestamp(new Date(row.created_at as string | Date))
  });
}

function mapMemoryRecordRow(row: Record<string, unknown>): MemoryRecord {
  return createMemoryRecord({
    memoryId: row.memory_id as string,
    taskId: (row.task_id as string | null) ?? null,
    scope: row.scope as MemoryRecord["scope"],
    provenance: row.provenance as MemoryRecord["provenance"],
    key: row.key as string,
    title: row.title as string,
    value: row.value,
    repo: (row.repo as string | null) ?? null,
    organizationId: (row.organization_id as string | null) ?? null,
    sourceUri: (row.source_uri as string | null) ?? null,
    tags: (row.tags as string[] | null) ?? [],
    createdAt: asIsoTimestamp(new Date(row.created_at as string | Date)),
    updatedAt: asIsoTimestamp(new Date(row.updated_at as string | Date))
  });
}

function mapPipelineRunRow(row: Record<string, unknown>): PipelineRun {
  return createPipelineRun({
    runId: row.run_id as string,
    taskId: row.task_id as string,
    concurrencyKey: row.concurrency_key as string,
    strategy: row.strategy as ConcurrencyStrategy,
    status: row.status as PipelineRun["status"],
    blockedByRunId: (row.blocked_by_run_id as string | null) ?? null,
    overlapReason: (row.overlap_reason as string | null) ?? null,
    startedAt: asIsoTimestamp(new Date(row.started_at as string | Date)),
    lastHeartbeatAt: asIsoTimestamp(
      new Date(row.last_heartbeat_at as string | Date)
    ),
    completedAt:
      row.completed_at === null || row.completed_at === undefined
        ? null
        : asIsoTimestamp(new Date(row.completed_at as string | Date)),
    staleAt:
      row.stale_at === null || row.stale_at === undefined
        ? null
        : asIsoTimestamp(new Date(row.stale_at as string | Date)),
    metadata: (row.metadata as Record<string, unknown>) ?? {}
  });
}

function mapApprovalRequestRow(row: Record<string, unknown>): ApprovalRequest {
  return createApprovalRequest({
    requestId: row.request_id as string,
    taskId: row.task_id as string,
    runId: row.run_id as string,
    phase: row.phase as ApprovalRequest["phase"],
    approvalMode: row.approval_mode as ApprovalRequest["approvalMode"],
    status: row.status as ApprovalRequest["status"],
    riskClass: row.risk_class as ApprovalRequest["riskClass"],
    summary: row.summary as string,
    requestedCapabilities:
      (row.requested_capabilities as
        | ApprovalRequest["requestedCapabilities"]
        | null) ?? [],
    allowedPaths: (row.allowed_paths as string[] | null) ?? [],
    blockedPhases:
      (row.blocked_phases as ApprovalRequest["blockedPhases"] | null) ?? [],
    policyReasons: (row.policy_reasons as string[] | null) ?? [],
    requestedBy: row.requested_by as string,
    decidedBy: (row.decided_by as string | null) ?? null,
    decision: (row.decision as ApprovalDecision | null) ?? null,
    decisionSummary: (row.decision_summary as string | null) ?? null,
    comment: (row.comment as string | null) ?? null,
    createdAt: asIsoTimestamp(new Date(row.created_at as string | Date)),
    updatedAt: asIsoTimestamp(new Date(row.updated_at as string | Date)),
    resolvedAt:
      row.resolved_at === null || row.resolved_at === undefined
        ? null
        : asIsoTimestamp(new Date(row.resolved_at as string | Date))
  });
}

export * from "./schema.js";
