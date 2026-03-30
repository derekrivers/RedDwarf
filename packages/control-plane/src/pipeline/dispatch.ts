import { bindPlanningLogger } from "../logger.js";
import { defaultLogger } from "../logger.js";
import {
  findApprovedFailureEscalationRequest,
  findAutomatedRetryRecovery,
  isRecoverablePhase,
  requirePhaseSnapshot
} from "./shared.js";
import {
  formatDispatchError
} from "./failure.js";
import {
  type DispatchPhaseOutcome,
  type DispatchReadyTaskDependencies,
  type DispatchReadyTaskInput,
  type DispatchReadyTaskResult,
  type RecoverablePhase
} from "./types.js";
import { runDeveloperPhase } from "./development.js";
import { runValidationPhase } from "./validation.js";
import { runScmPhase } from "./scm.js";

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
    if (approvedFailureRecoveryRequest !== null) {
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

  dispatchLogger.info("Starting post-approval dispatch.", {
    taskId,
    currentPhase: manifest.currentPhase,
    requestedCapabilities: manifest.requestedCapabilities,
    startPhase,
    dispatchMode,
    lifecycleStatus: manifest.lifecycleStatus
  });

  const phasesExecuted: string[] = [];

  let hollyHandoffMarkdown: string | undefined;
  try {
    const architectMemory = snapshot.memoryRecords.find(
      (memory) => memory.key === "architect.handoff"
    );
    if (
      architectMemory &&
      typeof architectMemory.value === "object" &&
      architectMemory.value !== null
    ) {
      const val = architectMemory.value as Record<string, unknown>;
      if (typeof val["summary"] === "string") {
        const parts: string[] = [];
        parts.push(`# Architecture Plan\n\n${val["summary"]}`);
        if (Array.isArray(val["affectedAreas"]) && val["affectedAreas"].length > 0) {
          parts.push(`\n## Affected Areas\n\n${(val["affectedAreas"] as string[]).map((a: string) => `- ${a}`).join("\n")}`);
        }
        if (Array.isArray(val["assumptions"]) && val["assumptions"].length > 0) {
          parts.push(`\n## Assumptions\n\n${(val["assumptions"] as string[]).map((a: string) => `- ${a}`).join("\n")}`);
        }
        if (Array.isArray(val["constraints"]) && val["constraints"].length > 0) {
          parts.push(`\n## Constraints\n\n${(val["constraints"] as string[]).map((a: string) => `- ${a}`).join("\n")}`);
        }
        if (Array.isArray(val["testExpectations"]) && val["testExpectations"].length > 0) {
          parts.push(`\n## Test Expectations\n\n${(val["testExpectations"] as string[]).map((a: string) => `- ${a}`).join("\n")}`);
        }
        hollyHandoffMarkdown = parts.join("\n");
        dispatchLogger.info("Retrieved Holly architect handoff from memory.", {
          taskId,
          contentLength: hollyHandoffMarkdown.length
        });
      }
    }
  } catch {
    dispatchLogger.warn("Failed to retrieve Holly architect handoff from memory.", { taskId });
  }

  if (startPhase === "development") {
    try {
      dispatchLogger.info("Dispatching developer phase.", { taskId });

      const devResult = await runDeveloperPhase(
        {
          taskId,
          targetRoot: input.targetRoot,
          evidenceRoot: input.evidenceRoot
        },
        {
          repository,
          developer: dependencies.developer,
          github: dependencies.github,
          ...(dependencies.openClawDispatch ? { openClawDispatch: dependencies.openClawDispatch } : {}),
          openClawAgentId: "reddwarf-developer",
          ...(dependencies.secrets ? { secrets: dependencies.secrets } : {}),
          ...(dependencies.workspaceRepoBootstrapper ? { workspaceRepoBootstrapper: dependencies.workspaceRepoBootstrapper } : {}),
          ...(dependencies.openClawCompletionAwaiter ? { openClawCompletionAwaiter: dependencies.openClawCompletionAwaiter } : {}),
          ...(hollyHandoffMarkdown ? { hollyHandoffMarkdown } : {}),
          ...(dependencies.logger ? { logger: dependencies.logger } : {}),
          ...(dependencies.clock ? { clock: dependencies.clock } : {}),
          ...(dependencies.concurrency ? { concurrency: dependencies.concurrency } : {}),
          ...(dependencies.timing ? { timing: dependencies.timing } : {})
        }
      );

      phasesExecuted.push("development");
      dispatchLogger.info("Developer phase completed.", {
        taskId,
        nextAction: devResult.nextAction,
        runId: devResult.runId
      });

      if (devResult.nextAction === "task_blocked") {
        return {
          taskId,
          outcome: "blocked",
          phasesExecuted,
          finalPhase: "development"
        };
      }
    } catch (error) {
      dispatchLogger.error("Developer phase failed.", {
        taskId,
        error: formatDispatchError(error)
      });
      return {
        taskId,
        outcome: "failed",
        phasesExecuted: [...phasesExecuted, "development"],
        finalPhase: "development",
        error: formatDispatchError(error)
      };
    }
  } else {
    dispatchLogger.info("Skipping developer phase for approved failure recovery resume.", {
      taskId,
      startPhase,
      approvalRequestId: approvedFailureRecoveryRequest?.requestId ?? null
    });
  }

  if (startPhase !== "scm") {
    try {
      dispatchLogger.info("Dispatching validation phase.", {
        taskId,
        resumed: startPhase === "validation"
      });

      const valResult = await runValidationPhase(
        {
          taskId,
          targetRoot: input.targetRoot,
          evidenceRoot: input.evidenceRoot
        },
        {
          repository,
          validator: dependencies.validator,
          ...(dependencies.github ? { github: dependencies.github } : {}),
          ...(dependencies.secrets ? { secrets: dependencies.secrets } : {}),
          ...(dependencies.logger ? { logger: dependencies.logger } : {}),
          ...(dependencies.clock ? { clock: dependencies.clock } : {}),
          ...(dependencies.concurrency ? { concurrency: dependencies.concurrency } : {}),
          ...(dependencies.timing ? { timing: dependencies.timing } : {})
        }
      );

      phasesExecuted.push("validation");
      dispatchLogger.info("Validation phase completed.", {
        taskId,
        nextAction: valResult.nextAction,
        runId: valResult.runId
      });

      if (valResult.nextAction === "task_blocked") {
        return {
          taskId,
          outcome: "blocked",
          phasesExecuted,
          finalPhase: "validation"
        };
      }

      if (valResult.nextAction === "await_review") {
        dispatchLogger.info("Validation returned await_review - skipping SCM (review is v1-disabled).", { taskId });
        return {
          taskId,
          outcome: "completed",
          phasesExecuted,
          finalPhase: "validation"
        };
      }
    } catch (error) {
      dispatchLogger.error("Validation phase failed.", {
        taskId,
        error: formatDispatchError(error)
      });
      return {
        taskId,
        outcome: "failed",
        phasesExecuted: [...phasesExecuted, "validation"],
        finalPhase: "validation",
        error: formatDispatchError(error)
      };
    }
  } else {
    dispatchLogger.info("Skipping validation phase for approved SCM recovery resume.", {
      taskId,
      approvalRequestId: approvedFailureRecoveryRequest?.requestId ?? null
    });
  }

  try {
    dispatchLogger.info("Dispatching SCM phase.", {
      taskId,
      resumed: startPhase === "scm"
    });

    const scmResult = await runScmPhase(
      {
        taskId,
        targetRoot: input.targetRoot,
        evidenceRoot: input.evidenceRoot
      },
      {
        repository,
        scm: dependencies.scm,
        github: dependencies.github,
        ...(dependencies.workspaceRepoBootstrapper ? { workspaceRepoBootstrapper: dependencies.workspaceRepoBootstrapper } : {}),
        ...(dependencies.workspaceCommitPublisher ? { workspaceCommitPublisher: dependencies.workspaceCommitPublisher } : {}),
        ...(dependencies.logger ? { logger: dependencies.logger } : {}),
        ...(dependencies.clock ? { clock: dependencies.clock } : {}),
        ...(dependencies.concurrency ? { concurrency: dependencies.concurrency } : {}),
        ...(dependencies.timing ? { timing: dependencies.timing } : {})
      }
    );

    phasesExecuted.push("scm");
    dispatchLogger.info("SCM phase completed.", {
      taskId,
      nextAction: scmResult.nextAction,
      runId: scmResult.runId,
      pullRequestUrl: scmResult.pullRequest?.url
    });

    if (scmResult.nextAction === "task_blocked") {
      return {
        taskId,
        outcome: "blocked",
        phasesExecuted,
        finalPhase: "scm"
      };
    }

    return {
      taskId,
      outcome: "completed",
      phasesExecuted,
      finalPhase: "scm",
      ...(scmResult.pullRequest?.url ? { pullRequestUrl: scmResult.pullRequest.url } : {})
    };
  } catch (error) {
    dispatchLogger.error("SCM phase failed.", {
      taskId,
      error: formatDispatchError(error)
    });
    return {
      taskId,
      outcome: "failed",
      phasesExecuted: [...phasesExecuted, "scm"],
      finalPhase: "scm",
      error: formatDispatchError(error)
    };
  }
}
