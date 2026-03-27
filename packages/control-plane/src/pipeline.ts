import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  asIsoTimestamp,
  concurrencyDecisionSchema,
  phaseRecordSchema,
  planningSpecSchema,
  planningTaskInputSchema,
  taskManifestSchema,
  workspaceContextBundleSchema,
  type ApprovalDecision,
  type ApprovalRequest,
  type Capability,
  type ConcurrencyDecision,
  type ConcurrencyStrategy,
  type DevelopmentAgent,
  type DevelopmentDraft,
  type FailureClass,
  type PhaseLifecycleStatus,
  type PhaseRecord,
  type PipelineRun,
  type PlanningAgent,
  type PlanningDraft,
  type PlanningSpec,
  type PlanningTaskInput,
  type PolicySnapshot,
  type RunEvent,
  type ScmAgent,
  type ScmDraft,
  type TaskManifest,
  type TaskPhase,
  type ValidationAgent,
  type ValidationCommand,
  type ValidationCommandResult,
  type ValidationDraft,
  type ValidationReport,
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
  type GitHubCreatedIssueSummary,
  type GitHubPullRequestSummary,
  type SecretLease,
  type SecretsAdapter
} from "@reddwarf/integrations";
import {
  agentDefinitions,
  assertPhaseExecutable,
  DeterministicDeveloperAgent,
  DeterministicPlanningAgent,
  DeterministicScmAgent,
  DeterministicValidationAgent
} from "@reddwarf/execution-plane";
export {
  DeterministicDeveloperAgent,
  DeterministicPlanningAgent,
  DeterministicScmAgent,
  DeterministicValidationAgent
};
import {
  assessEligibility,
  buildPolicySnapshot,
  classifyRisk,
  getPolicyVersion,
  resolveApprovalMode
} from "@reddwarf/policy";
import {
  assertTaskLifecycleTransition,
  assertPhaseLifecycleTransition
} from "./lifecycle.js";
import {
  type PlanningPipelineLogger,
  defaultLogger,
  bindPlanningLogger
} from "./logger.js";
import {
  type MaterializedManagedWorkspace,
  type ArchivedArtifactClass,
  type ArchivedEvidenceArtifact,
  workspaceLocationPrefix,
  evidenceLocationPrefix,
  archiveEvidenceArtifact,
  buildArchivedArtifactMetadata,
  createWorkspaceContextBundle,
  createWorkspaceContextBundleFromSnapshot,
  materializeManagedWorkspace,
  provisionTaskWorkspace,
  destroyTaskWorkspace,
  resolveEvidenceRoot,
  formatLiteralList,
  createWorkspaceCredentialPolicy,
  createWorkspaceToolPolicy
} from "./workspace.js";
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

