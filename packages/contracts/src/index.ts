import { z } from "zod";

export const taskPhases = [
  "intake",
  "eligibility",
  "planning",
  "policy_gate",
  "development",
  "validation",
  "review",
  "scm",
  "archive"
] as const;

export const taskLifecycleStatuses = [
  "draft",
  "ready",
  "active",
  "blocked",
  "completed",
  "failed",
  "cancelled"
] as const;

export const phaseLifecycleStatuses = [
  "pending",
  "running",
  "passed",
  "failed",
  "escalated",
  "skipped"
] as const;

export const riskClasses = ["low", "medium", "high"] as const;
export const approvalModes = [
  "auto",
  "review_required",
  "human_signoff_required",
  "disallowed"
] as const;

export const v1DisabledPhases = ["review"] as const satisfies readonly (typeof taskPhases)[number][];

export const capabilities = [
  "can_plan",
  "can_write_code",
  "can_run_tests",
  "can_open_pr",
  "can_modify_schema",
  "can_touch_sensitive_paths",
  "can_use_secrets",
  "can_review",
  "can_archive_evidence"
] as const;

export const agentTypes = [
  "architect",
  "developer",
  "validation",
  "reviewer",
  "scm"
] as const;
export const openClawAgentRoles = ["coordinator", "analyst", "validator"] as const;
export const openClawBootstrapFileKinds = [
  "identity",
  "soul",
  "agents",
  "tools",
  "skill"
] as const;

export const evidenceKinds = [
  "manifest",
  "planning_spec",
  "phase_record",
  "gate_decision",
  "run_event",
  "file_artifact"
] as const;

export const eventLevels = ["info", "warn", "error"] as const;
export const memoryScopes = [
  "task",
  "project",
  "organization",
  "external"
] as const;
export const memoryProvenances = [
  "human_curated",
  "pipeline_derived",
  "external_retrieval"
] as const;
export const policyPackEntryKinds = ["directory", "file"] as const;
export const concurrencyStrategies = ["serialize", "escalate"] as const;
export const pipelineRunStatuses = [
  "active",
  "completed",
  "blocked",
  "failed",
  "stale",
  "cancelled"
] as const;
export const overlapActions = ["start", "block"] as const;
export const failureClasses = [
  "planning_failure",
  "validation_failure",
  "review_failure",
  "integration_failure",
  "merge_failure",
  "policy_violation",
  "execution_loop"
] as const;
export const pipelineRunStatusesForSummary = [
  "completed",
  "blocked",
  "failed"
] as const;
export const workspaceLifecycleStatuses = ["provisioned", "destroyed"] as const;
export const workspaceToolModes = [
  "planning_only",
  "development_readonly",
  "validation_only",
  "scm_only"
] as const;
export const workspaceCredentialModes = ["none", "scoped_env"] as const;
export const approvalRequestStatuses = [
  "pending",
  "approved",
  "rejected",
  "cancelled"
] as const;
export const approvalDecisions = ["approve", "reject"] as const;
export const githubIssuePollingCursorStatuses = ["succeeded", "failed"] as const;

const isoDateTimeSchema = z.string().datetime({ offset: true });

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema)
  ])
);

export const taskPhaseSchema = z.enum(taskPhases);
export const taskLifecycleStatusSchema = z.enum(taskLifecycleStatuses);
export const phaseLifecycleStatusSchema = z.enum(phaseLifecycleStatuses);
export const riskClassSchema = z.enum(riskClasses);
export const approvalModeSchema = z.enum(approvalModes);
export const capabilitySchema = z.enum(capabilities);
export const agentTypeSchema = z.enum(agentTypes);
export const evidenceKindSchema = z.enum(evidenceKinds);
export const eventLevelSchema = z.enum(eventLevels);
export const memoryScopeSchema = z.enum(memoryScopes);
export const memoryProvenanceSchema = z.enum(memoryProvenances);
export const policyPackEntryKindSchema = z.enum(policyPackEntryKinds);
export const concurrencyStrategySchema = z.enum(concurrencyStrategies);
export const pipelineRunStatusSchema = z.enum(pipelineRunStatuses);
export const overlapActionSchema = z.enum(overlapActions);
export const failureClassSchema = z.enum(failureClasses);
export const pipelineRunStatusSummarySchema = z.enum(
  pipelineRunStatusesForSummary
);
export const workspaceLifecycleStatusSchema = z.enum(
  workspaceLifecycleStatuses
);
export const workspaceToolModeSchema = z.enum(workspaceToolModes);
export const workspaceCredentialModeSchema = z.enum(workspaceCredentialModes);
export const approvalRequestStatusSchema = z.enum(approvalRequestStatuses);
export const approvalDecisionSchema = z.enum(approvalDecisions);
export const githubIssuePollingCursorStatusSchema = z.enum(githubIssuePollingCursorStatuses);

