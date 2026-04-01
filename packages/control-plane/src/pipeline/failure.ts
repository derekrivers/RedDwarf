import {
  asIsoTimestamp,
  type ApprovalRequest,
  type PipelineRun,
  type TaskManifest,
  type TaskPhase
} from "@reddwarf/contracts";
import {
  createApprovalRequest,
  createEvidenceRecord,
  createMemoryRecord,
  deriveOrganizationId,
  type PersistedTaskSnapshot,
  type PlanningRepository
} from "@reddwarf/evidence";
import {
  type GitHubAdapter,
  type GitHubCreatedIssueSummary
} from "@reddwarf/integrations";
import {
  AllowedPathViolationError,
  ExternalCommandTimeoutError,
  OpenClawCompletionTimeoutError
} from "../live-workflow.js";
import { type PlanningPipelineLogger } from "../logger.js";
import {
  EventCodes,
  failureAutomationRequestedBy,
  failureRecoveryMemoryKey,
  PlanningPipelineFailure,
  phaseRegistry,
  type AutomatedFailureRecoveryResult,
  type ConcurrencyBlockedContext,
  type PhaseFailureContext,
  type RecoverablePhase
} from "./types.js";
import {
  createConcurrencyDecision,
  createPhaseRecord,
  getDurationMs,
  patchManifest,
  recordRunEvent,
  sanitizeSerializedErrorDetails,
  serializeError,
  findPendingFailureEscalationRequest
} from "./shared.js";
import {
  getPhaseRetryBudgetMemoryKey,
  readPhaseRetryBudgetState,
  resolvePhaseRetryLimit
} from "./retry-budget.js";

import { sanitizeSecretBearingText } from "../live-workflow.js";

// ── Error mapper registry ─────────────────────────────────────────────────────

interface PipelineErrorMapper {
  test(error: unknown): boolean;
  map(
    error: unknown,
    phase: TaskPhase,
    taskId: string,
    runId: string
  ): PlanningPipelineFailure;
}

const pipelineErrorMappers: PipelineErrorMapper[] = [
  {
    test: (e): e is PlanningPipelineFailure => e instanceof PlanningPipelineFailure,
    map: (e, _phase, taskId, runId) => {
      const err = e as PlanningPipelineFailure;
      return new PlanningPipelineFailure({
        message: sanitizeSecretBearingTextLocal(err.message),
        failureClass: err.failureClass,
        phase: err.phase,
        code: err.code,
        details: sanitizeSerializedErrorDetails(err.details),
        cause: err,
        taskId: err.taskId ?? taskId,
        runId: err.runId ?? runId
      });
    }
  },
  {
    test: (e): e is OpenClawCompletionTimeoutError => e instanceof OpenClawCompletionTimeoutError,
    map: (e, phase, taskId, runId) => {
      const err = e as OpenClawCompletionTimeoutError;
      return new PlanningPipelineFailure({
        message: sanitizeSecretBearingTextLocal(err.message),
        failureClass: phaseRegistry[phase].failureClass,
        phase,
        code: EventCodes.OPENCLAW_COMPLETION_TIMED_OUT,
        details: {
          sessionKey: err.sessionKey,
          timeoutMs: err.timeoutMs
        },
        cause: err,
        taskId,
        runId
      });
    }
  },
  {
    test: (e): e is ExternalCommandTimeoutError => e instanceof ExternalCommandTimeoutError,
    map: (e, phase, taskId, runId) => {
      const err = e as ExternalCommandTimeoutError;
      return new PlanningPipelineFailure({
        message: sanitizeSecretBearingTextLocal(err.message),
        failureClass: phaseRegistry[phase].failureClass,
        phase,
        code: EventCodes.GIT_COMMAND_TIMED_OUT,
        details: {
          executable: err.executable,
          args: err.args,
          cwd: err.cwd,
          timeoutMs: err.timeoutMs,
          stdout: sanitizeSecretBearingTextLocal(err.stdout),
          stderr: sanitizeSecretBearingTextLocal(err.stderr)
        },
        cause: err,
        taskId,
        runId
      });
    }
  },
  {
    test: (e): e is AllowedPathViolationError => e instanceof AllowedPathViolationError,
    map: (e, phase, taskId, runId) => {
      const err = e as AllowedPathViolationError;
      return new PlanningPipelineFailure({
        message: sanitizeSecretBearingTextLocal(err.message),
        failureClass: "policy_violation",
        phase,
        code: EventCodes.ALLOWED_PATHS_VIOLATED,
        details: {
          allowedPaths: err.allowedPaths,
          changedFiles: err.changedFiles,
          violatingFiles: err.violatingFiles
        },
        cause: err,
        taskId,
        runId
      });
    }
  }
];

