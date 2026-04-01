import { z } from "zod";
import { confidenceLevelSchema } from "./planning.js";
import {
  isoDateTimeSchema,
  approvalModeSchema,
  capabilitySchema,
  taskPhaseSchema,
  approvalRequestStatusSchema,
  approvalDecisionSchema,
  riskClassSchema,
  QUERY_LIMIT_MAX,
  QUERY_LIMIT_DEFAULT
} from "./enums.js";

export const policySnapshotSchema = z.object({
  policyVersion: z.string().min(1),
  approvalMode: approvalModeSchema,
  allowedCapabilities: z.array(capabilitySchema),
  allowedPaths: z.array(z.string().min(1)),
  allowedSecretScopes: z.array(z.string().min(1)).default([]),
  blockedPhases: z.array(taskPhaseSchema),
  reasons: z.array(z.string().min(1))
});

export const approvalRequestSchema = z.object({
  requestId: z.string().min(1),
  taskId: z.string().min(1),
  runId: z.string().min(1),
  phase: taskPhaseSchema,
  dryRun: z.boolean().default(false),
  confidenceLevel: confidenceLevelSchema.nullable().default(null),
  confidenceReason: z.string().min(1).nullable().default(null),
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
  limit: z.number().int().positive().max(QUERY_LIMIT_MAX).default(QUERY_LIMIT_DEFAULT)
});

export type PolicySnapshot = z.infer<typeof policySnapshotSchema>;
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
export type ApprovalRequestQuery = z.infer<typeof approvalRequestQuerySchema>;
