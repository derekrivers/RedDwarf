import { z } from "zod";
import {
  agentTypeSchema,
  architectureReviewCheckStatusSchema,
  architectureReviewVerdictSchema,
  capabilitySchema,
  eventLevelSchema,
  openClawAgentRoleSchema,
  openClawBootstrapFileKindSchema,
  openClawSandboxModeSchema,
  openClawToolProfileSchema,
  OPENCLAW_BOOTSTRAP_FILE_COUNT,
  taskPhaseSchema
} from "./enums.js";
import type {
  WorkspaceContextBundle,
  MaterializedManagedWorkspace
} from "./workspace.js";
import type { PlanningTaskInput, TaskManifest } from "./planning.js";

export const agentDefinitionSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  type: agentTypeSchema,
  capabilities: z.array(capabilitySchema),
  activePhases: z.array(taskPhaseSchema),
  enabled: z.boolean(),
  description: z.string().min(1)
});

export const openClawBootstrapFileSchema = z.object({
  kind: openClawBootstrapFileKindSchema,
  relativePath: z.string().min(1),
  description: z.string().min(1)
});

export const openClawModelBindingSchema = z.object({
  provider: z.literal("anthropic"),
  model: z.string().min(1)
});

export const openClawAgentRuntimePolicySchema = z.object({
  toolProfile: openClawToolProfileSchema,
  allow: z.array(z.string().min(1)),
  deny: z.array(z.string().min(1)),
  sandboxMode: openClawSandboxModeSchema,
  model: openClawModelBindingSchema
});

export const openClawAgentRoleDefinitionSchema = z.object({
  agentId: z.string().min(1),
  role: openClawAgentRoleSchema,
  displayName: z.string().min(1),
  purpose: z.string().min(1),
  runtimePolicy: openClawAgentRuntimePolicySchema,
  bootstrapFiles: z
    .array(openClawBootstrapFileSchema)
    .length(OPENCLAW_BOOTSTRAP_FILE_COUNT),
  canonicalSources: z.array(z.string().min(1)).min(1)
});

export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
export type OpenClawBootstrapFile = z.infer<typeof openClawBootstrapFileSchema>;
export type OpenClawModelBinding = z.infer<typeof openClawModelBindingSchema>;
export type OpenClawAgentRuntimePolicy = z.infer<
  typeof openClawAgentRuntimePolicySchema
>;
export type OpenClawAgentRoleDefinition = z.infer<
  typeof openClawAgentRoleDefinitionSchema
>;

export const architectureReviewCheckSchema = z.object({
  name: z.string().min(1),
  status: architectureReviewCheckStatusSchema,
  detail: z.string().min(1)
});

export const architectureReviewFindingSchema = z.object({
  severity: eventLevelSchema,
  summary: z.string().min(1),
  detail: z.string().min(1),
  affectedPaths: z.array(z.string().min(1))
});

export const architectureReviewReportSchema = z.object({
  verdict: architectureReviewVerdictSchema,
  summary: z.string().min(1),
  structuralDrift: z.array(z.string().min(1)),
  checks: z.array(architectureReviewCheckSchema).min(1),
  findings: z.array(architectureReviewFindingSchema),
  recommendedNextActions: z.array(z.string().min(1))
});

export type ArchitectureReviewCheck = z.infer<
  typeof architectureReviewCheckSchema
>;
export type ArchitectureReviewFinding = z.infer<
  typeof architectureReviewFindingSchema
>;
export type ArchitectureReviewReport = z.infer<
  typeof architectureReviewReportSchema
>;

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

export interface ArchitectureReviewAgent {
  reviewImplementation(
    bundle: WorkspaceContextBundle,
    context: {
      manifest: TaskManifest;
      runId: string;
      workspace: MaterializedManagedWorkspace;
      architectHandoffMarkdown?: string | null;
      developerHandoffMarkdown?: string | null;
    }
  ): Promise<ArchitectureReviewReport>;
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
