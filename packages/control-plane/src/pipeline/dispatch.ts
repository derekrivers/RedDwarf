import { z } from "zod";
import { deriveOrganizationId } from "@reddwarf/evidence";
import { bindPlanningLogger } from "../logger.js";
import { defaultLogger } from "../logger.js";
import {
  findApprovedFailureEscalationRequest,
  findAutomatedRetryRecovery,
  isRecoverablePhase,
  requirePhaseSnapshot
} from "./shared.js";
import { formatDispatchError } from "./failure.js";
import {
  type DispatchReadyTaskDependencies,
  type DispatchReadyTaskInput,
  type DispatchReadyTaskResult,
  type RecoverablePhase
} from "./types.js";
import { runArchitectureReviewPhase } from "./architecture-review.js";
import { runDeveloperPhase } from "./development.js";
import { runValidationPhase } from "./validation.js";
import { runScmPhase } from "./scm.js";
import { resolveUnmetTaskGroupDependencies } from "../task-groups.js";
import type { PlanningPipelineLogger } from "../logger.js";

/**
 * Build a failure result for a phase that threw an unhandled error.
 * Centralises the identical catch-block shape that previously appeared
 * once per pipeline phase.
 */
function buildPhaseFailureResult(
  taskId: string,
  phase: string,
  phasesExecuted: string[],
  error: unknown,
  logger: PlanningPipelineLogger
): DispatchReadyTaskResult {
  const formatted = formatDispatchError(error);
  logger.error(`${phase} phase failed.`, { taskId, error: formatted });
  return {
    taskId,
    outcome: "failed",
    phasesExecuted: [...phasesExecuted, phase],
    finalPhase: phase,
    error: formatted
  };
}

