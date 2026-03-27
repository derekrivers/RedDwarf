import { z } from "zod";
import {
  isoDateTimeSchema,
  jsonValueSchema,
  taskPhaseSchema,
  phaseLifecycleStatusSchema,
  evidenceKindSchema,
  eventLevelSchema,
  failureClassSchema,
  pipelineRunStatusSummarySchema,
  memoryScopeSchema,
  memoryProvenanceSchema,
  concurrencyStrategySchema,
  pipelineRunStatusSchema,
  overlapActionSchema,
  policyPackEntryKindSchema,
  githubIssuePollingCursorStatusSchema,
  QUERY_LIMIT_MAX,
  QUERY_LIMIT_DEFAULT
} from "./enums.js";

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

export const evidenceRecordSchema = z.object({
  recordId: z.string().min(1),
  taskId: z.string().min(1),
  kind: evidenceKindSchema,
  title: z.string().min(1),
  location: z.string().min(1),
  metadata: z.record(jsonValueSchema).default({}),
  createdAt: isoDateTimeSchema
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
  limit: z.number().int().positive().max(QUERY_LIMIT_MAX).default(QUERY_LIMIT_DEFAULT)
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
  limit: z.number().int().positive().max(QUERY_LIMIT_MAX).default(QUERY_LIMIT_DEFAULT)
});

export const concurrencyDecisionSchema = z.object({
  action: overlapActionSchema,
  strategy: concurrencyStrategySchema,
  blockedByRunId: z.string().min(1).nullable(),
  staleRunIds: z.array(z.string().min(1)).default([]),
  reason: z.string().min(1).nullable()
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

export type PhaseRecord = z.infer<typeof phaseRecordSchema>;
export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;
export type RunEvent = z.infer<typeof runEventSchema>;
export type RunSummary = z.infer<typeof runSummarySchema>;
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;
export type MemoryQuery = z.infer<typeof memoryQuerySchema>;
export type MemoryContext = z.infer<typeof memoryContextSchema>;
export type PipelineRun = z.infer<typeof pipelineRunSchema>;
export type PipelineRunQuery = z.infer<typeof pipelineRunQuerySchema>;
export type ConcurrencyDecision = z.infer<typeof concurrencyDecisionSchema>;
export type PolicyPackEntry = z.infer<typeof policyPackEntrySchema>;
export type PolicyPackManifest = z.infer<typeof policyPackManifestSchema>;
export type GitHubIssuePollingCursor = z.infer<typeof githubIssuePollingCursorSchema>;
