import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import pino from "pino";
import type { DestinationStream, Logger as PinoLogger } from "pino";
import {
  asIsoTimestamp,
  capabilities,
  concurrencyDecisionSchema,
  phaseRecordSchema,
  planningSpecSchema,
  planningTaskInputSchema,
  runtimeInstructionLayerSchema,
  taskManifestSchema,
  workspaceContextBundleSchema,
  workspaceDescriptorSchema,
  type ApprovalDecision,
  type ApprovalRequest,
  type Capability,
  type ConcurrencyDecision,
  type ConcurrencyStrategy,
  type FailureClass,
  type PhaseLifecycleStatus,
  type PhaseRecord,
  type PipelineRun,
  type PlanningSpec,
  type PlanningTaskInput,
  type PolicySnapshot,
  type RuntimeInstructionLayer,
  type RunEvent,
  type WorkspaceDescriptor,
  type TaskLifecycleStatus,
  type TaskManifest,
  type TaskPhase,
  type WorkspaceContextBundle
} from "@reddwarf/contracts";
import {
  createApprovalRequest,
  createEvidenceRecord,
  createMemoryRecord,
  createPipelineRun,
  createRunEvent,
  deriveOrganizationId,
  type PersistedTaskSnapshot,
  type PlanningRepository
} from "@reddwarf/evidence";
import {
  redactSecretValues,
  type GitHubAdapter,
  type GitHubBranchSummary,
  type GitHubPullRequestSummary,
  type SecretLease,
  type SecretsAdapter
} from "@reddwarf/integrations";
import {
  agentDefinitions,
  assertPhaseExecutable
} from "@reddwarf/execution-plane";
import {
  assessEligibility,
  buildPolicySnapshot,
  classifyRisk,
  getPolicyVersion,
  resolveApprovalMode
} from "@reddwarf/policy";

const taskLifecycleTransitions: Record<
  TaskLifecycleStatus,
  TaskLifecycleStatus[]
> = {
  draft: ["ready", "cancelled"],
  ready: ["active", "cancelled"],
  active: ["blocked", "completed", "failed", "cancelled"],
  blocked: ["ready", "active", "failed", "cancelled", "completed"],
  completed: [],
  failed: ["draft", "cancelled"],
  cancelled: []
};

const phaseLifecycleTransitions: Record<
  PhaseLifecycleStatus,
  PhaseLifecycleStatus[]
> = {
  pending: ["running", "skipped"],
  running: ["passed", "failed", "escalated", "skipped"],
  passed: [],
  failed: [],
  escalated: ["running", "skipped"],
  skipped: []
};

const phaseFailureClassMap: Record<TaskPhase, FailureClass> = {
  intake: "integration_failure",
  eligibility: "policy_violation",
  planning: "planning_failure",
  policy_gate: "policy_violation",
  development: "integration_failure",
  validation: "validation_failure",
  review: "review_failure",
  scm: "merge_failure",
  archive: "integration_failure"
};

const phaseFailureCodeMap: Record<TaskPhase, string> = {
  intake: "INTAKE_FAILED",
  eligibility: "ELIGIBILITY_FAILED",
  planning: "PLANNING_FAILED",
  policy_gate: "POLICY_GATE_FAILED",
  development: "DEVELOPMENT_FAILED",
  validation: "VALIDATION_FAILED",
  review: "REVIEW_FAILED",
  scm: "SCM_FAILED",
  archive: "ARCHIVE_FAILED"
};

export interface PlanningPipelineLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child?(bindings: Record<string, unknown>): PlanningPipelineLogger;
}

export interface PlanningLogRecord {
  level: RunEvent["level"];
  message: string;
  bindings: Record<string, unknown>;
}

export interface PlanningDraft {
  summary: string;
  assumptions: string[];
  affectedAreas: string[];
  constraints: string[];
  testExpectations: string[];
}

export interface PlanningAgent {
  createSpec(
    input: PlanningTaskInput,
    context: { manifest: TaskManifest; runId: string }
  ): Promise<PlanningDraft>;
}

export interface PlanningConcurrencyOptions {
  strategy?: ConcurrencyStrategy;
  staleAfterMs?: number;
}

export interface PlanningPipelineDependencies {
  repository: PlanningRepository;
  planner: PlanningAgent;
  logger?: PlanningPipelineLogger;
  clock?: () => Date;
  idGenerator?: () => string;
  concurrency?: PlanningConcurrencyOptions;
}

export interface PlanningPipelineResult {
  runId: string;
  manifest: TaskManifest;
  spec?: PlanningSpec;
  policySnapshot?: PolicySnapshot;
  approvalRequest?: ApprovalRequest;
  nextAction: "complete" | "await_human" | "task_blocked";
  concurrencyDecision: ConcurrencyDecision;
}

export interface DevelopmentDraft {
  summary: string;
  implementationNotes: string[];
  blockedActions: string[];
  nextActions: string[];
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
  secrets?: SecretsAdapter;
  environment?: string;
  logger?: PlanningPipelineLogger;
  clock?: () => Date;
  idGenerator?: () => string;
  concurrency?: PlanningConcurrencyOptions;
}

export interface ValidationPhaseDependencies {
  repository: PlanningRepository;
  validator: ValidationAgent;
  secrets?: SecretsAdapter;
  environment?: string;
  logger?: PlanningPipelineLogger;
  clock?: () => Date;
  idGenerator?: () => string;
  concurrency?: PlanningConcurrencyOptions;
}

export interface ScmPhaseDependencies {
  repository: PlanningRepository;
  scm: ScmAgent;
  github: GitHubAdapter;
  logger?: PlanningPipelineLogger;
  clock?: () => Date;
  idGenerator?: () => string;
  concurrency?: PlanningConcurrencyOptions;
}

export interface DevelopmentPhaseResult {
  runId: string;
  manifest: TaskManifest;
  workspace?: MaterializedManagedWorkspace;
  handoff?: DevelopmentDraft;
  handoffPath?: string;
  nextAction: "await_validation" | "task_blocked";
  concurrencyDecision: ConcurrencyDecision;
}

export interface ValidationPhaseResult {
  runId: string;
  manifest: TaskManifest;
  workspace?: MaterializedManagedWorkspace;
  report?: ValidationReport;
  reportPath?: string;
  nextAction: "await_review" | "await_scm" | "task_blocked";
  concurrencyDecision: ConcurrencyDecision;
}

export interface ScmPhaseResult {
  runId: string;
  manifest: TaskManifest;
  workspace?: MaterializedManagedWorkspace;
  draft?: ScmDraft;
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

export interface WorkspaceContextArtifacts {
  taskJson: string;
  specMarkdown: string;
  policySnapshotJson: string;
  allowedPathsJson: string;
  acceptanceCriteriaJson: string;
}

export interface RuntimeInstructionArtifacts {
  soulMd: string;
  agentsMd: string;
  toolsMd: string;
  taskSkillMd: string;
}

export interface MaterializedRuntimeInstructionFiles {
  soulMd: string;
  agentsMd: string;
  toolsMd: string;
  taskSkillMd: string;
}

export interface MaterializedWorkspaceContext {
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
    files: MaterializedRuntimeInstructionFiles;
  };
}

export interface MaterializedManagedWorkspace extends MaterializedWorkspaceContext {
  stateDir: string;
  stateFile: string;
  scratchDir: string;
  artifactsDir: string;
  descriptor: WorkspaceDescriptor;
}

export interface DestroyedManagedWorkspace {
  workspaceId: string;
  workspaceRoot: string;
  removed: boolean;
  descriptor: WorkspaceDescriptor | null;
}

export interface ProvisionWorkspaceResult {
  manifest: TaskManifest;
  workspace: MaterializedManagedWorkspace;
}

export interface DestroyWorkspaceResult {
  manifest: TaskManifest;
  workspace: DestroyedManagedWorkspace;
}

type ArchivedArtifactClass =
  | "handoff"
  | "log"
  | "test_result"
  | "report"
  | "diff"
  | "review_output";

interface ArchivedEvidenceArtifact {
  evidenceRoot: string;
  archivePath: string;
  relativePath: string;
  location: string;
  byteSize: number;
  sha256: string;
}

export interface PinoPlanningLoggerOptions {
  level?: RunEvent["level"];
  baseBindings?: Record<string, unknown>;
  destination?: DestinationStream;
}

export interface BufferedPlanningLogger {
  logger: PlanningPipelineLogger;
  records: PlanningLogRecord[];
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

const defaultLogger: PlanningPipelineLogger = {
  info() {},
  warn() {},
  error() {},
  child() {
    return defaultLogger;
  }
};

const taskContractRelativePaths = [
  ".context/task.json",
  ".context/spec.md",
  ".context/policy_snapshot.json",
  ".context/allowed_paths.json",
  ".context/acceptance_criteria.json"
] as const;

const runtimeInstructionRelativePaths = {
  soulMd: "SOUL.md",
  agentsMd: "AGENTS.md",
  toolsMd: "TOOLS.md",
  taskSkillMd: "skills/reddwarf-task/SKILL.md"
} as const;

const workspaceStateDirName = ".workspace";
const workspaceStateFileName = "workspace.json";
const workspaceScratchDirName = "scratch";
const workspaceArtifactsDirName = "artifacts";
const workspaceCredentialsDirName = "credentials";
const workspaceSecretEnvFileName = "secret-env.json";
const workspaceLocationPrefix = "workspace://";
const evidenceLocationPrefix = "evidence://";
const defaultEvidenceDirName = "evidence";
const evidenceTasksDirName = "tasks";

const agentInstructionPathByType: Partial<
  Record<TaskManifest["assignedAgentType"], string>
> = {
  architect: "agents/architect.md",
  developer: "agents/developer.md",
  validation: "agents/validation.md"
};

const capabilityGuidance: Record<Capability, string> = {
  can_plan:
    "Inspect task context, policy inputs, and mounted standards to produce deterministic planning output.",
  can_write_code:
    "Write or modify product code only after the development phase is enabled and policy grants it.",
  can_run_tests:
    "Run validation commands only when the validation phase and policy both allow test execution.",
  can_open_pr:
    "Create branches, commits, or pull requests only behind explicit SCM approval gates.",
  can_modify_schema:
    "Change schemas or migrations only with explicit approval for sensitive surfaces.",
  can_touch_sensitive_paths:
    "Touch restricted repo areas only after path-level approval is granted.",
  can_use_secrets:
    "Use scoped credentials only when a secrets adapter has injected them for this task.",
  can_review:
    "Review generated work and compare it to requirements when the review phase is enabled.",
  can_archive_evidence:
    "Persist structured logs, specs, diffs, and verification output as durable evidence."
};

const planningWorkspaceCapabilities: Capability[] = [
  "can_plan",
  "can_archive_evidence"
];
const developmentWorkspaceCapabilities: Capability[] = [
  "can_archive_evidence",
  "can_use_secrets"
];
const validationWorkspaceCapabilities: Capability[] = [
  "can_run_tests",
  "can_archive_evidence",
  "can_use_secrets"
];
const scmWorkspaceCapabilities: Capability[] = [
  "can_open_pr",
  "can_archive_evidence"
];

const planningWorkspaceToolPolicyNotes = [
  "Workspace execution is constrained to planning-only capabilities in RedDwarf v1.",
  "Filesystem access should stay inside the isolated workspace plus policy-approved product paths."
] as const;

const developmentWorkspaceToolPolicyNotes = [
  "Developer orchestration is enabled in RedDwarf v1, but product code writes remain disabled by default.",
  "Use the isolated workspace for inspection, handoff artifacts, and evidence capture before validation checks run."
] as const;

const validationWorkspaceToolPolicyNotes = [
  "Validation orchestration is enabled in RedDwarf v1 for deterministic workspace-local checks.",
  "Run lint, test, and contract validation commands inside the isolated workspace while product code writes remain disabled."
] as const;

const scmWorkspaceToolPolicyNotes = [
  "SCM orchestration is enabled in RedDwarf v1 only for approved branch and pull-request creation after validation.",
  "Remote mutations are limited to the GitHub adapter while product code writes remain disabled in the managed workspace."
] as const;

const defaultWorkspaceCredentialPolicyNotes = [
  "Scoped secrets are disabled unless a task is approved for can_use_secrets and a secrets adapter issues a lease.",
  "No credentials are injected into provisioned workspaces by default."
] as const;

export function createPinoPlanningLogger(
  options: PinoPlanningLoggerOptions = {}
): PlanningPipelineLogger {
  const logger = pino(
    {
      name: "reddwarf.control-plane",
      level:
        options.level ??
        (process.env.REDDWARF_LOG_LEVEL as RunEvent["level"] | undefined) ??
        "info",
      base: {
        service: "reddwarf-control-plane",
        ...(options.baseBindings ?? {})
      }
    },
    options.destination
  );

  return wrapPinoLogger(logger);
}

export function createBufferedPlanningLogger(): BufferedPlanningLogger {
  const records: PlanningLogRecord[] = [];

  const createLogger = (
    bindings: Record<string, unknown>
  ): PlanningPipelineLogger => ({
    info(message, context) {
      records.push({
        level: "info",
        message,
        bindings: {
          ...bindings,
          ...(context ?? {})
        }
      });
    },
    warn(message, context) {
      records.push({
        level: "warn",
        message,
        bindings: {
          ...bindings,
          ...(context ?? {})
        }
      });
    },
    error(message, context) {
      records.push({
        level: "error",
        message,
        bindings: {
          ...bindings,
          ...(context ?? {})
        }
      });
    },
    child(childBindings) {
      return createLogger({
        ...bindings,
        ...childBindings
      });
    }
  });

  return {
    logger: createLogger({}),
    records
  };
}

export function assertTaskLifecycleTransition(
  from: TaskLifecycleStatus,
  to: TaskLifecycleStatus
): void {
  if (!taskLifecycleTransitions[from].includes(to)) {
    throw new Error(`Illegal task lifecycle transition from ${from} to ${to}.`);
  }
}

export function assertPhaseLifecycleTransition(
  from: PhaseLifecycleStatus,
  to: PhaseLifecycleStatus
): void {
  if (!phaseLifecycleTransitions[from].includes(to)) {
    throw new Error(
      `Illegal phase lifecycle transition from ${from} to ${to}.`
    );
  }
}
export function createWorkspaceContextBundle(input: {
  manifest: TaskManifest;
  spec: PlanningSpec;
  policySnapshot: PolicySnapshot;
}): WorkspaceContextBundle {
  return workspaceContextBundleSchema.parse({
    manifest: input.manifest,
    spec: input.spec,
    policySnapshot: input.policySnapshot,
    acceptanceCriteria: input.spec.acceptanceCriteria,
    allowedPaths: input.policySnapshot.allowedPaths
  });
}

export function createWorkspaceContextBundleFromSnapshot(
  snapshot: PersistedTaskSnapshot
): WorkspaceContextBundle {
  if (!snapshot.manifest) {
    throw new Error(
      "Cannot materialize workspace context without a task manifest."
    );
  }

  if (!snapshot.spec) {
    throw new Error(
      `Cannot materialize workspace context for ${snapshot.manifest.taskId} without a planning spec.`
    );
  }

  if (!snapshot.policySnapshot) {
    throw new Error(
      `Cannot materialize workspace context for ${snapshot.manifest.taskId} without a persisted policy snapshot.`
    );
  }

  return createWorkspaceContextBundle({
    manifest: snapshot.manifest,
    spec: snapshot.spec,
    policySnapshot: snapshot.policySnapshot
  });
}

export function renderPlanningSpecMarkdown(
  bundle: WorkspaceContextBundle
): string {
  return [
    "# Planning Spec",
    "",
    `- Task ID: ${bundle.manifest.taskId}`,
    `- Source Repo: ${bundle.manifest.source.repo}`,
    `- Risk Class: ${bundle.manifest.riskClass}`,
    `- Approval Mode: ${bundle.policySnapshot.approvalMode}`,
    "",
    "## Summary",
    "",
    bundle.spec.summary,
    "",
    "## Assumptions",
    "",
    ...bundle.spec.assumptions.map((item) => `- ${item}`),
    "",
    "## Affected Areas",
    "",
    ...bundle.spec.affectedAreas.map((item) => `- ${item}`),
    "",
    "## Constraints",
    "",
    ...bundle.spec.constraints.map((item) => `- ${item}`),
    "",
    "## Acceptance Criteria",
    "",
    ...bundle.spec.acceptanceCriteria.map((item) => `- ${item}`),
    "",
    "## Test Expectations",
    "",
    ...bundle.spec.testExpectations.map((item) => `- ${item}`),
    "",
    "## Policy Reasons",
    "",
    ...bundle.policySnapshot.reasons.map((item) => `- ${item}`),
    ""
  ].join("\n");
}

export function createWorkspaceContextArtifacts(
  bundleInput: WorkspaceContextBundle
): WorkspaceContextArtifacts {
  const bundle = workspaceContextBundleSchema.parse(bundleInput);

  return {
    taskJson: `${JSON.stringify(bundle.manifest, null, 2)}\n`,
    specMarkdown: renderPlanningSpecMarkdown(bundle),
    policySnapshotJson: `${JSON.stringify(bundle.policySnapshot, null, 2)}\n`,
    allowedPathsJson: `${JSON.stringify(bundle.allowedPaths, null, 2)}\n`,
    acceptanceCriteriaJson: `${JSON.stringify(bundle.acceptanceCriteria, null, 2)}\n`
  };
}

export function createRuntimeInstructionLayer(
  bundleInput: WorkspaceContextBundle
): RuntimeInstructionLayer {
  const bundle = workspaceContextBundleSchema.parse(bundleInput);
  const canonicalSources = buildCanonicalSources(bundle);
  const toolPolicy = createWorkspaceToolPolicy(bundle);

  return runtimeInstructionLayerSchema.parse({
    taskId: bundle.manifest.taskId,
    assignedAgentType: bundle.manifest.assignedAgentType,
    recommendedAgentType: bundle.spec.recommendedAgentType,
    approvalMode: bundle.policySnapshot.approvalMode,
    allowedCapabilities: toolPolicy.allowedCapabilities,
    blockedPhases: toolPolicy.blockedPhases,
    canonicalSources,
    contextFiles: [...taskContractRelativePaths],
    files: [
      {
        relativePath: runtimeInstructionRelativePaths.soulMd,
        description: "Workspace operating posture and source hierarchy.",
        content: renderRuntimeSoulMarkdown(bundle, canonicalSources)
      },
      {
        relativePath: runtimeInstructionRelativePaths.agentsMd,
        description: "Runtime agent roster and task routing guidance.",
        content: renderRuntimeAgentsMarkdown(bundle)
      },
      {
        relativePath: runtimeInstructionRelativePaths.toolsMd,
        description:
          "Capability, path, and escalation guardrails for the workspace.",
        content: renderRuntimeToolsMarkdown(bundle)
      },
      {
        relativePath: runtimeInstructionRelativePaths.taskSkillMd,
        description:
          "Task-scoped skill that tells agents how to use the context bundle and policy pack.",
        content: renderRuntimeTaskSkillMarkdown(bundle, canonicalSources)
      }
    ]
  });
}

export function createRuntimeInstructionArtifacts(
  layerInput: RuntimeInstructionLayer
): RuntimeInstructionArtifacts {
  const layer = runtimeInstructionLayerSchema.parse(layerInput);

  return {
    soulMd: getRuntimeInstructionContent(
      layer,
      runtimeInstructionRelativePaths.soulMd
    ),
    agentsMd: getRuntimeInstructionContent(
      layer,
      runtimeInstructionRelativePaths.agentsMd
    ),
    toolsMd: getRuntimeInstructionContent(
      layer,
      runtimeInstructionRelativePaths.toolsMd
    ),
    taskSkillMd: getRuntimeInstructionContent(
      layer,
      runtimeInstructionRelativePaths.taskSkillMd
    )
  };
}

export async function materializeWorkspaceContext(input: {
  bundle: WorkspaceContextBundle;
  targetRoot: string;
  workspaceId?: string;
}): Promise<MaterializedWorkspaceContext> {
  const bundle = workspaceContextBundleSchema.parse(input.bundle);
  const workspaceId =
    input.workspaceId ?? bundle.manifest.workspaceId ?? bundle.manifest.taskId;
  const workspaceRoot = resolve(input.targetRoot, workspaceId);
  const contextDir = join(workspaceRoot, ".context");
  const files = {
    taskJson: join(contextDir, "task.json"),
    specMarkdown: join(contextDir, "spec.md"),
    policySnapshotJson: join(contextDir, "policy_snapshot.json"),
    allowedPathsJson: join(contextDir, "allowed_paths.json"),
    acceptanceCriteriaJson: join(contextDir, "acceptance_criteria.json")
  };
  const materializedBundle = workspaceContextBundleSchema.parse({
    ...bundle,
    manifest: {
      ...bundle.manifest,
      workspaceId
    }
  });
  const artifacts = createWorkspaceContextArtifacts(materializedBundle);
  const runtimeInstructionLayer =
    createRuntimeInstructionLayer(materializedBundle);
  const runtimeInstructionArtifacts = createRuntimeInstructionArtifacts(
    runtimeInstructionLayer
  );
  const instructionFiles = {
    soulMd: join(workspaceRoot, runtimeInstructionRelativePaths.soulMd),
    agentsMd: join(workspaceRoot, runtimeInstructionRelativePaths.agentsMd),
    toolsMd: join(workspaceRoot, runtimeInstructionRelativePaths.toolsMd),
    taskSkillMd: join(
      workspaceRoot,
      ...runtimeInstructionRelativePaths.taskSkillMd.split("/")
    )
  };

  await mkdir(contextDir, { recursive: true });
  await mkdir(join(workspaceRoot, "skills", "reddwarf-task"), {
    recursive: true
  });
  await Promise.all([
    writeFile(files.taskJson, artifacts.taskJson, "utf8"),
    writeFile(files.specMarkdown, artifacts.specMarkdown, "utf8"),
    writeFile(files.policySnapshotJson, artifacts.policySnapshotJson, "utf8"),
    writeFile(files.allowedPathsJson, artifacts.allowedPathsJson, "utf8"),
    writeFile(
      files.acceptanceCriteriaJson,
      artifacts.acceptanceCriteriaJson,
      "utf8"
    ),
    writeFile(
      instructionFiles.soulMd,
      runtimeInstructionArtifacts.soulMd,
      "utf8"
    ),
    writeFile(
      instructionFiles.agentsMd,
      runtimeInstructionArtifacts.agentsMd,
      "utf8"
    ),
    writeFile(
      instructionFiles.toolsMd,
      runtimeInstructionArtifacts.toolsMd,
      "utf8"
    ),
    writeFile(
      instructionFiles.taskSkillMd,
      runtimeInstructionArtifacts.taskSkillMd,
      "utf8"
    )
  ]);

  return {
    workspaceId,
    workspaceRoot,
    contextDir,
    files,
    instructions: {
      canonicalSources: runtimeInstructionLayer.canonicalSources,
      taskContractFiles: Object.values(files),
      files: instructionFiles
    }
  };
}

export function createWorkspaceDescriptor(input: {
  bundle: WorkspaceContextBundle;
  materialized: MaterializedWorkspaceContext;
  createdAt?: string;
  updatedAt?: string;
  status?: WorkspaceDescriptor["status"];
  destroyedAt?: string | null;
  secretLease?: SecretLease | null;
  secretEnvFile?: string | null;
}): WorkspaceDescriptor {
  const bundle = workspaceContextBundleSchema.parse(input.bundle);
  const workspaceId = input.materialized.workspaceId;
  const createdAt = input.createdAt ?? asIsoTimestamp();
  const updatedAt = input.updatedAt ?? createdAt;
  const stateDir = join(
    input.materialized.workspaceRoot,
    workspaceStateDirName
  );
  const stateFile = join(stateDir, workspaceStateFileName);
  const scratchDir = join(
    input.materialized.workspaceRoot,
    workspaceScratchDirName
  );
  const artifactsDir = join(
    input.materialized.workspaceRoot,
    workspaceArtifactsDirName
  );
  const toolPolicy = createWorkspaceToolPolicy(bundle);
  const credentialPolicy = createWorkspaceCredentialPolicy({
    bundle,
    secretLease: input.secretLease ?? null,
    secretEnvFile: input.secretEnvFile ?? null
  });

  return workspaceDescriptorSchema.parse({
    workspaceId,
    taskId: bundle.manifest.taskId,
    workspaceRoot: input.materialized.workspaceRoot,
    contextDir: input.materialized.contextDir,
    stateFile,
    scratchDir,
    artifactsDir,
    status: input.status ?? "provisioned",
    assignedAgentType: bundle.manifest.assignedAgentType,
    recommendedAgentType: bundle.spec.recommendedAgentType,
    allowedCapabilities: toolPolicy.allowedCapabilities,
    allowedPaths: bundle.allowedPaths,
    blockedPhases: toolPolicy.blockedPhases,
    canonicalSources: input.materialized.instructions.canonicalSources,
    taskContractFiles: input.materialized.instructions.taskContractFiles,
    instructionFiles: input.materialized.instructions.files,
    toolPolicy,
    credentialPolicy,
    createdAt,
    updatedAt,
    destroyedAt: input.destroyedAt ?? null
  });
}

export async function materializeManagedWorkspace(input: {
  bundle: WorkspaceContextBundle;
  targetRoot: string;
  workspaceId?: string;
  createdAt?: string;
  secretLease?: SecretLease | null;
}): Promise<MaterializedManagedWorkspace> {
  const bundle = workspaceContextBundleSchema.parse(input.bundle);
  const materializedBundle = workspaceContextBundleSchema.parse({
    ...bundle,
    manifest: {
      ...bundle.manifest,
      workspaceId:
        input.workspaceId ??
        bundle.manifest.workspaceId ??
        `${bundle.manifest.taskId}-workspace`
    }
  });
  const materialized = await materializeWorkspaceContext({
    bundle: materializedBundle,
    targetRoot: input.targetRoot,
    ...(materializedBundle.manifest.workspaceId
      ? { workspaceId: materializedBundle.manifest.workspaceId }
      : {})
  });
  const stateDir = join(materialized.workspaceRoot, workspaceStateDirName);
  const stateFile = join(stateDir, workspaceStateFileName);
  const scratchDir = join(materialized.workspaceRoot, workspaceScratchDirName);
  const artifactsDir = join(
    materialized.workspaceRoot,
    workspaceArtifactsDirName
  );
  const credentialsDir = join(stateDir, workspaceCredentialsDirName);
  const secretLease = input.secretLease ?? null;
  const secretEnvFile = secretLease
    ? join(credentialsDir, workspaceSecretEnvFileName)
    : null;
  const descriptor = createWorkspaceDescriptor({
    bundle: materializedBundle,
    materialized,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    secretLease,
    secretEnvFile
  });

  await Promise.all([
    mkdir(stateDir, { recursive: true }),
    mkdir(scratchDir, { recursive: true }),
    mkdir(artifactsDir, { recursive: true }),
    ...(secretEnvFile ? [mkdir(credentialsDir, { recursive: true })] : [])
  ]);

  if (secretLease && secretEnvFile) {
    await writeFile(
      secretEnvFile,
      `${JSON.stringify(
        {
          leaseId: secretLease.leaseId,
          mode: secretLease.mode,
          secretScopes: secretLease.secretScopes,
          injectedSecretKeys: secretLease.injectedSecretKeys,
          issuedAt: secretLease.issuedAt,
          expiresAt: secretLease.expiresAt,
          environmentVariables: secretLease.environmentVariables,
          notes: secretLease.notes
        },
        null,
        2
      )}
`,
      "utf8"
    );
  }

  await writeFile(
    stateFile,
    `${JSON.stringify(descriptor, null, 2)}
`,
    "utf8"
  );

  return {
    ...materialized,
    stateDir,
    stateFile,
    scratchDir,
    artifactsDir,
    descriptor
  };
}

export async function provisionTaskWorkspace(input: {
  snapshot: PersistedTaskSnapshot;
  repository: PlanningRepository;
  targetRoot: string;
  workspaceId?: string;
  clock?: () => Date;
}): Promise<ProvisionWorkspaceResult> {
  const bundle = createWorkspaceContextBundleFromSnapshot(input.snapshot);
  const now = asIsoTimestamp((input.clock ?? (() => new Date()))());
  const workspace = await materializeManagedWorkspace({
    bundle,
    targetRoot: input.targetRoot,
    createdAt: now,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {})
  });
  const manifest = taskManifestSchema.parse({
    ...bundle.manifest,
    workspaceId: workspace.workspaceId,
    updatedAt: now,
    evidenceLinks: [
      ...new Set([
        ...bundle.manifest.evidenceLinks,
        `${workspaceLocationPrefix}${workspace.workspaceId}`
      ])
    ]
  });

