import {
  approvalRequestSchema,
  asIsoTimestamp,
  memoryRecordSchema,
  pipelineRunSchema,
  runEventSchema,
  type ApprovalDecision,
  type ApprovalRequest,
  type ConcurrencyStrategy,
  type EvidenceRecord,
  type FailureClass,
  type GitHubIssuePollingCursor,
  type MemoryRecord,
  type PipelineRun,
  type RunEvent,
  type TaskManifest
} from "@reddwarf/contracts";
export function buildEvidenceLocation(
  kind: EvidenceRecord["kind"],
  id: string
): string {
  return `db://${kind}/${id}`;
}

export function createEvidenceRecord(input: {
  recordId: string;
  taskId: string;
  kind: EvidenceRecord["kind"];
  title: string;
  location?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}): EvidenceRecord {
  return {
    recordId: input.recordId,
    taskId: input.taskId,
    kind: input.kind,
    title: input.title,
    location:
      input.location ?? buildEvidenceLocation(input.kind, input.recordId),
    metadata: input.metadata ?? {},
    createdAt: input.createdAt ?? asIsoTimestamp()
  };
}

export function createRunEvent(input: {
  eventId: string;
  taskId: string;
  runId: string;
  phase: RunEvent["phase"];
  level: RunEvent["level"];
  code: string;
  message: string;
  failureClass?: FailureClass;
  durationMs?: number;
  data?: Record<string, unknown>;
  createdAt?: string;
}): RunEvent {
  return runEventSchema.parse({
    eventId: input.eventId,
    taskId: input.taskId,
    runId: input.runId,
    phase: input.phase,
    level: input.level,
    code: input.code,
    message: input.message,
    ...(input.failureClass === undefined
      ? {}
      : { failureClass: input.failureClass }),
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    data: input.data ?? {},
    createdAt: input.createdAt ?? asIsoTimestamp()
  });
}

export function createMemoryRecord(input: {
  memoryId: string;
  scope: MemoryRecord["scope"];
  provenance: MemoryRecord["provenance"];
  key: string;
  title: string;
  value: MemoryRecord["value"];
  taskId?: string | null;
  repo?: string | null;
  organizationId?: string | null;
  sourceUri?: string | null;
  tags?: string[];
  createdAt?: string;
  updatedAt?: string;
}): MemoryRecord {
  const createdAt = input.createdAt ?? asIsoTimestamp();
  return memoryRecordSchema.parse({
    memoryId: input.memoryId,
    taskId: input.taskId ?? null,
    scope: input.scope,
    provenance: input.provenance,
    key: input.key,
    title: input.title,
    value: input.value,
    repo: input.repo ?? null,
    organizationId: input.organizationId ?? null,
    sourceUri: input.sourceUri ?? null,
    tags: input.tags ?? [],
    createdAt,
    updatedAt: input.updatedAt ?? createdAt
  });
}

export function createPipelineRun(input: {
  runId: string;
  taskId: string;
  concurrencyKey: string;
  strategy: ConcurrencyStrategy;
  dryRun?: boolean;
  status: PipelineRun["status"];
  blockedByRunId?: string | null;
  overlapReason?: string | null;
  startedAt?: string;
  lastHeartbeatAt?: string;
  completedAt?: string | null;
  staleAt?: string | null;
  metadata?: Record<string, unknown>;
}): PipelineRun {
  const startedAt = input.startedAt ?? asIsoTimestamp();
  return pipelineRunSchema.parse({
    runId: input.runId,
    taskId: input.taskId,
    concurrencyKey: input.concurrencyKey,
    strategy: input.strategy,
    dryRun: input.dryRun ?? false,
    status: input.status,
    blockedByRunId: input.blockedByRunId ?? null,
    overlapReason: input.overlapReason ?? null,
    startedAt,
    lastHeartbeatAt: input.lastHeartbeatAt ?? startedAt,
    completedAt: input.completedAt ?? null,
    staleAt: input.staleAt ?? null,
    metadata: input.metadata ?? {}
  });
}

export function createApprovalRequest(input: {
  requestId: string;
  taskId: string;
  runId: string;
  phase: ApprovalRequest["phase"];
  dryRun?: boolean;
  approvalMode: ApprovalRequest["approvalMode"];
  status: ApprovalRequest["status"];
  riskClass: ApprovalRequest["riskClass"];
  summary: string;
  requestedCapabilities: ApprovalRequest["requestedCapabilities"];
  allowedPaths: string[];
  blockedPhases: ApprovalRequest["blockedPhases"];
  policyReasons: string[];
  requestedBy: string;
  decidedBy?: string | null;
  decision?: ApprovalDecision | null;
  decisionSummary?: string | null;
  comment?: string | null;
  createdAt?: string;
  updatedAt?: string;
  resolvedAt?: string | null;
}): ApprovalRequest {
  const createdAt = input.createdAt ?? asIsoTimestamp();

  return approvalRequestSchema.parse({
    requestId: input.requestId,
    taskId: input.taskId,
    runId: input.runId,
    phase: input.phase,
    dryRun: input.dryRun ?? false,
    approvalMode: input.approvalMode,
    status: input.status,
    riskClass: input.riskClass,
    summary: input.summary,
    requestedCapabilities: input.requestedCapabilities,
    allowedPaths: input.allowedPaths,
    blockedPhases: input.blockedPhases,
    policyReasons: input.policyReasons,
    requestedBy: input.requestedBy,
    decidedBy: input.decidedBy ?? null,
    decision: input.decision ?? null,
    decisionSummary: input.decisionSummary ?? null,
    comment: input.comment ?? null,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    resolvedAt: input.resolvedAt ?? null
  });
}
export function createGitHubIssuePollingCursor(input: {
  repo: string;
  lastSeenIssueNumber?: number | null;
  lastSeenUpdatedAt?: string | null;
  lastPollStartedAt?: string | null;
  lastPollCompletedAt?: string | null;
  lastPollStatus?: GitHubIssuePollingCursor["lastPollStatus"];
  lastPollError?: string | null;
  updatedAt?: string;
}): GitHubIssuePollingCursor {
  return {
    repo: input.repo,
    lastSeenIssueNumber: input.lastSeenIssueNumber ?? null,
    lastSeenUpdatedAt: input.lastSeenUpdatedAt ?? null,
    lastPollStartedAt: input.lastPollStartedAt ?? null,
    lastPollCompletedAt: input.lastPollCompletedAt ?? null,
    lastPollStatus: input.lastPollStatus ?? null,
    lastPollError: input.lastPollError ?? null,
    updatedAt: input.updatedAt ?? asIsoTimestamp()
  };
}
