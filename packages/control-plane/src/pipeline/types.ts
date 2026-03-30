import {
  type ApprovalDecision,
  type ApprovalRequest,
  type Capability,
  type ConcurrencyDecision,
  type ConcurrencyStrategy,
  type DevelopmentAgent,
  type FailureClass,
  type MaterializedManagedWorkspace,
  type PipelineRun,
  type PlanningAgent,
  type PlanningSpec,
  type PolicySnapshot,
  type ScmAgent,
  type TaskManifest,
  type TaskPhase,
  type ValidationAgent,
  type WorkspaceRuntimeConfig
} from "@reddwarf/contracts";
import {
  type PlanningRepository
} from "@reddwarf/evidence";
import {
  type GitHubAdapter,
  type GitHubBranchSummary,
  type GitHubCreatedIssueSummary,
  type GitHubPullRequestSummary,
  type OpenClawDispatchAdapter,
  type OpenClawDispatchResult,
  type SecretsAdapter
} from "@reddwarf/integrations";
import {
  DEFAULT_OPENCLAW_COMPLETION_TIMEOUT_MS,
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  type OpenClawCompletionAwaiter,
  type WorkspaceCommitPublisher,
  type WorkspaceRepoBootstrapper
} from "../live-workflow.js";
import { type PlanningPipelineLogger } from "../logger.js";

export interface PhaseDefinition {
  failureClass: FailureClass;
  failureCode: string;
  recovery: {
    retryLimit: number;
    retryableFailureClasses: readonly FailureClass[];
  };
}

const defaultRecovery: PhaseDefinition["recovery"] = {
  retryLimit: 0,
  retryableFailureClasses: []
};

export const phaseRegistry: Record<TaskPhase, PhaseDefinition> = {
  intake: { failureClass: "integration_failure", failureCode: "INTAKE_FAILED", recovery: defaultRecovery },
  eligibility: { failureClass: "policy_violation", failureCode: "ELIGIBILITY_FAILED", recovery: defaultRecovery },
  planning: { failureClass: "planning_failure", failureCode: "PLANNING_FAILED", recovery: defaultRecovery },
  policy_gate: { failureClass: "policy_violation", failureCode: "POLICY_GATE_FAILED", recovery: defaultRecovery },
  development: { failureClass: "integration_failure", failureCode: "DEVELOPMENT_FAILED", recovery: { retryLimit: 1, retryableFailureClasses: ["integration_failure"] } },
  validation: { failureClass: "validation_failure", failureCode: "VALIDATION_FAILED", recovery: { retryLimit: 1, retryableFailureClasses: ["validation_failure", "integration_failure"] } },
  review: { failureClass: "review_failure", failureCode: "REVIEW_FAILED", recovery: defaultRecovery },
  scm: { failureClass: "merge_failure", failureCode: "SCM_FAILED", recovery: defaultRecovery },
  archive: { failureClass: "integration_failure", failureCode: "ARCHIVE_FAILED", recovery: defaultRecovery }
};

export const failureAutomationRequestedBy = "failure-automation";
export const failureRecoveryMemoryKey = "failure.recovery";
export const followUpIssueMemoryPrefix = "failure.follow_up_issue";