  await input.repository.updateManifest(manifest);
  await input.repository.saveEvidenceRecord(
    createEvidenceRecord({
      recordId: `${bundle.manifest.taskId}:workspace:${workspace.workspaceId}:provisioned`,
      taskId: bundle.manifest.taskId,
      kind: "file_artifact",
      title: "Managed workspace provisioned",
      location: `${workspaceLocationPrefix}${workspace.workspaceId}`,
      metadata: {
        status: workspace.descriptor.status,
        workspaceRoot: workspace.workspaceRoot,
        stateFile: workspace.stateFile,
        descriptor: workspace.descriptor
      },
      createdAt: now
    })
  );

  return {
    manifest,
    workspace
  };
}

export async function destroyManagedWorkspace(input: {
  targetRoot: string;
  workspaceId: string;
  destroyedAt?: string;
}): Promise<DestroyedManagedWorkspace> {
  const destroyedAt = input.destroyedAt ?? asIsoTimestamp();
  const workspaceRoot = resolve(input.targetRoot, input.workspaceId);

  assertWorkspacePathWithinRoot(input.targetRoot, workspaceRoot);

  const stateFile = join(
    workspaceRoot,
    workspaceStateDirName,
    workspaceStateFileName
  );
  const descriptor = await readWorkspaceDescriptorForDestroy(
    stateFile,
    destroyedAt
  );
  const removed = await pathExists(workspaceRoot);

  if (removed) {
    await rm(workspaceRoot, { recursive: true, force: true });
  }

  return {
    workspaceId: input.workspaceId,
    workspaceRoot,
    removed,
    descriptor
  };
}

export async function destroyTaskWorkspace(input: {
  manifest: TaskManifest;
  repository: PlanningRepository;
  targetRoot: string;
  workspaceId?: string;
  evidenceRoot?: string | undefined;
  clock?: () => Date;
}): Promise<DestroyWorkspaceResult> {
  const workspaceId = input.workspaceId ?? input.manifest.workspaceId;

  if (!workspaceId) {
    throw new Error(
      `Cannot destroy workspace for ${input.manifest.taskId} without a workspaceId.`
    );
  }

  const destroyedAt = asIsoTimestamp((input.clock ?? (() => new Date()))());
  const workspace = await destroyManagedWorkspace({
    targetRoot: input.targetRoot,
    workspaceId,
    destroyedAt
  });
  const manifest = taskManifestSchema.parse({
    ...input.manifest,
    workspaceId: null,
    updatedAt: destroyedAt,
    evidenceLinks: [
      ...new Set([
        ...input.manifest.evidenceLinks,
        `${workspaceLocationPrefix}${workspaceId}`
      ])
    ]
  });

  await input.repository.updateManifest(manifest);
  await input.repository.saveEvidenceRecord(
    createEvidenceRecord({
      recordId: `${input.manifest.taskId}:workspace:${workspaceId}:destroyed`,
      taskId: input.manifest.taskId,
      kind: "file_artifact",
      title: "Managed workspace destroyed",
      location: `${workspaceLocationPrefix}${workspaceId}`,
      metadata: {
        status: workspace.descriptor?.status ?? "destroyed",
        workspaceRoot: workspace.workspaceRoot,
        removed: workspace.removed,
        descriptor: workspace.descriptor,
        destroyedAt
      },
      createdAt: destroyedAt
    })
  );

  return {
    manifest,
    workspace
  };
}

function resolveEvidenceRoot(targetRoot: string, evidenceRoot?: string): string {
  return resolve(
    evidenceRoot ??
      process.env.REDDWARF_HOST_EVIDENCE_ROOT ??
      join(targetRoot, "..", defaultEvidenceDirName)
  );
}

function sanitizeEvidencePathSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  return sanitized.length > 0 ? sanitized : "artifact";
}

async function archiveEvidenceArtifact(input: {
  taskId: string;
  runId: string;
  phase: TaskPhase;
  sourcePath: string;
  targetRoot: string;
  evidenceRoot?: string | undefined;
  fileName?: string;
}): Promise<ArchivedEvidenceArtifact> {
  const evidenceRoot = resolveEvidenceRoot(input.targetRoot, input.evidenceRoot);
  const relativePath = [
    evidenceTasksDirName,
    sanitizeEvidencePathSegment(input.taskId),
    sanitizeEvidencePathSegment(input.phase),
    sanitizeEvidencePathSegment(input.runId),
    input.fileName ?? basename(input.sourcePath)
  ].join("/");
  const archivePath = resolve(evidenceRoot, ...relativePath.split("/"));

  await mkdir(dirname(archivePath), { recursive: true });
  await copyFile(input.sourcePath, archivePath);

  const archiveContents = await readFile(archivePath);
  const archiveStats = await stat(archivePath);

  return {
    evidenceRoot,
    archivePath,
    relativePath,
    location: `${evidenceLocationPrefix}${relativePath}`,
    byteSize: archiveStats.size,
    sha256: createHash("sha256").update(archiveContents).digest("hex")
  };
}

function buildArchivedArtifactMetadata(input: {
  archivedArtifact: ArchivedEvidenceArtifact;
  artifactClass: ArchivedArtifactClass;
  sourceLocation: string;
  sourcePath: string;
}): Record<string, unknown> {
  return {
    artifactClass: input.artifactClass,
    sourceLocation: input.sourceLocation,
    sourcePath: input.sourcePath,
    evidenceRoot: input.archivedArtifact.evidenceRoot,
    archivePath: input.archivedArtifact.archivePath,
    archiveRelativePath: input.archivedArtifact.relativePath,
    byteSize: input.archivedArtifact.byteSize,
    sha256: input.archivedArtifact.sha256
  };
}

async function issueWorkspaceSecretLease(input: {
  bundle: WorkspaceContextBundle;
  phase: "development" | "validation";
  secrets?: SecretsAdapter;
  environment?: string;
}): Promise<SecretLease | null> {
  const bundle = workspaceContextBundleSchema.parse(input.bundle);
  const allowedSecretScopes = bundle.policySnapshot.allowedSecretScopes;
  const secretsRequested =
    bundle.manifest.requestedCapabilities.includes("can_use_secrets") &&
    bundle.policySnapshot.allowedCapabilities.includes("can_use_secrets") &&
    allowedSecretScopes.length > 0;

  if (!secretsRequested) {
    return null;
  }

  if (!input.secrets) {
    throw new PlanningPipelineFailure({
      message: `Task ${bundle.manifest.taskId} is approved for scoped secrets (${allowedSecretScopes.join(", ")}), but no secrets adapter is configured.`,
      failureClass: phaseFailureClassMap[input.phase],
      phase: input.phase,
      code: "SECRETS_ADAPTER_REQUIRED",
      details: {
        allowedSecretScopes,
        requestedCapabilities: bundle.manifest.requestedCapabilities
      },
      taskId: bundle.manifest.taskId,
      runId: null
    });
  }

  let lease: SecretLease | null;

  try {
    lease = await input.secrets.issueTaskSecrets({
      taskId: bundle.manifest.taskId,
      repo: bundle.manifest.source.repo,
      agentType: bundle.manifest.assignedAgentType,
      phase: input.phase,
      environment: input.environment ?? "default",
      riskClass: bundle.manifest.riskClass,
      approvalMode: bundle.manifest.approvalMode,
      requestedCapabilities: bundle.manifest.requestedCapabilities,
      allowedSecretScopes
    });
  } catch (error) {
    throw new PlanningPipelineFailure({
      message: `Failed to issue scoped secrets for ${bundle.manifest.taskId} during ${input.phase}.`,
      failureClass: phaseFailureClassMap[input.phase],
      phase: input.phase,
      code: "SECRET_LEASE_FAILED",
      details: {
        allowedSecretScopes,
        environment: input.environment ?? "default",
        cause: serializeError(error)
      },
      cause: error,
      taskId: bundle.manifest.taskId,
      runId: null
    });
  }

  if (!lease) {
    throw new PlanningPipelineFailure({
      message: `Scoped secrets were approved for ${bundle.manifest.taskId}, but the secrets adapter returned no lease.`,
      failureClass: phaseFailureClassMap[input.phase],
      phase: input.phase,
      code: "SECRET_LEASE_MISSING",
      details: {
        allowedSecretScopes,
        environment: input.environment ?? "default"
      },
      taskId: bundle.manifest.taskId,
      runId: null
    });
  }

  return lease;
}

function createApprovalRequestSummary(input: {
  policySnapshot: PolicySnapshot;
  requestedCapabilities: Capability[];
}): string {
  if (!input.requestedCapabilities.includes("can_use_secrets")) {
    return "Human approval is required before downstream execution can continue.";
  }

  if (input.policySnapshot.allowedSecretScopes.length > 0) {
    return `Human approval is required before downstream execution can continue. Approved secret scopes: ${input.policySnapshot.allowedSecretScopes.join(", ")}.`;
  }

  return "Human approval is required before downstream execution can continue. No secret scopes are currently approved for injection.";
}

export class DeterministicPlanningAgent implements PlanningAgent {
  async createSpec(
    input: PlanningTaskInput,
    context: { manifest: TaskManifest; runId: string }
  ): Promise<PlanningDraft> {
    return {
      summary: `Plan task ${context.manifest.taskId} for ${input.source.repo}: ${input.title}`,
      assumptions: [
        "The task source is trustworthy and labels accurately reflect readiness.",
        "Human approval remains mandatory before any future code-writing or PR mutation."
      ],
      affectedAreas:
        input.affectedPaths.length > 0
          ? input.affectedPaths
          : ["planning-surface-only"],
      constraints: [
        "Do not write product code in RedDwarf v1.",
        "Archive all planning outputs as durable evidence."
      ],
      testExpectations: [
        "Validate schemas for manifest, spec, and workspace context bundle.",
        "Verify policy gate output and lifecycle records for the task."
      ]
    };
  }
}

export class DeterministicDeveloperAgent implements DevelopmentAgent {
  async createHandoff(
    bundle: WorkspaceContextBundle,
    context: {
      manifest: TaskManifest;
      runId: string;
      workspace: MaterializedManagedWorkspace;
      codeWriteEnabled: boolean;
    }
  ): Promise<DevelopmentDraft> {
    return {
      summary: `Prepare workspace ${context.workspace.workspaceId} for task ${context.manifest.taskId} without mutating product code.`,
      implementationNotes: [
        `Inspect the allowed paths ${formatLiteralList(bundle.allowedPaths)} before proposing any edits.`,
        "Capture implementation intent and evidence in the workspace artifacts directory while product writes remain disabled.",
        "Keep the developer handoff aligned with the planning constraints and acceptance criteria from the task contract."
      ],
      blockedActions: [
        "Product code writes remain disabled by default in the development phase.",
        "Review automation remains blocked in RedDwarf v1 for tasks that do not request SCM handoff."
      ],
      nextActions: [
        "Run the validation phase against the managed workspace before asking for review or SCM handoff.",
        "Escalate if the task truly requires code-write access before downstream phases land."
      ]
    };
  }
}

export class DeterministicValidationAgent implements ValidationAgent {
  async createPlan(
    _bundle: WorkspaceContextBundle,
    context: {
      manifest: TaskManifest;
      runId: string;
      workspace: MaterializedManagedWorkspace;
    }
  ): Promise<ValidationDraft> {
    return {
      summary: `Run deterministic lint and test checks for workspace ${context.workspace.workspaceId} before review or SCM handoff.`,
      commands: [
        {
          id: "lint",
          name: "Lint workspace artifacts",
          executable: process.execPath,
          args: ["-e", createValidationNodeScript("lint")]
        },
        {
          id: "test",
          name: "Validate workspace contracts",
          executable: process.execPath,
          args: ["-e", createValidationNodeScript("test")]
        }
      ]
    };
  }
}

export class DeterministicScmAgent implements ScmAgent {
  async createPullRequest(
    bundle: WorkspaceContextBundle,
    context: {
      manifest: TaskManifest;
      runId: string;
      workspace: MaterializedManagedWorkspace;
      baseBranch: string;
      validationSummary: string;
      validationReportPath: string;
    }
  ): Promise<ScmDraft> {
    const branchName = createScmBranchName(context.manifest.taskId, context.runId);

    return {
      summary: `Create approved branch ${branchName} and a pull request for task ${context.manifest.taskId}.`,
      baseBranch: context.baseBranch,
      branchName,
      pullRequestTitle: `[RedDwarf] ${context.manifest.title}`,
      pullRequestBody: createScmPullRequestBody({
        bundle,
        validationSummary: context.validationSummary,
        validationReportPath: context.validationReportPath,
        branchName,
        baseBranch: context.baseBranch,
        workspace: context.workspace,
        runId: context.runId
      }),
      labels: ["reddwarf", "automation", `risk:${context.manifest.riskClass}`]
    };
  }
}

