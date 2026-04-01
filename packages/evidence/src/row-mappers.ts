import {
  asIsoTimestamp,
  type ApprovalDecision,
  type ApprovalRequest,
  type ConcurrencyStrategy,
  type EvidenceRecord,
  type FailureClass,
  type GitHubIssuePollingCursor,
  type MemoryRecord,
  type PhaseRecord,
  type PipelineRun,
  type PlanningSpec,
  type PolicySnapshot,
  type RunEvent,
  type TaskManifest
} from "@reddwarf/contracts";
import {
  createApprovalRequest,
  createMemoryRecord,
  createPipelineRun,
  createRunEvent
} from "./factories.js";

export function mapManifestRow(row: Record<string, unknown>): TaskManifest {
  return {
    taskId: row.task_id as string,
    source: row.source as TaskManifest["source"],
    title: row.title as string,
    summary: row.summary as string,
    priority: row.priority as number,
    dryRun: Boolean(row.dry_run),
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

export function mapPhaseRecordRow(row: Record<string, unknown>): PhaseRecord {
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

export function mapPlanningSpecRow(row: Record<string, unknown>): PlanningSpec {
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
    confidenceLevel: row.confidence_level as PlanningSpec["confidenceLevel"],
    confidenceReason: row.confidence_reason as PlanningSpec["confidenceReason"],
    createdAt: asIsoTimestamp(new Date(row.created_at as string | Date))
  };
}

export function mapPolicySnapshotRow(row: Record<string, unknown>): PolicySnapshot {
  return row.snapshot as PolicySnapshot;
}

export function mapEvidenceRecordRow(row: Record<string, unknown>): EvidenceRecord {
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

export function mapRunEventRow(row: Record<string, unknown>): RunEvent {
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

export function mapMemoryRecordRow(row: Record<string, unknown>): MemoryRecord {
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

export function mapPipelineRunRow(row: Record<string, unknown>): PipelineRun {
  return createPipelineRun({
    runId: row.run_id as string,
    taskId: row.task_id as string,
    concurrencyKey: row.concurrency_key as string,
    strategy: row.strategy as ConcurrencyStrategy,
    dryRun: Boolean(row.dry_run),
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

export function mapGitHubIssuePollingCursorRow(
  row: Record<string, unknown>
): GitHubIssuePollingCursor {
  return {
    repo: row.repo as string,
    lastSeenIssueNumber: (row.last_seen_issue_number as number | null) ?? null,
    lastSeenUpdatedAt:
      row.last_seen_updated_at === null || row.last_seen_updated_at === undefined
        ? null
        : asIsoTimestamp(new Date(row.last_seen_updated_at as string | Date)),
    lastPollStartedAt:
      row.last_poll_started_at === null || row.last_poll_started_at === undefined
        ? null
        : asIsoTimestamp(new Date(row.last_poll_started_at as string | Date)),
    lastPollCompletedAt:
      row.last_poll_completed_at === null || row.last_poll_completed_at === undefined
        ? null
        : asIsoTimestamp(new Date(row.last_poll_completed_at as string | Date)),
    lastPollStatus: (row.last_poll_status as GitHubIssuePollingCursor["lastPollStatus"]) ?? null,
    lastPollError: (row.last_poll_error as string | null) ?? null,
    updatedAt: asIsoTimestamp(new Date(row.updated_at as string | Date))
  };
}

export function mapApprovalRequestRow(row: Record<string, unknown>): ApprovalRequest {
  return createApprovalRequest({
    requestId: row.request_id as string,
    taskId: row.task_id as string,
    runId: row.run_id as string,
    phase: row.phase as ApprovalRequest["phase"],
    dryRun: Boolean(row.dry_run),
    confidenceLevel:
      (row.confidence_level as ApprovalRequest["confidenceLevel"] | null) ?? null,
    confidenceReason: (row.confidence_reason as string | null) ?? null,
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