export const sourceRefSchema = z.object({
  provider: z.literal("github"),
  repo: z.string().min(1),
  issueId: z.number().int().positive().optional(),
  issueNumber: z.number().int().positive().optional(),
  issueUrl: z.string().url().optional()
});

export const planningTaskInputSchema = z.object({
  source: sourceRefSchema,
  title: z.string().min(5),
  summary: z.string().min(20),
  priority: z.number().int().min(0).max(100),
  labels: z.array(z.string().min(1)).default([]),
  acceptanceCriteria: z.array(z.string().min(1)).default([]),
  affectedPaths: z.array(z.string().min(1)).default([]),
  requestedCapabilities: z
    .array(capabilitySchema)
    .default(["can_plan", "can_archive_evidence"]),
  metadata: z.record(jsonValueSchema).default({})
});

export const phaseRecordSchema = z.object({
  recordId: z.string().min(1),
  taskId: z.string().min(1),
  phase: taskPhaseSchema,
  status: phaseLifecycleStatusSchema,
  actor: z.string().min(1),
  summary: z.string().min(1),
  details: z.record(jsonValueSchema).default({}),
  createdAt: isoDateTimeSchema
});

export const planningSpecSchema = z.object({
  specId: z.string().min(1),
  taskId: z.string().min(1),
  summary: z.string().min(1),
  assumptions: z.array(z.string().min(1)),
  affectedAreas: z.array(z.string().min(1)),
  constraints: z.array(z.string().min(1)),
  acceptanceCriteria: z.array(z.string().min(1)),
  testExpectations: z.array(z.string().min(1)),
  recommendedAgentType: agentTypeSchema,
  riskClass: riskClassSchema,
  createdAt: isoDateTimeSchema
});

export const evidenceRecordSchema = z.object({
  recordId: z.string().min(1),
  taskId: z.string().min(1),
  kind: evidenceKindSchema,
  title: z.string().min(1),
  location: z.string().min(1),
  metadata: z.record(jsonValueSchema).default({}),
  createdAt: isoDateTimeSchema
});

export const policySnapshotSchema = z.object({
  policyVersion: z.string().min(1),
  approvalMode: approvalModeSchema,
  allowedCapabilities: z.array(capabilitySchema),
  allowedPaths: z.array(z.string().min(1)),
  allowedSecretScopes: z.array(z.string().min(1)).default([]),
  blockedPhases: z.array(taskPhaseSchema),
  reasons: z.array(z.string().min(1))
});

export const workspaceContextBundleSchema = z.object({
  manifest: z.lazy(() => taskManifestSchema),
  spec: planningSpecSchema,
  policySnapshot: policySnapshotSchema,
  acceptanceCriteria: z.array(z.string().min(1)),
  allowedPaths: z.array(z.string().min(1))
});

export const runtimeInstructionFileSchema = z.object({
  relativePath: z.string().min(1),
  description: z.string().min(1),
  content: z.string().min(1)
});

export const runtimeInstructionLayerSchema = z.object({
  taskId: z.string().min(1),
  assignedAgentType: agentTypeSchema,
  recommendedAgentType: agentTypeSchema,
  approvalMode: approvalModeSchema,
  allowedCapabilities: z.array(capabilitySchema),
  blockedPhases: z.array(taskPhaseSchema),
  canonicalSources: z.array(z.string().min(1)),
  contextFiles: z.array(z.string().min(1)),
  files: z.array(runtimeInstructionFileSchema).min(1)
});