export async function runPlanningPipeline(
  rawInput: PlanningTaskInput,
  dependencies: PlanningPipelineDependencies
): Promise<PlanningPipelineResult> {
  const input = planningTaskInputSchema.parse(rawInput);
  const repository = dependencies.repository;
  const planner = dependencies.planner;
  const logger = dependencies.logger ?? defaultLogger;
  const clock = dependencies.clock ?? (() => new Date());
  const idGenerator = dependencies.idGenerator ?? (() => randomUUID());
  const concurrency = {
    strategy: dependencies.concurrency?.strategy ?? "serialize",
    staleAfterMs: dependencies.concurrency?.staleAfterMs ?? 5 * 60_000
  } satisfies Required<PlanningConcurrencyOptions>;

  const runId = idGenerator();
  const runStartedAt = clock();
  const runStartedAtIso = asIsoTimestamp(runStartedAt);
  const taskId = createTaskId(input, runId);
  const concurrencyKey = createTaskConcurrencyKey(input);
  const riskClass = classifyRisk(input);
  const approvalMode = resolveApprovalMode({
    phase: "development",
    riskClass,
    requestedCapabilities: input.requestedCapabilities
  });

  let activePhase: TaskPhase = "intake";
  let concurrencyDecision = createConcurrencyDecision({
    action: "start",
    strategy: concurrency.strategy,
    blockedByRunId: null,
    staleRunIds: [],
    reason: null
  });
  let trackedRun = createPipelineRun({
    runId,
    taskId,
    concurrencyKey,
    strategy: concurrency.strategy,
    status: "active",
    startedAt: runStartedAtIso,
    lastHeartbeatAt: runStartedAtIso,
    metadata: {
      sourceRepo: input.source.repo,
      requestedCapabilities: input.requestedCapabilities
    }
  });
  let currentManifest = taskManifestSchema.parse({
    taskId,
    source: input.source,
    title: input.title,
    summary: input.summary,
    priority: input.priority,
    riskClass,
    approvalMode,
    currentPhase: "intake",
    lifecycleStatus: "active",
    assignedAgentType: "architect",
    requestedCapabilities: input.requestedCapabilities,
    retryCount: 0,
    evidenceLinks: [],
    workspaceId: null,
    branchName: null,
    prNumber: null,
    policyVersion: getPolicyVersion(),
    createdAt: runStartedAtIso,
    updatedAt: runStartedAtIso
  });

  const runLogger = bindPlanningLogger(logger, {
    runId,
    taskId,
    sourceRepo: input.source.repo
  });
  let eventSequence = 0;
  const nextEventId = (phase: TaskPhase, code: string): string => {
    const sequence = String(eventSequence).padStart(3, "0");
    eventSequence += 1;
    return `${runId}:${sequence}:${phase}:${code}`;
  };
  const persistTrackedRun = async (
    patch: Partial<PipelineRun> & { metadata?: Record<string, unknown> }
  ): Promise<void> => {
    trackedRun = createPipelineRun({
      ...trackedRun,
      ...patch,
      metadata: {
        ...trackedRun.metadata,
        ...(patch.metadata ?? {})
      }
    });
    await repository.savePipelineRun(trackedRun);
  };

  const overlappingRuns = await repository.listPipelineRuns({
    concurrencyKey,
    statuses: ["active"],
    limit: 25
  });
  const staleRunIds: string[] = [];
  let blockedByRun: PipelineRun | null = null;

  for (const overlap of overlappingRuns) {
    if (overlap.runId === runId) {
      continue;
    }

    if (isPipelineRunStale(overlap, runStartedAt, concurrency.staleAfterMs)) {
      await repository.savePipelineRun(
        createPipelineRun({
          ...overlap,
          status: "stale",
          lastHeartbeatAt: runStartedAtIso,
          completedAt: runStartedAtIso,
          staleAt: runStartedAtIso,
          overlapReason: `Marked stale by run ${runId}`,
          metadata: {
            ...overlap.metadata,
            staleDetectedByRunId: runId
          }
        })
      );
      staleRunIds.push(overlap.runId);
      continue;
    }

    blockedByRun = overlap;
    break;
  }

  if (blockedByRun) {
    concurrencyDecision = createConcurrencyDecision({
      action: "block",
      strategy: concurrency.strategy,
      blockedByRunId: blockedByRun.runId,
      staleRunIds,
      reason: `Active overlapping run ${blockedByRun.runId} already owns ${concurrencyKey}.`
    });
    const blockedManifest = taskManifestSchema.parse({
      ...currentManifest,
      lifecycleStatus: "blocked",
      updatedAt: runStartedAtIso
    });

    await repository.savePipelineRun(
      createPipelineRun({
        ...trackedRun,
        status: "blocked",
        blockedByRunId: blockedByRun.runId,
        overlapReason: concurrencyDecision.reason,
        completedAt: runStartedAtIso,
        metadata: {
          ...trackedRun.metadata,
          staleRunIds
        }
      })
    );
    await repository.saveEvidenceRecord(
      createEvidenceRecord({
        recordId: `${taskId}:concurrency:${runId}`,
        taskId,
        kind: "gate_decision",
        title: "Concurrency gate decision",
        metadata: concurrencyDecision,
        createdAt: runStartedAtIso
      })
    );
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("intake", "RUN_BLOCKED_BY_OVERLAP"),
      taskId,
      runId,
      phase: "intake",
      level: "warn",
      code: "RUN_BLOCKED_BY_OVERLAP",
      message:
        concurrencyDecision.reason ??
        "Planning pipeline blocked by an overlapping run.",
      failureClass: "execution_loop",
      data: {
        concurrencyKey,
        strategy: concurrency.strategy,
        blockedByRunId: blockedByRun.runId,
        staleRunIds
      },
      createdAt: runStartedAtIso
    });
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("intake", "PIPELINE_BLOCKED"),
      taskId,
      runId,
      phase: "intake",
      level: "warn",
      code: "PIPELINE_BLOCKED",
      message: "Planning pipeline blocked by concurrency controls.",
      failureClass: "execution_loop",
      durationMs: getDurationMs(runStartedAt, runStartedAt),
      data: {
        concurrencyKey,
        strategy: concurrency.strategy,
        blockedByRunId: blockedByRun.runId
      },
      createdAt: runStartedAtIso
    });

    return {
      runId,
      manifest: blockedManifest,
      nextAction: "task_blocked",
      concurrencyDecision
    };
  }

  concurrencyDecision = createConcurrencyDecision({
    action: "start",
    strategy: concurrency.strategy,
    blockedByRunId: null,
    staleRunIds,
    reason:
      staleRunIds.length > 0
        ? `Marked ${staleRunIds.length} stale overlapping run(s) before starting.`
        : null
  });
  await persistTrackedRun({
    metadata: {
      staleRunIds
    }
  });

  try {
    if (staleRunIds.length > 0) {
      await recordRunEvent({
        repository,
        logger: runLogger,
        eventId: nextEventId("intake", "STALE_RUNS_DETECTED"),
        taskId,
        runId,
        phase: "intake",
        level: "info",
        code: "STALE_RUNS_DETECTED",
        message: "Stale overlapping runs were marked before planning started.",
        data: {
          concurrencyKey,
          staleRunIds,
          strategy: concurrency.strategy
        },
        createdAt: runStartedAtIso
      });
    }

    await repository.saveManifest(currentManifest);
    await repository.saveEvidenceRecord(
      createEvidenceRecord({
        recordId: `${taskId}:manifest`,
        taskId,
        kind: "manifest",
        title: "Initial task manifest",
        metadata: { approvalMode, riskClass, concurrencyDecision },
        createdAt: runStartedAtIso
      })
    );
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("intake", "PIPELINE_STARTED"),
      taskId,
      runId,
      phase: "intake",
      level: "info",
      code: "PIPELINE_STARTED",
      message: "Planning pipeline started.",
      data: {
        approvalMode,
        riskClass,
        requestedCapabilities: input.requestedCapabilities,
        concurrencyKey,
        strategy: concurrency.strategy
      },
      createdAt: runStartedAtIso
    });

    const intakeCompletedAt = clock();
    const intakeCompletedAtIso = asIsoTimestamp(intakeCompletedAt);
    await repository.savePhaseRecord(
      createPhaseRecord({
        id: `${taskId}:phase:intake`,
        taskId,
        phase: "intake",
        status: "passed",
        actor: "control-plane",
        summary: "Task intake completed.",
        createdAt: intakeCompletedAtIso
      })
    );
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("intake", "PHASE_PASSED"),
      taskId,
      runId,
      phase: "intake",
      level: "info",
      code: "PHASE_PASSED",
      message: "Task intake completed.",
      durationMs: getDurationMs(runStartedAt, intakeCompletedAt),
      data: {
        actor: "control-plane",
        status: "passed"
      },
      createdAt: intakeCompletedAtIso
    });
    await persistTrackedRun({
      lastHeartbeatAt: intakeCompletedAtIso,
      metadata: {
        currentPhase: "intake"
      }
    });

    activePhase = "eligibility";
    const eligibilityStartedAt = clock();
    const eligibility = assessEligibility(input);

    if (!eligibility.eligible) {
      const blockedAt = clock();
      const blockedAtIso = asIsoTimestamp(blockedAt);
      const blockedManifest = taskManifestSchema.parse({
        ...currentManifest,
        currentPhase: "eligibility",
        lifecycleStatus: "blocked",
        updatedAt: blockedAtIso
      });

      await repository.savePhaseRecord(
        createPhaseRecord({
          id: `${taskId}:phase:eligibility`,
          taskId,
          phase: "eligibility",
          status: "failed",
          actor: "policy",
          summary: "Task failed eligibility checks.",
          details: { reasons: eligibility.reasons },
          createdAt: blockedAtIso
        })
      );
      await repository.saveEvidenceRecord(
        createEvidenceRecord({
          recordId: `${taskId}:gate:eligibility`,
          taskId,
          kind: "gate_decision",
          title: "Eligibility gate decision",
          metadata: { reasons: eligibility.reasons },
          createdAt: blockedAtIso
        })
      );
      await recordRunEvent({
        repository,
        logger: runLogger,
        eventId: nextEventId("eligibility", "PHASE_BLOCKED"),
        taskId,
        runId,
        phase: "eligibility",
        level: "warn",
        code: "PHASE_BLOCKED",
        message: "Task blocked by eligibility rules.",
        failureClass: "policy_violation",
        durationMs: getDurationMs(eligibilityStartedAt, blockedAt),
        data: {
          actor: "policy",
          reasons: eligibility.reasons,
          status: "failed"
        },
        createdAt: blockedAtIso
      });
      await recordRunEvent({
        repository,
        logger: runLogger,
        eventId: nextEventId("eligibility", "PIPELINE_BLOCKED"),
        taskId,
        runId,
        phase: "eligibility",
        level: "warn",
        code: "PIPELINE_BLOCKED",
        message: "Planning pipeline blocked by policy.",
        failureClass: "policy_violation",
        durationMs: getDurationMs(runStartedAt, blockedAt),
        data: {
          reasons: eligibility.reasons
        },
        createdAt: blockedAtIso
      });
      await repository.updateManifest(blockedManifest);
      await persistTrackedRun({
        status: "blocked",
        lastHeartbeatAt: blockedAtIso,
        completedAt: blockedAtIso,
        metadata: {
          currentPhase: "eligibility",
          eligibilityReasons: eligibility.reasons
        }
      });
      currentManifest = blockedManifest;

      return {
        runId,
        manifest: blockedManifest,
        nextAction: "task_blocked",
        concurrencyDecision
      };
    }

    const eligibilityCompletedAt = clock();
    const eligibilityCompletedAtIso = asIsoTimestamp(eligibilityCompletedAt);
    await repository.savePhaseRecord(
      createPhaseRecord({
        id: `${taskId}:phase:eligibility`,
        taskId,
        phase: "eligibility",
        status: "passed",
        actor: "policy",
        summary: "Task passed eligibility checks.",
        createdAt: eligibilityCompletedAtIso
      })
    );
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("eligibility", "PHASE_PASSED"),
      taskId,
      runId,
      phase: "eligibility",
      level: "info",
      code: "PHASE_PASSED",
      message: "Task passed eligibility checks.",
      durationMs: getDurationMs(eligibilityStartedAt, eligibilityCompletedAt),
      data: {
        actor: "policy",
        status: "passed"
      },
      createdAt: eligibilityCompletedAtIso
    });
    await persistTrackedRun({
      lastHeartbeatAt: eligibilityCompletedAtIso,
      metadata: {
        currentPhase: "eligibility"
      }
    });

    activePhase = "planning";
    const planningStartedAt = clock();
    assertPhaseExecutable("planning");

    let draft: PlanningDraft;

    try {
      draft = await planner.createSpec(input, {
        manifest: currentManifest,
        runId
      });
    } catch (error) {
      throw normalizePipelineFailure(error, activePhase, taskId, runId);
    }

    const planningCompletedAt = clock();
    const planningCompletedAtIso = asIsoTimestamp(planningCompletedAt);
    const spec = planningSpecSchema.parse({
      specId: `${taskId}:planning-spec`,
      taskId,
      summary: draft.summary,
      assumptions: draft.assumptions,
      affectedAreas: draft.affectedAreas,
      constraints: draft.constraints,
      acceptanceCriteria: input.acceptanceCriteria,
      testExpectations: draft.testExpectations,
      recommendedAgentType: "architect",
      riskClass,
      createdAt: planningCompletedAtIso
    });

    await repository.savePlanningSpec(spec);
    await repository.savePhaseRecord(
      createPhaseRecord({
        id: `${taskId}:phase:planning`,
        taskId,
        phase: "planning",
        status: "passed",
        actor: "architect",
        summary: "Planning spec generated.",
        createdAt: planningCompletedAtIso
      })
    );
    await repository.saveEvidenceRecord(
      createEvidenceRecord({
        recordId: `${taskId}:spec`,
        taskId,
        kind: "planning_spec",
        title: "Planning specification",
        metadata: { specId: spec.specId },
        createdAt: planningCompletedAtIso
      })
    );
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("planning", "PHASE_PASSED"),
      taskId,
      runId,
      phase: "planning",
      level: "info",
      code: "PHASE_PASSED",
      message: "Planning spec generated.",
      durationMs: getDurationMs(planningStartedAt, planningCompletedAt),
      data: {
        actor: "architect",
        specId: spec.specId,
        status: "passed"
      },
      createdAt: planningCompletedAtIso
    });
    await persistTrackedRun({
      lastHeartbeatAt: planningCompletedAtIso,
      metadata: {
        currentPhase: "planning",
        specId: spec.specId
      }
    });

    activePhase = "policy_gate";
    const policyStartedAt = clock();
    const policySnapshot = buildPolicySnapshot(input, riskClass, approvalMode);
    const approvalRequestId =
      approvalMode === "auto" ? null : `${taskId}:approval:${runId}`;
    await repository.savePolicySnapshot(taskId, policySnapshot);
    await repository.saveMemoryRecord(
      createMemoryRecord({
        memoryId: `${taskId}:memory:task:planning`,
        taskId,
        scope: "task",
        provenance: "pipeline_derived",
        key: "planning.brief",
        title: "Planning brief",
        value: {
          specId: spec.specId,
          summary: spec.summary,
          acceptanceCriteria: spec.acceptanceCriteria,
          affectedAreas: spec.affectedAreas,
          constraints: spec.constraints,
          policyReasons: policySnapshot.reasons,
          approvalMode,
          allowedSecretScopes: policySnapshot.allowedSecretScopes,
          defaultBranch: readConfiguredBaseBranch(input),
          ...(approvalRequestId ? { approvalRequestId } : {})
        },
        repo: input.source.repo,
        organizationId: deriveOrganizationId(input.source.repo),
        tags: ["planning", "task"],
        createdAt: planningCompletedAtIso,
        updatedAt: planningCompletedAtIso
      })
    );

    const policyCompletedAt = clock();
    const policyCompletedAtIso = asIsoTimestamp(policyCompletedAt);
    const policyStatus: PhaseLifecycleStatus =
      approvalMode === "auto" ? "passed" : "escalated";
    const approvalRequest =
      approvalRequestId === null
        ? undefined
        : createApprovalRequest({
            requestId: approvalRequestId,
            taskId,
            runId,
            phase: "policy_gate",
            approvalMode,
            status: "pending",
            riskClass,
            summary: createApprovalRequestSummary({
              policySnapshot,
              requestedCapabilities: input.requestedCapabilities
            }),
            requestedCapabilities: input.requestedCapabilities,
            allowedPaths: policySnapshot.allowedPaths,
            blockedPhases: policySnapshot.blockedPhases,
            policyReasons: policySnapshot.reasons,
            requestedBy: "policy",
            createdAt: policyCompletedAtIso,
            updatedAt: policyCompletedAtIso
          });

    if (approvalRequest) {
      await repository.saveApprovalRequest(approvalRequest);
    }

    await repository.savePhaseRecord(
      createPhaseRecord({
        id: `${taskId}:phase:policy_gate`,
        taskId,
        phase: "policy_gate",
        status: policyStatus,
        actor: "policy",
        summary:
          policyStatus === "passed"
            ? "Policy gate passed for this planning run."
            : "Planning completed, but future execution requires human intervention.",
        details: {
          approvalMode,
          reasons: policySnapshot.reasons,
          ...(approvalRequest
            ? { approvalRequestId: approvalRequest.requestId }
            : {})
        },
        createdAt: policyCompletedAtIso
      })
    );
    await repository.saveEvidenceRecord(
      createEvidenceRecord({
        recordId: `${taskId}:gate:policy`,
        taskId,
        kind: "gate_decision",
        title: "Policy gate decision",
        metadata: {
          approvalMode,
          blockedPhases: policySnapshot.blockedPhases,
          policySnapshot,
          ...(approvalRequest
            ? { approvalRequestId: approvalRequest.requestId }
            : {})
        },
        createdAt: policyCompletedAtIso
      })
    );
    if (approvalRequest) {
      await repository.saveEvidenceRecord(
        createEvidenceRecord({
          recordId: `${taskId}:approval:${runId}`,
          taskId,
          kind: "gate_decision",
          title: "Approval request queued",
          metadata: {
            requestId: approvalRequest.requestId,
            approvalMode,
            riskClass,
            requestedCapabilities: approvalRequest.requestedCapabilities,
            allowedPaths: approvalRequest.allowedPaths,
            blockedPhases: approvalRequest.blockedPhases,
            policyReasons: approvalRequest.policyReasons,
            allowedSecretScopes: policySnapshot.allowedSecretScopes
          },
          createdAt: policyCompletedAtIso
        })
      );
    }
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId(
        "policy_gate",
        policyStatus === "passed" ? "PHASE_PASSED" : "PHASE_ESCALATED"
      ),
      taskId,
      runId,
      phase: "policy_gate",
      level: policyStatus === "passed" ? "info" : "warn",
      code: policyStatus === "passed" ? "PHASE_PASSED" : "PHASE_ESCALATED",
      message:
        policyStatus === "passed"
          ? "Policy gate passed for this planning run."
          : "Planning completed, but future execution requires human intervention.",
      durationMs: getDurationMs(policyStartedAt, policyCompletedAt),
      data: {
        actor: "policy",
        approvalMode,
        reasons: policySnapshot.reasons,
        allowedSecretScopes: policySnapshot.allowedSecretScopes,
        status: policyStatus,
        ...(approvalRequest
          ? { approvalRequestId: approvalRequest.requestId }
          : {})
      },
      createdAt: policyCompletedAtIso
    });
    if (approvalRequest) {
      await recordRunEvent({
        repository,
        logger: runLogger,
        eventId: nextEventId("policy_gate", "APPROVAL_REQUESTED"),
        taskId,
        runId,
        phase: "policy_gate",
        level: "warn",
        code: "APPROVAL_REQUESTED",
        message: "Approval request queued for downstream execution.",
        data: {
          requestId: approvalRequest.requestId,
          approvalMode,
          blockedPhases: approvalRequest.blockedPhases,
          requestedCapabilities: approvalRequest.requestedCapabilities,
          allowedSecretScopes: policySnapshot.allowedSecretScopes
        },
        createdAt: policyCompletedAtIso
      });
    }
    await persistTrackedRun({
      lastHeartbeatAt: policyCompletedAtIso,
      metadata: {
        currentPhase: "policy_gate",
        approvalMode,
        ...(approvalRequest
          ? { approvalRequestId: approvalRequest.requestId }
          : {})
      }
    });

    activePhase = "archive";
    const archiveStartedAt = clock();
    const archiveCompletedAt = clock();
    const archiveCompletedAtIso = asIsoTimestamp(archiveCompletedAt);
    await repository.savePhaseRecord(
      createPhaseRecord({
        id: `${taskId}:phase:archive`,
        taskId,
        phase: "archive",
        status: "passed",
        actor: "evidence",
        summary: "Planning outputs archived.",
        details: approvalRequest
          ? { approvalRequestId: approvalRequest.requestId }
          : {},
        createdAt: archiveCompletedAtIso
      })
    );
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("archive", "PHASE_PASSED"),
      taskId,
      runId,
      phase: "archive",
      level: "info",
      code: "PHASE_PASSED",
      message: "Planning outputs archived.",
      durationMs: getDurationMs(archiveStartedAt, archiveCompletedAt),
      data: {
        actor: "evidence",
        status: "passed",
        ...(approvalRequest
          ? { approvalRequestId: approvalRequest.requestId }
          : {})
      },
      createdAt: archiveCompletedAtIso
    });
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId(
        "archive",
        approvalRequest ? "PIPELINE_BLOCKED" : "PIPELINE_COMPLETED"
      ),
      taskId,
      runId,
      phase: "archive",
      level: approvalRequest ? "warn" : "info",
      code: approvalRequest ? "PIPELINE_BLOCKED" : "PIPELINE_COMPLETED",
      message: approvalRequest
        ? "Planning outputs are archived and the task is waiting for human approval."
        : "Planning pipeline completed.",
      durationMs: getDurationMs(runStartedAt, archiveCompletedAt),
      data: {
        approvalMode,
        riskClass,
        ...(approvalRequest
          ? { approvalRequestId: approvalRequest.requestId }
          : {})
      },
      createdAt: archiveCompletedAtIso
    });

    const completedManifest = taskManifestSchema.parse({
      ...currentManifest,
      currentPhase: "archive",
      lifecycleStatus: approvalRequest ? "blocked" : "completed",
      evidenceLinks: [
        `db://manifest/${taskId}`,
        `db://planning_spec/${spec.specId}`,
        `db://gate_decision/${taskId}:gate:policy`,
        ...(approvalRequest
          ? [`db://gate_decision/${taskId}:approval:${runId}`]
          : [])
      ],
      updatedAt: archiveCompletedAtIso
    });

    await repository.updateManifest(completedManifest);
    await persistTrackedRun({
      status: approvalRequest ? "blocked" : "completed",
      lastHeartbeatAt: archiveCompletedAtIso,
      completedAt: archiveCompletedAtIso,
      metadata: {
        currentPhase: "archive",
        nextAction: approvalRequest ? "await_human" : "complete",
        ...(approvalRequest
          ? { approvalRequestId: approvalRequest.requestId }
          : {})
      }
    });
    currentManifest = completedManifest;

    return {
      runId,
      manifest: completedManifest,
      spec,
      policySnapshot,
      ...(approvalRequest ? { approvalRequest } : {}),
      nextAction: approvalRequest ? "await_human" : "complete",
      concurrencyDecision
    };
  } catch (error) {
    const pipelineFailure = normalizePipelineFailure(
      error,
      activePhase,
      taskId,
      runId
    );
    const failedAt = clock();
    const failedAtIso = asIsoTimestamp(failedAt);
    const failedManifest = taskManifestSchema.parse({
      ...currentManifest,
      currentPhase: activePhase,
      lifecycleStatus: "failed",
      updatedAt: failedAtIso
    });

    try {
      await repository.savePhaseRecord(
        createPhaseRecord({
          id: `${taskId}:phase:${activePhase}`,
          taskId,
          phase: activePhase,
          status: "failed",
          actor: "control-plane",
          summary: pipelineFailure.message,
          details: {
            code: pipelineFailure.code,
            failureClass: pipelineFailure.failureClass,
            ...pipelineFailure.details
          },
          createdAt: failedAtIso
        })
      );
      await repository.saveEvidenceRecord(
        createEvidenceRecord({
          recordId: `${taskId}:failure:${runId}`,
          taskId,
          kind: "run_event",
          title: `Pipeline failure during ${activePhase}`,
          metadata: {
            runId,
            phase: activePhase,
            code: pipelineFailure.code,
            failureClass: pipelineFailure.failureClass,
            details: pipelineFailure.details
          },
          createdAt: failedAtIso
        })
      );
      await recordRunEvent({
        repository,
        logger: runLogger,
        eventId: nextEventId(activePhase, "PHASE_FAILED"),
        taskId,
        runId,
        phase: activePhase,
        level: "error",
        code: "PHASE_FAILED",
        message: pipelineFailure.message,
        failureClass: pipelineFailure.failureClass,
        data: {
          causeCode: pipelineFailure.code,
          details: pipelineFailure.details,
          status: "failed"
        },
        createdAt: failedAtIso
      });
      await recordRunEvent({
        repository,
        logger: runLogger,
        eventId: nextEventId(activePhase, "PIPELINE_FAILED"),
        taskId,
        runId,
        phase: activePhase,
        level: "error",
        code: "PIPELINE_FAILED",
        message: "Planning pipeline failed.",
        failureClass: pipelineFailure.failureClass,
        durationMs: getDurationMs(runStartedAt, failedAt),
        data: {
          causeCode: pipelineFailure.code,
          details: pipelineFailure.details
        },
        createdAt: failedAtIso
      });
      await repository.updateManifest(failedManifest);
      await persistTrackedRun({
        status: "failed",
        lastHeartbeatAt: failedAtIso,
        completedAt: failedAtIso,
        metadata: {
          currentPhase: activePhase,
          failureCode: pipelineFailure.code,
          failureClass: pipelineFailure.failureClass
        }
      });
      currentManifest = failedManifest;
    } catch (persistenceError) {
      runLogger.error("Failed to persist planning failure evidence.", {
        runId,
        taskId,
        phase: activePhase,
        failureClass: pipelineFailure.failureClass,
        code: pipelineFailure.code,
        persistenceError: serializeError(persistenceError)
      });
    }

    throw new PlanningPipelineFailure({
      message: pipelineFailure.message,
      failureClass: pipelineFailure.failureClass,
      phase: pipelineFailure.phase,
      code: pipelineFailure.code,
      details: pipelineFailure.details,
      cause: pipelineFailure,
      taskId,
      runId
    });
  }
}

