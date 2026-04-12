import { z } from "zod";

export const taskPhases = [
  "intake",
  "eligibility",
  "planning",
  "policy_gate",
  "development",
  "architecture_review",
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
  "external",
  /** Repository-scoped memories — persist across tasks for the same repo (Feature 156). */
  "repo"
] as const;
export const memoryProvenances = [
  "human_curated",
  "pipeline_derived",
  "external_retrieval",
  /** Observations extracted from agent session outputs such as OpenClaw dreaming passes (Feature 156). */
  "agent_observed",
  /** Feedback provided by an operator via the approval rework flow (Feature 175). */
  "operator_provided"
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
  "active",
  "completed",
  "blocked",
  "failed"
] as const;
export const workspaceLifecycleStatuses = ["provisioned", "destroyed"] as const;
export const workspaceToolModes = [
  "planning_only",
  "development_readonly",
  "development_readwrite",
  "architecture_review_only",
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
export const approvalDecisions = ["approve", "reject", "rework"] as const;
export const githubIssuePollingCursorStatuses = ["succeeded", "failed"] as const;

export const openClawAgentRoles = [
  "coordinator",
  "analyst",
  "reviewer",
  "validator",
  "developer"
] as const;
export const openClawModelProviders = ["anthropic", "openai", "openai-codex"] as const;
export const openClawModelProviderSchema = z.enum(openClawModelProviders);
export const openClawBootstrapFileKinds = [
  "identity",
  "soul",
  "agents",
  "tools",
  "skill"
] as const;
export const openClawToolProfiles = ["minimal", "coding", "messaging", "full"] as const;
export const openClawSandboxModes = ["read_only", "workspace_write"] as const;
export const projectSizes = ["small", "medium", "large"] as const;
export const projectStatuses = [
  "draft",
  "clarification_pending",
  "pending_approval",
  "approved",
  "executing",
  "complete",
  "failed"
] as const;
export const ticketStatuses = [
  "pending",
  "dispatched",
  "in_progress",
  "pr_open",
  "merged",
  "failed"
] as const;

export const architectureReviewVerdicts = ["pass", "fail", "escalate"] as const;
export const architectureReviewCheckStatuses = [
  "pass",
  "fail",
  "not_applicable"
] as const;

// Schema validation constants

export const TITLE_MIN_LENGTH = 5;
export const SUMMARY_MIN_LENGTH = 20;
export const PRIORITY_MIN = 0;
export const PRIORITY_MAX = 100;
export const QUERY_LIMIT_MAX = 100;
export const QUERY_LIMIT_DEFAULT = 50;
export const OPENCLAW_BOOTSTRAP_FILE_COUNT = 5;

// Shared utility schemas

export const isoDateTimeSchema = z.string().datetime({ offset: true });

export const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema)
  ])
);

// Enum schemas

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
export const openClawAgentRoleSchema = z.enum(openClawAgentRoles);
export const openClawBootstrapFileKindSchema = z.enum(openClawBootstrapFileKinds);
export const openClawToolProfileSchema = z.enum(openClawToolProfiles);
export const openClawSandboxModeSchema = z.enum(openClawSandboxModes);
export const projectSizeSchema = z.enum(projectSizes);
export const projectStatusSchema = z.enum(projectStatuses);
export const ticketStatusSchema = z.enum(ticketStatuses);
export const architectureReviewVerdictSchema = z.enum(
  architectureReviewVerdicts
);
export const architectureReviewCheckStatusSchema = z.enum(
  architectureReviewCheckStatuses
);

// Enum type exports