// ── Normalization ─────────────────────────────────────────────────────────────

export function normalizePipelineFailure(
  error: unknown,
  phase: TaskPhase,
  taskId: string,
  runId: string
): PlanningPipelineFailure {
  const mapper = pipelineErrorMappers.find((m) => m.test(error));
  if (mapper) {
    return mapper.map(error, phase, taskId, runId);
  }

  return new PlanningPipelineFailure({
    message:
      error instanceof Error
        ? sanitizeSecretBearingTextLocal(error.message)
        : `Unexpected failure while running ${phase}.`,
    failureClass: phaseRegistry[phase].failureClass,
    phase,
    code: phaseRegistry[phase].failureCode,
    details: serializeError(error),
    cause: error,
    taskId,
    runId
  });
}

function sanitizeSecretBearingTextLocal(text: string): string {
  return sanitizeSecretBearingText(text);
}

export function formatDispatchError(error: unknown): string {
  return sanitizeSecretBearingTextLocal(
    error instanceof Error ? error.message : String(error)
  );
}

// ── Phase failure helpers ─────────────────────────────────────────────────────

export function findExistingFollowUpIssue(
  snapshot: PersistedTaskSnapshot,
  phase: RecoverablePhase
): GitHubCreatedIssueSummary | null {
  const record = snapshot.memoryRecords.find(
    (entry) => entry.key === `failure.follow_up_issue.${phase}`
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

function formatPhaseLabel(phase: RecoverablePhase): string {
  switch (phase) {
    case "development":
      return "Development";
    case "architecture_review":
      return "Architecture review";
    case "validation":
      return "Validation";
    case "scm":
      return "SCM";
  }
}

function buildFailureEscalationSummary(input: {
  manifest: TaskManifest;
  phase: RecoverablePhase;
  failure: PlanningPipelineFailure;
  attempts: number;
  retryLimit: number;
}): string {
  const sourceIssue =
    input.manifest.source.issueNumber ?? input.manifest.source.issueId;
  const sourceLabel =
    sourceIssue === undefined
      ? input.manifest.source.repo
      : `${input.manifest.source.repo}#${sourceIssue}`;

  return `${formatPhaseLabel(input.phase)} failed for ${sourceLabel}. Code ${input.failure.code} (${input.failure.failureClass}). Attempts ${input.attempts}. Retry budget ${input.retryLimit} exhausted or recovery is not retryable.`;
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

export async function handleAutomatedPhaseFailure(input: {
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
    patch: Partial<PipelineRun> & { metadata?: Record<string, unknown> },
    runRepository?: { savePipelineRun(run: PipelineRun): Promise<void> }
  ) => Promise<void>;
  github: GitHubAdapter | undefined;
}): Promise<AutomatedFailureRecoveryResult> {
  const { repository, snapshot, manifest, phase, runId, failure } = input;
  const policy = phaseRegistry[phase].recovery;
  const retryLimit = resolvePhaseRetryLimit(phase);
  const priorRetryState = readPhaseRetryBudgetState(snapshot, phase);
  const nextAttempt = (priorRetryState?.attempts ?? 0) + 1;
  const retryEligible =
    policy.retryableFailureClasses.includes(failure.failureClass) &&
    nextAttempt <= retryLimit;
  const retryExhausted = !retryEligible;
  const organizationId = deriveOrganizationId(manifest.source.repo);
  const failedPhaseDetails = {
    attemptNumber: nextAttempt,
    retryLimit,
    retryExhausted,
    retryReason: failure.message,
    code: failure.code,
    failureClass: failure.failureClass,
    ...failure.details
  };
  const retryBudgetState = {
    phase,
    attempts: nextAttempt,
    retryLimit,
    retryExhausted,
    lastError: failure.message,
    lastFailureCode: failure.code,
    lastFailureClass: failure.failureClass,
    lastRunId: runId,
    updatedAt: input.failedAtIso
  };

  let approvalRequest = findPendingFailureEscalationRequest(snapshot, phase);
  const shouldPersistApprovalRequest = approvalRequest === null;

  if (!approvalRequest) {
    approvalRequest = createApprovalRequest({
      requestId: `${manifest.taskId}:approval:${phase}:failure:${runId}`,
      taskId: manifest.taskId,
      runId,
      phase,
      dryRun: manifest.dryRun,
      approvalMode: "human_signoff_required",
      status: "pending",
      riskClass: manifest.riskClass,
      summary: buildFailureEscalationSummary({
        manifest,
        phase,
        failure,
        attempts: nextAttempt,
        retryLimit
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
  }

  let followUpIssue = findExistingFollowUpIssue(snapshot, phase);
  let createdFollowUpIssue: GitHubCreatedIssueSummary | null = null;
  let followUpIssueError: Record<string, unknown> | null = null;

  if (
    !retryEligible &&
    followUpIssue === null &&
    input.github &&
    !manifest.dryRun &&
    manifest.source.issueNumber !== undefined
  ) {
    try {
      createdFollowUpIssue = await input.github.createIssue({
        repo: manifest.source.repo,
        title: `Follow-up: ${formatPhaseLabel(phase)} failure for ${manifest.title}`,
        body: buildFollowUpIssueBody({
          manifest,
          phase,
          runId,
          failure,
          approvalRequest,
          retryLimit
        }),
        labels: ["reddwarf", "follow-up", phase]
      });
      followUpIssue = createdFollowUpIssue;
    } catch (error) {
      followUpIssueError = serializeError(error);
    }
  }

  return repository.runInTransaction(async (transactionalRepository) => {
    await transactionalRepository.savePhaseRecord(
      createPhaseRecord({
        id: `${manifest.taskId}:phase:${phase}:${runId}:failed`,
        taskId: manifest.taskId,
        phase,
        status: "failed",
        actor: "control-plane",
        summary: failure.message,
        details: failedPhaseDetails,
        createdAt: input.failedAtIso
      })
    );
    await transactionalRepository.saveEvidenceRecord(
      createEvidenceRecord({
        recordId: `${manifest.taskId}:${phase}:failure:${runId}`,
        taskId: manifest.taskId,
        kind: "run_event",
        title: `${phase.charAt(0).toUpperCase() + phase.slice(1)} phase failure`,
        metadata: {
          runId,
          code: failure.code,
          failureClass: failure.failureClass,
          details: failure.details
        },
        createdAt: input.failedAtIso
      })
    );
    await recordRunEvent({
      repository: transactionalRepository,
      logger: input.runLogger,
      eventId: input.nextEventId(phase, EventCodes.PHASE_FAILED),
      taskId: manifest.taskId,
      runId,
      phase,
      level: "error",
      code: EventCodes.PHASE_FAILED,
      message: failure.message,
      failureClass: failure.failureClass,
      data: {
        causeCode: failure.code,
        details: failure.details
      },
      createdAt: input.failedAtIso
    });

    if (retryEligible) {
      const retryCount = Math.min(nextAttempt, retryLimit);
      const nextManifest = patchManifest(manifest, {
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
        retryLimit
      };

      await transactionalRepository.saveMemoryRecord(
        createMemoryRecord({
          memoryId: `${manifest.taskId}:memory:task:retry-budget:${phase}`,
          taskId: manifest.taskId,
          scope: "task",
          provenance: "pipeline_derived",
          key: getPhaseRetryBudgetMemoryKey(phase),
          title: `${formatPhaseLabel(phase)} retry budget state`,
          value: retryBudgetState,
          repo: manifest.source.repo,
          organizationId,
          tags: ["failure", "retry-budget", phase],
          createdAt: input.failedAtIso,
          updatedAt: input.failedAtIso
        })
      );
      await transactionalRepository.saveMemoryRecord(
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
      await transactionalRepository.saveEvidenceRecord(
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
        repository: transactionalRepository,
        logger: input.runLogger,
        eventId: input.nextEventId(phase, EventCodes.PHASE_RETRY_SCHEDULED),
        taskId: manifest.taskId,
        runId,
        phase,
        level: "warn",
        code: EventCodes.PHASE_RETRY_SCHEDULED,
        message: `${formatPhaseLabel(phase)} failure was classified as retryable and queued for another attempt.`,
        failureClass: failure.failureClass,
        data: {
          ...recoveryMetadata,
          attempts: nextAttempt,
          lastError: failure.message
        },
        createdAt: input.failedAtIso
      });
      await recordRunEvent({
        repository: transactionalRepository,
        logger: input.runLogger,
        eventId: input.nextEventId(phase, EventCodes.PIPELINE_BLOCKED),
        taskId: manifest.taskId,
        runId,
        phase,
        level: "warn",
        code: EventCodes.PIPELINE_BLOCKED,
        message: `${formatPhaseLabel(phase)} phase blocked pending a retry attempt.`,
        failureClass: failure.failureClass,
        durationMs: getDurationMs(input.runStartedAt, input.failedAt),
        data: recoveryMetadata,
        createdAt: input.failedAtIso
      });
      await transactionalRepository.updateManifest(nextManifest);
      await input.persistTrackedRun(
        {
          status: "blocked",
          lastHeartbeatAt: input.failedAtIso,
          completedAt: input.failedAtIso,
          metadata: {
            currentPhase: phase,
            failureCode: failure.code,
            failureClass: failure.failureClass,
            recoveryAction: "retry",
            retryCount,
            retryLimit,
            attempts: nextAttempt,
            retryExhausted: false
          }
        },
        transactionalRepository
      );

      return {
        manifest: nextManifest,
        recoveryAction: "retry",
        approvalRequest: null,
        followUpIssue: null
      };
    }

    if (shouldPersistApprovalRequest) {
      await transactionalRepository.saveApprovalRequest(approvalRequest);
    }

    if (createdFollowUpIssue) {
      await transactionalRepository.saveMemoryRecord(
        createMemoryRecord({
          memoryId: `${manifest.taskId}:memory:task:follow-up-issue:${phase}`,
          taskId: manifest.taskId,
          scope: "task",
          provenance: "pipeline_derived",
          key: `failure.follow_up_issue.${phase}`,
          title: "Follow-up issue created for failed phase",
          value: createdFollowUpIssue,
          repo: manifest.source.repo,
          organizationId,
          tags: ["failure", "follow-up", phase],
          createdAt: input.failedAtIso,
          updatedAt: input.failedAtIso
        })
      );
      await recordRunEvent({
        repository: transactionalRepository,
        logger: input.runLogger,
        eventId: input.nextEventId(phase, EventCodes.FOLLOW_UP_ISSUE_CREATED),
        taskId: manifest.taskId,
        runId,
        phase,
        level: "info",
        code: EventCodes.FOLLOW_UP_ISSUE_CREATED,
        message: `Created a follow-up issue for the ${phase} failure.`,
        data: {
          followUpIssueNumber: createdFollowUpIssue.issueNumber,
          followUpIssueUrl: createdFollowUpIssue.url
        },
        createdAt: input.failedAtIso
      });
    } else if (followUpIssueError) {
      await recordRunEvent({
        repository: transactionalRepository,
        logger: input.runLogger,
        eventId: input.nextEventId(phase, EventCodes.FOLLOW_UP_ISSUE_SKIPPED),
        taskId: manifest.taskId,
        runId,
        phase,
        level: "warn",
        code: EventCodes.FOLLOW_UP_ISSUE_SKIPPED,
        failureClass: failure.failureClass,
        message: `Failed to create a follow-up issue for the ${phase} failure.`,
        data: {
          error: followUpIssueError
        },
        createdAt: input.failedAtIso
      });
    }

    const nextManifest = patchManifest(manifest, {
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
      retryCount: Math.min(nextAttempt, retryLimit),
      retryLimit,
      attempts: nextAttempt,
      reason: retryExhausted
        ? "retry-budget-exhausted"
        : "non-retryable-failure",
      lastError: failure.message,
      approvalRequestId: approvalRequest.requestId,
      ...(followUpIssue
        ? {
            followUpIssueNumber: followUpIssue.issueNumber,
            followUpIssueUrl: followUpIssue.url
          }
        : {})
    };

    await transactionalRepository.savePhaseRecord(
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
    await transactionalRepository.saveMemoryRecord(
      createMemoryRecord({
        memoryId: `${manifest.taskId}:memory:task:retry-budget:${phase}`,
        taskId: manifest.taskId,
        scope: "task",
        provenance: "pipeline_derived",
        key: getPhaseRetryBudgetMemoryKey(phase),
        title: `${formatPhaseLabel(phase)} retry budget state`,
        value: retryBudgetState,
        repo: manifest.source.repo,
        organizationId,
        tags: ["failure", "retry-budget", phase],
        createdAt: input.failedAtIso,
        updatedAt: input.failedAtIso
      })
    );
    await transactionalRepository.saveMemoryRecord(
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
    await transactionalRepository.saveEvidenceRecord(
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
      repository: transactionalRepository,
      logger: input.runLogger,
      eventId: input.nextEventId(phase, EventCodes.PHASE_ESCALATED),
      taskId: manifest.taskId,
      runId,
      phase,
      level: "warn",
      code: EventCodes.PHASE_ESCALATED,
      message: `${formatPhaseLabel(phase)} failure escalated for human review.`,
      failureClass: failure.failureClass,
      data: recoveryMetadata,
      createdAt: input.failedAtIso
    });
    await recordRunEvent({
      repository: transactionalRepository,
      logger: input.runLogger,
      eventId: input.nextEventId(phase, EventCodes.PIPELINE_BLOCKED),
      taskId: manifest.taskId,
      runId,
      phase,
      level: "warn",
      code: EventCodes.PIPELINE_BLOCKED,
      message: `${formatPhaseLabel(phase)} phase blocked pending operator review.`,
      failureClass: failure.failureClass,
      durationMs: getDurationMs(input.runStartedAt, input.failedAt),
      data: recoveryMetadata,
      createdAt: input.failedAtIso
    });
    await transactionalRepository.updateManifest(nextManifest);
    await input.persistTrackedRun(
      {
        status: "blocked",
        lastHeartbeatAt: input.failedAtIso,
        completedAt: input.failedAtIso,
        metadata: {
          currentPhase: phase,
          failureCode: failure.code,
          failureClass: failure.failureClass,
          recoveryAction: "escalate",
          retryCount: Math.min(nextAttempt, retryLimit),
          retryLimit,
          attempts: nextAttempt,
          retryExhausted,
          approvalRequestId: approvalRequest.requestId,
          ...(followUpIssue
            ? { followUpIssueNumber: followUpIssue.issueNumber }
            : {})
        }
      },
      transactionalRepository
    );

    return {
      manifest: nextManifest,
      recoveryAction: "escalate",
      approvalRequest,
      followUpIssue
    };
  });
}

export async function persistConcurrencyBlock(
  ctx: ConcurrencyBlockedContext
): Promise<import("@reddwarf/contracts").ConcurrencyDecision> {
  const decision = createConcurrencyDecision({
    action: "block",
    strategy: ctx.strategy,
    blockedByRunId: ctx.blockedByRun.runId,
    staleRunIds: ctx.staleRunIds,
    reason: `Active overlapping run ${ctx.blockedByRun.runId} already owns ${ctx.concurrencyKey}.`
  });
  const phaseLabel =
    ctx.phase === "scm"
      ? "SCM"
      : ctx.phase.charAt(0).toUpperCase() + ctx.phase.slice(1);

  return ctx.repository.runInTransaction(async (repository) => {
    const { createPipelineRun, createEvidenceRecord } = await import("@reddwarf/evidence");
    await repository.savePipelineRun(
      createPipelineRun({
        ...ctx.trackedRun,
        status: "blocked",
        blockedByRunId: ctx.blockedByRun.runId,
        overlapReason: decision.reason,
        completedAt: ctx.runStartedAtIso,
        metadata: {
          ...ctx.trackedRun.metadata,
          staleRunIds: ctx.staleRunIds
        }
      })
    );
    await repository.saveEvidenceRecord(
      createEvidenceRecord({
        recordId: `${ctx.taskId}:${ctx.phase}:concurrency:${ctx.runId}`,
        taskId: ctx.taskId,
        kind: "gate_decision",
        title: `${phaseLabel} concurrency gate decision`,
        metadata: decision,
        createdAt: ctx.runStartedAtIso
      })
    );
    await recordRunEvent({
      repository,
      logger: ctx.runLogger,
      eventId: ctx.nextEventId(ctx.phase, EventCodes.RUN_BLOCKED_BY_OVERLAP),
      taskId: ctx.taskId,
      runId: ctx.runId,
      phase: ctx.phase,
      level: "warn",
      code: EventCodes.RUN_BLOCKED_BY_OVERLAP,
      message:
        decision.reason ?? `${phaseLabel} phase blocked by an overlapping run.`,
      failureClass: "execution_loop",
      data: {
        concurrencyKey: ctx.concurrencyKey,
        strategy: ctx.strategy,
        blockedByRunId: ctx.blockedByRun.runId,
        staleRunIds: ctx.staleRunIds
      },
      createdAt: ctx.runStartedAtIso
    });
    await recordRunEvent({
      repository,
      logger: ctx.runLogger,
      eventId: ctx.nextEventId(ctx.phase, EventCodes.PIPELINE_BLOCKED),
      taskId: ctx.taskId,
      runId: ctx.runId,
      phase: ctx.phase,
      level: "warn",
      code: EventCodes.PIPELINE_BLOCKED,
      message: `${phaseLabel} phase blocked by concurrency controls.`,
      failureClass: "execution_loop",
      durationMs: getDurationMs(ctx.runStartedAt, ctx.runStartedAt),
      data: {
        concurrencyKey: ctx.concurrencyKey,
        strategy: ctx.strategy,
        blockedByRunId: ctx.blockedByRun.runId
      },
      createdAt: ctx.runStartedAtIso
    });
    return decision;
  });
}

export async function persistPhaseFailure(
  ctx: PhaseFailureContext
): Promise<TaskManifest> {
  const recoverable: RecoverablePhase[] = [
    "development",
    "architecture_review",
    "validation",
    "scm"
  ];

  if (recoverable.includes(ctx.phase as RecoverablePhase)) {
    return (
      await handleAutomatedPhaseFailure({
        repository: ctx.repository,
        snapshot: ctx.snapshot,
        manifest: ctx.manifest,
        phase: ctx.phase as RecoverablePhase,
        runId: ctx.runId,
        failure: ctx.failure,
        runLogger: ctx.runLogger,
        nextEventId: ctx.nextEventId,
        runStartedAt: ctx.runStartedAt,
        failedAt: ctx.failedAt,
        failedAtIso: ctx.failedAtIso,
        persistTrackedRun: ctx.persistTrackedRun,
        github: ctx.github
      })
    ).manifest;
  }

  const taskId = ctx.manifest.taskId;
  return ctx.repository.runInTransaction(async (repository) => {
    await repository.savePhaseRecord(
      createPhaseRecord({
        id: `${taskId}:phase:${ctx.phase}:${ctx.runId}:failed`,
        taskId,
        phase: ctx.phase,
        status: "failed",
        actor: "control-plane",
        summary: ctx.failure.message,
        details: {
          code: ctx.failure.code,
          failureClass: ctx.failure.failureClass,
          ...ctx.failure.details
        },
        createdAt: ctx.failedAtIso
      })
    );
    await repository.saveEvidenceRecord(
      createEvidenceRecord({
        recordId: `${taskId}:${ctx.phase}:failure:${ctx.runId}`,
        taskId,
        kind: "run_event",
        title: `${ctx.phase.charAt(0).toUpperCase() + ctx.phase.slice(1)} phase failure`,
        metadata: {
          runId: ctx.runId,
          code: ctx.failure.code,
          failureClass: ctx.failure.failureClass,
          details: ctx.failure.details
        },
        createdAt: ctx.failedAtIso
      })
    );
    await recordRunEvent({
      repository,
      logger: ctx.runLogger,
      eventId: ctx.nextEventId(ctx.phase, EventCodes.PHASE_FAILED),
      taskId,
      runId: ctx.runId,
      phase: ctx.phase,
      level: "error",
      code: EventCodes.PHASE_FAILED,
      message: ctx.failure.message,
      failureClass: ctx.failure.failureClass,
      data: {
        causeCode: ctx.failure.code,
        details: ctx.failure.details
      },
      createdAt: ctx.failedAtIso
    });
    return ctx.manifest;
  });
}