export const EventCodes = {
  PIPELINE_STARTED: "PIPELINE_STARTED",
  PIPELINE_COMPLETED: "PIPELINE_COMPLETED",
  PIPELINE_BLOCKED: "PIPELINE_BLOCKED",
  PIPELINE_FAILED: "PIPELINE_FAILED",
  PHASE_RUNNING: "PHASE_RUNNING",
  PHASE_PASSED: "PHASE_PASSED",
  PHASE_FAILED: "PHASE_FAILED",
  PHASE_BLOCKED: "PHASE_BLOCKED",
  PHASE_RETRY_SCHEDULED: "PHASE_RETRY_SCHEDULED",
  PHASE_ESCALATED: "PHASE_ESCALATED",
  RUN_BLOCKED_BY_OVERLAP: "RUN_BLOCKED_BY_OVERLAP",
  STALE_RUNS_DETECTED: "STALE_RUNS_DETECTED",
  APPROVAL_REQUESTED: "APPROVAL_REQUESTED",
  WORKSPACE_PROVISIONED: "WORKSPACE_PROVISIONED",
  WORKSPACE_PREPARED: "WORKSPACE_PREPARED",
  CODE_WRITE_DISABLED: "CODE_WRITE_DISABLED",
  SECRET_LEASE_ISSUED: "SECRET_LEASE_ISSUED",
  SECRET_LEASE_SCRUBBED: "SECRET_LEASE_SCRUBBED",
  BRANCH_CREATED: "BRANCH_CREATED",
  PULL_REQUEST_CREATED: "PULL_REQUEST_CREATED",
  FOLLOW_UP_ISSUE_CREATED: "FOLLOW_UP_ISSUE_CREATED",
  FOLLOW_UP_ISSUE_SKIPPED: "FOLLOW_UP_ISSUE_SKIPPED",
  VALIDATION_PLAN_EMPTY: "VALIDATION_PLAN_EMPTY",
  VALIDATION_COMMAND_STARTED: "VALIDATION_COMMAND_STARTED",
  VALIDATION_COMMAND_PASSED: "VALIDATION_COMMAND_PASSED",
  VALIDATION_COMMAND_FAILED: "VALIDATION_COMMAND_FAILED",
  SECRETS_ADAPTER_REQUIRED: "SECRETS_ADAPTER_REQUIRED",
  SECRET_LEASE_FAILED: "SECRET_LEASE_FAILED",
  SECRET_LEASE_MISSING: "SECRET_LEASE_MISSING",
  OPENCLAW_DISPATCH: "OPENCLAW_DISPATCH",
  OPENCLAW_COMPLETION_TIMED_OUT: "OPENCLAW_COMPLETION_TIMED_OUT",
  VALIDATION_COMMAND_TIMED_OUT: "VALIDATION_COMMAND_TIMED_OUT",
  GIT_COMMAND_TIMED_OUT: "GIT_COMMAND_TIMED_OUT",
  ALLOWED_PATHS_VIOLATED: "ALLOWED_PATHS_VIOLATED"
} as const;

export const DEFAULT_PHASE_STALE_AFTER_MS = 5 * 60_000;
export const PHASE_HEARTBEAT_INTERVAL_MS = DEFAULT_OPENCLAW_COMPLETION_TIMEOUT_MS;
export const PHASE_STALE_GRACE_MS = PHASE_HEARTBEAT_INTERVAL_MS * 3;
export const DEFAULT_VALIDATION_COMMAND_TIMEOUT_MS = 10 * 60_000;

export const phaseTimeoutBudgetsMs: Partial<Record<TaskPhase, number>> = {
  planning: DEFAULT_OPENCLAW_COMPLETION_TIMEOUT_MS,
  development: DEFAULT_OPENCLAW_COMPLETION_TIMEOUT_MS,
  validation: DEFAULT_VALIDATION_COMMAND_TIMEOUT_MS,
  scm: DEFAULT_GIT_COMMAND_TIMEOUT_MS
};

export type RecoverablePhase = "development" | "validation" | "scm";

export interface PlanningConcurrencyOptions {
  strategy?: ConcurrencyStrategy;
  staleAfterMs?: number;
}

export interface PhaseTimingOptions {
  heartbeatIntervalMs?: number;
  openClawCompletionTimeoutMs?: number;
  gitCommandTimeoutMs?: number;
  validationCommandTimeoutMs?: number;
}

export interface PlanningPipelineDependencies {
  repository: PlanningRepository;
  planner: PlanningAgent;
  runtimeConfig?: WorkspaceRuntimeConfig;
  openClawDispatch?: OpenClawDispatchAdapter;
  openClawArchitectAgentId?: string;
  openClawArchitectAwaiter?: OpenClawCompletionAwaiter;
  architectTargetRoot?: string;
  logger?: PlanningPipelineLogger;
  clock?: () => Date;
  idGenerator?: () => string;
  concurrency?: PlanningConcurrencyOptions;
  timing?: PhaseTimingOptions;
}

export interface PlanningPipelineResult {
  runId: string;
  manifest: TaskManifest;
  spec?: PlanningSpec;
  policySnapshot?: PolicySnapshot;
  approvalRequest?: ApprovalRequest;
  hollyHandoffMarkdown?: string;
  nextAction: "complete" | "await_human" | "task_blocked";
  concurrencyDecision: ConcurrencyDecision;
}