/**
 * Return a new object containing only the keys from `obj` whose values are
 * not undefined. Used to forward optional dependencies into phase runners
 * without the verbose `...(dep ? { dep } : {})` pattern.
 *
 * The cast strips `undefined` from the return type so callers are compatible
 * with `exactOptionalPropertyTypes` — the runtime filter guarantees no
 * undefined value survives into the result.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pickDefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined)
  ) as Partial<T>;
}

export async function dispatchReadyTask(
  input: DispatchReadyTaskInput,
  dependencies: DispatchReadyTaskDependencies
): Promise<DispatchReadyTaskResult> {
  const { repository } = dependencies;
  const logger = dependencies.logger ?? defaultLogger;
  const taskId = input.taskId.trim();

  const rawSnapshot = await repository.getTaskSnapshot(taskId);
  const { snapshot, manifest } = requirePhaseSnapshot(rawSnapshot, taskId);

  const approvedFailureRecoveryRequest =
    isRecoverablePhase(manifest.currentPhase)
      ? findApprovedFailureEscalationRequest(snapshot, manifest.currentPhase)
      : null;
  const automatedRetryRecovery =
    isRecoverablePhase(manifest.currentPhase)
      ? findAutomatedRetryRecovery(snapshot, manifest.currentPhase)
      : null;
  const isDispatchableReadyManifest = manifest.lifecycleStatus === "ready";
  const isDispatchableBlockedRetryManifest =
    manifest.lifecycleStatus === "blocked" && automatedRetryRecovery !== null;

  if (!isDispatchableReadyManifest && !isDispatchableBlockedRetryManifest) {
    throw new Error(
      `Task ${taskId} has lifecycleStatus "${manifest.lifecycleStatus}" and cannot be dispatched; expected "ready" or an automated retryable blocked task.`
    );
  }

  let startPhase: RecoverablePhase = "development";
  if (isRecoverablePhase(manifest.currentPhase)) {
    if (isDispatchableReadyManifest) {
      startPhase = manifest.currentPhase;
    } else if (approvedFailureRecoveryRequest !== null) {
      startPhase = manifest.currentPhase;
    } else if (automatedRetryRecovery !== null) {
      startPhase = manifest.currentPhase;
    }
  }
  const dispatchMode =
    approvedFailureRecoveryRequest !== null
      ? "resume_failure_recovery"
      : automatedRetryRecovery !== null
        ? "resume_automated_retry"
        : "fresh";

  const dispatchLogger = bindPlanningLogger(logger, {
    taskId,
    sourceRepo: manifest.source.repo,
    ...(approvedFailureRecoveryRequest
      ? { approvalRequestId: approvedFailureRecoveryRequest.requestId }
      : {})
  });

  const groupDependencies = await resolveUnmetTaskGroupDependencies(
    repository,
    manifest
  );
  if (groupDependencies.unmetDependencies.length > 0) {
    dispatchLogger.info("Task is waiting for grouped dependencies to complete.", {
      taskId,
      groupId: groupDependencies.membership?.groupId ?? null,
      unmetDependencies: groupDependencies.unmetDependencies
    });
    return {
      taskId,
      outcome: "blocked",
      phasesExecuted: [],
      finalPhase: manifest.currentPhase,
      error: `Waiting on grouped task dependencies: ${groupDependencies.unmetDependencies
        .map((dependency) => `${dependency.taskId} (${dependency.lifecycleStatus})`)
        .join(", ")}`
    };
  }

  dispatchLogger.info("Starting post-approval dispatch.", {
    taskId,
    currentPhase: manifest.currentPhase,
    requestedCapabilities: manifest.requestedCapabilities,
    startPhase,
    dispatchMode,
    lifecycleStatus: manifest.lifecycleStatus
  });

  const phasesExecuted: string[] = [];
  const memoryContext = await repository.getMemoryContext({
    taskId,
    repo: manifest.source.repo,
    organizationId: deriveOrganizationId(manifest.source.repo)
  });

  // Retrieve Holly's architect handoff from memory. The architecture plan is a
  // required prerequisite for the developer phase — a missing or unreadable
  // handoff blocks the run rather than silently degrading Lister's context.
  const architectHandoffSchema = z.object({
    summary: z.string(),
    affectedAreas: z.array(z.string()).default([]),
    assumptions: z.array(z.string()).default([]),
    constraints: z.array(z.string()).default([]),
    testExpectations: z.array(z.string()).default([])
  });

  let hollyHandoffMarkdown: string | undefined;
  {
    let architectMemoryError: unknown = null;

    try {
      const architectMemory = snapshot.memoryRecords.find(
        (memory) => memory.key === "architect.handoff"
      );
      if (architectMemory?.value !== undefined && architectMemory.value !== null) {
        const parsed = architectHandoffSchema.safeParse(architectMemory.value);
        if (parsed.success) {
          const handoff = parsed.data;
          const parts: string[] = [];
          parts.push(`# Architecture Plan\n\n${handoff.summary}`);
          if (handoff.affectedAreas.length > 0) {
            parts.push(`\n## Affected Areas\n\n${handoff.affectedAreas.map((a) => `- ${a}`).join("\n")}`);
          }
          if (handoff.assumptions.length > 0) {
            parts.push(`\n## Assumptions\n\n${handoff.assumptions.map((a) => `- ${a}`).join("\n")}`);
          }
          if (handoff.constraints.length > 0) {
            parts.push(`\n## Constraints\n\n${handoff.constraints.map((a) => `- ${a}`).join("\n")}`);
          }
          if (handoff.testExpectations.length > 0) {
            parts.push(`\n## Test Expectations\n\n${handoff.testExpectations.map((a) => `- ${a}`).join("\n")}`);
          }
          hollyHandoffMarkdown = parts.join("\n");
          dispatchLogger.info("Retrieved Holly architect handoff from memory.", {
            taskId,
            contentLength: hollyHandoffMarkdown.length
          });
        }
      }
    } catch (err) {
      architectMemoryError = err;
    }

    if (architectMemoryError !== null) {
      // A thrown error during memory retrieval indicates a system-level problem
      // (e.g., DB connectivity, deserialization failure) rather than a missing
      // record. Block the task so operators can investigate rather than silently
      // dispatching Lister without any architectural context.
      dispatchLogger.error("Failed to retrieve Holly architect handoff from memory — blocking task.", {
        taskId,
        error: formatDispatchError(architectMemoryError)
      });
      return {
        taskId,
        outcome: "blocked",
        phasesExecuted: [],
        finalPhase: "development",
        error: `Architect handoff retrieval failed: ${formatDispatchError(architectMemoryError)}`
      };
    }

    if (hollyHandoffMarkdown === undefined) {
      // No architect.handoff memory record exists yet. This is expected on the
      // very first dispatch (the record is written after planning completes). Log
      // it as a warning but do not block — the developer phase is designed to
      // handle a missing handoff by running in readonly/no-plan mode.
      dispatchLogger.warn("No Holly architect handoff found in memory — dispatching developer without architecture plan.", { taskId });
    }
  }

  const phaseInput = {
    taskId,
    targetRoot: input.targetRoot,
    evidenceRoot: input.evidenceRoot
  };
  const sharedDeps = pickDefined({
    logger: dependencies.logger,
    clock: dependencies.clock,
    concurrency: dependencies.concurrency,
    timing: dependencies.timing
  });

  // ── Development phase ─────────────────────────────────────────────────────

  if (startPhase === "development") {
    try {
      dispatchLogger.info("Dispatching developer phase.", { taskId });
      const devResult = await runDeveloperPhase(phaseInput, {
        repository,
        developer: dependencies.developer,
        memoryContext,
        github: dependencies.github,
        openClawAgentId: "reddwarf-developer",
        ...pickDefined({
          ci: dependencies.ci,
          openClawDispatch: dependencies.openClawDispatch,
          secrets: dependencies.secrets,
          workspaceRepoBootstrapper: dependencies.workspaceRepoBootstrapper,
          openClawCompletionAwaiter: dependencies.openClawCompletionAwaiter
        }),
        ...(hollyHandoffMarkdown ? { hollyHandoffMarkdown } : {}),
        ...sharedDeps
      });
      phasesExecuted.push("development");
      dispatchLogger.info("Developer phase completed.", { taskId, nextAction: devResult.nextAction, runId: devResult.runId });
      if (devResult.nextAction === "task_blocked") {
        return { taskId, outcome: "blocked", phasesExecuted, finalPhase: "development" };
      }
    } catch (error) {
      return buildPhaseFailureResult(taskId, "development", phasesExecuted, error, dispatchLogger);
    }
  } else {
    dispatchLogger.info("Skipping developer phase for downstream recovery resume.", {
      taskId,
      startPhase,
      approvalRequestId: approvedFailureRecoveryRequest?.requestId ?? null
    });
  }

  // ── Architecture review phase ─────────────────────────────────────────────

  if (startPhase === "development" || startPhase === "architecture_review") {
    try {
      dispatchLogger.info("Dispatching architecture review phase.", { taskId });
      const reviewResult = await runArchitectureReviewPhase(phaseInput, {
        repository,
        reviewer: dependencies.reviewer,
        memoryContext,
        ...pickDefined({
          openClawDispatch: dependencies.openClawDispatch,
          workspaceRepoBootstrapper: dependencies.workspaceRepoBootstrapper,
          architectureReviewAwaiter: dependencies.architectureReviewAwaiter,
          openClawReviewAgentId: dependencies.openClawReviewAgentId
        }),
        ...sharedDeps
      });
      phasesExecuted.push("architecture_review");
      dispatchLogger.info("Architecture review phase completed.", { taskId, nextAction: reviewResult.nextAction, runId: reviewResult.runId });
      if (reviewResult.nextAction === "task_blocked" || reviewResult.nextAction === "await_human_review") {
        return { taskId, outcome: "blocked", phasesExecuted, finalPhase: "architecture_review" };
      }
    } catch (error) {
      return buildPhaseFailureResult(taskId, "architecture_review", phasesExecuted, error, dispatchLogger);
    }
  }

  // ── Validation phase ──────────────────────────────────────────────────────

  if (startPhase !== "scm") {
    try {
      dispatchLogger.info("Dispatching validation phase.", { taskId, resumed: startPhase === "validation" });
      const valResult = await runValidationPhase(phaseInput, {
        repository,
        validator: dependencies.validator,
        memoryContext,
        ...pickDefined({
          github: dependencies.github,
          ci: dependencies.ci,
          secrets: dependencies.secrets
        }),
        ...sharedDeps
      });
      phasesExecuted.push("validation");
      dispatchLogger.info("Validation phase completed.", { taskId, nextAction: valResult.nextAction, runId: valResult.runId });
      if (valResult.nextAction === "task_blocked") {
        return { taskId, outcome: "blocked", phasesExecuted, finalPhase: "validation" };
      }
      if (valResult.nextAction === "await_review") {
        dispatchLogger.info("Validation returned await_review - skipping SCM (review is v1-disabled).", { taskId });
        return { taskId, outcome: "completed", phasesExecuted, finalPhase: "validation" };
      }
    } catch (error) {
      return buildPhaseFailureResult(taskId, "validation", phasesExecuted, error, dispatchLogger);
    }
  } else {
    dispatchLogger.info("Skipping validation phase for approved SCM recovery resume.", {
      taskId,
      approvalRequestId: approvedFailureRecoveryRequest?.requestId ?? null
    });
  }

  // ── SCM phase ─────────────────────────────────────────────────────────────

  try {
    dispatchLogger.info("Dispatching SCM phase.", { taskId, resumed: startPhase === "scm" });
    const scmResult = await runScmPhase(phaseInput, {
      repository,
      scm: dependencies.scm,
      memoryContext,
      github: dependencies.github,
      ...pickDefined({
        workspaceRepoBootstrapper: dependencies.workspaceRepoBootstrapper,
        workspaceCommitPublisher: dependencies.workspaceCommitPublisher
      }),
      ...sharedDeps
    });
    phasesExecuted.push("scm");
    dispatchLogger.info("SCM phase completed.", { taskId, nextAction: scmResult.nextAction, runId: scmResult.runId, pullRequestUrl: scmResult.pullRequest?.url });
    if (scmResult.nextAction === "task_blocked") {
      return { taskId, outcome: "blocked", phasesExecuted, finalPhase: "scm" };
    }
    return {
      taskId,
      outcome: "completed",
      phasesExecuted,
      finalPhase: "scm",
      ...(scmResult.pullRequest?.url ? { pullRequestUrl: scmResult.pullRequest.url } : {})
    };
  } catch (error) {
    return buildPhaseFailureResult(taskId, "scm", phasesExecuted, error, dispatchLogger);
  }
}
