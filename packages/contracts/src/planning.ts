import { z } from "zod";
import {
  isoDateTimeSchema,
  jsonValueSchema,
  capabilitySchema,
  failureClassSchema,
  riskClassSchema,
  approvalModeSchema,
  taskPhaseSchema,
  taskLifecycleStatusSchema,
  agentTypeSchema,
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
  outputTokens: z.number().int().min(0)
});

export const tokenBudgetResultSchema = z.object({
  phase: taskPhaseSchema,
  estimatedTokens: z.number().int().min(0),
  budgetLimit: z.number().int().min(0),
  withinBudget: z.boolean(),
  overageAction: tokenBudgetOverageActionSchema,
  actualInputTokens: z.number().int().min(0).nullable().optional(),
  actualOutputTokens: z.number().int().min(0).nullable().optional()
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

export type PlanningTaskInput = z.infer<typeof planningTaskInputSchema>;
export type DirectTaskInjectionRequest = z.infer<typeof directTaskInjectionRequestSchema>;
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
export type PlanningSpec = z.infer<typeof planningSpecSchema>;

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