export interface RunDeveloperPhaseInput {
  taskId: string;
  targetRoot: string;
  workspaceId?: string;
  evidenceRoot?: string | undefined;
}

export interface RunValidationPhaseInput {
  taskId: string;
  targetRoot: string;
  workspaceId?: string;
  evidenceRoot?: string | undefined;
}

export interface RunScmPhaseInput {
  taskId: string;
  targetRoot: string;
  workspaceId?: string;
  evidenceRoot?: string | undefined;
}

export interface DevelopmentPhaseDependencies {
  repository: PlanningRepository;
  developer: DevelopmentAgent;
  runtimeConfig?: WorkspaceRuntimeConfig;
  github?: GitHubAdapter;
  secrets?: SecretsAdapter;
  openClawDispatch?: OpenClawDispatchAdapter;
  workspaceRepoBootstrapper?: WorkspaceRepoBootstrapper;
  openClawCompletionAwaiter?: OpenClawCompletionAwaiter;
  openClawAgentId?: string;
  hollyHandoffMarkdown?: string;
  environment?: string;
  logger?: PlanningPipelineLogger;
  clock?: () => Date;
  idGenerator?: () => string;
  concurrency?: PlanningConcurrencyOptions;
  timing?: PhaseTimingOptions;
}

export interface ValidationPhaseDependencies {
  repository: PlanningRepository;
  validator: ValidationAgent;
  runtimeConfig?: WorkspaceRuntimeConfig;
  github?: GitHubAdapter;
  secrets?: SecretsAdapter;
  environment?: string;
  logger?: PlanningPipelineLogger;
  clock?: () => Date;
  idGenerator?: () => string;
  concurrency?: PlanningConcurrencyOptions;
  timing?: PhaseTimingOptions;
}

export interface ScmPhaseDependencies {
  repository: PlanningRepository;
  scm: ScmAgent;
  runtimeConfig?: WorkspaceRuntimeConfig;
  github: GitHubAdapter;
  workspaceRepoBootstrapper?: WorkspaceRepoBootstrapper;
  workspaceCommitPublisher?: WorkspaceCommitPublisher;
  logger?: PlanningPipelineLogger;
  clock?: () => Date;
  idGenerator?: () => string;
  concurrency?: PlanningConcurrencyOptions;
  timing?: PhaseTimingOptions;
}

export interface DevelopmentPhaseResult {
  runId: string;
  manifest: TaskManifest;
  workspace?: MaterializedManagedWorkspace;
  handoff?: import("@reddwarf/contracts").DevelopmentDraft;
  handoffPath?: string;
  nextAction: "await_validation" | "task_blocked";
  concurrencyDecision: ConcurrencyDecision;
  openClawDispatchResult?: OpenClawDispatchResult;
}

export interface ValidationPhaseResult {
  runId: string;
  manifest: TaskManifest;
  workspace?: MaterializedManagedWorkspace;
  report?: import("@reddwarf/contracts").ValidationReport;
  reportPath?: string;
  nextAction: "await_review" | "await_scm" | "task_blocked";
  concurrencyDecision: ConcurrencyDecision;
}

export interface ScmPhaseResult {
  runId: string;
  manifest: TaskManifest;
  workspace?: MaterializedManagedWorkspace;
  draft?: import("@reddwarf/contracts").ScmDraft;
  branch?: GitHubBranchSummary;
  pullRequest?: GitHubPullRequestSummary;
  reportPath?: string;
  nextAction: "complete" | "task_blocked";
  concurrencyDecision: ConcurrencyDecision;
}

export interface ResolveApprovalRequestInput {
  requestId: string;
  decision: ApprovalDecision;
  decidedBy: string;
  decisionSummary: string;
  comment?: string | null;
}

export interface ResolveApprovalRequestDependencies {
  repository: PlanningRepository;
  logger?: PlanningPipelineLogger;
  clock?: () => Date;
}

export interface ResolveApprovalRequestResult {
  approvalRequest: ApprovalRequest;
  manifest: TaskManifest;
}

export interface SweepStaleRunsOptions {
  staleAfterMs?: number;
  clock?: () => Date;
  logger?: PlanningPipelineLogger;
}

export interface SweepStaleRunsResult {
  sweptRunIds: string[];
  sweptAt: string;
}

export interface DispatchReadyTaskInput {
  taskId: string;
  targetRoot: string;
  evidenceRoot?: string | undefined;
}