export const workspaceDescriptorSchema = z.object({
  workspaceId: z.string().min(1),
  taskId: z.string().min(1),
  workspaceRoot: z.string().min(1),
  contextDir: z.string().min(1),
  stateFile: z.string().min(1),
  scratchDir: z.string().min(1),
  artifactsDir: z.string().min(1),
  status: workspaceLifecycleStatusSchema,
  assignedAgentType: agentTypeSchema,
  recommendedAgentType: agentTypeSchema,
  allowedCapabilities: z.array(capabilitySchema),
  allowedPaths: z.array(z.string().min(1)),
  blockedPhases: z.array(taskPhaseSchema),
  canonicalSources: z.array(z.string().min(1)),
  taskContractFiles: z.array(z.string().min(1)),
  instructionFiles: z.object({
    soulMd: z.string().min(1),
    agentsMd: z.string().min(1),
    toolsMd: z.string().min(1),
    taskSkillMd: z.string().min(1)
  }),
  toolPolicy: z.object({
    mode: workspaceToolModeSchema,
    codeWriteEnabled: z.boolean(),
    allowedCapabilities: z.array(capabilitySchema),
    blockedPhases: z.array(taskPhaseSchema),
    notes: z.array(z.string().min(1))
  }),
  credentialPolicy: z.object({
    mode: workspaceCredentialModeSchema,
    allowedSecretScopes: z.array(z.string().min(1)),
    injectedSecretKeys: z.array(z.string().min(1)),
    secretEnvFile: z.string().min(1).nullable(),
    leaseIssuedAt: isoDateTimeSchema.nullable(),
    leaseExpiresAt: isoDateTimeSchema.nullable(),
    notes: z.array(z.string().min(1))
  }),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  destroyedAt: isoDateTimeSchema.nullable()
});

export const approvalRequestSchema = z.object({
  requestId: z.string().min(1),
  taskId: z.string().min(1),
  runId: z.string().min(1),
  phase: taskPhaseSchema,
  approvalMode: approvalModeSchema,
  status: approvalRequestStatusSchema,
  riskClass: riskClassSchema,
  summary: z.string().min(1),
  requestedCapabilities: z.array(capabilitySchema),
  allowedPaths: z.array(z.string().min(1)),
  blockedPhases: z.array(taskPhaseSchema),
  policyReasons: z.array(z.string().min(1)),
  requestedBy: z.string().min(1),
  decidedBy: z.string().min(1).nullable(),
  decision: approvalDecisionSchema.nullable(),
  decisionSummary: z.string().min(1).nullable(),
  comment: z.string().min(1).nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  resolvedAt: isoDateTimeSchema.nullable()
});

export const approvalRequestQuerySchema = z.object({
  taskId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  statuses: z.array(approvalRequestStatusSchema).default([]),
  limit: z.number().int().positive().max(100).default(50)
});

export const githubIssuePollingCursorSchema = z.object({
  repo: z.string().min(1),
  lastSeenIssueNumber: z.number().int().positive().nullable(),
  lastSeenUpdatedAt: isoDateTimeSchema.nullable(),
  lastPollStartedAt: isoDateTimeSchema.nullable(),
  lastPollCompletedAt: isoDateTimeSchema.nullable(),
  lastPollStatus: githubIssuePollingCursorStatusSchema.nullable(),
  lastPollError: z.string().min(1).nullable(),
  updatedAt: isoDateTimeSchema
});

export const runEventSchema = z.object({
  eventId: z.string().min(1),
  taskId: z.string().min(1),
  runId: z.string().min(1),
  phase: taskPhaseSchema,
  level: eventLevelSchema,
  code: z.string().min(1),
  message: z.string().min(1),
  failureClass: failureClassSchema.optional(),
  durationMs: z.number().int().min(0).optional(),
  data: z.record(jsonValueSchema).default({}),
  createdAt: isoDateTimeSchema
});

