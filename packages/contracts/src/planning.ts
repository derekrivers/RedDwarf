import { z } from "zod";
import {
  isoDateTimeSchema,
  jsonValueSchema,
  capabilitySchema,
  capabilities,
  failureClassSchema,
  riskClassSchema,
  approvalModeSchema,
  taskPhaseSchema,
  taskLifecycleStatusSchema,
  agentTypeSchema,
  projectSizeSchema,
  projectStatusSchema,
  ticketStatusSchema,
  QUERY_LIMIT_DEFAULT,
  QUERY_LIMIT_MAX,
  TITLE_MIN_LENGTH,
  SUMMARY_MIN_LENGTH,
  PRIORITY_MIN,
  PRIORITY_MAX
} from "./enums.js";

export const sourceRefSchema = z.object({
  provider: z.literal("github"),
  repo: z.string().min(1),
  issueId: z.number().int().positive().optional(),
  issueNumber: z.number().int().positive().optional(),
  issueUrl: z.string().url().optional()
});

export const planningTaskInputSchema = z.object({
  source: sourceRefSchema,
  title: z.string().min(TITLE_MIN_LENGTH),
  summary: z.string().min(SUMMARY_MIN_LENGTH),
  priority: z.number().int().min(PRIORITY_MIN).max(PRIORITY_MAX),
  dryRun: z.boolean().default(false),
  labels: z.array(z.string().min(1)).default([]),
  acceptanceCriteria: z.array(z.string().min(1)).default([]),
  affectedPaths: z.array(z.string().min(1)).default([]),
  proposedSubTasks: z.array(z.string().min(1)).optional(),
  requestedCapabilities: z
    .array(capabilitySchema)
    .default(["can_plan", "can_archive_evidence"]),
  metadata: z.record(jsonValueSchema).default({})
});

export const directTaskInjectionRequestSchema = z.object({
  repo: z.string().min(1),
  title: z.string().min(TITLE_MIN_LENGTH),
  summary: z.string().min(SUMMARY_MIN_LENGTH),
  priority: z.number().int().min(PRIORITY_MIN).max(PRIORITY_MAX).default(3),
  dryRun: z.boolean().optional(),
  labels: z.array(z.string().min(1)).default(["ai-eligible"]),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  affectedPaths: z.array(z.string().min(1)).default([]),
  proposedSubTasks: z.array(z.string().min(1)).optional(),
  constraints: z.array(z.string().min(1)).default([]),
  requestedCapabilities: z
    .array(capabilitySchema)
    .default(["can_plan", "can_archive_evidence"]),
  riskClassHint: riskClassSchema.optional(),
  issueNumber: z.number().int().positive().optional(),
  issueUrl: z.string().url().optional(),
  metadata: z.record(jsonValueSchema).default({})
});

export const preScreenFindingKindSchema = z.enum([
  "under_specified",
  "duplicate",
  "out_of_scope"
]);

export const preScreenFindingSchema = z.object({
  kind: preScreenFindingKindSchema,
  summary: z.string().min(1),
  detail: z.string().min(1)
});

export const preScreenAssessmentSchema = z.object({
  accepted: z.boolean(),
  summary: z.string().min(1),
  findings: z.array(preScreenFindingSchema),
  recommendedActions: z.array(z.string().min(1)).default([])
});

export const taskGroupExecutionModeSchema = z.enum(["sequential", "parallel"]);

export const groupedTaskInjectionRequestSchema =
  directTaskInjectionRequestSchema.extend({
    taskKey: z.string().min(1),
    dependsOn: z.array(z.string().min(1)).default([])
  });

export const taskGroupInjectionRequestSchema = z.object({
  groupId: z.string().min(1).optional(),
  groupName: z.string().min(1).optional(),
  executionMode: taskGroupExecutionModeSchema.default("sequential"),
  tasks: z.array(groupedTaskInjectionRequestSchema).min(1)
});

export const taskGroupMembershipSchema = z.object({
  groupId: z.string().min(1),
  groupName: z.string().min(1).nullable(),
  executionMode: taskGroupExecutionModeSchema,
  taskKey: z.string().min(1),
  sequence: z.number().int().min(0),
  dependsOnTaskKeys: z.array(z.string().min(1)),
  dependsOnTaskIds: z.array(z.string().min(1))
});

export const confidenceLevelSchema = z.enum(["low", "medium", "high"]);