export interface DispatchReadyTaskDependencies {
  repository: PlanningRepository;
  developer: DevelopmentAgent;
  validator: ValidationAgent;
  scm: ScmAgent;
  github: GitHubAdapter;
  openClawDispatch?: OpenClawDispatchAdapter;
  secrets?: SecretsAdapter;
  workspaceRepoBootstrapper?: WorkspaceRepoBootstrapper;
  openClawCompletionAwaiter?: OpenClawCompletionAwaiter;
  workspaceCommitPublisher?: WorkspaceCommitPublisher;
  logger?: PlanningPipelineLogger;
  clock?: () => Date;
  concurrency?: PlanningConcurrencyOptions;
  timing?: PhaseTimingOptions;
}

export type DispatchPhaseOutcome = "completed" | "blocked" | "failed";

export interface DispatchReadyTaskResult {
  taskId: string;
  outcome: DispatchPhaseOutcome;
  phasesExecuted: string[];
  finalPhase: string;
  pullRequestUrl?: string;
  error?: string;
}

export class PlanningPipelineFailure extends Error {
  public readonly failureClass: FailureClass;
  public readonly phase: TaskPhase;
  public readonly code: string;
  public readonly details: Record<string, unknown>;
  public readonly taskId: string | null;
  public readonly runId: string | null;

  constructor(input: {
    message: string;
    failureClass: FailureClass;
    phase: TaskPhase;
    code: string;
    details?: Record<string, unknown>;
    cause?: unknown;
    taskId?: string | null;
    runId?: string | null;
  }) {
    super(
      input.message,
      input.cause === undefined ? undefined : { cause: input.cause }
    );
    this.name = "PlanningPipelineFailure";
    this.failureClass = input.failureClass;
    this.phase = input.phase;
    this.code = input.code;
    this.details = input.details ?? {};
    this.taskId = input.taskId ?? null;
    this.runId = input.runId ?? null;
  }
}

// Internal types used across modules
export interface AutomatedFailureRecoveryResult {
  manifest: TaskManifest;
  recoveryAction: "retry" | "escalate";
  approvalRequest: ApprovalRequest | null;
  followUpIssue: GitHubCreatedIssueSummary | null;
}

export interface FailureRecoveryMemoryValue {
  phase: RecoverablePhase;
  action: "retry" | "escalate";
  runId: string;
  failureCode: string;
  failureClass: FailureClass;
  retryCount: number;
  retryLimit: number;
}

export interface ValidatedPhaseSnapshot {
  snapshot: import("@reddwarf/evidence").PersistedTaskSnapshot;
  manifest: TaskManifest;
  spec: PlanningSpec;
  policySnapshot: PolicySnapshot;
}

export interface ResolvedPhaseDependencies {
  logger: PlanningPipelineLogger;
  clock: () => Date;
  idGenerator: () => string;
  concurrency: Required<PlanningConcurrencyOptions>;
}

export interface ConcurrencyBlockedContext {
  repository: PlanningRepository;
  trackedRun: PipelineRun;
  concurrencyKey: string;
  strategy: ConcurrencyStrategy;
  taskId: string;
  runId: string;
  phase: TaskPhase;
  runStartedAt: Date;
  runStartedAtIso: string;
  blockedByRun: PipelineRun;
  staleRunIds: string[];
  runLogger: PlanningPipelineLogger;
  nextEventId: (phase: TaskPhase, code: string) => string;
}

export interface PhaseFailureContext {
  repository: PlanningRepository;
  snapshot: import("@reddwarf/evidence").PersistedTaskSnapshot;
  manifest: TaskManifest;
  phase: TaskPhase;
  runId: string;
  failure: PlanningPipelineFailure;
  runLogger: PlanningPipelineLogger;
  nextEventId: (phase: TaskPhase, code: string) => string;
  runStartedAt: Date;
  failedAt: Date;
  failedAtIso: string;
  persistTrackedRun: (
    patch: Partial<PipelineRun> & { metadata?: Record<string, unknown> },
    runRepository?: { savePipelineRun(run: PipelineRun): Promise<void> }
  ) => Promise<void>;
  github?: GitHubAdapter | undefined;
}

export type ExecutedValidationCommandResult = import("@reddwarf/contracts").ValidationCommandResult & {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  timeoutMs: number | null;
};