export async function runDeveloperPhase(
  input: RunDeveloperPhaseInput,
  dependencies: DevelopmentPhaseDependencies
): Promise<DevelopmentPhaseResult> {
  const taskId = input.taskId.trim();

  if (taskId.length === 0) {
    throw new Error("Task id is required to run the developer phase.");
  }

  const repository = dependencies.repository;
  const developer = dependencies.developer;
  const logger = dependencies.logger ?? defaultLogger;
  const clock = dependencies.clock ?? (() => new Date());
  const idGenerator = dependencies.idGenerator ?? (() => randomUUID());
  const concurrency = {
    strategy: dependencies.concurrency?.strategy ?? "serialize",
    staleAfterMs: dependencies.concurrency?.staleAfterMs ?? 5 * 60_000
  } satisfies Required<PlanningConcurrencyOptions>;
  const snapshot = await repository.getTaskSnapshot(taskId);

  if (!snapshot.manifest) {
    throw new Error(`Task manifest ${taskId} was not found.`);
  }

  if (!snapshot.spec) {
    throw new Error(`Planning spec for ${taskId} was not found.`);
  }

  if (!snapshot.policySnapshot) {
    throw new Error(`Policy snapshot for ${taskId} was not found.`);
  }

  const approvedRequest =
    snapshot.manifest.approvalMode === "auto"
      ? null
      : (snapshot.approvalRequests.find(
          (request) => request.status === "approved"
        ) ?? null);

  if (snapshot.manifest.approvalMode !== "auto" && !approvedRequest) {
    throw new Error(
      `Task ${taskId} requires an approved request before the developer phase can start.`
    );
  }

  const lifecycleAllowsDevelopment =
    snapshot.manifest.lifecycleStatus === "ready" ||
    snapshot.manifest.lifecycleStatus === "active" ||
    (snapshot.manifest.lifecycleStatus === "blocked" &&
      snapshot.manifest.currentPhase === "development");

  if (!lifecycleAllowsDevelopment) {
    throw new Error(
      `Task ${taskId} is ${snapshot.manifest.lifecycleStatus} in phase ${snapshot.manifest.currentPhase} and cannot enter development.`
    );
  }

  assertPhaseExecutable("development");

  const runId = idGenerator();
  const runStartedAt = clock();
  const runStartedAtIso = asIsoTimestamp(runStartedAt);
  const concurrencyKey = createSourceConcurrencyKey(snapshot.manifest.source);
  let currentManifest = taskManifestSchema.parse(snapshot.manifest);
  let concurrencyDecision = createConcurrencyDecision({
    action: "start",
    strategy: concurrency.strategy,
    blockedByRunId: null,
    staleRunIds: [],
    reason: null
  });
  let trackedRun = createPipelineRun({
    runId,
    taskId,
    concurrencyKey,
    strategy: concurrency.strategy,
    status: "active",
    startedAt: runStartedAtIso,
    lastHeartbeatAt: runStartedAtIso,
    metadata: {
      sourceRepo: currentManifest.source.repo,
      phase: "development",
      ...(approvedRequest
        ? { approvalRequestId: approvedRequest.requestId }
        : {})
    }
  });
  const runLogger = bindPlanningLogger(logger, {
    runId,
    taskId,
    sourceRepo: currentManifest.source.repo,
    phase: "development"
  });
  let eventSequence = 0;
  const nextEventId = (phase: TaskPhase, code: string): string => {
    const sequence = String(eventSequence).padStart(3, "0");
    eventSequence += 1;
    return `${runId}:${sequence}:${phase}:${code}`;
  };
  const persistTrackedRun = async (
    patch: Partial<PipelineRun> & { metadata?: Record<string, unknown> }
  ): Promise<void> => {
    trackedRun = createPipelineRun({
      ...trackedRun,
      ...patch,
      metadata: {
        ...trackedRun.metadata,
        ...(patch.metadata ?? {})
      }
    });
    await repository.savePipelineRun(trackedRun);
  };

  const overlappingRuns = await repository.listPipelineRuns({
    concurrencyKey,
    statuses: ["active"],
    limit: 25
  });
  const staleRunIds: string[] = [];
  let blockedByRun: PipelineRun | null = null;

  for (const overlap of overlappingRuns) {
    if (overlap.runId === runId) {
      continue;
    }

    if (isPipelineRunStale(overlap, runStartedAt, concurrency.staleAfterMs)) {
      await repository.savePipelineRun(
        createPipelineRun({
          ...overlap,
          status: "stale",
          lastHeartbeatAt: runStartedAtIso,
          completedAt: runStartedAtIso,
          staleAt: runStartedAtIso,
          overlapReason: `Marked stale by run ${runId}`,
          metadata: {
            ...overlap.metadata,
            staleDetectedByRunId: runId
          }
        })
      );
      staleRunIds.push(overlap.runId);
      continue;
    }

    blockedByRun = overlap;
    break;
  }

  if (blockedByRun) {
    concurrencyDecision = createConcurrencyDecision({
      action: "block",
      strategy: concurrency.strategy,
      blockedByRunId: blockedByRun.runId,
      staleRunIds,
      reason: `Active overlapping run ${blockedByRun.runId} already owns ${concurrencyKey}.`
    });
    await repository.savePipelineRun(
      createPipelineRun({
        ...trackedRun,
        status: "blocked",
        blockedByRunId: blockedByRun.runId,
        overlapReason: concurrencyDecision.reason,
        completedAt: runStartedAtIso,
        metadata: {
          ...trackedRun.metadata,
          staleRunIds
        }
      })
    );
    await repository.saveEvidenceRecord(
      createEvidenceRecord({
        recordId: `${taskId}:development:concurrency:${runId}`,
        taskId,
        kind: "gate_decision",
        title: "Development concurrency gate decision",
        metadata: concurrencyDecision,
        createdAt: runStartedAtIso
      })
    );
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("development", "RUN_BLOCKED_BY_OVERLAP"),
      taskId,
      runId,
      phase: "development",
      level: "warn",
      code: "RUN_BLOCKED_BY_OVERLAP",
      message:
        concurrencyDecision.reason ??
        "Developer phase blocked by an overlapping run.",
      failureClass: "execution_loop",
      data: {
        concurrencyKey,
        strategy: concurrency.strategy,
        blockedByRunId: blockedByRun.runId,
        staleRunIds
      },
      createdAt: runStartedAtIso
    });
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("development", "PIPELINE_BLOCKED"),
      taskId,
      runId,
      phase: "development",
      level: "warn",
      code: "PIPELINE_BLOCKED",
      message: "Developer phase blocked by concurrency controls.",
      failureClass: "execution_loop",
      durationMs: getDurationMs(runStartedAt, runStartedAt),
      data: {
        concurrencyKey,
        strategy: concurrency.strategy,
        blockedByRunId: blockedByRun.runId
      },
      createdAt: runStartedAtIso
    });

    return {
      runId,
      manifest: currentManifest,
      nextAction: "task_blocked",
      concurrencyDecision
    };
  }

  concurrencyDecision = createConcurrencyDecision({
    action: "start",
    strategy: concurrency.strategy,
    blockedByRunId: null,
    staleRunIds,
    reason:
      staleRunIds.length > 0
        ? `Marked ${staleRunIds.length} stale overlapping run(s) before starting.`
        : null
  });
  await persistTrackedRun({ metadata: { staleRunIds } });

  try {
    if (staleRunIds.length > 0) {
      await recordRunEvent({
        repository,
        logger: runLogger,
        eventId: nextEventId("development", "STALE_RUNS_DETECTED"),
        taskId,
        runId,
        phase: "development",
        level: "info",
        code: "STALE_RUNS_DETECTED",
        message:
          "Stale overlapping runs were marked before the developer phase started.",
        data: {
          concurrencyKey,
          staleRunIds,
          strategy: concurrency.strategy
        },
        createdAt: runStartedAtIso
      });
    }

    const developmentStartedAt = clock();
    const developmentStartedAtIso = asIsoTimestamp(developmentStartedAt);
    currentManifest = taskManifestSchema.parse({
      ...currentManifest,
      currentPhase: "development",
      lifecycleStatus: "active",
      assignedAgentType: "developer",
      updatedAt: developmentStartedAtIso
    });
    await repository.updateManifest(currentManifest);
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("development", "PHASE_RUNNING"),
      taskId,
      runId,
      phase: "development",
      level: "info",
      code: "PHASE_RUNNING",
      message: "Developer phase started.",
      data: {
        actor: "developer",
        ...(approvedRequest
          ? { approvalRequestId: approvedRequest.requestId }
          : {})
      },
      createdAt: developmentStartedAtIso
    });
    await persistTrackedRun({
      lastHeartbeatAt: developmentStartedAtIso,
      metadata: {
        currentPhase: "development",
        ...(approvedRequest
          ? { approvalRequestId: approvedRequest.requestId }
          : {})
      }
    });

    const bundle = createWorkspaceContextBundle({
      manifest: currentManifest,
      spec: snapshot.spec,
      policySnapshot: snapshot.policySnapshot
    });
    const secretLease = await issueWorkspaceSecretLease({
      bundle,
      phase: "development",
      ...(dependencies.secrets ? { secrets: dependencies.secrets } : {}),
      ...(dependencies.environment
        ? { environment: dependencies.environment }
        : {})
    });
    const workspace = await materializeManagedWorkspace({
      bundle,
      targetRoot: input.targetRoot,
      workspaceId:
        input.workspaceId ??
        currentManifest.workspaceId ??
        `${taskId}-workspace`,
      createdAt: developmentStartedAtIso,
      secretLease
    });
    currentManifest = taskManifestSchema.parse({
      ...currentManifest,
      workspaceId: workspace.workspaceId,
      updatedAt: developmentStartedAtIso,
      evidenceLinks: [
        ...new Set([
          ...currentManifest.evidenceLinks,
          `${workspaceLocationPrefix}${workspace.workspaceId}`
        ])
      ]
    });
    await repository.updateManifest(currentManifest);
    await repository.saveEvidenceRecord(
      createEvidenceRecord({
        recordId: `${taskId}:workspace:${workspace.workspaceId}:provisioned`,
        taskId,
        kind: "file_artifact",
        title: "Managed workspace provisioned",
        location: `${workspaceLocationPrefix}${workspace.workspaceId}`,
        metadata: {
          status: workspace.descriptor.status,
          workspaceRoot: workspace.workspaceRoot,
          stateFile: workspace.stateFile,
          descriptor: workspace.descriptor,
          phase: "development",
          runId,
          allowedSecretScopes:
            workspace.descriptor.credentialPolicy.allowedSecretScopes,
          injectedSecretKeys:
            workspace.descriptor.credentialPolicy.injectedSecretKeys
        },
        createdAt: developmentStartedAtIso
      })
    );
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("development", "WORKSPACE_PROVISIONED"),
      taskId,
      runId,
      phase: "development",
      level: "info",
      code: "WORKSPACE_PROVISIONED",
      message: "Developer workspace provisioned.",
      data: {
        workspaceId: workspace.workspaceId,
        toolPolicyMode: workspace.descriptor.toolPolicy.mode,
        codeWriteEnabled: workspace.descriptor.toolPolicy.codeWriteEnabled,
        credentialMode: workspace.descriptor.credentialPolicy.mode,
        allowedSecretScopes:
          workspace.descriptor.credentialPolicy.allowedSecretScopes,
        injectedSecretKeys:
          workspace.descriptor.credentialPolicy.injectedSecretKeys
      },
      createdAt: developmentStartedAtIso
    });
    if (secretLease) {
      await recordRunEvent({
        repository,
        logger: runLogger,
        eventId: nextEventId("development", "SECRET_LEASE_ISSUED"),
        taskId,
        runId,
        phase: "development",
        level: "info",
        code: "SECRET_LEASE_ISSUED",
        message: "Scoped developer credentials issued for the managed workspace.",
        data: {
          workspaceId: workspace.workspaceId,
          credentialMode: workspace.descriptor.credentialPolicy.mode,
          allowedSecretScopes: secretLease.secretScopes,
          injectedSecretKeys: secretLease.injectedSecretKeys,
          leaseIssuedAt: secretLease.issuedAt,
          leaseExpiresAt: secretLease.expiresAt
        },
        createdAt: developmentStartedAtIso
      });
    }

    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("development", "CODE_WRITE_DISABLED"),
      taskId,
      runId,
      phase: "development",
      level: "warn",
      code: "CODE_WRITE_DISABLED",
      message:
        "Developer workspace is ready, but product code writes remain disabled by default.",
      data: {
        workspaceId: workspace.workspaceId,
        toolPolicyMode: workspace.descriptor.toolPolicy.mode,
        requestedCapabilities: currentManifest.requestedCapabilities
      },
      createdAt: developmentStartedAtIso
    });

    const handoff = await developer.createHandoff(bundle, {
      manifest: currentManifest,
      runId,
      workspace,
      codeWriteEnabled: workspace.descriptor.toolPolicy.codeWriteEnabled
    });
    const developmentCompletedAt = clock();
    const developmentCompletedAtIso = asIsoTimestamp(developmentCompletedAt);
    const handoffPath = join(workspace.artifactsDir, "developer-handoff.md");
    await writeFile(
      handoffPath,
      renderDevelopmentHandoffMarkdown({
        bundle,
        handoff,
        workspace,
        runId,
        codeWriteEnabled: workspace.descriptor.toolPolicy.codeWriteEnabled
      }),
      "utf8"
    );
    const handoffSourceLocation = `${workspaceLocationPrefix}${workspace.workspaceId}/artifacts/developer-handoff.md`;
    const archivedHandoff = await archiveEvidenceArtifact({
      taskId,
      runId,
      phase: "development",
      sourcePath: handoffPath,
      targetRoot: input.targetRoot,
      evidenceRoot: input.evidenceRoot,
      fileName: "developer-handoff.md"
    });
    await repository.saveMemoryRecord(
      createMemoryRecord({
        memoryId: `${taskId}:memory:task:development`,
        taskId,
        scope: "task",
        provenance: "pipeline_derived",
        key: "development.handoff",
        title: "Developer handoff",
        value: {
          summary: handoff.summary,
          implementationNotes: handoff.implementationNotes,
          blockedActions: handoff.blockedActions,
          nextActions: handoff.nextActions,
          runId,
          workspaceId: workspace.workspaceId,
          codeWriteEnabled: workspace.descriptor.toolPolicy.codeWriteEnabled,
          archiveLocation: archivedHandoff.location,
          archivePath: archivedHandoff.archivePath
        },
        repo: currentManifest.source.repo,
        organizationId: deriveOrganizationId(currentManifest.source.repo),
        tags: ["development", "task"],
        createdAt: developmentCompletedAtIso,
        updatedAt: developmentCompletedAtIso
      })
    );
    await repository.savePhaseRecord(
      createPhaseRecord({
        id: `${taskId}:phase:development`,
        taskId,
        phase: "development",
        status: "passed",
        actor: "developer",
        summary: "Developer phase orchestrated in an isolated workspace.",
        details: {
          workspaceId: workspace.workspaceId,
          handoffPath,
          toolPolicyMode: workspace.descriptor.toolPolicy.mode,
          codeWriteEnabled: workspace.descriptor.toolPolicy.codeWriteEnabled,
          ...(approvedRequest
            ? { approvalRequestId: approvedRequest.requestId }
            : {})
        },
        createdAt: developmentCompletedAtIso
      })
    );
    await repository.saveEvidenceRecord(
      createEvidenceRecord({
        recordId: `${taskId}:development:${runId}:handoff`,
        taskId,
        kind: "file_artifact",
        title: "Developer handoff",
        location: archivedHandoff.location,
        metadata: {
          runId,
          workspaceId: workspace.workspaceId,
          toolPolicyMode: workspace.descriptor.toolPolicy.mode,
          codeWriteEnabled: workspace.descriptor.toolPolicy.codeWriteEnabled,
          summary: handoff.summary,
          ...buildArchivedArtifactMetadata({
            archivedArtifact: archivedHandoff,
            artifactClass: "handoff",
            sourceLocation: handoffSourceLocation,
            sourcePath: handoffPath
          })
        },
        createdAt: developmentCompletedAtIso
      })
    );
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("development", "PHASE_PASSED"),
      taskId,
      runId,
      phase: "development",
      level: "info",
      code: "PHASE_PASSED",
      message: "Developer handoff captured in the managed workspace.",
      durationMs: getDurationMs(developmentStartedAt, developmentCompletedAt),
      data: {
        actor: "developer",
        workspaceId: workspace.workspaceId,
        handoffPath,
        handoffArchiveLocation: archivedHandoff.location,
        codeWriteEnabled: workspace.descriptor.toolPolicy.codeWriteEnabled
      },
      createdAt: developmentCompletedAtIso
    });
    await persistTrackedRun({
      lastHeartbeatAt: developmentCompletedAtIso,
      metadata: {
        currentPhase: "development",
        workspaceId: workspace.workspaceId,
        handoffPath,
        handoffArchiveLocation: archivedHandoff.location
      }
    });

    const blockedAt = clock();
    const blockedAtIso = asIsoTimestamp(blockedAt);
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("development", "PIPELINE_BLOCKED"),
      taskId,
      runId,
      phase: "development",
      level: "warn",
      code: "PIPELINE_BLOCKED",
      message:
        "Developer phase completed and is ready for validation execution.",
      durationMs: getDurationMs(runStartedAt, blockedAt),
      data: {
        nextPhase: "validation",
        workspaceId: workspace.workspaceId,
        handoffPath,
        handoffArchiveLocation: archivedHandoff.location
      },
      createdAt: blockedAtIso
    });

    currentManifest = taskManifestSchema.parse({
      ...currentManifest,
      currentPhase: "development",
      lifecycleStatus: "blocked",
      updatedAt: blockedAtIso
    });
    await repository.updateManifest(currentManifest);
    await persistTrackedRun({
      status: "blocked",
      lastHeartbeatAt: blockedAtIso,
      completedAt: blockedAtIso,
      metadata: {
        currentPhase: "development",
        nextAction: "await_validation",
        workspaceId: workspace.workspaceId,
        handoffPath,
        handoffArchiveLocation: archivedHandoff.location
      }
    });

    return {
      runId,
      manifest: currentManifest,
      workspace,
      handoff,
      handoffPath,
      nextAction: "await_validation",
      concurrencyDecision
    };
  } catch (error) {
    const pipelineFailure = normalizePipelineFailure(
      error,
      "development",
      taskId,
      runId
    );
    const failedAt = clock();
    const failedAtIso = asIsoTimestamp(failedAt);
    currentManifest = taskManifestSchema.parse({
      ...currentManifest,
      currentPhase: "development",
      lifecycleStatus: "failed",
      updatedAt: failedAtIso
    });

    try {
      await repository.savePhaseRecord(
        createPhaseRecord({
          id: `${taskId}:phase:development`,
          taskId,
          phase: "development",
          status: "failed",
          actor: "control-plane",
          summary: pipelineFailure.message,
          details: {
            code: pipelineFailure.code,
            failureClass: pipelineFailure.failureClass,
            ...pipelineFailure.details
          },
          createdAt: failedAtIso
        })
      );
      await repository.saveEvidenceRecord(
        createEvidenceRecord({
          recordId: `${taskId}:development:failure:${runId}`,
          taskId,
          kind: "run_event",
          title: "Developer phase failure",
          metadata: {
            runId,
            code: pipelineFailure.code,
            failureClass: pipelineFailure.failureClass,
            details: pipelineFailure.details
          },
          createdAt: failedAtIso
        })
      );
      await recordRunEvent({
        repository,
        logger: runLogger,
        eventId: nextEventId("development", "PHASE_FAILED"),
        taskId,
        runId,
        phase: "development",
        level: "error",
        code: "PHASE_FAILED",
        message: pipelineFailure.message,
        failureClass: pipelineFailure.failureClass,
        data: {
          causeCode: pipelineFailure.code,
          details: pipelineFailure.details
        },
        createdAt: failedAtIso
      });
      await recordRunEvent({
        repository,
        logger: runLogger,
        eventId: nextEventId("development", "PIPELINE_FAILED"),
        taskId,
        runId,
        phase: "development",
        level: "error",
        code: "PIPELINE_FAILED",
        message: "Developer phase failed.",
        failureClass: pipelineFailure.failureClass,
        durationMs: getDurationMs(runStartedAt, failedAt),
        data: {
          causeCode: pipelineFailure.code,
          details: pipelineFailure.details
        },
        createdAt: failedAtIso
      });
      await repository.updateManifest(currentManifest);
      await persistTrackedRun({
        status: "failed",
        lastHeartbeatAt: failedAtIso,
        completedAt: failedAtIso,
        metadata: {
          currentPhase: "development",
          failureCode: pipelineFailure.code,
          failureClass: pipelineFailure.failureClass
        }
      });
    } catch (persistenceError) {
      runLogger.error("Failed to persist developer phase failure evidence.", {
        runId,
        taskId,
        failureClass: pipelineFailure.failureClass,
        code: pipelineFailure.code,
        persistenceError: serializeError(persistenceError)
      });
    }

    throw new PlanningPipelineFailure({
      message: pipelineFailure.message,
      failureClass: pipelineFailure.failureClass,
      phase: pipelineFailure.phase,
      code: pipelineFailure.code,
      details: pipelineFailure.details,
      cause: pipelineFailure,
      taskId,
      runId
    });
  }
}

