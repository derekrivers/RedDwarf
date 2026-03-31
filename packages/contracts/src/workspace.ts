import { z } from "zod";
import {
  isoDateTimeSchema,
  taskPhaseSchema,
  agentTypeSchema,
  capabilitySchema,
  approvalModeSchema,
  workspaceLifecycleStatusSchema,
  workspaceToolModeSchema,
  workspaceCredentialModeSchema
} from "./enums.js";
import { memoryContextSchema } from "./evidence.js";
import { taskManifestSchema, planningSpecSchema } from "./planning.js";
import { policySnapshotSchema } from "./policy.js";
export const workspaceContextBundleSchema = z.object({
  manifest: z.lazy(() => taskManifestSchema),
  spec: planningSpecSchema,
  policySnapshot: policySnapshotSchema,
  memoryContext: memoryContextSchema.nullable().optional(),
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

export type WorkspaceContextBundle = z.infer<typeof workspaceContextBundleSchema>;
export type RuntimeInstructionFile = z.infer<typeof runtimeInstructionFileSchema>;
export type RuntimeInstructionLayer = z.infer<typeof runtimeInstructionLayerSchema>;
export type WorkspaceDescriptor = z.infer<typeof workspaceDescriptorSchema>;

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
  repoRoot: string | null;
  descriptor: WorkspaceDescriptor;
}


/** Injectable runtime environment configuration for workspace path resolution. */
export interface WorkspaceRuntimeConfig {
  /** Container-visible workspace root (default: REDDWARF_WORKSPACE_ROOT env, "/var/lib/reddwarf/workspaces"). */
  workspaceRoot?: string;
  /** Host-side workspace root used to compute the relative path into the container mount (default: REDDWARF_HOST_WORKSPACE_ROOT env). */
  hostWorkspaceRoot?: string;
  /** Host-side evidence root for artifact archival (default: REDDWARF_HOST_EVIDENCE_ROOT env). */
  hostEvidenceRoot?: string;
}