const failureAutomationRequestedBy = "failure-automation";
const failureRecoveryMemoryKey = "failure.recovery";
const followUpIssueMemoryPrefix = "failure.follow_up_issue";
const failureRecoveryPolicies = {
  development: {
    retryLimit: 1,
    retryableFailureClasses: ["integration_failure"] as FailureClass[]
  },
  validation: {
    retryLimit: 1,
    retryableFailureClasses: ["validation_failure", "integration_failure"] as FailureClass[]
  },
  scm: {
    retryLimit: 0,
    retryableFailureClasses: [] as FailureClass[]
  }
} as const;

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
  github?: GitHubAdapter;
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
  github?: GitHubAdapter;
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

  const { staleRunIds, blockedByRun } = await detectOverlappingRuns({
    repository,
    concurrencyKey,
    runId,
    runStartedAt,
    runStartedAtIso,
    staleAfterMs: concurrency.staleAfterMs,
    strategy: concurrency.strategy
  });

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
        createdAt: asIsoTimestamp(archiveStartedAt)
      })
    );
    const archiveCompletedAt = clock();
    const archiveCompletedAtIso = asIsoTimestamp(archiveCompletedAt);
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
  const { logger, clock, idGenerator, concurrency } = resolvePhaseDependencies(dependencies);
  const rawSnapshot = await repository.getTaskSnapshot(taskId);
  const { snapshot, manifest: validatedManifest, spec: validatedSpec, policySnapshot: validatedPolicySnapshot } = requirePhaseSnapshot(rawSnapshot, taskId);
  const approvedRequest = requireApprovedRequest(snapshot, validatedManifest, "development");
  requireNoFailureEscalation(snapshot, taskId, "development");

  const lifecycleAllowsDevelopment =
    validatedManifest.lifecycleStatus === "ready" ||
    validatedManifest.lifecycleStatus === "active" ||
    (validatedManifest.lifecycleStatus === "blocked" &&
      validatedManifest.currentPhase === "development");

  if (!lifecycleAllowsDevelopment) {
    throw new Error(
      `Task ${taskId} is ${validatedManifest.lifecycleStatus} in phase ${validatedManifest.currentPhase} and cannot enter development.`
    );
  }

  assertPhaseExecutable("development");

  const runId = idGenerator();
  const runStartedAt = clock();
  const runStartedAtIso = asIsoTimestamp(runStartedAt);
  const concurrencyKey = createSourceConcurrencyKey(validatedManifest.source);
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

  const { staleRunIds, blockedByRun } = await detectOverlappingRuns({
    repository,
    concurrencyKey,
    runId,
    runStartedAt,
    runStartedAtIso,
    staleAfterMs: concurrency.staleAfterMs,
    strategy: concurrency.strategy
  });

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
      spec: validatedSpec,
      policySnapshot: validatedPolicySnapshot
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
          id: `${taskId}:phase:development:${runId}:failed`,
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
      currentManifest = (
        await handleAutomatedPhaseFailure({
          repository,
          snapshot,
          manifest: currentManifest,
          phase: "development",
          runId,
          failure: pipelineFailure,
          runLogger,
          nextEventId,
          runStartedAt,
          failedAt,
          failedAtIso,
          persistTrackedRun,
          github: dependencies.github
        })
      ).manifest;
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
  const { logger, clock, idGenerator, concurrency } = resolvePhaseDependencies(dependencies);
  const rawSnapshot = await repository.getTaskSnapshot(taskId);
  const { snapshot, manifest: validatedManifest, spec: validatedSpec, policySnapshot: validatedPolicySnapshot } = requirePhaseSnapshot(rawSnapshot, taskId);
  const approvedRequest = requireApprovedRequest(snapshot, validatedManifest, "validation");
  requireNoFailureEscalation(snapshot, taskId, "validation");

  const lifecycleAllowsValidation =
    (validatedManifest.lifecycleStatus === "blocked" &&
      ["development", "validation"].includes(validatedManifest.currentPhase)) ||
    (validatedManifest.lifecycleStatus === "active" &&
      validatedManifest.currentPhase === "validation");

  if (!lifecycleAllowsValidation) {
    throw new Error(
      `Task ${taskId} is ${validatedManifest.lifecycleStatus} in phase ${validatedManifest.currentPhase} and cannot enter validation.`
    );
  }

  if (
    input.workspaceId &&
    validatedManifest.workspaceId &&
    input.workspaceId !== validatedManifest.workspaceId
  ) {
    throw new Error(
      `Validation must reuse workspace ${validatedManifest.workspaceId}; received ${input.workspaceId}.`
    );
  }

  const workspaceId = validatedManifest.workspaceId ?? input.workspaceId;

  if (!workspaceId) {
    throw new Error(
      `Task ${taskId} requires a managed workspace from the developer phase before validation can start.`
    );
  }

  assertPhaseExecutable("validation");

  const runId = idGenerator();
  const runStartedAt = clock();
  const runStartedAtIso = asIsoTimestamp(runStartedAt);
  const concurrencyKey = createSourceConcurrencyKey(validatedManifest.source);
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

  const { staleRunIds, blockedByRun } = await detectOverlappingRuns({
    repository,
    concurrencyKey,
    runId,
    runStartedAt,
    runStartedAtIso,
    staleAfterMs: concurrency.staleAfterMs,
    strategy: concurrency.strategy
  });

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
      spec: validatedSpec,
      policySnapshot: validatedPolicySnapshot
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
          id: `${taskId}:phase:validation:${runId}:failed`,
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
      currentManifest = (
        await handleAutomatedPhaseFailure({
          repository,
          snapshot,
          manifest: currentManifest,
          phase: "validation",
          runId,
          failure: pipelineFailure,
          runLogger,
          nextEventId,
          runStartedAt,
          failedAt,
          failedAtIso,
          persistTrackedRun,
          github: dependencies.github
        })
      ).manifest;
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