export const confidenceSignalSchema = z.object({
  level: confidenceLevelSchema,
  reason: z.string().min(1).max(300)
});

export const tokenBudgetOverageActionSchema = z.enum(["warn", "block"]);

export const tokenUsageSchema = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  /** Optional Anthropic prompt-cache read tokens (Feature 180). */
  cachedTokens: z.number().int().min(0).optional(),
  /** Optional model id used for this call, e.g. "claude-opus-4-7" (Feature 180). */
  model: z.string().min(1).optional(),
  /** Optional provider identifier; derivable from model but explicit is safer. */
  provider: z
    .enum(["anthropic", "openai", "openai-codex", "unknown"])
    .optional()
});

export const tokenBudgetResultSchema = z.object({
  phase: taskPhaseSchema,
  estimatedTokens: z.number().int().min(0),
  budgetLimit: z.number().int().min(0),
  withinBudget: z.boolean(),
  overageAction: tokenBudgetOverageActionSchema,
  actualInputTokens: z.number().int().min(0).nullable().optional(),
  actualOutputTokens: z.number().int().min(0).nullable().optional(),
  // Feature 180 — USD cost attribution. `null` means cost could not be
  // computed (no model info on this phase). All values round to the
  // millionth of a dollar to avoid float noise across long-running runs.
  actualCachedTokens: z.number().int().min(0).nullable().optional(),
  model: z.string().min(1).nullable().optional(),
  costUsd: z.number().nonnegative().nullable().optional(),
  costBudgetUsd: z.number().nonnegative().nullable().optional(),
  withinCostBudget: z.boolean().nullable().optional()
});

export const phaseRetryBudgetStateSchema = z.object({
  phase: taskPhaseSchema,
  attempts: z.number().int().min(0),
  retryLimit: z.number().int().min(0),
  retryExhausted: z.boolean(),
  lastError: z.string().nullable(),
  lastFailureCode: z.string().nullable(),
  lastFailureClass: failureClassSchema.nullable().optional(),
  lastRunId: z.string().nullable(),
  updatedAt: isoDateTimeSchema
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
  confidenceLevel: confidenceLevelSchema,
  confidenceReason: z.string().min(1).max(300),
  projectSize: projectSizeSchema.default("small"),
  createdAt: isoDateTimeSchema
});