export async function runValidationPhase(
  input: RunValidationPhaseInput,
  dependencies: ValidationPhaseDependencies
): Promise<ValidationPhaseResult> {
  const taskId = input.taskId.trim();

  if (taskId.length === 0) {
    throw new Error("Task id is required to run the validation phase.");
  }

  const repository = dependencies.repository;
  const validator = dependencies.validator;
  const logger = dependencies.logger ?? defaultLogger;
  const clock = dependencies.clock ?? (() => new Date());
  const idGenerator = dependencies.idGenerator ?? (() => randomUUID());
  const concurrency = {
    strategy: dependencies.concurrency?.strategy ?? "serialize",
    staleAfterMs: dependencies.concurrency?.staleAfterMs ?? 5 * 60_000
  } satisfies Required<PlanningConcurrencyOptions>;
  const snapshot = await repository.getTaskSnapshot(taskId);

  if (!snapshot.manifest) {
    throw new Error(`Task manifest ${taskId} was not found.`);
  }

  if (!snapshot.spec) {
    throw new Error(`Planning spec for ${taskId} was not found.`);
  }

  if (!snapshot.policySnapshot) {
    throw new Error(`Policy snapshot for ${taskId} was not found.`);
  }

  const approvedRequest =
    snapshot.manifest.approvalMode === "auto"
      ? null
      : (snapshot.approvalRequests.find(
          (request) => request.status === "approved"
        ) ?? null);

  if (snapshot.manifest.approvalMode !== "auto" && !approvedRequest) {
    throw new Error(
      `Task ${taskId} requires an approved request before the validation phase can start.`
    );
  }

  const lifecycleAllowsValidation =
    (snapshot.manifest.lifecycleStatus === "blocked" &&
      ["development", "validation"].includes(snapshot.manifest.currentPhase)) ||
    (snapshot.manifest.lifecycleStatus === "active" &&
      snapshot.manifest.currentPhase === "validation");

  if (!lifecycleAllowsValidation) {
    throw new Error(
      `Task ${taskId} is ${snapshot.manifest.lifecycleStatus} in phase ${snapshot.manifest.currentPhase} and cannot enter validation.`
    );
  }

  if (
    input.workspaceId &&
    snapshot.manifest.workspaceId &&
    input.workspaceId !== snapshot.manifest.workspaceId
  ) {
    throw new Error(
      `Validation must reuse workspace ${snapshot.manifest.workspaceId}; received ${input.workspaceId}.`
    );
  }

  const workspaceId = snapshot.manifest.workspaceId ?? input.workspaceId;

  if (!workspaceId) {
    throw new Error(
      `Task ${taskId} requires a managed workspace from the developer phase before validation can start.`
    );
  }

  assertPhaseExecutable("validation");

  const runId = idGenerator();
  const runStartedAt = clock();
  const runStartedAtIso = asIsoTimestamp(runStartedAt);
  const concurrencyKey = createSourceConcurrencyKey(snapshot.manifest.source);
  let currentManifest = taskManifestSchema.parse(snapshot.manifest);
  let concurrencyDecision = createConcurrencyDecision({
    action: "start",
    strategy: concurrency.strategy,
    blockedByRunId: null,
    staleRunIds: [],
    reason: null
  });
  let trackedRun = createPipelineRun({
    runId,
    taskId,
    concurrencyKey,
    strategy: concurrency.strategy,
    status: "active",
    startedAt: runStartedAtIso,
    lastHeartbeatAt: runStartedAtIso,
    metadata: {
      sourceRepo: currentManifest.source.repo,
      phase: "validation",
      workspaceId,
      ...(approvedRequest
        ? { approvalRequestId: approvedRequest.requestId }
        : {})
    }
  });
  const runLogger = bindPlanningLogger(logger, {
    runId,
    taskId,
    sourceRepo: currentManifest.source.repo,
    phase: "validation"
  });
  let eventSequence = 0;
  const nextEventId = (phase: TaskPhase, code: string): string => {
    const sequence = String(eventSequence).padStart(3, "0");
    eventSequence += 1;
    return `${runId}:${sequence}:${phase}:${code}`;
  };
  const persistTrackedRun = async (
    patch: Partial<PipelineRun> & { metadata?: Record<string, unknown> }
  ): Promise<void> => {
    trackedRun = createPipelineRun({
      ...trackedRun,
      ...patch,
      metadata: {
        ...trackedRun.metadata,
        ...(patch.metadata ?? {})
      }
    });
    await repository.savePipelineRun(trackedRun);
  };

  const overlappingRuns = await repository.listPipelineRuns({
    concurrencyKey,
    statuses: ["active"],
    limit: 25
  });
  const staleRunIds: string[] = [];
  let blockedByRun: PipelineRun | null = null;

  for (const overlap of overlappingRuns) {
    if (overlap.runId === runId) {
      continue;
    }

    if (isPipelineRunStale(overlap, runStartedAt, concurrency.staleAfterMs)) {
      await repository.savePipelineRun(
        createPipelineRun({
          ...overlap,
          status: "stale",
          lastHeartbeatAt: runStartedAtIso,
          completedAt: runStartedAtIso,
          staleAt: runStartedAtIso,
          overlapReason: `Marked stale by run ${runId}`,
          metadata: {
            ...overlap.metadata,
            staleDetectedByRunId: runId
          }
        })
      );
      staleRunIds.push(overlap.runId);
      continue;
    }

    blockedByRun = overlap;
    break;
  }

  if (blockedByRun) {
    concurrencyDecision = createConcurrencyDecision({
      action: "block",
      strategy: concurrency.strategy,
      blockedByRunId: blockedByRun.runId,
      staleRunIds,
      reason: `Active overlapping run ${blockedByRun.runId} already owns ${concurrencyKey}.`
    });
    await repository.savePipelineRun(
      createPipelineRun({
        ...trackedRun,
        status: "blocked",
        blockedByRunId: blockedByRun.runId,
        overlapReason: concurrencyDecision.reason,
        completedAt: runStartedAtIso,
        metadata: {
          ...trackedRun.metadata,
          staleRunIds
        }
      })
    );
    await repository.saveEvidenceRecord(
      createEvidenceRecord({
        recordId: `${taskId}:validation:concurrency:${runId}`,
        taskId,
        kind: "gate_decision",
        title: "Validation concurrency gate decision",
        metadata: concurrencyDecision,
        createdAt: runStartedAtIso
      })
    );
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("validation", "RUN_BLOCKED_BY_OVERLAP"),
      taskId,
      runId,
      phase: "validation",
      level: "warn",
      code: "RUN_BLOCKED_BY_OVERLAP",
      message:
        concurrencyDecision.reason ??
        "Validation phase blocked by an overlapping run.",
      failureClass: "execution_loop",
      data: {
        concurrencyKey,
        strategy: concurrency.strategy,
        blockedByRunId: blockedByRun.runId,
        staleRunIds
      },
      createdAt: runStartedAtIso
    });
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("validation", "PIPELINE_BLOCKED"),
      taskId,
      runId,
      phase: "validation",
      level: "warn",
      code: "PIPELINE_BLOCKED",
      message: "Validation phase blocked by concurrency controls.",
      failureClass: "execution_loop",
      durationMs: getDurationMs(runStartedAt, runStartedAt),
      data: {
        concurrencyKey,
        strategy: concurrency.strategy,
        blockedByRunId: blockedByRun.runId
      },
      createdAt: runStartedAtIso
    });

    return {
      runId,
      manifest: currentManifest,
      nextAction: "task_blocked",
      concurrencyDecision
    };
  }

  concurrencyDecision = createConcurrencyDecision({
    action: "start",
    strategy: concurrency.strategy,
    blockedByRunId: null,
    staleRunIds,
    reason:
      staleRunIds.length > 0
        ? `Marked ${staleRunIds.length} stale overlapping run(s) before starting.`
        : null
  });
  await persistTrackedRun({ metadata: { staleRunIds } });

  try {
    if (staleRunIds.length > 0) {
      await recordRunEvent({
        repository,
        logger: runLogger,
        eventId: nextEventId("validation", "STALE_RUNS_DETECTED"),
        taskId,
        runId,
        phase: "validation",
        level: "info",
        code: "STALE_RUNS_DETECTED",
        message:
          "Stale overlapping runs were marked before the validation phase started.",
        data: {
          concurrencyKey,
          staleRunIds,
          strategy: concurrency.strategy
        },
        createdAt: runStartedAtIso
      });
    }

    const validationStartedAt = clock();
    const validationStartedAtIso = asIsoTimestamp(validationStartedAt);
    currentManifest = taskManifestSchema.parse({
      ...currentManifest,
      currentPhase: "validation",
      lifecycleStatus: "active",
      assignedAgentType: "validation",
      workspaceId,
      updatedAt: validationStartedAtIso
    });
    await repository.updateManifest(currentManifest);
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("validation", "PHASE_RUNNING"),
      taskId,
      runId,
      phase: "validation",
      level: "info",
      code: "PHASE_RUNNING",
      message: "Validation phase started.",
      data: {
        actor: "validation",
        workspaceId,
        ...(approvedRequest
          ? { approvalRequestId: approvedRequest.requestId }
          : {})
      },
      createdAt: validationStartedAtIso
    });
    await persistTrackedRun({
      lastHeartbeatAt: validationStartedAtIso,
      metadata: {
        currentPhase: "validation",
        workspaceId,
        ...(approvedRequest
          ? { approvalRequestId: approvedRequest.requestId }
          : {})
      }
    });

    const bundle = createWorkspaceContextBundle({
      manifest: currentManifest,
      spec: snapshot.spec,
      policySnapshot: snapshot.policySnapshot
    });
    const secretLease = await issueWorkspaceSecretLease({
      bundle,
      phase: "validation",
      ...(dependencies.secrets ? { secrets: dependencies.secrets } : {}),
      ...(dependencies.environment
        ? { environment: dependencies.environment }
        : {})
    });
    const workspace = await materializeManagedWorkspace({
      bundle,
      targetRoot: input.targetRoot,
      workspaceId,
      createdAt: validationStartedAtIso,
      secretLease
    });
    currentManifest = taskManifestSchema.parse({
      ...currentManifest,
      workspaceId: workspace.workspaceId,
      updatedAt: validationStartedAtIso,
      evidenceLinks: [
        ...new Set([
          ...currentManifest.evidenceLinks,
          `${workspaceLocationPrefix}${workspace.workspaceId}`
        ])
      ]
    });
    await repository.updateManifest(currentManifest);
    await repository.saveEvidenceRecord(
      createEvidenceRecord({
        recordId: `${taskId}:workspace:${workspace.workspaceId}:validation:${runId}`,
        taskId,
        kind: "file_artifact",
        title: "Managed workspace prepared for validation",
        location: `${workspaceLocationPrefix}${workspace.workspaceId}`,
        metadata: {
          status: workspace.descriptor.status,
          workspaceRoot: workspace.workspaceRoot,
          stateFile: workspace.stateFile,
          descriptor: workspace.descriptor,
          phase: "validation",
          runId,
          allowedSecretScopes:
            workspace.descriptor.credentialPolicy.allowedSecretScopes,
          injectedSecretKeys:
            workspace.descriptor.credentialPolicy.injectedSecretKeys
        },
        createdAt: validationStartedAtIso
      })
    );
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("validation", "WORKSPACE_PREPARED"),
      taskId,
      runId,
      phase: "validation",
      level: "info",
      code: "WORKSPACE_PREPARED",
      message: "Validation workspace prepared.",
      data: {
        workspaceId: workspace.workspaceId,
        toolPolicyMode: workspace.descriptor.toolPolicy.mode,
        codeWriteEnabled: workspace.descriptor.toolPolicy.codeWriteEnabled,
        credentialMode: workspace.descriptor.credentialPolicy.mode,
        allowedSecretScopes:
          workspace.descriptor.credentialPolicy.allowedSecretScopes,
        injectedSecretKeys:
          workspace.descriptor.credentialPolicy.injectedSecretKeys
      },
      createdAt: validationStartedAtIso
    });

    if (secretLease) {
      await recordRunEvent({
        repository,
        logger: runLogger,
        eventId: nextEventId("validation", "SECRET_LEASE_ISSUED"),
        taskId,
        runId,
        phase: "validation",
        level: "info",
        code: "SECRET_LEASE_ISSUED",
        message: "Scoped validation credentials issued for the managed workspace.",
        data: {
          workspaceId: workspace.workspaceId,
          credentialMode: workspace.descriptor.credentialPolicy.mode,
          allowedSecretScopes: secretLease.secretScopes,
          injectedSecretKeys: secretLease.injectedSecretKeys,
          leaseIssuedAt: secretLease.issuedAt,
          leaseExpiresAt: secretLease.expiresAt
        },
        createdAt: validationStartedAtIso
      });
    }

    const plan = await validator.createPlan(bundle, {
      manifest: currentManifest,
      runId,
      workspace
    });

    if (plan.commands.length === 0) {
      throw new PlanningPipelineFailure({
        message: "Validation plan did not provide any commands.",
        failureClass: "validation_failure",
        phase: "validation",
        code: "VALIDATION_PLAN_EMPTY",
        details: {
          workspaceId: workspace.workspaceId
        },
        taskId,
        runId
      });
    }

    const commandResults: ValidationCommandResult[] = [];

    for (const command of plan.commands) {
      const commandStartedAt = clock();
      const commandStartedAtIso = asIsoTimestamp(commandStartedAt);
      await recordRunEvent({
        repository,
        logger: runLogger,
        eventId: nextEventId("validation", "VALIDATION_COMMAND_STARTED"),
        taskId,
        runId,
        phase: "validation",
        level: "info",
        code: "VALIDATION_COMMAND_STARTED",
        message: `Validation command ${command.id} started.`,
        data: {
          commandId: command.id,
          commandName: command.name,
          executable: command.executable,
          args: command.args,
          workspaceId: workspace.workspaceId
        },
        createdAt: commandStartedAtIso
      });
      const executed = await executeValidationCommand({
        command,
        workspace,
        startedAt: commandStartedAt,
        secretLease
      });
      const { stdout: _stdout, stderr: _stderr, ...commandResult } = executed;
      commandResults.push(commandResult);
      const commandLogSourceLocation = `${workspaceLocationPrefix}${workspace.workspaceId}/artifacts/validation-${command.id}.log`;
      const archivedCommandLog = await archiveEvidenceArtifact({
        taskId,
        runId,
        phase: "validation",
        sourcePath: commandResult.logPath,
        targetRoot: input.targetRoot,
        evidenceRoot: input.evidenceRoot,
        fileName: `validation-${command.id}.log`
      });
      await repository.saveEvidenceRecord(
        createEvidenceRecord({
          recordId: `${taskId}:validation:${runId}:command:${command.id}`,
          taskId,
          kind: "file_artifact",
          title: `Validation command log: ${command.name}`,
          location: archivedCommandLog.location,
          metadata: {
            runId,
            workspaceId: workspace.workspaceId,
            commandId: command.id,
            commandName: command.name,
            exitCode: commandResult.exitCode,
            signal: commandResult.signal,
            durationMs: commandResult.durationMs,
            status: commandResult.status,
            logPath: commandResult.logPath,
            ...buildArchivedArtifactMetadata({
              archivedArtifact: archivedCommandLog,
              artifactClass: "log",
              sourceLocation: commandLogSourceLocation,
              sourcePath: commandResult.logPath
            })
          },
          createdAt: commandStartedAtIso
        })
      );

      if (commandResult.exitCode !== 0) {
        await recordRunEvent({
          repository,
          logger: runLogger,
          eventId: nextEventId("validation", "VALIDATION_COMMAND_FAILED"),
          taskId,
          runId,
          phase: "validation",
          level: "error",
          code: "VALIDATION_COMMAND_FAILED",
          message: `Validation command ${command.id} failed.`,
          failureClass: "validation_failure",
          durationMs: commandResult.durationMs,
          data: {
            commandId: command.id,
            commandName: command.name,
            exitCode: commandResult.exitCode,
            signal: commandResult.signal,
            logPath: commandResult.logPath,
            workspaceId: workspace.workspaceId
          },
          createdAt: commandStartedAtIso
        });
        throw new PlanningPipelineFailure({
          message: `Validation command ${command.id} failed with exit code ${commandResult.exitCode}.`,
          failureClass: "validation_failure",
          phase: "validation",
          code: "VALIDATION_COMMAND_FAILED",
          details: {
            commandId: command.id,
            commandName: command.name,
            exitCode: commandResult.exitCode,
            signal: commandResult.signal,
            logPath: commandResult.logPath,
            workspaceId: workspace.workspaceId
          },
          taskId,
          runId
        });
      }
      await recordRunEvent({
        repository,
        logger: runLogger,
        eventId: nextEventId("validation", "VALIDATION_COMMAND_PASSED"),
        taskId,
        runId,
        phase: "validation",
        level: "info",
        code: "VALIDATION_COMMAND_PASSED",
        message: `Validation command ${command.id} passed.`,
        durationMs: commandResult.durationMs,
        data: {
          commandId: command.id,
          commandName: command.name,
          exitCode: commandResult.exitCode,
          logPath: commandResult.logPath,
          workspaceId: workspace.workspaceId
        },
        createdAt: commandStartedAtIso
      });
      await persistTrackedRun({
        lastHeartbeatAt: commandStartedAtIso,
        metadata: {
          currentPhase: "validation",
          workspaceId: workspace.workspaceId,
          lastValidationCommandId: command.id
        }
      });
    }

    const report: ValidationReport = {
      summary: plan.summary,
      commandResults
    };
    const validationCompletedAt = clock();
    const validationCompletedAtIso = asIsoTimestamp(validationCompletedAt);
    const reportPath = join(workspace.artifactsDir, "validation-report.md");
    await writeFile(
      reportPath,
      renderValidationReportMarkdown({
        bundle,
        report,
        workspace,
        runId
      }),
      "utf8"
    );
    const resultsPath = join(workspace.artifactsDir, "validation-results.json");
    await writeFile(
      resultsPath,
      `${JSON.stringify(
        {
          taskId,
          runId,
          workspaceId: workspace.workspaceId,
          summary: report.summary,
          commandResults
        },
        null,
        2
      )}
`,
      "utf8"
    );
    const reportSourceLocation = `${workspaceLocationPrefix}${workspace.workspaceId}/artifacts/validation-report.md`;
    const resultsSourceLocation = `${workspaceLocationPrefix}${workspace.workspaceId}/artifacts/validation-results.json`;
    const archivedReport = await archiveEvidenceArtifact({
      taskId,
      runId,
      phase: "validation",
      sourcePath: reportPath,
      targetRoot: input.targetRoot,
      evidenceRoot: input.evidenceRoot,
      fileName: "validation-report.md"
    });
    const archivedResults = await archiveEvidenceArtifact({
      taskId,
      runId,
      phase: "validation",
      sourcePath: resultsPath,
      targetRoot: input.targetRoot,
      evidenceRoot: input.evidenceRoot,
      fileName: "validation-results.json"
    });
    await repository.saveMemoryRecord(
      createMemoryRecord({
        memoryId: `${taskId}:memory:task:validation`,
        taskId,
        scope: "task",
        provenance: "pipeline_derived",
        key: "validation.summary",
        title: "Validation summary",
        value: {
          summary: report.summary,
          commandResults,
          runId,
          workspaceId: workspace.workspaceId,
          reportPath,
          resultsPath,
          reportArchiveLocation: archivedReport.location,
          resultsArchiveLocation: archivedResults.location
        },
        repo: currentManifest.source.repo,
        organizationId: deriveOrganizationId(currentManifest.source.repo),
        tags: ["validation", "task"],
        createdAt: validationCompletedAtIso,
        updatedAt: validationCompletedAtIso
      })
    );
    await repository.savePhaseRecord(
      createPhaseRecord({
        id: `${taskId}:phase:validation`,
        taskId,
        phase: "validation",
        status: "passed",
        actor: "validation",
        summary:
          "Validation phase completed with deterministic workspace-local checks.",
        details: {
          workspaceId: workspace.workspaceId,
          reportPath,
          resultsPath,
          reportArchiveLocation: archivedReport.location,
          resultsArchiveLocation: archivedResults.location,
          commandResults,
          ...(approvedRequest
            ? { approvalRequestId: approvedRequest.requestId }
            : {})
        },
        createdAt: validationCompletedAtIso
      })
    );
    await repository.saveEvidenceRecord(
      createEvidenceRecord({
        recordId: `${taskId}:validation:${runId}:report`,
        taskId,
        kind: "file_artifact",
        title: "Validation report",
        location: archivedReport.location,
        metadata: {
          runId,
          workspaceId: workspace.workspaceId,
          summary: report.summary,
          commandResults,
          ...buildArchivedArtifactMetadata({
            archivedArtifact: archivedReport,
            artifactClass: "report",
            sourceLocation: reportSourceLocation,
            sourcePath: reportPath
          })
        },
        createdAt: validationCompletedAtIso
      })
    );
    await repository.saveEvidenceRecord(
      createEvidenceRecord({
        recordId: `${taskId}:validation:${runId}:results`,
        taskId,
        kind: "file_artifact",
        title: "Validation test results",
        location: archivedResults.location,
        metadata: {
          runId,
          workspaceId: workspace.workspaceId,
          summary: report.summary,
          commandResults,
          ...buildArchivedArtifactMetadata({
            archivedArtifact: archivedResults,
            artifactClass: "test_result",
            sourceLocation: resultsSourceLocation,
            sourcePath: resultsPath
          })
        },
        createdAt: validationCompletedAtIso
      })
    );
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("validation", "PHASE_PASSED"),
      taskId,
      runId,
      phase: "validation",
      level: "info",
      code: "PHASE_PASSED",
      message: "Validation checks passed in the managed workspace.",
      durationMs: getDurationMs(validationStartedAt, validationCompletedAt),
      data: {
        actor: "validation",
        workspaceId: workspace.workspaceId,
        reportPath,
        reportArchiveLocation: archivedReport.location,
        resultsArchiveLocation: archivedResults.location,
        commandCount: commandResults.length
      },
      createdAt: validationCompletedAtIso
    });
    await persistTrackedRun({
      lastHeartbeatAt: validationCompletedAtIso,
      metadata: {
        currentPhase: "validation",
        workspaceId: workspace.workspaceId,
        reportPath,
        reportArchiveLocation: archivedReport.location,
        resultsArchiveLocation: archivedResults.location
      }
    });

    const nextAction = taskRequestsPullRequest(currentManifest)
      ? "await_scm"
      : "await_review";
    const nextPhase = nextAction === "await_scm" ? "scm" : "review";
    const blockedMessage =
      nextAction === "await_scm"
        ? "Validation phase completed and is ready for SCM branch and pull-request creation."
        : "Validation phase completed, but review automation is not implemented yet.";
    const blockedAt = clock();
    const blockedAtIso = asIsoTimestamp(blockedAt);
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("validation", "PIPELINE_BLOCKED"),
      taskId,
      runId,
      phase: "validation",
      level: "warn",
      code: "PIPELINE_BLOCKED",
      message: blockedMessage,
      durationMs: getDurationMs(runStartedAt, blockedAt),
      data: {
        nextPhase,
        nextAction,
        workspaceId: workspace.workspaceId,
        reportPath,
        reportArchiveLocation: archivedReport.location,
        resultsArchiveLocation: archivedResults.location
      },
      createdAt: blockedAtIso
    });

    currentManifest = taskManifestSchema.parse({
      ...currentManifest,
      currentPhase: "validation",
      lifecycleStatus: "blocked",
      updatedAt: blockedAtIso
    });
    await repository.updateManifest(currentManifest);
    await persistTrackedRun({
      status: "blocked",
      lastHeartbeatAt: blockedAtIso,
      completedAt: blockedAtIso,
      metadata: {
        currentPhase: "validation",
        nextAction,
        workspaceId: workspace.workspaceId,
        reportPath,
        reportArchiveLocation: archivedReport.location,
        resultsArchiveLocation: archivedResults.location
      }
    });

    return {
      runId,
      manifest: currentManifest,
      workspace,
      report,
      reportPath,
      nextAction,
      concurrencyDecision
    };
  } catch (error) {
    const pipelineFailure = normalizePipelineFailure(
      error,
      "validation",
      taskId,
      runId
    );
    const failedAt = clock();
    const failedAtIso = asIsoTimestamp(failedAt);
    currentManifest = taskManifestSchema.parse({
      ...currentManifest,
      currentPhase: "validation",
      lifecycleStatus: "failed",
      updatedAt: failedAtIso
    });

    try {
      await repository.savePhaseRecord(
        createPhaseRecord({
          id: `${taskId}:phase:validation`,
          taskId,
          phase: "validation",
          status: "failed",
          actor: "control-plane",
          summary: pipelineFailure.message,
          details: {
            code: pipelineFailure.code,
            failureClass: pipelineFailure.failureClass,
            ...pipelineFailure.details
          },
          createdAt: failedAtIso
        })
      );
      await repository.saveEvidenceRecord(
        createEvidenceRecord({
          recordId: `${taskId}:validation:failure:${runId}`,
          taskId,
          kind: "run_event",
          title: "Validation phase failure",
          metadata: {
            runId,
            code: pipelineFailure.code,
            failureClass: pipelineFailure.failureClass,
            details: pipelineFailure.details
          },
          createdAt: failedAtIso
        })
      );
      await recordRunEvent({
        repository,
        logger: runLogger,
        eventId: nextEventId("validation", "PHASE_FAILED"),
        taskId,
        runId,
        phase: "validation",
        level: "error",
        code: "PHASE_FAILED",
        message: pipelineFailure.message,
        failureClass: pipelineFailure.failureClass,
        data: {
          causeCode: pipelineFailure.code,
          details: pipelineFailure.details
        },
        createdAt: failedAtIso
      });
      await recordRunEvent({
        repository,
        logger: runLogger,
        eventId: nextEventId("validation", "PIPELINE_FAILED"),
        taskId,
        runId,
        phase: "validation",
        level: "error",
        code: "PIPELINE_FAILED",
        message: "Validation phase failed.",
        failureClass: pipelineFailure.failureClass,
        durationMs: getDurationMs(runStartedAt, failedAt),
        data: {
          causeCode: pipelineFailure.code,
          details: pipelineFailure.details
        },
        createdAt: failedAtIso
      });
      await repository.updateManifest(currentManifest);
      await persistTrackedRun({
        status: "failed",
        lastHeartbeatAt: failedAtIso,
        completedAt: failedAtIso,
        metadata: {
          currentPhase: "validation",
          failureCode: pipelineFailure.code,
          failureClass: pipelineFailure.failureClass
        }
      });
    } catch (persistenceError) {
      runLogger.error("Failed to persist validation phase failure evidence.", {
        runId,
        taskId,
        failureClass: pipelineFailure.failureClass,
        code: pipelineFailure.code,
        persistenceError: serializeError(persistenceError)
      });
    }

    throw new PlanningPipelineFailure({
      message: pipelineFailure.message,
      failureClass: pipelineFailure.failureClass,
      phase: pipelineFailure.phase,
      code: pipelineFailure.code,
      details: pipelineFailure.details,
      cause: pipelineFailure,
      taskId,
      runId
    });
  }
}