// ── Shared phase pre-flight helpers ──────────────────────────────────────────

interface ValidatedPhaseSnapshot {
  snapshot: PersistedTaskSnapshot;
  manifest: TaskManifest;
  spec: PlanningSpec;
  policySnapshot: PolicySnapshot;
}

function requirePhaseSnapshot(
  snapshot: PersistedTaskSnapshot,
  taskId: string
): ValidatedPhaseSnapshot {
  if (!snapshot.manifest) {
    throw new Error(`Task manifest ${taskId} was not found.`);
  }
  if (!snapshot.spec) {
    throw new Error(`Planning spec for ${taskId} was not found.`);
  }
  if (!snapshot.policySnapshot) {
    throw new Error(`Policy snapshot for ${taskId} was not found.`);
  }
  return {
    snapshot,
    manifest: snapshot.manifest,
    spec: snapshot.spec,
    policySnapshot: snapshot.policySnapshot
  };
}

function requireApprovedRequest(
  snapshot: PersistedTaskSnapshot,
  manifest: TaskManifest,
  phase: TaskPhase
): ApprovalRequest | null {
  if (manifest.approvalMode === "auto") {
    return null;
  }
  const approvedRequest =
    snapshot.approvalRequests.find(
      (request) => request.status === "approved"
    ) ?? null;

  if (!approvedRequest) {
    throw new Error(
      `Task ${manifest.taskId} requires an approved request before the ${phase} phase can start.`
    );
  }
  return approvedRequest;
}

function requireNoFailureEscalation(
  snapshot: PersistedTaskSnapshot,
  taskId: string,
  phase: RecoverablePhase
): void {
  const pendingFailureEscalation = findPendingFailureEscalationRequest(
    snapshot,
    phase
  );
  if (pendingFailureEscalation) {
    throw new Error(
      `Task ${taskId} has a pending failure escalation request ${pendingFailureEscalation.requestId} before the ${phase} phase can restart.`
    );
  }
}

interface ResolvedPhaseDependencies {
  logger: PlanningPipelineLogger;
  clock: () => Date;
  idGenerator: () => string;
  concurrency: Required<PlanningConcurrencyOptions>;
}