export const runSummarySchema = z.object({
  taskId: z.string().min(1),
  runId: z.string().min(1),
  status: pipelineRunStatusSummarySchema,
  totalDurationMs: z.number().int().min(0),
  phaseDurations: z.record(z.string().min(1), z.number().int().min(0)),
  eventCounts: z.object({
    info: z.number().int().min(0),
    warn: z.number().int().min(0),
    error: z.number().int().min(0)
  }),
  latestPhase: taskPhaseSchema,
  failureClass: failureClassSchema.nullable(),
  failureCodes: z.array(z.string().min(1)),
  firstEventAt: isoDateTimeSchema.nullable(),
  lastEventAt: isoDateTimeSchema.nullable()
});

export const agentDefinitionSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  type: agentTypeSchema,
  capabilities: z.array(capabilitySchema),
  activePhases: z.array(taskPhaseSchema),
  enabled: z.boolean(),
  description: z.string().min(1)
});

export const openClawAgentRoleSchema = z.enum(openClawAgentRoles);
export const openClawBootstrapFileKindSchema = z.enum(openClawBootstrapFileKinds);
export const openClawBootstrapFileSchema = z.object({
  kind: openClawBootstrapFileKindSchema,
  relativePath: z.string().min(1),
  description: z.string().min(1)
});
export const openClawAgentRoleDefinitionSchema = z.object({
  agentId: z.string().min(1),
  role: openClawAgentRoleSchema,
  displayName: z.string().min(1),
  purpose: z.string().min(1),
  bootstrapFiles: z.array(openClawBootstrapFileSchema).length(5),
  canonicalSources: z.array(z.string().min(1)).min(1)
});

export const taskManifestSchema = z.object({
  taskId: z.string().min(1),
  source: sourceRefSchema,
  title: z.string().min(5),
  summary: z.string().min(20),
  priority: z.number().int().min(0).max(100),
  riskClass: riskClassSchema,
  approvalMode: approvalModeSchema,
  currentPhase: taskPhaseSchema,
  lifecycleStatus: taskLifecycleStatusSchema,
  assignedAgentType: agentTypeSchema,
  requestedCapabilities: z.array(capabilitySchema),
  retryCount: z.number().int().min(0),
  evidenceLinks: z.array(z.string().min(1)),
  workspaceId: z.string().min(1).nullable(),
  branchName: z.string().min(1).nullable(),
  prNumber: z.number().int().positive().nullable(),
  policyVersion: z.string().min(1),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
});

export const memoryRecordSchema = z
  .object({
    memoryId: z.string().min(1),
    taskId: z.string().min(1).nullable().default(null),
    scope: memoryScopeSchema,
    provenance: memoryProvenanceSchema,
    key: z.string().min(1),
    title: z.string().min(1),
    value: jsonValueSchema,
    repo: z.string().min(1).nullable().default(null),
    organizationId: z.string().min(1).nullable().default(null),
    sourceUri: z.string().min(1).nullable().default(null),
    tags: z.array(z.string().min(1)).default([]),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema
  })
  .superRefine((record, context) => {
    if (record.scope === "task" && record.taskId === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Task memory requires taskId."
      });
    }

    if (record.scope === "project" && record.repo === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Project memory requires repo."
      });
    }

    if (record.scope === "organization" && record.organizationId === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Organization memory requires organizationId."
      });
    }

    if (record.scope === "external" && record.sourceUri === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "External memory requires sourceUri."
      });
    }
  });

export const memoryQuerySchema = z.object({
  taskId: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  organizationId: z.string().min(1).optional(),
  sourceUri: z.string().min(1).optional(),
  scope: memoryScopeSchema.optional(),
  tags: z.array(z.string().min(1)).default([]),
  keyPrefix: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).default(50)
});

export const memoryContextSchema = z.object({
  taskId: z.string().min(1),
  repo: z.string().min(1),
  organizationId: z.string().min(1).nullable(),
  taskMemory: z.array(memoryRecordSchema),
  projectMemory: z.array(memoryRecordSchema),
  organizationMemory: z.array(memoryRecordSchema),
  externalMemory: z.array(memoryRecordSchema)
});

export const policyPackEntrySchema = z.object({
  path: z.string().min(1),
  kind: policyPackEntryKindSchema,
  requiredAtRuntime: z.boolean()
});