export async function resolveApprovalRequest(
  input: ResolveApprovalRequestInput,
  dependencies: ResolveApprovalRequestDependencies
): Promise<ResolveApprovalRequestResult> {
  const requestId = input.requestId.trim();
  const decidedBy = input.decidedBy.trim();
  const decisionSummary = input.decisionSummary.trim();

  if (requestId.length === 0) {
    throw new Error("Approval request id is required.");
  }

  if (decidedBy.length === 0) {
    throw new Error("Approval decisions require a non-empty actor.");
  }

  if (decisionSummary.length === 0) {
    throw new Error("Approval decisions require a non-empty summary.");
  }

  const repository = dependencies.repository;
  const logger = dependencies.logger ?? defaultLogger;
  const clock = dependencies.clock ?? (() => new Date());
  const resolvedAt = clock();
  const resolvedAtIso = asIsoTimestamp(resolvedAt);
  const approvalRequest = await repository.getApprovalRequest(requestId);

  if (!approvalRequest) {
    throw new Error(`Approval request ${requestId} was not found.`);
  }

  if (approvalRequest.status !== "pending") {
    throw new Error(
      `Approval request ${requestId} is already ${approvalRequest.status}.`
    );
  }

  const manifest = await repository.getManifest(approvalRequest.taskId);

  if (!manifest) {
    throw new Error(
      `Task manifest ${approvalRequest.taskId} was not found for approval request ${requestId}.`
    );
  }

  const lifecycleStatus = input.decision === "approve" ? "ready" : "cancelled";
  assertTaskLifecycleTransition(manifest.lifecycleStatus, lifecycleStatus);

  const updatedApprovalRequest = createApprovalRequest({
    ...approvalRequest,
    status: input.decision === "approve" ? "approved" : "rejected",
    decidedBy,
    decision: input.decision,
    decisionSummary,
    comment: input.comment ?? null,
    updatedAt: resolvedAtIso,
    resolvedAt: resolvedAtIso
  });
  const updatedManifest = taskManifestSchema.parse({
    ...manifest,
    lifecycleStatus,
    evidenceLinks: [
      ...manifest.evidenceLinks,
      `db://gate_decision/${approvalRequest.taskId}:approval-decision:${approvalRequest.requestId}`
    ],
    updatedAt: resolvedAtIso
  });
  const decisionCode =
    input.decision === "approve" ? "APPROVAL_APPROVED" : "APPROVAL_REJECTED";
  const decisionMessage =
    input.decision === "approve"
      ? "Approval granted for downstream execution."
      : "Approval rejected and the task was cancelled.";
  const phaseStatus: PhaseLifecycleStatus =
    input.decision === "approve" ? "passed" : "failed";
  const runLogger = bindPlanningLogger(logger, {
    runId: approvalRequest.runId,
    taskId: approvalRequest.taskId,
    sourceRepo: manifest.source.repo,
    approvalRequestId: approvalRequest.requestId
  });

  await repository.saveApprovalRequest(updatedApprovalRequest);
  await repository.updateManifest(updatedManifest);
  await repository.savePhaseRecord(
    createPhaseRecord({
      id: `${approvalRequest.taskId}:phase:policy_gate:approval:${approvalRequest.requestId}`,
      taskId: approvalRequest.taskId,
      phase: "policy_gate",
      status: phaseStatus,
      actor: decidedBy,
      summary: decisionSummary,
      details: {
        requestId: approvalRequest.requestId,
        decision: input.decision,
        approvalMode: approvalRequest.approvalMode,
        comment: input.comment ?? null
      },
      createdAt: resolvedAtIso
    })
  );
  await repository.saveEvidenceRecord(
    createEvidenceRecord({
      recordId: `${approvalRequest.taskId}:approval-decision:${approvalRequest.requestId}`,
      taskId: approvalRequest.taskId,
      kind: "gate_decision",
      title:
        input.decision === "approve" ? "Approval granted" : "Approval rejected",
      metadata: {
        requestId: approvalRequest.requestId,
        decision: input.decision,
        decidedBy,
        decisionSummary,
        comment: input.comment ?? null,
        lifecycleStatus
      },
      createdAt: resolvedAtIso
    })
  );
  await recordRunEvent({
    repository,
    logger: runLogger,
    eventId: `${approvalRequest.requestId}:${decisionCode}`,
    taskId: approvalRequest.taskId,
    runId: approvalRequest.runId,
    phase: "policy_gate",
    level: input.decision === "approve" ? "info" : "warn",
    code: decisionCode,
    message: decisionMessage,
    data: {
      requestId: approvalRequest.requestId,
      decision: input.decision,
      decidedBy,
      decisionSummary,
      lifecycleStatus,
      ...(input.comment ? { comment: input.comment } : {})
    },
    createdAt: resolvedAtIso
  });

  return {
    approvalRequest: updatedApprovalRequest,
    manifest: updatedManifest
  };
}

function createPhaseRecord(input: {
  id: string;
  taskId: string;
  phase: TaskPhase;
  status: PhaseLifecycleStatus;
  actor: string;
  summary: string;
  details?: Record<string, unknown>;
  createdAt: string;
}): PhaseRecord {
  return phaseRecordSchema.parse({
    recordId: input.id,
    taskId: input.taskId,
    phase: input.phase,
    status: input.status,
    actor: input.actor,
    summary: input.summary,
    details: input.details ?? {},
    createdAt: input.createdAt
  });
}

function createConcurrencyDecision(
  input: ConcurrencyDecision
): ConcurrencyDecision {
  return concurrencyDecisionSchema.parse(input);
}

function createSourceConcurrencyKey(
  source: PlanningTaskInput["source"]
): string {
  const sourceIssue = source.issueNumber ?? source.issueId ?? "adhoc";
  return `${source.provider}:${source.repo}:${sourceIssue}`;
}

function createTaskConcurrencyKey(input: PlanningTaskInput): string {
  return createSourceConcurrencyKey(input.source);
}

function isPipelineRunStale(
  run: PipelineRun,
  now: Date,
  staleAfterMs: number
): boolean {
  return now.getTime() - new Date(run.lastHeartbeatAt).getTime() > staleAfterMs;
}

function createTaskId(input: PlanningTaskInput, runId: string): string {
  const sourceIssue = input.source.issueNumber ?? input.source.issueId ?? runId;
  const repo = input.source.repo.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  return `${repo}-${sourceIssue}`;
}

function wrapPinoLogger(logger: PinoLogger): PlanningPipelineLogger {
  return {
    info(message, context) {
      logger.info(context ?? {}, message);
    },
    warn(message, context) {
      logger.warn(context ?? {}, message);
    },
    error(message, context) {
      logger.error(context ?? {}, message);
    },
    child(bindings) {
      return wrapPinoLogger(logger.child(bindings));
    }
  };
}
function bindPlanningLogger(
  logger: PlanningPipelineLogger,
  bindings: Record<string, unknown>
): PlanningPipelineLogger {
  if (logger.child) {
    return logger.child(bindings);
  }

  return {
    info(message, context) {
      logger.info(message, {
        ...bindings,
        ...(context ?? {})
      });
    },
    warn(message, context) {
      logger.warn(message, {
        ...bindings,
        ...(context ?? {})
      });
    },
    error(message, context) {
      logger.error(message, {
        ...bindings,
        ...(context ?? {})
      });
    },
    child(childBindings) {
      return bindPlanningLogger(logger, {
        ...bindings,
        ...childBindings
      });
    }
  };
}

function createWorkspaceCredentialPolicy(input: {
  bundle: WorkspaceContextBundle;
  secretLease?: SecretLease | null;
  secretEnvFile?: string | null;
}): WorkspaceDescriptor["credentialPolicy"] {
  const bundle = workspaceContextBundleSchema.parse(input.bundle);
  const allowedSecretScopes = [...new Set(bundle.policySnapshot.allowedSecretScopes)];
  const secretsAllowedByPolicy =
    bundle.manifest.requestedCapabilities.includes("can_use_secrets") &&
    bundle.policySnapshot.allowedCapabilities.includes("can_use_secrets") &&
    allowedSecretScopes.length > 0;

  if (!secretsAllowedByPolicy) {
    return {
      mode: "none",
      allowedSecretScopes,
      injectedSecretKeys: [],
      secretEnvFile: null,
      leaseIssuedAt: null,
      leaseExpiresAt: null,
      notes: [...defaultWorkspaceCredentialPolicyNotes]
    };
  }

  const secretLease = input.secretLease ?? null;

  if (!secretLease) {
    return {
      mode: "none",
      allowedSecretScopes,
      injectedSecretKeys: [],
      secretEnvFile: null,
      leaseIssuedAt: null,
      leaseExpiresAt: null,
      notes: [
        `Task is approved for scoped credentials (${allowedSecretScopes.join(", ")}), but no lease has been materialized for this workspace.`
      ]
    };
  }

  if (secretLease.mode !== "scoped_env") {
    throw new Error(
      `Unsupported secret lease mode ${secretLease.mode} for workspace credential policy.`
    );
  }

  const disallowedScopes = secretLease.secretScopes.filter(
    (scope) => !allowedSecretScopes.includes(scope)
  );

  if (disallowedScopes.length > 0) {
    throw new Error(
      `Secret lease requested scopes outside policy approval: ${disallowedScopes.join(", ")}.`
    );
  }

  if (!input.secretEnvFile) {
    throw new Error(
      "A scoped secret lease requires a workspace-local credential file path."
    );
  }

  return {
    mode: "scoped_env",
    allowedSecretScopes,
    injectedSecretKeys: [...secretLease.injectedSecretKeys].sort(),
    secretEnvFile: input.secretEnvFile,
    leaseIssuedAt: secretLease.issuedAt,
    leaseExpiresAt: secretLease.expiresAt,
    notes: [
      ...secretLease.notes,
      "Scoped credentials are materialized into a workspace-local lease file and never persisted in evidence metadata."
    ]
  };
}

function readConfiguredBaseBranch(input: PlanningTaskInput): string {
  const githubMetadata = input.metadata["github"];

  if (githubMetadata && typeof githubMetadata === "object") {
    const baseBranch = (githubMetadata as Record<string, unknown>)["baseBranch"];

    if (typeof baseBranch === "string" && baseBranch.trim().length > 0) {
      return baseBranch.trim();
    }
  }

  return "main";
}

function readTaskMemoryValue(
  snapshot: PersistedTaskSnapshot,
  key: string
): unknown {
  return (
    snapshot.memoryRecords.find(
      (record) => record.scope === "task" && record.key === key
    )?.value ?? null
  );
}

function readPlanningDefaultBranchFromSnapshot(
  snapshot: PersistedTaskSnapshot
): string {
  const planningBrief = readTaskMemoryValue(snapshot, "planning.brief");

  if (planningBrief && typeof planningBrief === "object") {
    const defaultBranch = (planningBrief as Record<string, unknown>)[
      "defaultBranch"
    ];

    if (typeof defaultBranch === "string" && defaultBranch.trim().length > 0) {
      return defaultBranch.trim();
    }
  }

  return "main";
}

function readValidationSummaryFromSnapshot(
  snapshot: PersistedTaskSnapshot
): string {
  const validationSummary = readTaskMemoryValue(snapshot, "validation.summary");

  if (validationSummary && typeof validationSummary === "object") {
    const summary = (validationSummary as Record<string, unknown>)["summary"];

    if (typeof summary === "string" && summary.trim().length > 0) {
      return summary.trim();
    }
  }

  throw new Error(
    `Task ${snapshot.manifest?.taskId ?? "unknown"} requires a validation.summary memory record before SCM can start.`
  );
}

function readValidationReportPathFromSnapshot(
  snapshot: PersistedTaskSnapshot
): string {
  const validationSummary = readTaskMemoryValue(snapshot, "validation.summary");

  if (validationSummary && typeof validationSummary === "object") {
    const reportPath = (validationSummary as Record<string, unknown>)["reportPath"];

    if (typeof reportPath === "string" && reportPath.trim().length > 0) {
      return reportPath;
    }
  }

  throw new Error(
    `Task ${snapshot.manifest?.taskId ?? "unknown"} requires a validation report path before SCM can start.`
  );
}

function taskRequestsPullRequest(manifest: TaskManifest): boolean {
  return manifest.requestedCapabilities.includes("can_open_pr");
}

function createScmBranchName(taskId: string, runId: string): string {
  return `reddwarf/${sanitizeBranchSegment(taskId)}/${sanitizeBranchSegment(runId)}`;
}

function sanitizeBranchSegment(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-/.]+|[-/.]+$/g, "");

  return sanitized.length > 0 ? sanitized : "task";
}

function toolPolicyRequiresScmEscalation(
  bundle: WorkspaceContextBundle
): boolean {
  return !createWorkspaceToolPolicy(bundle).allowedCapabilities.includes(
    "can_open_pr"
  );
}

function createWorkspaceToolPolicy(
  bundleInput: WorkspaceContextBundle
): WorkspaceDescriptor["toolPolicy"] {
  const bundle = workspaceContextBundleSchema.parse(bundleInput);
  const secretsCapability =
    bundle.policySnapshot.allowedCapabilities.includes("can_use_secrets") &&
    bundle.policySnapshot.allowedSecretScopes.length > 0
      ? (["can_use_secrets"] as Capability[])
      : [];

  if (
    bundle.manifest.currentPhase === "validation" ||
    bundle.manifest.assignedAgentType === "validation"
  ) {
    return {
      mode: "validation_only",
      codeWriteEnabled: false,
      allowedCapabilities: [
        ...validationWorkspaceCapabilities.filter(
          (capability) => capability !== "can_use_secrets"
        ),
        ...secretsCapability
      ],
      blockedPhases: bundle.policySnapshot.blockedPhases,
      notes: [...validationWorkspaceToolPolicyNotes]
    };
  }

  if (
    bundle.manifest.currentPhase === "development" ||
    bundle.manifest.assignedAgentType === "developer"
  ) {
    return {
      mode: "development_readonly",
      codeWriteEnabled: false,
      allowedCapabilities: [
        ...developmentWorkspaceCapabilities.filter(
          (capability) => capability !== "can_use_secrets"
        ),
        ...secretsCapability
      ],
      blockedPhases: bundle.policySnapshot.blockedPhases,
      notes: [...developmentWorkspaceToolPolicyNotes]
    };
  }

  if (
    bundle.manifest.currentPhase === "scm" ||
    bundle.manifest.assignedAgentType === "scm"
  ) {
    return {
      mode: "scm_only",
      codeWriteEnabled: false,
      allowedCapabilities: [...scmWorkspaceCapabilities],
      blockedPhases: bundle.policySnapshot.blockedPhases,
      notes: [...scmWorkspaceToolPolicyNotes]
    };
  }

  return {
    mode: "planning_only",
    codeWriteEnabled: false,
    allowedCapabilities: [...planningWorkspaceCapabilities],
    blockedPhases: bundle.policySnapshot.blockedPhases,
    notes: [...planningWorkspaceToolPolicyNotes]
  };
}

function renderDevelopmentHandoffMarkdown(input: {
  bundle: WorkspaceContextBundle;
  handoff: DevelopmentDraft;
  workspace: MaterializedManagedWorkspace;
  runId: string;
  codeWriteEnabled: boolean;
}): string {
  return [
    "# Development Handoff",
    "",
    `- Task ID: ${input.bundle.manifest.taskId}`,
    `- Run ID: ${input.runId}`,
    `- Workspace ID: ${input.workspace.workspaceId}`,
    `- Tool policy mode: ${input.workspace.descriptor.toolPolicy.mode}`,
    `- Credential policy mode: ${input.workspace.descriptor.credentialPolicy.mode}`,
    `- Approved secret scopes: ${formatLiteralList(input.workspace.descriptor.credentialPolicy.allowedSecretScopes)}`,
    `- Code writing enabled: ${input.codeWriteEnabled ? "yes" : "no"}`,
    "",
    "## Summary",
    "",
    input.handoff.summary,
    "",
    "## Implementation Notes",
    "",
    ...input.handoff.implementationNotes.map((item) => `- ${item}`),
    "",
    "## Blocked Actions",
    "",
    ...input.handoff.blockedActions.map((item) => `- ${item}`),
    "",
    "## Next Actions",
    "",
    ...input.handoff.nextActions.map((item) => `- ${item}`),
    ""
  ].join("\n");
}

function renderValidationReportMarkdown(input: {
  bundle: WorkspaceContextBundle;
  report: ValidationReport;
  workspace: MaterializedManagedWorkspace;
  runId: string;
}): string {
  return [
    "# Validation Report",
    "",
    `- Task ID: ${input.bundle.manifest.taskId}`,
    `- Run ID: ${input.runId}`,
    `- Workspace ID: ${input.workspace.workspaceId}`,
    `- Tool policy mode: ${input.workspace.descriptor.toolPolicy.mode}`,
    `- Credential policy mode: ${input.workspace.descriptor.credentialPolicy.mode}`,
    `- Approved secret scopes: ${formatLiteralList(input.workspace.descriptor.credentialPolicy.allowedSecretScopes)}`,
    "",
    "## Summary",
    "",
    input.report.summary,
    "",
    "## Command Results",
    "",
    ...input.report.commandResults.flatMap((result) => [
      `### ${result.name}`,
      "",
      `- Command ID: ${result.id}`,
      `- Status: ${result.status}`,
      `- Exit Code: ${result.exitCode}`,
      `- Duration (ms): ${result.durationMs}`,
      `- Log Path: ${relative(input.workspace.workspaceRoot, result.logPath).replace(/\\/g, "/")}`,
      ""
    ])
  ].join("\n");
}

