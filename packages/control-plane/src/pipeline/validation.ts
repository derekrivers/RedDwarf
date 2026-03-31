import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  asIsoTimestamp,
  type ValidationReport
} from "@reddwarf/contracts";
import {
  createEvidenceRecord,
  createMemoryRecord,
  createPipelineRun,
  deriveOrganizationId
} from "@reddwarf/evidence";
import {
  assertPhaseExecutable
} from "@reddwarf/execution-plane";
import {
  type SecretLease
} from "@reddwarf/integrations";
import {
  archiveEvidenceArtifact,
  buildArchivedArtifactMetadata,
  createWorkspaceContextBundle,
  materializeManagedWorkspace,
  workspaceLocationPrefix,
  type MaterializedManagedWorkspace
} from "../workspace.js";
import {
  createConcurrencyDecision,
  createPhaseRecord,
  createSourceConcurrencyKey,
  getDurationMs,
  heartbeatTrackedRun,
  issueWorkspaceSecretLease,
  patchManifest,
  readDevelopmentCodeWriteEnabledFromSnapshot,
  recordRunEvent,
  requireApprovedRequest,
  requireNoFailureEscalation,
  requirePhaseSnapshot,
  resolvePhaseDependencies,
  resolveTaskMemoryContext,
  scrubWorkspaceSecretLeaseOnPhaseExit,
  serializeError,
  taskManifestSchema,
  taskRequestsPullRequest,
  waitWithHeartbeat
} from "./shared.js";
import {
  createPhaseRunContext
} from "./context.js";
import {
  EventCodes,
  PHASE_HEARTBEAT_INTERVAL_MS,
  DEFAULT_VALIDATION_COMMAND_TIMEOUT_MS,
  PlanningPipelineFailure,
  type RunValidationPhaseInput,
  type ValidationPhaseDependencies,
  type ValidationPhaseResult
} from "./types.js";
import {
  normalizePipelineFailure,
  persistConcurrencyBlock,
  persistPhaseFailure
} from "./failure.js";
import {
  renderValidationReportMarkdown
} from "./prompts.js";
import {
  executeValidationCommand
} from "./validation-command.js";
import {
  findApprovedFailureEscalationRequest
} from "./shared.js";

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
  const { logger, clock, idGenerator, concurrency } = resolvePhaseDependencies("validation", dependencies);
  const heartbeatIntervalMs =
    dependencies.timing?.heartbeatIntervalMs ?? PHASE_HEARTBEAT_INTERVAL_MS;
  const validationCommandTimeoutMs =
    dependencies.timing?.validationCommandTimeoutMs ??
    DEFAULT_VALIDATION_COMMAND_TIMEOUT_MS;
  const rawSnapshot = await repository.getTaskSnapshot(taskId);
  const { snapshot, manifest: validatedManifest, spec: validatedSpec, policySnapshot: validatedPolicySnapshot } = requirePhaseSnapshot(rawSnapshot, taskId);
  const approvedRequest = requireApprovedRequest(snapshot, validatedManifest, "validation");
  requireNoFailureEscalation(snapshot, taskId, "validation");
  const approvedFailureRetry = findApprovedFailureEscalationRequest(
    snapshot,
    "validation"
  );

  const lifecycleAllowsValidation =
    (validatedManifest.lifecycleStatus === "blocked" &&
      ["development", "architecture_review", "validation"].includes(validatedManifest.currentPhase)) ||
    (validatedManifest.lifecycleStatus === "active" &&
      validatedManifest.currentPhase === "validation") ||
    (validatedManifest.lifecycleStatus === "ready" &&
      validatedManifest.currentPhase === "validation" &&
      approvedFailureRetry !== null);

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
  const { runLogger, nextEventId, persistTrackedRun } = createPhaseRunContext({
    runId,
    taskId,
    sourceRepo: currentManifest.source.repo,
    phase: "validation",
    getTrackedRun: () => trackedRun,
    setTrackedRun: (run) => { trackedRun = run; },
    repository,
    logger
  });
  let workspace: MaterializedManagedWorkspace | null = null;
  let secretLease: SecretLease | null = null;

  const { staleRunIds, blockedByRun } = await repository.claimPipelineRun({
    run: trackedRun,
    staleAfterMs: concurrency.staleAfterMs
  });

  if (blockedByRun) {
    concurrencyDecision = await persistConcurrencyBlock({
      repository, trackedRun, concurrencyKey,
      strategy: concurrency.strategy, taskId, runId,
      phase: "validation", runStartedAt, runStartedAtIso,
      blockedByRun, staleRunIds, runLogger, nextEventId
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
        eventId: nextEventId("validation", EventCodes.STALE_RUNS_DETECTED),
        taskId,
        runId,
        phase: "validation",
        level: "info",
        code: EventCodes.STALE_RUNS_DETECTED,
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
    currentManifest = patchManifest(currentManifest, {
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
      eventId: nextEventId("validation", EventCodes.PHASE_RUNNING),
      taskId,
      runId,
      phase: "validation",
      level: "info",
      code: EventCodes.PHASE_RUNNING,
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

    const memoryContext = await resolveTaskMemoryContext({
      repository,
      manifest: currentManifest,
      ...(dependencies.memoryContext !== undefined
        ? { providedMemoryContext: dependencies.memoryContext }
        : {})
    });
    const bundle = createWorkspaceContextBundle({
      manifest: currentManifest,
      spec: validatedSpec,
      policySnapshot: validatedPolicySnapshot,
      memoryContext
    });
    secretLease = await issueWorkspaceSecretLease({
      bundle,
      phase: "validation",
      ...(dependencies.secrets ? { secrets: dependencies.secrets } : {}),
      ...(dependencies.environment
        ? { environment: dependencies.environment }
        : {})
    });
    workspace = await materializeManagedWorkspace({
      bundle,
      targetRoot: input.targetRoot,
      workspaceId,
      createdAt: validationStartedAtIso,
      secretLease
    });
    currentManifest = patchManifest(currentManifest, {
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
      eventId: nextEventId("validation", EventCodes.WORKSPACE_PREPARED),
      taskId,
      runId,
      phase: "validation",
      level: "info",
      code: EventCodes.WORKSPACE_PREPARED,
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
        eventId: nextEventId("validation", EventCodes.SECRET_LEASE_ISSUED),
        taskId,
        runId,
        phase: "validation",
        level: "info",
        code: EventCodes.SECRET_LEASE_ISSUED,
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
        code: EventCodes.VALIDATION_PLAN_EMPTY,
        details: {
          workspaceId: workspace.workspaceId
        },
        taskId,
        runId
      });
    }

    const commandResults: import("@reddwarf/contracts").ValidationCommandResult[] = [];

    for (const command of plan.commands) {
      const commandStartedAt = clock();
      const commandStartedAtIso = asIsoTimestamp(commandStartedAt);
      await recordRunEvent({
        repository,
        logger: runLogger,
        eventId: nextEventId("validation", EventCodes.VALIDATION_COMMAND_STARTED),
        taskId,
        runId,
        phase: "validation",
        level: "info",
        code: EventCodes.VALIDATION_COMMAND_STARTED,
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
      const executed = await waitWithHeartbeat({
        work: executeValidationCommand({
          command,
          workspace,
          startedAt: commandStartedAt,
          secretLease,
          timeoutMs: validationCommandTimeoutMs
        }),
        heartbeatIntervalMs,
        onHeartbeat: () =>
          heartbeatTrackedRun({
            phase: "validation",
            persistTrackedRun,
            clock,
            metadata: {
              workspaceId,
              lastValidationCommandId: command.id
            }
          })
      });
      const { stdout: _stdout, stderr: _stderr, timedOut, timeoutMs } = executed;
      const commandResult: import("@reddwarf/contracts").ValidationCommandResult = {
        id: executed.id,
        name: executed.name,
        executable: executed.executable,
        args: executed.args,
        exitCode: executed.exitCode,
        signal: executed.signal,
        durationMs: executed.durationMs,
        status: executed.status,
        logPath: executed.logPath
      };
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
            timedOut,
            timeoutMs,
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
        const commandFailedCode = timedOut
          ? EventCodes.VALIDATION_COMMAND_TIMED_OUT
          : EventCodes.VALIDATION_COMMAND_FAILED;
        const commandFailedMessage = timedOut
          ? `Validation command ${command.id} timed out after ${timeoutMs}ms.`
          : `Validation command ${command.id} failed.`;
        await recordRunEvent({
          repository,
          logger: runLogger,
          eventId: nextEventId("validation", commandFailedCode),
          taskId,
          runId,
          phase: "validation",
          level: "error",
          code: commandFailedCode,
          message: commandFailedMessage,
          failureClass: "validation_failure",
          durationMs: commandResult.durationMs,
          data: {
            commandId: command.id,
            commandName: command.name,
            exitCode: commandResult.exitCode,
            signal: commandResult.signal,
            logPath: commandResult.logPath,
            workspaceId: workspace.workspaceId,
            timedOut,
            timeoutMs
          },
          createdAt: commandStartedAtIso
        });
        throw new PlanningPipelineFailure({
          message: commandFailedMessage,
          failureClass: "validation_failure",
          phase: "validation",
          code: commandFailedCode,
          details: {
            commandId: command.id,
            commandName: command.name,
            exitCode: commandResult.exitCode,
            signal: commandResult.signal,
            logPath: commandResult.logPath,
            workspaceId: workspace.workspaceId,
            timedOut,
            timeoutMs
          },
          taskId,
          runId
        });
      }
      await recordRunEvent({
        repository,
        logger: runLogger,
        eventId: nextEventId("validation", EventCodes.VALIDATION_COMMAND_PASSED),
        taskId,
        runId,
        phase: "validation",
        level: "info",
        code: EventCodes.VALIDATION_COMMAND_PASSED,
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
      await heartbeatTrackedRun({
        phase: "validation",
        persistTrackedRun,
        clock,
        metadata: {
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
    const developerCodeWriteEnabled =
      readDevelopmentCodeWriteEnabledFromSnapshot(snapshot);
    await scrubWorkspaceSecretLeaseOnPhaseExit({
      repository,
      logger: runLogger,
      taskId,
      runId,
      phase: "validation",
      workspace,
      clock,
      nextEventId
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
          resultsArchiveLocation: archivedResults.location,
          developerCodeWriteEnabled
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
          developerCodeWriteEnabled,
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
      eventId: nextEventId("validation", EventCodes.PHASE_PASSED),
      taskId,
      runId,
      phase: "validation",
      level: "info",
      code: EventCodes.PHASE_PASSED,
      message: "Validation checks passed in the managed workspace.",
      durationMs: getDurationMs(validationStartedAt, validationCompletedAt),
      data: {
        actor: "validation",
        workspaceId: workspace.workspaceId,
        reportPath,
        reportArchiveLocation: archivedReport.location,
        resultsArchiveLocation: archivedResults.location,
        developerCodeWriteEnabled,
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
        resultsArchiveLocation: archivedResults.location,
        developerCodeWriteEnabled
      }
    });
    const nextAction =
      taskRequestsPullRequest(currentManifest) && developerCodeWriteEnabled
        ? "await_scm"
        : "await_review";
    const nextPhase = nextAction === "await_scm" ? "scm" : "review";
    const blockedMessage =
      nextAction === "await_scm"
        ? "Validation phase completed and is ready for SCM branch and pull-request creation."
        : taskRequestsPullRequest(currentManifest)
          ? "Validation phase completed, but SCM handoff is unavailable because the developer phase stayed read-only."
          : "Validation phase completed, but review automation is not implemented yet.";
    const blockedAt = clock();
    const blockedAtIso = asIsoTimestamp(blockedAt);
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("validation", EventCodes.PIPELINE_BLOCKED),
      taskId,
      runId,
      phase: "validation",
      level: "warn",
      code: EventCodes.PIPELINE_BLOCKED,
      message: blockedMessage,
      durationMs: getDurationMs(runStartedAt, blockedAt),
      data: {
        nextPhase,
        nextAction,
        workspaceId: workspace.workspaceId,
        reportPath,
        reportArchiveLocation: archivedReport.location,
        resultsArchiveLocation: archivedResults.location,
        developerCodeWriteEnabled
      },
      createdAt: blockedAtIso
    });

    currentManifest = patchManifest(currentManifest, {
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
        resultsArchiveLocation: archivedResults.location,
        developerCodeWriteEnabled
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
    let scrubFailure: unknown = null;

    if (workspace) {
      try {
        await scrubWorkspaceSecretLeaseOnPhaseExit({
          repository,
          logger: runLogger,
          taskId,
          runId,
          phase: "validation",
          workspace,
          clock,
          nextEventId
        });
      } catch (secretScrubError) {
        scrubFailure = secretScrubError;
        runLogger.error("Failed to scrub validation workspace credentials after phase exit.", {
          runId,
          taskId,
          persistenceError: serializeError(secretScrubError)
        });
      }
    }

    let pipelineFailure = normalizePipelineFailure(
      error,
      "validation",
      taskId,
      runId
    );

    if (scrubFailure) {
      pipelineFailure = new PlanningPipelineFailure({
        message: pipelineFailure.message,
        failureClass: pipelineFailure.failureClass,
        phase: pipelineFailure.phase,
        code: pipelineFailure.code,
        details: {
          ...(pipelineFailure.details ?? {}),
          credentialScrubFailure: serializeError(scrubFailure)
        },
        cause: pipelineFailure.cause,
        taskId,
        runId
      });
    }
    const failedAt = clock();
    const failedAtIso = asIsoTimestamp(failedAt);
    currentManifest = patchManifest(currentManifest, {
      currentPhase: "validation",
      lifecycleStatus: "failed",
      updatedAt: failedAtIso
    });

    try {
      currentManifest = await persistPhaseFailure({
        repository, snapshot, manifest: currentManifest,
        phase: "validation", runId, failure: pipelineFailure,
        runLogger, nextEventId, runStartedAt, failedAt, failedAtIso,
        persistTrackedRun, github: dependencies.github
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