export const taskManifestSchema = z.object({
  taskId: z.string().min(1),
  source: sourceRefSchema,
  title: z.string().min(TITLE_MIN_LENGTH),
  summary: z.string().min(SUMMARY_MIN_LENGTH),
  priority: z.number().int().min(PRIORITY_MIN).max(PRIORITY_MAX),
  dryRun: z.boolean().default(false),
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

export const taskManifestQuerySchema = z.object({
  repo: z.string().min(1).optional(),
  lifecycleStatuses: z.array(taskLifecycleStatusSchema).default([]),
  phases: z.array(taskPhaseSchema).default([]),
  limit: z.number().int().positive().max(QUERY_LIMIT_MAX).default(QUERY_LIMIT_DEFAULT)
});

export const githubIssueSubmitSchema = z.object({
  repo: z.string().min(1),
  title: z.string().min(TITLE_MIN_LENGTH).max(200),
  summary: z.string().min(SUMMARY_MIN_LENGTH),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  affectedPaths: z.array(z.string().min(1)).default([]),
  constraints: z.array(z.string().min(1)).default([]),
  labels: z.array(z.string().min(1)).default([]),
  requestedCapabilities: z
    .array(capabilitySchema)
    .default([...capabilities]),
  riskClassHint: riskClassSchema.optional()
});

export type PlanningTaskInput = z.infer<typeof planningTaskInputSchema>;
export type DirectTaskInjectionRequest = z.infer<typeof directTaskInjectionRequestSchema>;
export type GitHubIssueSubmitRequest = z.infer<typeof githubIssueSubmitSchema>;
export type PreScreenFinding = z.infer<typeof preScreenFindingSchema>;
export type PreScreenAssessment = z.infer<typeof preScreenAssessmentSchema>;
export type GroupedTaskInjectionRequest = z.infer<
  typeof groupedTaskInjectionRequestSchema
>;
export type TaskGroupExecutionMode = z.infer<typeof taskGroupExecutionModeSchema>;
export type TaskGroupInjectionRequest = z.infer<
  typeof taskGroupInjectionRequestSchema
>;
export type TaskGroupMembership = z.infer<typeof taskGroupMembershipSchema>;
export type ConfidenceLevel = z.infer<typeof confidenceLevelSchema>;
export type ConfidenceSignal = z.infer<typeof confidenceSignalSchema>;
export type TokenBudgetOverageAction = z.infer<
  typeof tokenBudgetOverageActionSchema
>;
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
export type TokenBudgetResult = z.infer<typeof tokenBudgetResultSchema>;
export type PhaseRetryBudgetState = z.infer<typeof phaseRetryBudgetStateSchema>;
export type TaskManifest = z.infer<typeof taskManifestSchema>;
export type TaskManifestQuery = z.infer<typeof taskManifestQuerySchema>;
export type PlanningSpec = z.infer<typeof planningSpecSchema>;

export const complexityClassificationSchema = z.object({
  size: projectSizeSchema,
  reasoning: z.string().min(1),
  signals: z.array(z.string().min(1))
});

// M25 F-190 fills in the full RequiredCheckContract shape. F-189 introduces
// the field with a permissive schema so the migration, repository, and
// operator API can land before Holly starts emitting populated contracts.
// `requiredCheckNames: []` (or an empty object) is treated as "no contract"
// by the auto-merge evaluator (F-194), which then refuses to auto-merge.
export const autoMergePolicySchema = z
  .object({
    requiredCheckNames: z.array(z.string().min(1)).default([]),
    minimumCheckCount: z.number().int().min(0).default(0),
    forbidSkipCi: z.boolean().default(true),
    forbidEmptyTestDiff: z.boolean().default(true),
    rationale: z.string().min(1).optional()
  })
  .partial()
  .passthrough();
export type AutoMergePolicy = z.infer<typeof autoMergePolicySchema>;

export const ticketSpecSchema = z.object({
  ticketId: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)),
  dependsOn: z.array(z.string().min(1)).default([]),
  status: ticketStatusSchema,
  complexityClass: riskClassSchema,
  riskClass: riskClassSchema,
  githubSubIssueNumber: z.number().int().positive().nullable().default(null),
  githubPrNumber: z.number().int().positive().nullable().default(null),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
});

export const projectSpecSchema = z.object({
  projectId: z.string().min(1),
  sourceIssueId: z.string().min(1).nullable().default(null),
  sourceRepo: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  projectSize: projectSizeSchema,
  status: projectStatusSchema,
  complexityClassification: complexityClassificationSchema.nullable().default(null),
  approvalDecision: z.string().min(1).nullable().default(null),
  decidedBy: z.string().min(1).nullable().default(null),
  decisionSummary: z.string().min(1).nullable().default(null),
  amendments: z.string().min(1).nullable().default(null),
  clarificationQuestions: z.array(z.string().min(1)).nullable().default(null),
  clarificationAnswers: z.record(z.string(), z.string()).nullable().default(null),
  clarificationRequestedAt: isoDateTimeSchema.nullable().default(null),
  // M25 F-189: per-project opt-in for auto-merge of sub-ticket PRs.
  // The global REDDWARF_PROJECT_AUTOMERGE_ENABLED flag must also be true for
  // the evaluator (F-194) to ever attempt a merge. `autoMergePolicy` is a
  // snapshot of the resolved RequiredCheckContract at approval time so a
  // historic decision remains reproducible if the global policy changes.
  autoMergeEnabled: z.boolean().default(false),
  autoMergePolicy: autoMergePolicySchema.nullable().default(null),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
});

export type ComplexityClassification = z.infer<typeof complexityClassificationSchema>;
export type TicketSpec = z.infer<typeof ticketSpecSchema>;
export type ProjectSpec = z.infer<typeof projectSpecSchema>;

export interface RetryBudgetConfig {
  maxRetries: Partial<Record<z.infer<typeof taskPhaseSchema>, number>>;
}

export class PhaseRetryExhaustedError extends Error {
  readonly phase: z.infer<typeof taskPhaseSchema>;
  readonly attempts: number;
  readonly runId: string;

  constructor(
    phase: z.infer<typeof taskPhaseSchema>,
    attempts: number,
    runId: string
  ) {
    super(
      `Phase '${phase}' retry budget exhausted after ${attempts} attempts (run: ${runId})`
    );
    this.name = "PhaseRetryExhaustedError";
    this.phase = phase;
    this.attempts = attempts;
    this.runId = runId;
  }
}