export const policyPackManifestSchema = z.object({
  policyPackId: z.string().min(1),
  policyPackVersion: z.string().min(1),
  rootPackageVersion: z.string().min(1),
  createdAt: isoDateTimeSchema,
  sourceRoot: z.string().min(1),
  packageRoot: z.string().min(1),
  composePolicySourceRoot: z.string().min(1),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  runtimeDependenciesBundled: z.boolean(),
  includedEntries: z.array(policyPackEntrySchema),
  notes: z.array(z.string().min(1)).default([])
});

export const pipelineRunSchema = z.object({
  runId: z.string().min(1),
  taskId: z.string().min(1),
  concurrencyKey: z.string().min(1),
  strategy: concurrencyStrategySchema,
  status: pipelineRunStatusSchema,
  blockedByRunId: z.string().min(1).nullable().default(null),
  overlapReason: z.string().min(1).nullable().default(null),
  startedAt: isoDateTimeSchema,
  lastHeartbeatAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.nullable().default(null),
  staleAt: isoDateTimeSchema.nullable().default(null),
  metadata: z.record(jsonValueSchema).default({})
});

export const pipelineRunQuerySchema = z.object({
  taskId: z.string().min(1).optional(),
  concurrencyKey: z.string().min(1).optional(),
  statuses: z.array(pipelineRunStatusSchema).default([]),
  limit: z.number().int().positive().max(100).default(50)
});

export const concurrencyDecisionSchema = z.object({
  action: overlapActionSchema,
  strategy: concurrencyStrategySchema,
  blockedByRunId: z.string().min(1).nullable(),
  staleRunIds: z.array(z.string().min(1)).default([]),
  reason: z.string().min(1).nullable()
});

export type TaskPhase = z.infer<typeof taskPhaseSchema>;
export type TaskLifecycleStatus = z.infer<typeof taskLifecycleStatusSchema>;
export type PhaseLifecycleStatus = z.infer<typeof phaseLifecycleStatusSchema>;
export type RiskClass = z.infer<typeof riskClassSchema>;
export type ApprovalMode = z.infer<typeof approvalModeSchema>;
export type Capability = z.infer<typeof capabilitySchema>;
export type AgentType = z.infer<typeof agentTypeSchema>;
export type PlanningTaskInput = z.infer<typeof planningTaskInputSchema>;
export type TaskManifest = z.infer<typeof taskManifestSchema>;
export type PhaseRecord = z.infer<typeof phaseRecordSchema>;
export type PlanningSpec = z.infer<typeof planningSpecSchema>;
export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;
export type PolicySnapshot = z.infer<typeof policySnapshotSchema>;
export type WorkspaceContextBundle = z.infer<
  typeof workspaceContextBundleSchema
>;
export type RuntimeInstructionFile = z.infer<
  typeof runtimeInstructionFileSchema
>;
export type RuntimeInstructionLayer = z.infer<
  typeof runtimeInstructionLayerSchema
>;
export type WorkspaceLifecycleStatus = z.infer<
  typeof workspaceLifecycleStatusSchema
>;
export type WorkspaceToolMode = z.infer<typeof workspaceToolModeSchema>;
export type WorkspaceCredentialMode = z.infer<
  typeof workspaceCredentialModeSchema