function createScmPullRequestBody(input: {
  bundle: WorkspaceContextBundle;
  validationSummary: string;
  validationReportPath: string;
  branchName: string;
  baseBranch: string;
  workspace: MaterializedManagedWorkspace;
  runId: string;
}): string {
  return [
    "## RedDwarf SCM Handoff",
    "",
    `- Task ID: ${input.bundle.manifest.taskId}`,
    `- Run ID: ${input.runId}`,
    `- Base branch: ${input.baseBranch}`,
    `- Head branch: ${input.branchName}`,
    `- Validation report: ${workspaceLocationPrefix}${input.workspace.workspaceId}/artifacts/${relative(input.workspace.artifactsDir, input.validationReportPath).replace(/\\/g, "/")}`,
    "",
    "### Summary",
    "",
    input.bundle.spec.summary,
    "",
    "### Validation",
    "",
    input.validationSummary,
    "",
    "### Acceptance Criteria",
    "",
    ...input.bundle.acceptanceCriteria.map((item) => `- ${item}`),
    ""
  ].join("\n");
}

function renderScmReportMarkdown(input: {
  bundle: WorkspaceContextBundle;
  draft: ScmDraft;
  branch: GitHubBranchSummary;
  pullRequest: GitHubPullRequestSummary;
  workspace: MaterializedManagedWorkspace;
  runId: string;
  validationReportPath: string;
}): string {
  return [
    "# SCM Report",
    "",
    `- Task ID: ${input.bundle.manifest.taskId}`,
    `- Run ID: ${input.runId}`,
    `- Workspace ID: ${input.workspace.workspaceId}`,
    `- Tool policy mode: ${input.workspace.descriptor.toolPolicy.mode}`,
    `- Base branch: ${input.branch.baseBranch}`,
    `- Head branch: ${input.branch.branchName}`,
    `- Branch URL: ${input.branch.url}`,
    `- Pull Request: #${input.pullRequest.number}`,
    `- Pull Request URL: ${input.pullRequest.url}`,
    `- Validation report path: ${relative(input.workspace.workspaceRoot, input.validationReportPath).replace(/\\/g, "/")}`,
    "",
    "## Summary",
    "",
    input.draft.summary,
    "",
    "## Pull Request Title",
    "",
    input.draft.pullRequestTitle,
    "",
    "## Applied Labels",
    "",
    ...(input.draft.labels.length > 0
      ? input.draft.labels.map((label) => `- ${label}`)
      : ["- none"]),
    ""
  ].join("\n");
}

function renderScmDiffMarkdown(input: {
  bundle: WorkspaceContextBundle;
  branch: GitHubBranchSummary;
  pullRequest: GitHubPullRequestSummary;
  validationSummary: string;
}): string {
  return [
    "# SCM Diff Summary",
    "",
    `- Task ID: ${input.bundle.manifest.taskId}`,
    `- Base branch: ${input.branch.baseBranch}`,
    `- Head branch: ${input.branch.branchName}`,
    `- Pull Request URL: ${input.pullRequest.url}`,
    "",
    "## Planned Change Surface",
    "",
    ...(input.bundle.spec.affectedAreas.length > 0
      ? input.bundle.spec.affectedAreas.map((area) => `- ${area}`)
      : ["- planning-surface-only"]),
    "",
    "## Validation Summary",
    "",
    input.validationSummary,
    "",
    "## Diff Availability",
    "",
    "No product-repo diff patch was generated because RedDwarf still keeps product code writes disabled by default. This summary preserves the approved change intent and SCM metadata until code-writing lands.",
    ""
  ].join("\n");
}

function createValidationNodeScript(kind: "lint" | "test"): string {
  if (kind === "lint") {
    return [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const handoffPath = path.join(process.cwd(), "artifacts", "developer-handoff.md");',
      'const handoff = fs.readFileSync(handoffPath, "utf8");',
      'const requiredHeadings = ["# Development Handoff", "## Summary", "## Implementation Notes", "## Blocked Actions", "## Next Actions"];',
      "for (const heading of requiredHeadings) {",
      "  if (!handoff.includes(heading)) {",
      "    throw new Error(`Missing heading ${heading} in ${handoffPath}.`);",
      "  }",
      "}",
      'if (!handoff.includes("Code writing enabled: no")) {',
      '  throw new Error("Developer handoff must confirm code writing stays disabled.");',
      "}",
      'console.log("Validated developer handoff headings and guardrails.");'
    ].join("\n");
  }

  return [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const task = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".context", "task.json"), "utf8"));',
    'const descriptor = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".workspace", "workspace.json"), "utf8"));',
    'const tools = fs.readFileSync(path.join(process.cwd(), "TOOLS.md"), "utf8");',
    'if (task.currentPhase !== "validation") {',
    "  throw new Error(`Expected validation phase in task.json, received ${task.currentPhase}.`);",
    "}",
    'if (task.assignedAgentType !== "validation") {',
    "  throw new Error(`Expected validation agent assignment, received ${task.assignedAgentType}.`);",
    "}",
    'if (descriptor.toolPolicy.mode !== "validation_only") {',
    "  throw new Error(`Expected validation_only tool mode, received ${descriptor.toolPolicy.mode}.`);",
    "}",
    "if (descriptor.toolPolicy.codeWriteEnabled !== false) {",
    '  throw new Error("Validation workspace must keep code writing disabled.");',
    "}",
    'if (!descriptor.toolPolicy.allowedCapabilities.includes("can_run_tests")) {',
    '  throw new Error("Validation workspace must allow can_run_tests.");',
    "}",
    'if (!tools.includes("can_run_tests")) {',
    '  throw new Error("Runtime TOOLS.md must describe can_run_tests for validation.");',
    "}",
    'if (descriptor.credentialPolicy.mode === "scoped_env" && !descriptor.credentialPolicy.secretEnvFile) {',
    '  throw new Error("Scoped credential leases must declare a workspace-local secretEnvFile.");',
    "}",
    'console.log("Validated workspace contract for the validation phase.");'
  ].join("\n");
}

interface ExecutedValidationCommandResult extends ValidationCommandResult {
  stdout: string;
  stderr: string;
}

async function executeValidationCommand(input: {
  command: ValidationCommand;
  workspace: MaterializedManagedWorkspace;
  startedAt: Date;
  secretLease?: SecretLease | null;
}): Promise<ExecutedValidationCommandResult> {
  const { command, workspace, startedAt } = input;
  const logPath = join(workspace.artifactsDir, `validation-${command.id}.log`);
  const execution = await new Promise<{
    exitCode: number;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    completedAt: Date;
  }>((resolveCommand, rejectCommand) => {
    const child = spawn(command.executable, command.args, {
      cwd: workspace.workspaceRoot,
      env: {
        ...process.env,
        ...(input.secretLease?.environmentVariables ?? {}),
        REDDWARF_WORKSPACE_ID: workspace.workspaceId,
        REDDWARF_WORKSPACE_ROOT: workspace.workspaceRoot
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderrChunks.push(chunk);
    });
    child.on("error", (error) => {
      rejectCommand(error);
    });
    child.on("close", (exitCode, signal) => {
      resolveCommand({
        exitCode: exitCode ?? 1,
        signal: signal ?? null,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        completedAt: new Date()
      });
    });
  });

  const durationMs = getDurationMs(startedAt, execution.completedAt);
  const stdout = input.secretLease
    ? redactSecretValues(execution.stdout, input.secretLease)
    : execution.stdout;
  const stderr = input.secretLease
    ? redactSecretValues(execution.stderr, input.secretLease)
    : execution.stderr;
  await writeFile(
    logPath,
    [
      "# Validation Command Log",
      "",
      `- Command ID: ${command.id}`,
      `- Name: ${command.name}`,
      `- Executable: ${command.executable}`,
      `- Args: ${JSON.stringify(command.args)}`,
      `- Exit Code: ${execution.exitCode}`,
      `- Signal: ${execution.signal ?? "none"}`,
      `- Duration (ms): ${durationMs}`,
      "",
      "## Stdout",
      "",
      stdout.length > 0 ? stdout.trimEnd() : "(empty)",
      "",
      "## Stderr",
      "",
      stderr.length > 0 ? stderr.trimEnd() : "(empty)",
      ""
    ].join("\n"),
    "utf8"
  );

  return {
    id: command.id,
    name: command.name,
    executable: command.executable,
    args: [...command.args],
    exitCode: execution.exitCode,
    signal: execution.signal,
    durationMs,
    status: execution.exitCode === 0 ? "passed" : "failed",
    logPath,
    stdout,
    stderr
  };
}

function buildCanonicalSources(bundle: WorkspaceContextBundle): string[] {
  const canonicalSources = new Set<string>([
    "openclaw_ai_dev_team_v_2_architecture.md",
    "docs/implementation-map.md",
    "standards/engineering.md",
    "prompts/planning-system.md"
  ]);
  const assignedAgentSource =
    agentInstructionPathByType[bundle.manifest.assignedAgentType];
  const recommendedAgentSource =
    agentInstructionPathByType[bundle.spec.recommendedAgentType];

  if (assignedAgentSource) {
    canonicalSources.add(assignedAgentSource);
  }

  if (recommendedAgentSource) {
    canonicalSources.add(recommendedAgentSource);
  }

  return [...canonicalSources];
}

function getRuntimeInstructionContent(
  layer: RuntimeInstructionLayer,
  relativePath: string
): string {
  const file = layer.files.find((entry) => entry.relativePath === relativePath);

  if (!file) {
    throw new Error(`Missing runtime instruction file ${relativePath}.`);
  }

  return file.content.endsWith("\n") ? file.content : `${file.content}\n`;
}

function renderRuntimeSoulMarkdown(
  bundle: WorkspaceContextBundle,
  canonicalSources: string[]
): string {
  const toolPolicy = createWorkspaceToolPolicy(bundle);

  return [
    "# RedDwarf Runtime Soul",
    "",
    `This workspace is provisioned for task \`${bundle.manifest.taskId}\` under policy \`${bundle.policySnapshot.policyVersion}\`.`,
    "",
    "## Task Frame",
    "",
    `- Assigned agent: \`${bundle.manifest.assignedAgentType}\``,
    `- Recommended agent: \`${bundle.spec.recommendedAgentType}\``,
    `- Workspace ID: \`${bundle.manifest.workspaceId ?? bundle.manifest.taskId}\``,
    `- Current phase in manifest: \`${bundle.manifest.currentPhase}\``,
    `- Risk class: \`${bundle.manifest.riskClass}\``,
    `- Approval mode: \`${bundle.policySnapshot.approvalMode}\``,
    "",
    "## First Reads",
    "",
    ...taskContractRelativePaths.map((path) => `- \`${path}\``),
    "",
    "## Canonical Sources",
    "",
    ...canonicalSources.map((path) => `- \`${path}\``),
    "",
    "## Guardrails",
    "",
    `- Allowed capabilities: ${formatLiteralList(toolPolicy.allowedCapabilities)}`,
    `- Allowed paths: ${formatLiteralList(bundle.allowedPaths)}`,
    `- Blocked phases in v1: ${formatLiteralList(toolPolicy.blockedPhases)}`,
    "- Product code writes remain disabled; stay inside the approved workspace and path scope.",
    toolPolicy.allowedCapabilities.includes("can_open_pr")
      ? "- Remote mutations are limited to approved branch and pull-request creation for this task."
      : "- Remote mutations remain blocked; escalate before opening branches, pull requests, or mutating external systems.",
    "- Treat `.context/` as the task contract and the policy-pack docs as the canonical source of engineering rules.",
    ""
  ].join("\n");
}

function renderRuntimeAgentsMarkdown(bundle: WorkspaceContextBundle): string {
  const enabledAgents = agentDefinitions
    .filter((agent) => agent.enabled)
    .map((agent) => agent.type);

  return [
    "# Agent Instructions",
    "",
    `- Assigned agent for this task: \`${bundle.manifest.assignedAgentType}\``,
    `- Recommended agent from planning: \`${bundle.spec.recommendedAgentType}\``,
    `- Enabled autonomous agents in v1: ${formatLiteralList(enabledAgents)}`,
    "",
    ...agentDefinitions.flatMap((agent) => {
      const instructionPath = agentInstructionPathByType[agent.type];

      return [
        `## ${agent.displayName}`,
        "",
        `- Type: \`${agent.type}\``,
        `- Enabled: ${agent.enabled ? "yes" : "no"}`,
        `- Active phases: ${formatLiteralList(agent.activePhases)}`,
        `- Capabilities: ${formatLiteralList(agent.capabilities)}`,
        `- Description: ${agent.description}`,
        instructionPath
          ? `- Canonical role file: \`${instructionPath}\``
          : "- Canonical role file: no dedicated markdown asset is versioned yet; use this roster entry.",
        ""
      ];
    })
  ].join("\n");
}

function renderRuntimeToolsMarkdown(bundle: WorkspaceContextBundle): string {
  const toolPolicy = createWorkspaceToolPolicy(bundle);
  const deniedCapabilities = capabilities.filter(
    (capability) => !toolPolicy.allowedCapabilities.includes(capability)
  );
  const requestedButDenied = bundle.manifest.requestedCapabilities.filter(
    (capability) => !toolPolicy.allowedCapabilities.includes(capability)
  );

  return [
    "# Tool Contract",
    "",
    `- Tool policy mode: \`${toolPolicy.mode}\``,
    `- Code writing enabled: ${toolPolicy.codeWriteEnabled ? "yes" : "no"}`,
    `- Requested capabilities: ${formatLiteralList(bundle.manifest.requestedCapabilities)}`,
    `- Allowed capabilities now: ${formatLiteralList(toolPolicy.allowedCapabilities)}`,
    `- Currently denied capabilities: ${formatLiteralList(deniedCapabilities)}`,
    `- Requested but denied: ${formatLiteralList(requestedButDenied)}`,
    `- Allowed secret scopes: ${formatLiteralList(bundle.policySnapshot.allowedSecretScopes)}`,
    "",
    "## Tool Policy Notes",
    "",
    ...toolPolicy.notes.map((note) => `- ${note}`),
    "",
    "## Allowed Capability Guidance",
    "",
    ...toolPolicy.allowedCapabilities.flatMap((capability) => [
      `### \`${capability}\``,
      "",
      capabilityGuidance[capability],
      ""
    ]),
    "## Credential Guardrails",
    "",
    ...(bundle.policySnapshot.allowedSecretScopes.length > 0
      ? [
          `- Approved secret scopes: ${formatLiteralList(bundle.policySnapshot.allowedSecretScopes)}`,
          `- When a secrets adapter issues a lease, credentials are mounted at \`${workspaceStateDirName}/${workspaceCredentialsDirName}/${workspaceSecretEnvFileName}\` and only the key names are persisted in metadata.`
        ]
      : ["- No secret scopes are approved for this task."]),
    "",
    "## Path Guardrails",
    "",
    ...(bundle.allowedPaths.length > 0
      ? bundle.allowedPaths.map((path) => `- \`${path}\``)
      : [
          "- No product-repo paths are pre-authorized. Escalate before modifying any surface."
        ]),
    "",
    "## Blocked Phases",
    "",
    ...toolPolicy.blockedPhases.map((phase) => `- \`${phase}\``),
    "",
    "## Escalate Instead Of",
    "",
    "- writing product code",
    ...(toolPolicy.allowedCapabilities.includes("can_open_pr")
      ? ["- mutating remote systems outside approved branch and pull-request creation"]
      : ["- opening pull requests or mutating remote systems"]),
    "- using secrets outside approved scopes or without an injected lease",
    "- touching paths outside the allowed scope",
    ""
  ].join("\n");
}

function renderRuntimeTaskSkillMarkdown(
  bundle: WorkspaceContextBundle,
  canonicalSources: string[]
): string {
  return [
    "# RedDwarf Task Runtime Skill",
    "",
    `Use this skill before taking action on task \`${bundle.manifest.taskId}\`.`,
    "",
    "## Workflow",
    "",
    "1. Read `.context/task.json`, `.context/spec.md`, and `.context/policy_snapshot.json` before proposing or executing work.",
    "2. Confirm that the requested action stays within the current tool-policy capabilities and allowed paths.",
    `3. Use the assigned role instructions first: \`${agentInstructionPathByType[bundle.manifest.assignedAgentType] ?? "AGENTS.md"}\`.`,
    `4. Use the recommended role instructions from planning: \`${agentInstructionPathByType[bundle.spec.recommendedAgentType] ?? "AGENTS.md"}\`.`,
    "5. Produce evidence-friendly output that traces assumptions, affected areas, constraints, acceptance criteria, and verification intent.",
    toolPolicyRequiresScmEscalation(bundle)
      ? "6. Escalate whenever the task would require code-writing, secrets, PR creation, or a blocked phase in v1."
      : "6. Escalate whenever the task would require code-writing, secrets outside approved scopes, or a blocked phase in v1.",
    "",
    "## Canonical Sources",
    "",
    ...canonicalSources.map((path) => `- \`${path}\``),
    ""
  ].join("\n");
}

function formatLiteralList(items: readonly string[]): string {
  if (items.length === 0) {
    return "none";
  }

  return items.map((item) => `\`${item}\``).join(", ");
}

async function readWorkspaceDescriptorForDestroy(
  stateFile: string,
  destroyedAt: string
): Promise<WorkspaceDescriptor | null> {
  try {
    const descriptor = workspaceDescriptorSchema.parse(
      JSON.parse(await readFile(stateFile, "utf8"))
    );

    return workspaceDescriptorSchema.parse({
      ...descriptor,
      status: "destroyed",
      updatedAt: destroyedAt,
      destroyedAt
    });
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }

    throw error;
  }
}