function resolvePhaseDependencies(dependencies: {
  logger?: PlanningPipelineLogger;
  clock?: () => Date;
  idGenerator?: () => string;
  concurrency?: PlanningConcurrencyOptions;
}): ResolvedPhaseDependencies {
  return {
    logger: dependencies.logger ?? defaultLogger,
    clock: dependencies.clock ?? (() => new Date()),
    idGenerator: dependencies.idGenerator ?? (() => randomUUID()),
    concurrency: {
      strategy: dependencies.concurrency?.strategy ?? "serialize",
      staleAfterMs: dependencies.concurrency?.staleAfterMs ?? 5 * 60_000
    }
  };
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

async function detectOverlappingRuns(input: {
  repository: PlanningRepository;
  concurrencyKey: string;
  runId: string;
  runStartedAt: Date;
  runStartedAtIso: string;
  staleAfterMs: number;
  strategy: ConcurrencyStrategy;
}): Promise<{ staleRunIds: string[]; blockedByRun: PipelineRun | null }> {
  const {
    repository,
    concurrencyKey,
    runId,
    runStartedAt,
    runStartedAtIso,
    staleAfterMs
  } = input;

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

    if (isPipelineRunStale(overlap, runStartedAt, staleAfterMs)) {
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

  return { staleRunIds, blockedByRun };
}

function createTaskId(input: PlanningTaskInput, runId: string): string {
  const sourceIssue = input.source.issueNumber ?? input.source.issueId ?? runId;
  const repo = input.source.repo.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  return `${repo}-${sourceIssue}`;
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
  const { logger, clock, idGenerator, concurrency } = resolvePhaseDependencies(dependencies);
  const rawSnapshot = await repository.getTaskSnapshot(taskId);
  const { snapshot, manifest: validatedManifest, spec: validatedSpec, policySnapshot: validatedPolicySnapshot } = requirePhaseSnapshot(rawSnapshot, taskId);

  if (!taskRequestsPullRequest(validatedManifest)) {
    throw new Error(
      `Task ${taskId} did not request can_open_pr and cannot enter SCM.`
    );
  }

  const approvedRequest = requireApprovedRequest(snapshot, validatedManifest, "scm");
  requireNoFailureEscalation(snapshot, taskId, "scm");

  const lifecycleAllowsScm =
    (validatedManifest.lifecycleStatus === "blocked" &&
      ["validation", "scm"].includes(validatedManifest.currentPhase)) ||
    (validatedManifest.lifecycleStatus === "active" &&
      validatedManifest.currentPhase === "scm");

  if (!lifecycleAllowsScm) {
    throw new Error(
      `Task ${taskId} is ${validatedManifest.lifecycleStatus} in phase ${validatedManifest.currentPhase} and cannot enter SCM.`
    );
  }

  if (
    input.workspaceId &&
    validatedManifest.workspaceId &&
    input.workspaceId !== validatedManifest.workspaceId
  ) {
    throw new Error(
      `SCM must reuse workspace ${validatedManifest.workspaceId}; received ${input.workspaceId}.`
    );
  }

  const workspaceId = validatedManifest.workspaceId ?? input.workspaceId;

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
  const concurrencyKey = createSourceConcurrencyKey(validatedManifest.source);
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

  const { staleRunIds, blockedByRun } = await detectOverlappingRuns({
    repository,
    concurrencyKey,
    runId,
    runStartedAt,
    runStartedAtIso,
    staleAfterMs: concurrency.staleAfterMs,
    strategy: concurrency.strategy
  });

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
      spec: validatedSpec,
      policySnapshot: validatedPolicySnapshot
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
          id: `${taskId}:phase:scm:${runId}:failed`,
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
      currentManifest = (
        await handleAutomatedPhaseFailure({
          repository,
          snapshot,
          manifest: currentManifest,
          phase: "scm",
          runId,
          failure: pipelineFailure,
          runLogger,
          nextEventId,
          runStartedAt,
          failedAt,
          failedAtIso,
          persistTrackedRun,
          github: github
        })
      ).manifest;
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


type RecoverablePhase = "development" | "validation" | "scm";

interface AutomatedFailureRecoveryResult {
  manifest: TaskManifest;
  recoveryAction: "retry" | "escalate";
  approvalRequest: ApprovalRequest | null;
  followUpIssue: GitHubCreatedIssueSummary | null;
}

function isRecoverablePhase(phase: TaskPhase): phase is RecoverablePhase {
  return phase === "development" || phase === "validation" || phase === "scm";
}

function formatPhaseLabel(phase: RecoverablePhase): string {
  switch (phase) {
    case "development":
      return "Development";
    case "validation":
      return "Validation";
    case "scm":
      return "SCM";
  }
}

function findPendingFailureEscalationRequest(
  snapshot: PersistedTaskSnapshot,
  phase: RecoverablePhase
): ApprovalRequest | null {
  return (
    snapshot.approvalRequests.find(
      (request) =>
        request.phase === phase &&
        request.status === "pending" &&
        request.requestedBy === failureAutomationRequestedBy
    ) ?? null
  );
}

function findExistingFollowUpIssue(
  snapshot: PersistedTaskSnapshot,
  phase: RecoverablePhase
): GitHubCreatedIssueSummary | null {
  const record = snapshot.memoryRecords.find(
    (entry) => entry.key === `${followUpIssueMemoryPrefix}.${phase}`
  );
  const value = record?.value;

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const objectValue = value as Record<string, unknown>;
  const issueNumber = objectValue.issueNumber;
  const url = objectValue.url;
  const title = objectValue.title;
  const createdAt = objectValue.createdAt;

  if (
    typeof issueNumber !== "number" ||
    typeof url !== "string" ||
    typeof title !== "string" ||
    typeof createdAt !== "string"
  ) {
    return null;
  }

  return {
    repo: snapshot.manifest?.source.repo ?? record?.repo ?? "",
    issueNumber,
    url,
    state: "open",
    title,
    createdAt
  };
}

function buildFailureEscalationSummary(input: {
  manifest: TaskManifest;
  phase: RecoverablePhase;
  failure: PlanningPipelineFailure;
  retryLimit: number;
}): string {
  const sourceIssue =
    input.manifest.source.issueNumber ?? input.manifest.source.issueId;
  const sourceLabel =
    sourceIssue === undefined
      ? input.manifest.source.repo
      : `${input.manifest.source.repo}#${sourceIssue}`;

  return `${formatPhaseLabel(input.phase)} failed for ${sourceLabel}. Code ${input.failure.code} (${input.failure.failureClass}). Retry limit ${input.retryLimit} reached or recovery is not retryable.`;
}

function buildFollowUpIssueBody(input: {
  manifest: TaskManifest;
  phase: RecoverablePhase;
  runId: string;
  failure: PlanningPipelineFailure;
  approvalRequest: ApprovalRequest;
  retryLimit: number;
}): string {
  return [
    `Source task: ${input.manifest.title}`,
    `Task ID: ${input.manifest.taskId}`,
    `Source repo: ${input.manifest.source.repo}`,
    `Source issue: ${input.manifest.source.issueUrl ?? "n/a"}`,
    `Failed phase: ${input.phase}`,
    `Run ID: ${input.runId}`,
    `Failure code: ${input.failure.code}`,
    `Failure class: ${input.failure.failureClass}`,
    `Retry count: ${input.manifest.retryCount}`,
    `Retry limit: ${input.retryLimit}`,
    `Escalation request: ${input.approvalRequest.requestId}`,
    "",
    "Summary:",
    input.failure.message
  ].join("\n");
}

async function handleAutomatedPhaseFailure(input: {
  repository: PlanningRepository;
  snapshot: PersistedTaskSnapshot;
  manifest: TaskManifest;
  phase: RecoverablePhase;
  runId: string;
  failure: PlanningPipelineFailure;
  runLogger: PlanningPipelineLogger;
  nextEventId: (phase: TaskPhase, code: string) => string;
  runStartedAt: Date;
  failedAt: Date;
  failedAtIso: string;
  persistTrackedRun: (
    patch: Partial<PipelineRun> & { metadata?: Record<string, unknown> }
  ) => Promise<void>;
  github: GitHubAdapter | undefined;
}): Promise<AutomatedFailureRecoveryResult> {
  const { repository, snapshot, manifest, phase, runId, failure } = input;
  const policy = failureRecoveryPolicies[phase];
  const retryEligible =
    policy.retryableFailureClasses.includes(failure.failureClass) &&
    manifest.retryCount < policy.retryLimit;
  const organizationId = deriveOrganizationId(manifest.source.repo);

  if (retryEligible) {
    const retryCount = manifest.retryCount + 1;
    const nextManifest = taskManifestSchema.parse({
      ...manifest,
      currentPhase: phase,
      lifecycleStatus: "blocked",
      retryCount,
      updatedAt: input.failedAtIso
    });
    const recoveryMetadata = {
      phase,
      action: "retry",
      runId,
      failureCode: failure.code,
      failureClass: failure.failureClass,
      retryCount,
      retryLimit: policy.retryLimit
    };

    await repository.saveMemoryRecord(
      createMemoryRecord({
        memoryId: `${manifest.taskId}:memory:task:failure-recovery`,
        taskId: manifest.taskId,
        scope: "task",
        provenance: "pipeline_derived",
        key: failureRecoveryMemoryKey,
        title: "Automated failure recovery plan",
        value: recoveryMetadata,
        repo: manifest.source.repo,
        organizationId,
        tags: ["failure", "recovery", phase],
        createdAt: input.failedAtIso,
        updatedAt: input.failedAtIso
      })
    );
    await repository.saveEvidenceRecord(
      createEvidenceRecord({
        recordId: `${manifest.taskId}:recovery:${phase}:${runId}`,
        taskId: manifest.taskId,
        kind: "gate_decision",
        title: "Failure recovery decision",
        metadata: recoveryMetadata,
        createdAt: input.failedAtIso
      })
    );
    await recordRunEvent({
      repository,
      logger: input.runLogger,
      eventId: input.nextEventId(phase, "PHASE_RETRY_SCHEDULED"),
      taskId: manifest.taskId,
      runId,
      phase,
      level: "warn",
      code: "PHASE_RETRY_SCHEDULED",
      message: `${formatPhaseLabel(phase)} failure was classified as retryable and queued for another attempt.`,
      failureClass: failure.failureClass,
      data: recoveryMetadata,
      createdAt: input.failedAtIso
    });
    await recordRunEvent({
      repository,
      logger: input.runLogger,
      eventId: input.nextEventId(phase, "PIPELINE_BLOCKED"),
      taskId: manifest.taskId,
      runId,
      phase,
      level: "warn",
      code: "PIPELINE_BLOCKED",
      message: `${formatPhaseLabel(phase)} phase blocked pending a retry attempt.`,
      failureClass: failure.failureClass,
      durationMs: getDurationMs(input.runStartedAt, input.failedAt),
      data: recoveryMetadata,
      createdAt: input.failedAtIso
    });
    await repository.updateManifest(nextManifest);
    await input.persistTrackedRun({
      status: "blocked",
      lastHeartbeatAt: input.failedAtIso,
      completedAt: input.failedAtIso,
      metadata: {
        currentPhase: phase,
        failureCode: failure.code,
        failureClass: failure.failureClass,
        recoveryAction: "retry",
        retryCount,
        retryLimit: policy.retryLimit
      }
    });

    return {
      manifest: nextManifest,
      recoveryAction: "retry",
      approvalRequest: null,
      followUpIssue: null
    };
  }

  let approvalRequest = findPendingFailureEscalationRequest(snapshot, phase);

  if (!approvalRequest) {
    approvalRequest = createApprovalRequest({
      requestId: `${manifest.taskId}:approval:${phase}:failure:${runId}`,
      taskId: manifest.taskId,
      runId,
      phase,
      approvalMode: "human_signoff_required",
      status: "pending",
      riskClass: manifest.riskClass,
      summary: buildFailureEscalationSummary({
        manifest,
        phase,
        failure,
        retryLimit: policy.retryLimit
      }),
      requestedCapabilities: manifest.requestedCapabilities,
      allowedPaths: snapshot.policySnapshot?.allowedPaths ?? [],
      blockedPhases: [phase],
      policyReasons: [
        `${formatPhaseLabel(phase)} failed with ${failure.failureClass}.`,
        "Human review is required before retrying the phase."
      ],
      requestedBy: failureAutomationRequestedBy,
      createdAt: input.failedAtIso,
      updatedAt: input.failedAtIso
    });
    await repository.saveApprovalRequest(approvalRequest);
  }

  let followUpIssue = findExistingFollowUpIssue(snapshot, phase);

  if (
    followUpIssue === null &&
    input.github &&
    manifest.source.issueNumber !== undefined
  ) {
    try {
      followUpIssue = await input.github.createIssue({
        repo: manifest.source.repo,
        title: `Follow-up: ${formatPhaseLabel(phase)} failure for ${manifest.title}`,
        body: buildFollowUpIssueBody({
          manifest,
          phase,
          runId,
          failure,
          approvalRequest,
          retryLimit: policy.retryLimit
        }),
        labels: ["reddwarf", "follow-up", phase]
      });
      await repository.saveMemoryRecord(
        createMemoryRecord({
          memoryId: `${manifest.taskId}:memory:task:follow-up-issue:${phase}`,
          taskId: manifest.taskId,
          scope: "task",
          provenance: "pipeline_derived",
          key: `${followUpIssueMemoryPrefix}.${phase}`,
          title: "Follow-up issue created for failed phase",
          value: followUpIssue,
          repo: manifest.source.repo,
          organizationId,
          tags: ["failure", "follow-up", phase],
          createdAt: input.failedAtIso,
          updatedAt: input.failedAtIso
        })
      );
      await recordRunEvent({
        repository,
        logger: input.runLogger,
        eventId: input.nextEventId(phase, "FOLLOW_UP_ISSUE_CREATED"),
        taskId: manifest.taskId,
        runId,
        phase,
        level: "info",
        code: "FOLLOW_UP_ISSUE_CREATED",
        message: `Created a follow-up issue for the ${phase} failure.`,
        data: {
          followUpIssueNumber: followUpIssue.issueNumber,
          followUpIssueUrl: followUpIssue.url
        },
        createdAt: input.failedAtIso
      });
    } catch (error) {
      await recordRunEvent({
        repository,
        logger: input.runLogger,
        eventId: input.nextEventId(phase, "FOLLOW_UP_ISSUE_SKIPPED"),
        taskId: manifest.taskId,
        runId,
        phase,
        level: "warn",
        code: "FOLLOW_UP_ISSUE_SKIPPED",
        failureClass: failure.failureClass,
        message: `Failed to create a follow-up issue for the ${phase} failure.`,
        data: {
          error: serializeError(error)
        },
        createdAt: input.failedAtIso
      });
    }
  }

  const nextManifest = taskManifestSchema.parse({
    ...manifest,
    currentPhase: phase,
    lifecycleStatus: "blocked",
    updatedAt: input.failedAtIso
  });
  const recoveryMetadata = {
    phase,
    action: "escalate",
    runId,
    failureCode: failure.code,
    failureClass: failure.failureClass,
    retryCount: manifest.retryCount,
    retryLimit: policy.retryLimit,
    approvalRequestId: approvalRequest.requestId,
    ...(followUpIssue
      ? {
          followUpIssueNumber: followUpIssue.issueNumber,
          followUpIssueUrl: followUpIssue.url
        }
      : {})
  };

  await repository.savePhaseRecord(
    createPhaseRecord({
      id: `${manifest.taskId}:phase:${phase}:escalated:${runId}`,
      taskId: manifest.taskId,
      phase,
      status: "escalated",
      actor: "control-plane",
      summary: `${formatPhaseLabel(phase)} failure escalated for human review.`,
      details: recoveryMetadata,
      createdAt: input.failedAtIso
    })
  );
  await repository.saveMemoryRecord(
    createMemoryRecord({
      memoryId: `${manifest.taskId}:memory:task:failure-recovery`,
      taskId: manifest.taskId,
      scope: "task",
      provenance: "pipeline_derived",
      key: failureRecoveryMemoryKey,
      title: "Automated failure recovery plan",
      value: recoveryMetadata,
      repo: manifest.source.repo,
      organizationId,
      tags: ["failure", "recovery", phase],
      createdAt: input.failedAtIso,
      updatedAt: input.failedAtIso
    })
  );
  await repository.saveEvidenceRecord(
    createEvidenceRecord({
      recordId: `${manifest.taskId}:recovery:${phase}:${runId}`,
      taskId: manifest.taskId,
      kind: "gate_decision",
      title: "Failure recovery decision",
      metadata: recoveryMetadata,
      createdAt: input.failedAtIso
    })
  );
  await recordRunEvent({
    repository,
    logger: input.runLogger,
    eventId: input.nextEventId(phase, "PHASE_ESCALATED"),
    taskId: manifest.taskId,
    runId,
    phase,
    level: "warn",
    code: "PHASE_ESCALATED",
    message: `${formatPhaseLabel(phase)} failure escalated for human review.`,
    failureClass: failure.failureClass,
    data: recoveryMetadata,
    createdAt: input.failedAtIso
  });
  await recordRunEvent({
    repository,
    logger: input.runLogger,
    eventId: input.nextEventId(phase, "PIPELINE_BLOCKED"),
    taskId: manifest.taskId,
    runId,
    phase,
    level: "warn",
    code: "PIPELINE_BLOCKED",
    message: `${formatPhaseLabel(phase)} phase blocked pending operator review.`,
    failureClass: failure.failureClass,
    durationMs: getDurationMs(input.runStartedAt, input.failedAt),
    data: recoveryMetadata,
    createdAt: input.failedAtIso
  });
  await repository.updateManifest(nextManifest);
  await input.persistTrackedRun({
    status: "blocked",
    lastHeartbeatAt: input.failedAtIso,
    completedAt: input.failedAtIso,
    metadata: {
      currentPhase: phase,
      failureCode: failure.code,
      failureClass: failure.failureClass,
      recoveryAction: "escalate",
      retryCount: manifest.retryCount,
      retryLimit: policy.retryLimit,
      approvalRequestId: approvalRequest.requestId,
      ...(followUpIssue
        ? { followUpIssueNumber: followUpIssue.issueNumber }
        : {})
    }
  });

  return {
    manifest: nextManifest,
    recoveryAction: "escalate",
    approvalRequest,
    followUpIssue
  };
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