>;
export type WorkspaceDescriptor = z.infer<typeof workspaceDescriptorSchema>;
export type ApprovalRequestStatus = z.infer<typeof approvalRequestStatusSchema>;
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
export type ApprovalRequestQuery = z.infer<typeof approvalRequestQuerySchema>;
export type GitHubIssuePollingCursorStatus = z.infer<typeof githubIssuePollingCursorStatusSchema>;
export type GitHubIssuePollingCursor = z.infer<typeof githubIssuePollingCursorSchema>;
export type RunEvent = z.infer<typeof runEventSchema>;
export type RunSummary = z.infer<typeof runSummarySchema>;
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
export type OpenClawAgentRole = z.infer<typeof openClawAgentRoleSchema>;
export type OpenClawBootstrapFileKind = z.infer<typeof openClawBootstrapFileKindSchema>;
export type OpenClawBootstrapFile = z.infer<typeof openClawBootstrapFileSchema>;
export type OpenClawAgentRoleDefinition = z.infer<typeof openClawAgentRoleDefinitionSchema>;
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;
export type MemoryQuery = z.infer<typeof memoryQuerySchema>;
export type MemoryContext = z.infer<typeof memoryContextSchema>;
export type PolicyPackEntry = z.infer<typeof policyPackEntrySchema>;
export type PolicyPackManifest = z.infer<typeof policyPackManifestSchema>;
export type MemoryProvenance = z.infer<typeof memoryProvenanceSchema>;
export type ConcurrencyStrategy = z.infer<typeof concurrencyStrategySchema>;
export type PipelineRunStatus = z.infer<typeof pipelineRunStatusSchema>;
export type OverlapAction = z.infer<typeof overlapActionSchema>;
export type PipelineRun = z.infer<typeof pipelineRunSchema>;
export type PipelineRunQuery = z.infer<typeof pipelineRunQuerySchema>;
export type ConcurrencyDecision = z.infer<typeof concurrencyDecisionSchema>;
export type FailureClass = z.infer<typeof failureClassSchema>;
export type PipelineRunStatusSummary = z.infer<
  typeof pipelineRunStatusSummarySchema
>;

export function asIsoTimestamp(date: Date = new Date()): string {
  return date.toISOString();
}

// ============================================================
// Managed workspace interface (shared across packages)
// ============================================================

export interface MaterializedManagedWorkspace {
  workspaceId: string;
  workspaceRoot: string;
  contextDir: string;
  files: {
    taskJson: string;
    specMarkdown: string;
    policySnapshotJson: string;
    allowedPathsJson: string;
    acceptanceCriteriaJson: string;
  };
  instructions: {
    canonicalSources: string[];
    taskContractFiles: string[];
    files: {
      soulMd: string;
      agentsMd: string;
      toolsMd: string;
      taskSkillMd: string;
    };
  };
  stateDir: string;
  stateFile: string;
  scratchDir: string;
  artifactsDir: string;
  descriptor: WorkspaceDescriptor;
}

// ============================================================
// Agent draft types
// ============================================================

export interface PlanningDraft {
  summary: string;
  assumptions: string[];
  affectedAreas: string[];
  constraints: string[];
  testExpectations: string[];
}

export interface DevelopmentDraft {
  summary: string;
  implementationNotes: string[];
  blockedActions: string[];
  nextActions: string[];
}

export interface ValidationCommand {
  id: string;
  name: string;
  executable: string;
  args: string[];
}

export interface ValidationDraft {
  summary: string;
  commands: ValidationCommand[];
}

export interface ValidationCommandResult {
  id: string;
  name: string;
  executable: string;
  args: string[];
  exitCode: number;
  signal: NodeJS.Signals | null;
  durationMs: number;
  status: "passed" | "failed";
  logPath: string;
}

export interface ValidationReport {
  summary: string;
  commandResults: ValidationCommandResult[];
}

export interface ScmDraft {
  summary: string;
  baseBranch: string;
  branchName: string;
  pullRequestTitle: string;
  pullRequestBody: string;
  labels: string[];
}

// ============================================================
// Agent interfaces
// ============================================================

export interface PlanningAgent {
  createSpec(
    input: PlanningTaskInput,
    context: { manifest: TaskManifest; runId: string }
  ): Promise<PlanningDraft>;
}

export interface DevelopmentAgent {
  createHandoff(
    bundle: WorkspaceContextBundle,
    context: {
      manifest: TaskManifest;
      runId: string;
      workspace: MaterializedManagedWorkspace;
      codeWriteEnabled: boolean;
    }
  ): Promise<DevelopmentDraft>;
}

export interface ValidationAgent {
  createPlan(
    bundle: WorkspaceContextBundle,
    context: {
      manifest: TaskManifest;
      runId: string;
      workspace: MaterializedManagedWorkspace;
    }
  ): Promise<ValidationDraft>;
}

export interface ScmAgent {
  createPullRequest(
    bundle: WorkspaceContextBundle,
    context: {
      manifest: TaskManifest;
      runId: string;
      workspace: MaterializedManagedWorkspace;
      baseBranch: string;
      validationSummary: string;
      validationReportPath: string;
    }
  ): Promise<ScmDraft>;
}

