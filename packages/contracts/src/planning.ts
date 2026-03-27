import { z } from "zod";
import {
  isoDateTimeSchema,
  jsonValueSchema,
  capabilitySchema,
  riskClassSchema,
  approvalModeSchema,
  taskPhaseSchema,
  taskLifecycleStatusSchema,
  agentTypeSchema
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

export type PlanningTaskInput = z.infer<typeof planningTaskInputSchema>;
export type TaskManifest = z.infer<typeof taskManifestSchema>;
export type PlanningSpec = z.infer<typeof planningSpecSchema>;