export type TaskPhase = z.infer<typeof taskPhaseSchema>;
export type TaskLifecycleStatus = z.infer<typeof taskLifecycleStatusSchema>;
export type PhaseLifecycleStatus = z.infer<typeof phaseLifecycleStatusSchema>;
export type RiskClass = z.infer<typeof riskClassSchema>;
export type ApprovalMode = z.infer<typeof approvalModeSchema>;
export type Capability = z.infer<typeof capabilitySchema>;
export type AgentType = z.infer<typeof agentTypeSchema>;
export type WorkspaceLifecycleStatus = z.infer<typeof workspaceLifecycleStatusSchema>;
export type WorkspaceToolMode = z.infer<typeof workspaceToolModeSchema>;
export type WorkspaceCredentialMode = z.infer<typeof workspaceCredentialModeSchema>;
export type ApprovalRequestStatus = z.infer<typeof approvalRequestStatusSchema>;
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
export type GitHubIssuePollingCursorStatus = z.infer<typeof githubIssuePollingCursorStatusSchema>;
export type MemoryProvenance = z.infer<typeof memoryProvenanceSchema>;
export type ConcurrencyStrategy = z.infer<typeof concurrencyStrategySchema>;
export type PipelineRunStatus = z.infer<typeof pipelineRunStatusSchema>;
export type OverlapAction = z.infer<typeof overlapActionSchema>;
export type FailureClass = z.infer<typeof failureClassSchema>;
export type PipelineRunStatusSummary = z.infer<typeof pipelineRunStatusSummarySchema>;
export type OpenClawAgentRole = z.infer<typeof openClawAgentRoleSchema>;
export type OpenClawBootstrapFileKind = z.infer<typeof openClawBootstrapFileKindSchema>;
export type OpenClawToolProfile = z.infer<typeof openClawToolProfileSchema>;
export type OpenClawSandboxMode = z.infer<typeof openClawSandboxModeSchema>;
export type ArchitectureReviewVerdict = z.infer<
  typeof architectureReviewVerdictSchema
>;
export type ProjectSize = z.infer<typeof projectSizeSchema>;
export type ProjectStatus = z.infer<typeof projectStatusSchema>;
export type TicketStatus = z.infer<typeof ticketStatusSchema>;
export type ArchitectureReviewCheckStatus = z.infer<
  typeof architectureReviewCheckStatusSchema
>;

// Status transition maps

/**
 * Valid state transitions for ProjectSpec.status.
 * Any transition not listed here is illegal and should be rejected.
 */
export const validProjectStatusTransitions: Record<ProjectStatus, readonly ProjectStatus[]> = {
  draft: ["clarification_pending", "pending_approval", "failed"],
  clarification_pending: ["draft", "pending_approval", "failed"],
  pending_approval: ["approved", "draft", "failed"],
  approved: ["executing", "failed"],
  executing: ["complete", "failed"],
  complete: [],
  failed: ["executing", "draft"]
};

/**
 * Valid state transitions for TicketSpec.status.
 * Any transition not listed here is illegal and should be rejected.
 */
export const validTicketStatusTransitions: Record<TicketStatus, readonly TicketStatus[]> = {
  pending: ["dispatched", "failed"],
  dispatched: ["in_progress", "pr_open", "merged", "failed"],
  in_progress: ["pr_open", "merged", "failed"],
  pr_open: ["merged", "failed"],
  merged: [],
  failed: ["dispatched", "pending"]
};

/**
 * Validate that a project status transition is legal.
 * Throws if the transition is not allowed.
 */
export function assertValidProjectStatusTransition(
  from: ProjectStatus,
  to: ProjectStatus
): void {
  if (from === to) return;
  const allowed = validProjectStatusTransitions[from];
  if (!allowed.includes(to)) {
    throw new Error(
      `Invalid project status transition: '${from}' → '${to}'. Allowed transitions from '${from}': [${allowed.join(", ")}].`
    );
  }
}

/**
 * Validate that a ticket status transition is legal.
 * Throws if the transition is not allowed.
 */
export function assertValidTicketStatusTransition(
  from: TicketStatus,
  to: TicketStatus
): void {
  if (from === to) return;
  const allowed = validTicketStatusTransitions[from];
  if (!allowed.includes(to)) {
    throw new Error(
      `Invalid ticket status transition: '${from}' → '${to}'. Allowed transitions from '${from}': [${allowed.join(", ")}].`
    );
  }
}

// Utility

export function asIsoTimestamp(date: Date = new Date()): string {
  return date.toISOString();
}