function assertWorkspacePathWithinRoot(
  targetRoot: string,
  workspaceRoot: string
): void {
  const resolvedTargetRoot = resolve(targetRoot);
  const resolvedWorkspaceRoot = resolve(workspaceRoot);
  const relativePath = relative(resolvedTargetRoot, resolvedWorkspaceRoot);

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(
      `Workspace path ${resolvedWorkspaceRoot} escapes configured root ${resolvedTargetRoot}.`
    );
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export async function runScmPhase(
  input: RunScmPhaseInput,
  dependencies: ScmPhaseDependencies
): Promise<ScmPhaseResult> {
  const taskId = input.taskId.trim();

  if (taskId.length === 0) {
    throw new Error("Task id is required to run the SCM phase.");
  }

  const repository = dependencies.repository;
  const scm = dependencies.scm;
  const github = dependencies.github;
  const logger = dependencies.logger ?? defaultLogger;
  const clock = dependencies.clock ?? (() => new Date());
  const idGenerator = dependencies.idGenerator ?? (() => randomUUID());
  const concurrency = {
    strategy: dependencies.concurrency?.strategy ?? "serialize",
    staleAfterMs: dependencies.concurrency?.staleAfterMs ?? 5 * 60_000
  } satisfies Required<PlanningConcurrencyOptions>;
  const snapshot = await repository.getTaskSnapshot(taskId);

  if (!snapshot.manifest) {
    throw new Error(`Task manifest ${taskId} was not found.`);
  }

  if (!snapshot.spec) {
    throw new Error(`Planning spec for ${taskId} was not found.`);
  }

  if (!snapshot.policySnapshot) {
    throw new Error(`Policy snapshot for ${taskId} was not found.`);
  }

  if (!taskRequestsPullRequest(snapshot.manifest)) {
    throw new Error(
      `Task ${taskId} did not request can_open_pr and cannot enter SCM.`
    );
  }

  const approvedRequest =
    snapshot.manifest.approvalMode === "auto"
      ? null
      : (snapshot.approvalRequests.find(
          (request) => request.status === "approved"
        ) ?? null);

  if (snapshot.manifest.approvalMode !== "auto" && !approvedRequest) {
    throw new Error(
      `Task ${taskId} requires an approved request before the SCM phase can start.`
    );
  }

  const lifecycleAllowsScm =
    (snapshot.manifest.lifecycleStatus === "blocked" &&
      ["validation", "scm"].includes(snapshot.manifest.currentPhase)) ||
    (snapshot.manifest.lifecycleStatus === "active" &&
      snapshot.manifest.currentPhase === "scm");

  if (!lifecycleAllowsScm) {
    throw new Error(
      `Task ${taskId} is ${snapshot.manifest.lifecycleStatus} in phase ${snapshot.manifest.currentPhase} and cannot enter SCM.`
    );
  }

  if (
    input.workspaceId &&
    snapshot.manifest.workspaceId &&
    input.workspaceId !== snapshot.manifest.workspaceId
  ) {
    throw new Error(
      `SCM must reuse workspace ${snapshot.manifest.workspaceId}; received ${input.workspaceId}.`
    );
  }

  const workspaceId = snapshot.manifest.workspaceId ?? input.workspaceId;

  if (!workspaceId) {
    throw new Error(
      `Task ${taskId} requires a managed workspace from the developer phase before SCM can start.`
    );
  }

  const validationSummary = readValidationSummaryFromSnapshot(snapshot);
  const validationReportPath = readValidationReportPathFromSnapshot(snapshot);
  const baseBranch = readPlanningDefaultBranchFromSnapshot(snapshot);

  assertPhaseExecutable("scm");

  const runId = idGenerator();
  const runStartedAt = clock();
  const runStartedAtIso = asIsoTimestamp(runStartedAt);
  const concurrencyKey = createSourceConcurrencyKey(snapshot.manifest.source);
  let currentManifest = taskManifestSchema.parse(snapshot.manifest);
  let concurrencyDecision = createConcurrencyDecision({
    action: "start",
    strategy: concurrency.strategy,
    blockedByRunId: null,
    staleRunIds: [],
    reason: null
  });
  let trackedRun = createPipelineRun({
    runId,
    taskId,
    concurrencyKey,
    strategy: concurrency.strategy,
    status: "active",
    startedAt: runStartedAtIso,
    lastHeartbeatAt: runStartedAtIso,
    metadata: {
      sourceRepo: currentManifest.source.repo,
      phase: "scm",
      workspaceId,
      ...(approvedRequest
        ? { approvalRequestId: approvedRequest.requestId }
        : {})
    }
  });
  const runLogger = bindPlanningLogger(logger, {
    runId,
    taskId,
    sourceRepo: currentManifest.source.repo,
    phase: "scm"
  });
  let eventSequence = 0;
  const nextEventId = (phase: TaskPhase, code: string): string => {
    const sequence = String(eventSequence).padStart(3, "0");
    eventSequence += 1;
    return `${runId}:${sequence}:${phase}:${code}`;
  };
  const persistTrackedRun = async (
    patch: Partial<PipelineRun> & { metadata?: Record<string, unknown> }
  ): Promise<void> => {
    trackedRun = createPipelineRun({
      ...trackedRun,
      ...patch,
      metadata: {
        ...trackedRun.metadata,
        ...(patch.metadata ?? {})
      }
    });
    await repository.savePipelineRun(trackedRun);
  };

  const overlappingRuns = await repository.listPipelineRuns({
    concurrencyKey,
    statuses: ["active"],
    limit: 25
  });
  const staleRunIds: string[] = [];
  let blockedByRun: PipelineRun | null = null;

  for (const overlap of overlappingRuns) {
    if (overlap.runId === runId) {
      continue;
    }

    if (isPipelineRunStale(overlap, runStartedAt, concurrency.staleAfterMs)) {
      await repository.savePipelineRun(
        createPipelineRun({
          ...overlap,
          status: "stale",
          lastHeartbeatAt: runStartedAtIso,
          completedAt: runStartedAtIso,
          staleAt: runStartedAtIso,
          overlapReason: `Marked stale by run ${runId}`,
          metadata: {
            ...overlap.metadata,
            staleDetectedByRunId: runId
          }
        })
      );
      staleRunIds.push(overlap.runId);
      continue;
    }

    blockedByRun = overlap;
    break;
  }

  if (blockedByRun) {
    concurrencyDecision = createConcurrencyDecision({
      action: "block",
      strategy: concurrency.strategy,
      blockedByRunId: blockedByRun.runId,
      staleRunIds,
      reason: `Active overlapping run ${blockedByRun.runId} already owns ${concurrencyKey}.`
    });
    await repository.savePipelineRun(
      createPipelineRun({
        ...trackedRun,
        status: "blocked",
        blockedByRunId: blockedByRun.runId,
        overlapReason: concurrencyDecision.reason,
        completedAt: runStartedAtIso,
        metadata: {
          ...trackedRun.metadata,
          staleRunIds
        }
      })
    );
    await repository.saveEvidenceRecord(
      createEvidenceRecord({
        recordId: `${taskId}:scm:concurrency:${runId}`,
        taskId,
        kind: "gate_decision",
        title: "SCM concurrency gate decision",
        metadata: concurrencyDecision,
        createdAt: runStartedAtIso
      })
    );
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("scm", "RUN_BLOCKED_BY_OVERLAP"),
      taskId,
      runId,
      phase: "scm",
      level: "warn",
      code: "RUN_BLOCKED_BY_OVERLAP",
      message:
        concurrencyDecision.reason ?? "SCM phase blocked by an overlapping run.",
      failureClass: "execution_loop",
      data: {
        concurrencyKey,
        strategy: concurrency.strategy,
        blockedByRunId: blockedByRun.runId,
        staleRunIds
      },
      createdAt: runStartedAtIso
    });
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("scm", "PIPELINE_BLOCKED"),
      taskId,
      runId,
      phase: "scm",
      level: "warn",
      code: "PIPELINE_BLOCKED",
      message: "SCM phase blocked by concurrency controls.",
      failureClass: "execution_loop",
      durationMs: getDurationMs(runStartedAt, runStartedAt),
      data: {
        concurrencyKey,
        strategy: concurrency.strategy,
        blockedByRunId: blockedByRun.runId
      },
      createdAt: runStartedAtIso
    });

    return {
      runId,
      manifest: currentManifest,
      nextAction: "task_blocked",
      concurrencyDecision
    };
  }

  concurrencyDecision = createConcurrencyDecision({
    action: "start",
    strategy: concurrency.strategy,
    blockedByRunId: null,
    staleRunIds,
    reason:
      staleRunIds.length > 0
        ? `Marked ${staleRunIds.length} stale overlapping run(s) before starting.`
        : null
  });
  await persistTrackedRun({ metadata: { staleRunIds } });

  try {
    if (staleRunIds.length > 0) {
      await recordRunEvent({
        repository,
        logger: runLogger,
        eventId: nextEventId("scm", "STALE_RUNS_DETECTED"),
        taskId,
        runId,
        phase: "scm",
        level: "info",
        code: "STALE_RUNS_DETECTED",
        message: "Stale overlapping runs were marked before the SCM phase started.",
        data: {
          concurrencyKey,
          staleRunIds,
          strategy: concurrency.strategy
        },
        createdAt: runStartedAtIso
      });
    }

    const scmStartedAt = clock();
    const scmStartedAtIso = asIsoTimestamp(scmStartedAt);
    currentManifest = taskManifestSchema.parse({
      ...currentManifest,
      currentPhase: "scm",
      lifecycleStatus: "active",
      assignedAgentType: "scm",
      workspaceId,
      updatedAt: scmStartedAtIso
    });
    await repository.updateManifest(currentManifest);
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("scm", "PHASE_RUNNING"),
      taskId,
      runId,
      phase: "scm",
      level: "info",
      code: "PHASE_RUNNING",
      message: "SCM phase started.",
      data: {
        actor: "scm",
        workspaceId,
        ...(approvedRequest
          ? { approvalRequestId: approvedRequest.requestId }
          : {})
      },
      createdAt: scmStartedAtIso
    });
    await persistTrackedRun({
      lastHeartbeatAt: scmStartedAtIso,
      metadata: {
        currentPhase: "scm",
        workspaceId,
        ...(approvedRequest
          ? { approvalRequestId: approvedRequest.requestId }
          : {})
      }
    });

    const bundle = createWorkspaceContextBundle({
      manifest: currentManifest,
      spec: snapshot.spec,
      policySnapshot: snapshot.policySnapshot
    });
    const workspace = await materializeManagedWorkspace({
      bundle,
      targetRoot: input.targetRoot,
      workspaceId,
      createdAt: scmStartedAtIso
    });
    currentManifest = taskManifestSchema.parse({
      ...currentManifest,
      workspaceId: workspace.workspaceId,
      updatedAt: scmStartedAtIso,
      evidenceLinks: [
        ...new Set([
          ...currentManifest.evidenceLinks,
          `${workspaceLocationPrefix}${workspace.workspaceId}`
        ])
      ]
    });
    await repository.updateManifest(currentManifest);
    await repository.saveEvidenceRecord(
      createEvidenceRecord({
        recordId: `${taskId}:workspace:${workspace.workspaceId}:scm:${runId}`,
        taskId,
        kind: "file_artifact",
        title: "Managed workspace prepared for SCM",
        location: `${workspaceLocationPrefix}${workspace.workspaceId}`,
        metadata: {
          status: workspace.descriptor.status,
          workspaceRoot: workspace.workspaceRoot,
          stateFile: workspace.stateFile,
          descriptor: workspace.descriptor,
          phase: "scm",
          runId
        },
        createdAt: scmStartedAtIso
      })
    );
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("scm", "WORKSPACE_PREPARED"),
      taskId,
      runId,
      phase: "scm",
      level: "info",
      code: "WORKSPACE_PREPARED",
      message: "SCM workspace prepared.",
      data: {
        workspaceId: workspace.workspaceId,
        toolPolicyMode: workspace.descriptor.toolPolicy.mode,
        codeWriteEnabled: workspace.descriptor.toolPolicy.codeWriteEnabled
      },
      createdAt: scmStartedAtIso
    });

    const draft = await scm.createPullRequest(bundle, {
      manifest: currentManifest,
      runId,
      workspace,
      baseBranch,
      validationSummary,
      validationReportPath
    });

    if (draft.branchName.trim().length === 0) {
      throw new Error(`SCM draft for ${taskId} did not provide a branch name.`);
    }

    if (draft.baseBranch.trim().length === 0) {
      throw new Error(`SCM draft for ${taskId} did not provide a base branch.`);
    }

    const branch = await github.createBranch(
      currentManifest.source.repo,
      draft.baseBranch,
      draft.branchName
    );
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("scm", "BRANCH_CREATED"),
      taskId,
      runId,
      phase: "scm",
      level: "info",
      code: "BRANCH_CREATED",
      message: `SCM branch ${branch.branchName} created.`,
      data: {
        workspaceId: workspace.workspaceId,
        baseBranch: branch.baseBranch,
        branchName: branch.branchName,
        branchUrl: branch.url,
        branchRef: branch.ref
      },
      createdAt: scmStartedAtIso
    });
    await persistTrackedRun({
      lastHeartbeatAt: scmStartedAtIso,
      metadata: {
        currentPhase: "scm",
        workspaceId: workspace.workspaceId,
        branchName: branch.branchName
      }
    });

    const pullRequest = await github.createPullRequest({
      repo: currentManifest.source.repo,
      baseBranch: draft.baseBranch,
      headBranch: draft.branchName,
      title: draft.pullRequestTitle,
      body: draft.pullRequestBody,
      labels: draft.labels,
      ...(currentManifest.source.issueNumber
        ? { issueNumber: currentManifest.source.issueNumber }
        : {})
    });
    const scmCompletedAt = clock();
    const scmCompletedAtIso = asIsoTimestamp(scmCompletedAt);
    const reportPath = join(workspace.artifactsDir, "scm-report.md");
    await writeFile(
      reportPath,
      renderScmReportMarkdown({
        bundle,
        draft,
        branch,
        pullRequest,
        workspace,
        runId,
        validationReportPath
      }),
      "utf8"
    );
    const diffPath = join(workspace.artifactsDir, "scm-diff.md");
    await writeFile(
      diffPath,
      renderScmDiffMarkdown({
        bundle,
        branch,
        pullRequest,
        validationSummary
      }),
      "utf8"
    );
    const reportSourceLocation = `${workspaceLocationPrefix}${workspace.workspaceId}/artifacts/scm-report.md`;
    const diffSourceLocation = `${workspaceLocationPrefix}${workspace.workspaceId}/artifacts/scm-diff.md`;
    const archivedScmReport = await archiveEvidenceArtifact({
      taskId,
      runId,
      phase: "scm",
      sourcePath: reportPath,
      targetRoot: input.targetRoot,
      evidenceRoot: input.evidenceRoot,
      fileName: "scm-report.md"
    });
    const archivedScmDiff = await archiveEvidenceArtifact({
      taskId,
      runId,
      phase: "scm",
      sourcePath: diffPath,
      targetRoot: input.targetRoot,
      evidenceRoot: input.evidenceRoot,
      fileName: "scm-diff.md"
    });
    currentManifest = taskManifestSchema.parse({
      ...currentManifest,
      currentPhase: "scm",
      lifecycleStatus: "completed",
      branchName: branch.branchName,
      prNumber: pullRequest.number,
      workspaceId: workspace.workspaceId,
      updatedAt: scmCompletedAtIso,
      evidenceLinks: [
        ...new Set([
          ...currentManifest.evidenceLinks,
          pullRequest.url,
          branch.url
        ])
      ]
    });
    await repository.updateManifest(currentManifest);
    await repository.saveMemoryRecord(
      createMemoryRecord({
        memoryId: `${taskId}:memory:task:scm`,
        taskId,
        scope: "task",
        provenance: "pipeline_derived",
        key: "scm.summary",
        title: "SCM summary",
        value: {
          summary: draft.summary,
          branch,
          pullRequest,
          runId,
          workspaceId: workspace.workspaceId,
          validationReportPath,
          reportPath,
          diffPath,
          reportArchiveLocation: archivedScmReport.location,
          diffArchiveLocation: archivedScmDiff.location
        },
        repo: currentManifest.source.repo,
        organizationId: deriveOrganizationId(currentManifest.source.repo),
        tags: ["scm", "task"],
        createdAt: scmCompletedAtIso,
        updatedAt: scmCompletedAtIso
      })
    );
    await repository.savePhaseRecord(
      createPhaseRecord({
        id: `${taskId}:phase:scm`,
        taskId,
        phase: "scm",
        status: "passed",
        actor: "scm",
        summary: "SCM phase created an approved branch and pull request.",
        details: {
          workspaceId: workspace.workspaceId,
          branch,
          pullRequest,
          reportPath,
          diffPath,
          validationReportPath,
          reportArchiveLocation: archivedScmReport.location,
          diffArchiveLocation: archivedScmDiff.location,
          ...(approvedRequest
            ? { approvalRequestId: approvedRequest.requestId }
            : {})
        },
        createdAt: scmCompletedAtIso
      })
    );
    await repository.saveEvidenceRecord(
      createEvidenceRecord({
        recordId: `${taskId}:scm:${runId}:report`,
        taskId,
        kind: "file_artifact",
        title: "SCM report",
        location: archivedScmReport.location,
        metadata: {
          runId,
          workspaceId: workspace.workspaceId,
          summary: draft.summary,
          branch,
          pullRequest,
          validationReportPath,
          reportPath,
          ...buildArchivedArtifactMetadata({
            archivedArtifact: archivedScmReport,
            artifactClass: "report",
            sourceLocation: reportSourceLocation,
            sourcePath: reportPath
          })
        },
        createdAt: scmCompletedAtIso
      })
    );
    await repository.saveEvidenceRecord(
      createEvidenceRecord({
        recordId: `${taskId}:scm:${runId}:diff`,
        taskId,
        kind: "file_artifact",
        title: "SCM diff summary",
        location: archivedScmDiff.location,
        metadata: {
          runId,
          workspaceId: workspace.workspaceId,
          branch,
          pullRequest,
          validationReportPath,
          diffPath,
          ...buildArchivedArtifactMetadata({
            archivedArtifact: archivedScmDiff,
            artifactClass: "diff",
            sourceLocation: diffSourceLocation,
            sourcePath: diffPath
          })
        },
        createdAt: scmCompletedAtIso
      })
    );
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("scm", "PULL_REQUEST_CREATED"),
      taskId,
      runId,
      phase: "scm",
      level: "info",
      code: "PULL_REQUEST_CREATED",
      message: `Pull request #${pullRequest.number} created for ${branch.branchName}.`,
      data: {
        workspaceId: workspace.workspaceId,
        branchName: branch.branchName,
        prNumber: pullRequest.number,
        pullRequestUrl: pullRequest.url,
        labels: draft.labels
      },
      createdAt: scmCompletedAtIso
    });
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("scm", "PHASE_PASSED"),
      taskId,
      runId,
      phase: "scm",
      level: "info",
      code: "PHASE_PASSED",
      message: "SCM branch and pull request created.",
      durationMs: getDurationMs(scmStartedAt, scmCompletedAt),
      data: {
        actor: "scm",
        workspaceId: workspace.workspaceId,
        branchName: branch.branchName,
        prNumber: pullRequest.number,
        reportPath,
        reportArchiveLocation: archivedScmReport.location,
        diffArchiveLocation: archivedScmDiff.location
      },
      createdAt: scmCompletedAtIso
    });
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("scm", "PIPELINE_COMPLETED"),
      taskId,
      runId,
      phase: "scm",
      level: "info",
      code: "PIPELINE_COMPLETED",
      message: "Task completed after SCM handoff.",
      durationMs: getDurationMs(runStartedAt, scmCompletedAt),
      data: {
        workspaceId: workspace.workspaceId,
        branchName: branch.branchName,
        prNumber: pullRequest.number,
        pullRequestUrl: pullRequest.url,
        reportArchiveLocation: archivedScmReport.location,
        diffArchiveLocation: archivedScmDiff.location
      },
      createdAt: scmCompletedAtIso
    });
    await persistTrackedRun({
      status: "completed",
      lastHeartbeatAt: scmCompletedAtIso,
      completedAt: scmCompletedAtIso,
      metadata: {
        currentPhase: "scm",
        workspaceId: workspace.workspaceId,
        branchName: branch.branchName,
        prNumber: pullRequest.number,
        pullRequestUrl: pullRequest.url,
        reportPath,
        reportArchiveLocation: archivedScmReport.location,
        diffArchiveLocation: archivedScmDiff.location
      }
    });

    return {
      runId,
      manifest: currentManifest,
      workspace,
      draft,
      branch,
      pullRequest,
      reportPath,
      nextAction: "complete",
      concurrencyDecision
    };
  } catch (error) {
    const pipelineFailure = normalizePipelineFailure(error, "scm", taskId, runId);
    const failedAt = clock();
    const failedAtIso = asIsoTimestamp(failedAt);
    currentManifest = taskManifestSchema.parse({
      ...currentManifest,
      currentPhase: "scm",
      lifecycleStatus: "failed",
      updatedAt: failedAtIso
    });

    try {
      await repository.savePhaseRecord(
        createPhaseRecord({
          id: `${taskId}:phase:scm`,
          taskId,
          phase: "scm",
          status: "failed",
          actor: "control-plane",
          summary: pipelineFailure.message,
          details: {
            code: pipelineFailure.code,
            failureClass: pipelineFailure.failureClass,
            ...pipelineFailure.details
          },
          createdAt: failedAtIso
        })
      );
      await repository.saveEvidenceRecord(
        createEvidenceRecord({
          recordId: `${taskId}:scm:failure:${runId}`,
          taskId,
          kind: "run_event",
          title: "SCM phase failure",
          metadata: {
            runId,
            code: pipelineFailure.code,
            failureClass: pipelineFailure.failureClass,
            details: pipelineFailure.details
          },
          createdAt: failedAtIso
        })
      );
      await recordRunEvent({
        repository,
        logger: runLogger,
        eventId: nextEventId("scm", "PHASE_FAILED"),
        taskId,
        runId,
        phase: "scm",
        level: "error",
        code: "PHASE_FAILED",
        message: pipelineFailure.message,
        failureClass: pipelineFailure.failureClass,
        data: {
          causeCode: pipelineFailure.code,
          details: pipelineFailure.details
        },
        createdAt: failedAtIso
      });
      await recordRunEvent({
        repository,
        logger: runLogger,
        eventId: nextEventId("scm", "PIPELINE_FAILED"),
        taskId,
        runId,
        phase: "scm",
        level: "error",
        code: "PIPELINE_FAILED",
        message: "SCM phase failed.",
        failureClass: pipelineFailure.failureClass,
        durationMs: getDurationMs(runStartedAt, failedAt),
        data: {
          causeCode: pipelineFailure.code,
          details: pipelineFailure.details
        },
        createdAt: failedAtIso
      });
      await repository.updateManifest(currentManifest);
      await persistTrackedRun({
        status: "failed",
        lastHeartbeatAt: failedAtIso,
        completedAt: failedAtIso,
        metadata: {
          currentPhase: "scm",
          failureCode: pipelineFailure.code,
          failureClass: pipelineFailure.failureClass
        }
      });
    } catch (persistenceError) {
      runLogger.error("Failed to persist SCM phase failure evidence.", {
        runId,
        taskId,
        failureClass: pipelineFailure.failureClass,
        code: pipelineFailure.code,
        persistenceError: serializeError(persistenceError)
      });
    }

    throw new PlanningPipelineFailure({
      message: pipelineFailure.message,
      failureClass: pipelineFailure.failureClass,
      phase: pipelineFailure.phase,
      code: pipelineFailure.code,
      details: pipelineFailure.details,
      cause: pipelineFailure,
      taskId,
      runId
    });
  }
}

function normalizePipelineFailure(
  error: unknown,
  phase: TaskPhase,
  taskId: string,
  runId: string
): PlanningPipelineFailure {
  if (error instanceof PlanningPipelineFailure) {
    return new PlanningPipelineFailure({
      message: error.message,
      failureClass: error.failureClass,
      phase: error.phase,
      code: error.code,
      details: error.details,
      cause: error,
      taskId: error.taskId ?? taskId,
      runId: error.runId ?? runId
    });
  }

  return new PlanningPipelineFailure({
    message:
      error instanceof Error
        ? error.message
        : `Unexpected failure while running ${phase}.`,
    failureClass: phaseFailureClassMap[phase],
    phase,
    code: phaseFailureCodeMap[phase],
    details: serializeError(error),
    cause: error,
    taskId,
    runId
  });
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof PlanningPipelineFailure) {
    return {
      name: error.name,
      message: error.message,
      code: error.code,
      phase: error.phase,
      failureClass: error.failureClass,
      taskId: error.taskId,
      runId: error.runId,
      details: error.details
    };
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null
    };
  }

  return {
    message: String(error)
  };
}

function getDurationMs(start: Date, end: Date): number {
  return Math.max(0, end.getTime() - start.getTime());
}

async function recordRunEvent(input: {
  repository: PlanningRepository;
  logger: PlanningPipelineLogger;
  eventId: string;
  taskId: string;
  runId: string;
  phase: TaskPhase;
  level: RunEvent["level"];
  code: string;
  message: string;
  failureClass?: FailureClass;
  durationMs?: number;
  data?: Record<string, unknown>;
  createdAt: string;
}): Promise<RunEvent> {
  const event = createRunEvent({
    eventId: input.eventId,
    taskId: input.taskId,
    runId: input.runId,
    phase: input.phase,
    level: input.level,
    code: input.code,
    message: input.message,
    ...(input.failureClass === undefined
      ? {}
      : { failureClass: input.failureClass }),
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    data: input.data ?? {},
    createdAt: input.createdAt
  });
  await input.repository.saveRunEvent(event);

  const context: Record<string, unknown> = {
    eventId: event.eventId,
    taskId: event.taskId,
    runId: event.runId,
    phase: event.phase,
    code: event.code,
    ...(event.failureClass === undefined
      ? {}
      : { failureClass: event.failureClass }),
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
    ...event.data
  };

  if (event.level === "info") {
    input.logger.info(event.message, context);
  } else if (event.level === "warn") {
    input.logger.warn(event.message, context);
  } else {
    input.logger.error(event.message, context);
  }

  return event;
}
