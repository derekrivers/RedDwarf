import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  architectureReviewReportSchema,
  asIsoTimestamp
} from "@reddwarf/contracts";
import {
  createApprovalRequest,
  createEvidenceRecord,
  createMemoryRecord,
  createPipelineRun,
  deriveOrganizationId
} from "@reddwarf/evidence";
import { assertPhaseExecutable } from "@reddwarf/execution-plane";
import {
  archiveEvidenceArtifact,
  buildArchivedArtifactMetadata,
  createWorkspaceContextBundle,
  materializeManagedWorkspace,
  workspaceLocationPrefix,
  type MaterializedManagedWorkspace
} from "../workspace.js";
import {
  assignWorkspaceRepoRoot,
  createArchitectureReviewAwaiter,
  createGitHubWorkspaceRepoBootstrapper
} from "../live-workflow.js";
import {
  createConcurrencyDecision,
  createPhaseRecord,
  createSourceConcurrencyKey,
  getDurationMs,
  heartbeatTrackedRun,
  patchManifest,
  readPlanningDefaultBranchFromSnapshot,
  recordRunEvent,
  requireApprovedRequest,
  requireNoFailureEscalation,
  requirePhaseSnapshot,
  resolvePhaseDependencies,
  resolveTaskMemoryContext,
  serializeError,
  taskManifestSchema,
  waitWithHeartbeat
} from "./shared.js";
import { createPhaseRunContext } from "./context.js";
import {
  EventCodes,
  PHASE_HEARTBEAT_INTERVAL_MS,
  PlanningPipelineFailure,
  type ArchitectureReviewPhaseDependencies,
  type ArchitectureReviewPhaseResult,
  type RunArchitectureReviewPhaseInput
} from "./types.js";
import {
  normalizePipelineFailure,
  persistConcurrencyBlock,
  persistPhaseFailure
} from "./failure.js";
import { enforceTokenBudget } from "./token-budget.js";
import {
  buildOpenClawArchitectureReviewPrompt,
  renderArchitectureReviewReportMarkdown
} from "./prompts.js";
import { capturePromptSnapshot } from "./prompt-registry.js";
import { buildOpenClawIssueSessionKeyFromManifest } from "../openclaw-session-key.js";

export async function runArchitectureReviewPhase(
  input: RunArchitectureReviewPhaseInput,
  dependencies: ArchitectureReviewPhaseDependencies
): Promise<ArchitectureReviewPhaseResult> {
  const taskId = input.taskId.trim();

  if (taskId.length === 0) {
    throw new Error(
      "Task id is required to run the architecture review phase."
    );
  }

  const repository = dependencies.repository;
  const reviewer = dependencies.reviewer;
  const { logger, clock, idGenerator, concurrency } = resolvePhaseDependencies(
    "architecture_review",
    dependencies
  );
  const heartbeatIntervalMs =
    dependencies.timing?.heartbeatIntervalMs ?? PHASE_HEARTBEAT_INTERVAL_MS;
  const workspaceRepoBootstrapper =
    dependencies.workspaceRepoBootstrapper ??
    createGitHubWorkspaceRepoBootstrapper({
      ...(dependencies.timing?.gitCommandTimeoutMs !== undefined
        ? { commandTimeoutMs: dependencies.timing.gitCommandTimeoutMs }
        : {})
    });
  const reviewAwaiter =
    dependencies.architectureReviewAwaiter ??
    createArchitectureReviewAwaiter({
      ...(dependencies.timing?.openClawCompletionTimeoutMs !== undefined
        ? { timeoutMs: dependencies.timing.openClawCompletionTimeoutMs }
        : {}),
      ...(dependencies.timing?.heartbeatIntervalMs !== undefined
        ? { heartbeatIntervalMs: dependencies.timing.heartbeatIntervalMs }
        : {})
    });
  const rawSnapshot = await repository.getTaskSnapshot(taskId);
  const {
    snapshot,
    manifest: validatedManifest,
    spec: validatedSpec,
    policySnapshot: validatedPolicySnapshot
  } = requirePhaseSnapshot(rawSnapshot, taskId);
  const approvedRequest = requireApprovedRequest(
    snapshot,
    validatedManifest,
    "architecture_review"
  );
  requireNoFailureEscalation(snapshot, taskId, "architecture_review");

  const lifecycleAllowsArchitectureReview =
    (validatedManifest.lifecycleStatus === "blocked" &&
      ["development", "architecture_review"].includes(
        validatedManifest.currentPhase
      )) ||
    (validatedManifest.lifecycleStatus === "active" &&
      validatedManifest.currentPhase === "architecture_review");

  if (!lifecycleAllowsArchitectureReview) {
    throw new Error(
      `Task ${taskId} is ${validatedManifest.lifecycleStatus} in phase ${validatedManifest.currentPhase} and cannot enter architecture review.`
    );
  }

  if (
    input.workspaceId &&
    validatedManifest.workspaceId &&
    input.workspaceId !== validatedManifest.workspaceId
  ) {
    throw new Error(
      `Architecture review must reuse workspace ${validatedManifest.workspaceId}; received ${input.workspaceId}.`
    );
  }

  const workspaceId = validatedManifest.workspaceId ?? input.workspaceId;

  if (!workspaceId) {
    throw new Error(
      `Task ${taskId} requires a managed workspace from the developer phase before architecture review can start.`
    );
  }

  assertPhaseExecutable("architecture_review");

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
    dryRun: currentManifest.dryRun,
    status: "active",
    startedAt: runStartedAtIso,
    lastHeartbeatAt: runStartedAtIso,
    metadata: {
      sourceRepo: currentManifest.source.repo,
      phase: "architecture_review",
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
    phase: "architecture_review",
    getTrackedRun: () => trackedRun,
    setTrackedRun: (run) => {
      trackedRun = run;
    },
    repository,
    logger
  });
  let workspace: MaterializedManagedWorkspace | null = null;

  const { staleRunIds, blockedByRun } = await repository.claimPipelineRun({
    run: trackedRun,
    staleAfterMs: concurrency.staleAfterMs
  });

  if (blockedByRun) {
    concurrencyDecision = await persistConcurrencyBlock({
      repository,
      trackedRun,
      concurrencyKey,
      strategy: concurrency.strategy,
      taskId,
      runId,
      phase: "architecture_review",
      runStartedAt,
      runStartedAtIso,
      blockedByRun,
      staleRunIds,
      runLogger,
      nextEventId
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
        eventId: nextEventId(
          "architecture_review",
          EventCodes.STALE_RUNS_DETECTED
        ),
        taskId,
        runId,
        phase: "architecture_review",
        level: "info",
        code: EventCodes.STALE_RUNS_DETECTED,
        message:
          "Stale overlapping runs were marked before the architecture review phase started.",
        data: {
          concurrencyKey,
          staleRunIds,
          strategy: concurrency.strategy
        },
        createdAt: runStartedAtIso
      });
    }

    const reviewStartedAt = clock();
    const reviewStartedAtIso = asIsoTimestamp(reviewStartedAt);
    currentManifest = patchManifest(currentManifest, {
      currentPhase: "architecture_review",
      lifecycleStatus: "active",
      assignedAgentType: "reviewer",
      workspaceId,
      updatedAt: reviewStartedAtIso
    });
    await repository.updateManifest(currentManifest);
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("architecture_review", EventCodes.PHASE_RUNNING),
      taskId,
      runId,
      phase: "architecture_review",
      level: "info",
      code: EventCodes.PHASE_RUNNING,
      message: "Architecture review phase started.",
      data: {
        actor: "reviewer",
        workspaceId,
        ...(approvedRequest
          ? { approvalRequestId: approvedRequest.requestId }
          : {})
      },
      createdAt: reviewStartedAtIso
    });
    await persistTrackedRun({
      lastHeartbeatAt: reviewStartedAtIso,
      metadata: {
        currentPhase: "architecture_review",
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
    workspace = await materializeManagedWorkspace({
      bundle,
      targetRoot: input.targetRoot,
      workspaceId,
      createdAt: reviewStartedAtIso
    });
    currentManifest = patchManifest(currentManifest, {
      workspaceId: workspace.workspaceId,
      updatedAt: reviewStartedAtIso,
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
        recordId: `${taskId}:workspace:${workspace.workspaceId}:architecture-review:${runId}`,
        taskId,
        kind: "file_artifact",
        title: "Managed workspace prepared for architecture review",
        location: `${workspaceLocationPrefix}${workspace.workspaceId}`,
        metadata: {
          status: workspace.descriptor.status,
          workspaceRoot: workspace.workspaceRoot,
          stateFile: workspace.stateFile,
          descriptor: workspace.descriptor,
          phase: "architecture_review",
          runId
        },
        createdAt: reviewStartedAtIso
      })
    );
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId(
        "architecture_review",
        EventCodes.WORKSPACE_PREPARED
      ),
      taskId,
      runId,
      phase: "architecture_review",
      level: "info",
      code: EventCodes.WORKSPACE_PREPARED,
      message: "Architecture review workspace prepared.",
      data: {
        workspaceId: workspace.workspaceId,
        toolPolicyMode: workspace.descriptor.toolPolicy.mode,
        codeWriteEnabled: workspace.descriptor.toolPolicy.codeWriteEnabled
      },
      createdAt: reviewStartedAtIso
    });

    const developerHandoffPath = join(
      workspace.artifactsDir,
      "developer-handoff.md"
    );
    const developerHandoffMarkdown = await readFile(
      developerHandoffPath,
      "utf8"
    );
    const architectHandoffMarkdown = readArchitectHandoffMarkdown(snapshot);

    let report = architectureReviewReportSchema.parse({
      verdict: "escalate",
      summary: "Architecture review did not produce a verdict.",
      structuralDrift: [
        "The architecture review report was missing before phase completion."
      ],
      checks: [
        {
          name: "review_output",
          status: "fail",
          detail: "No structured architecture review report was produced."
        }
      ],
      findings: [
        {
          severity: "error",
          summary: "Missing architecture review report",
          detail:
            "The phase completed without a valid architecture review report artifact.",
          affectedPaths: []
        }
      ],
      recommendedNextActions: [
        "Inspect the architecture review runner and rerun the phase."
      ]
    });
    let reportJsonPath = join(workspace.artifactsDir, "architecture-review.json");
    let dispatchResult: import("@reddwarf/integrations").OpenClawDispatchResult | null = null;
    let reviewTokenBudget: import("@reddwarf/contracts").TokenBudgetResult | null = null;

    if (dependencies.openClawDispatch) {
      const baseBranch = readPlanningDefaultBranchFromSnapshot(snapshot);
      const reviewHeartbeatMetadata = {
        workspaceId: workspace.workspaceId,
        ...(approvedRequest
          ? { approvalRequestId: approvedRequest.requestId }
          : {})
      };
      const repoBootstrap = await waitWithHeartbeat({
        work: workspaceRepoBootstrapper.ensureRepo({
          manifest: currentManifest,
          workspace,
          baseBranch,
          logger: runLogger
        }),
        heartbeatIntervalMs,
        onHeartbeat: () =>
          heartbeatTrackedRun({
            phase: "architecture_review",
            persistTrackedRun,
            clock,
            metadata: {
              ...reviewHeartbeatMetadata,
              architectureReviewStep: "repo_bootstrap"
            }
          })
      });
      assignWorkspaceRepoRoot(workspace, repoBootstrap.repoRoot);

      const openClawReviewAgentId =
        dependencies.openClawReviewAgentId ?? "reddwarf-arch-reviewer";
      const sessionKey = buildOpenClawIssueSessionKeyFromManifest(currentManifest);
      const prompt = buildOpenClawArchitectureReviewPrompt(
        bundle,
        currentManifest,
        workspace,
        architectHandoffMarkdown,
        dependencies.runtimeConfig
      );
      await capturePromptSnapshot({
        repository,
        logger: runLogger,
        nextEventId,
        taskId,
        runId,
        phase: "architecture_review",
        promptPath:
          "packages/control-plane/src/pipeline/prompts.ts#buildOpenClawArchitectureReviewPrompt",
        promptText: prompt,
        capturedAt: asIsoTimestamp(clock()),
        metadata: {
          mode: "openclaw",
          workspaceId: workspace.workspaceId
        }
      });
      reviewTokenBudget = await enforceTokenBudget({
        repository,
        logger: runLogger,
        nextEventId,
        manifest: currentManifest,
        runId,
        phase: "architecture_review",
        actor: "reviewer",
        contextValue: prompt,
        checkedAt: asIsoTimestamp(clock()),
        detailLabel: "Architecture review prompt",
        eventData: {
          workspaceId: workspace.workspaceId,
          mode: "openclaw"
        }
      });

      dispatchResult = await dependencies.openClawDispatch.dispatch({
        sessionKey,
        agentId: openClawReviewAgentId,
        prompt,
        metadata: {
          taskId,
          runId,
          phase: "architecture_review",
          workspaceId: workspace.workspaceId
        }
      });

      await recordRunEvent({
        repository,
        logger: runLogger,
        eventId: nextEventId(
          "architecture_review",
          EventCodes.OPENCLAW_DISPATCH
        ),
        taskId,
        runId,
        phase: "architecture_review",
        level: "info",
        code: EventCodes.OPENCLAW_DISPATCH,
        message: `Dispatched to OpenClaw reviewer ${openClawReviewAgentId} with session key ${sessionKey}.`,
        data: {
          sessionKey,
          agentId: openClawReviewAgentId,
          accepted: dispatchResult.accepted,
          sessionId: dispatchResult.sessionId,
          repoRoot: repoBootstrap.repoRoot,
          baseBranch: repoBootstrap.baseBranch
        },
        createdAt: asIsoTimestamp(clock())
      });

      if (!dispatchResult.accepted) {
        throw new Error(
          `OpenClaw architecture review dispatch for ${taskId} was not accepted.`
        );
      }

      const completion = await reviewAwaiter.waitForCompletion({
        manifest: currentManifest,
        workspace,
        sessionKey,
        dispatchResult,
        logger: runLogger,
        onHeartbeat: () =>
          heartbeatTrackedRun({
            phase: "architecture_review",
            persistTrackedRun,
            clock,
            metadata: {
              ...reviewHeartbeatMetadata,
              sessionKey,
              openClawReviewAgentId
            }
          }),
        heartbeatIntervalMs
      });
      assignWorkspaceRepoRoot(
        workspace,
        completion.repoRoot ?? repoBootstrap.repoRoot
      );
      reportJsonPath = completion.reportPath;
      report = architectureReviewReportSchema.parse(
        JSON.parse(await readFile(completion.reportPath, "utf8"))
      );
    } else {
      reviewTokenBudget = await enforceTokenBudget({
        repository,
        logger: runLogger,
        nextEventId,
        manifest: currentManifest,
        runId,
        phase: "architecture_review",
        actor: "reviewer",
        contextValue: {
          bundle,
          workspaceId: workspace.workspaceId,
          architectHandoffMarkdown,
          developerHandoffMarkdown
        },
        checkedAt: asIsoTimestamp(clock()),
        detailLabel: "Architecture review",
        eventData: {
          workspaceId: workspace.workspaceId,
          mode: "deterministic"
        }
      });
      report = architectureReviewReportSchema.parse(
        await reviewer.reviewImplementation(bundle, {
          manifest: currentManifest,
          runId,
          workspace,
          architectHandoffMarkdown,
          developerHandoffMarkdown
        })
      );
      await writeFile(
        reportJsonPath,
        `${JSON.stringify(report, null, 2)}\n`,
        "utf8"
      );
    }

    const reviewCompletedAt = clock();
    const reviewCompletedAtIso = asIsoTimestamp(reviewCompletedAt);
    const reportMarkdownPath = join(
      workspace.artifactsDir,
      "architecture-review.md"
    );
    await writeFile(
      reportMarkdownPath,
      renderArchitectureReviewReportMarkdown({
        bundle,
        report,
        workspace,
        runId
      }),
      "utf8"
    );

    const reportSourceLocation = `${workspaceLocationPrefix}${workspace.workspaceId}/artifacts/architecture-review.json`;
    const reportMarkdownSourceLocation = `${workspaceLocationPrefix}${workspace.workspaceId}/artifacts/architecture-review.md`;
    const archivedReport = await archiveEvidenceArtifact({
      taskId,
      runId,
      phase: "architecture_review",
      sourcePath: reportJsonPath,
      targetRoot: input.targetRoot,
      evidenceRoot: input.evidenceRoot,
      fileName: "architecture-review.json"
    });
    const archivedReportMarkdown = await archiveEvidenceArtifact({
      taskId,
      runId,
      phase: "architecture_review",
      sourcePath: reportMarkdownPath,
      targetRoot: input.targetRoot,
      evidenceRoot: input.evidenceRoot,
      fileName: "architecture-review.md"
    });

    await repository.saveMemoryRecord(
      createMemoryRecord({
        memoryId: `${taskId}:memory:task:architecture-review`,
        taskId,
        scope: "task",
        provenance: "pipeline_derived",
        key: "architecture_review.verdict",
        title: "Architecture review verdict",
        value: {
          verdict: report.verdict,
          summary: report.summary,
          structuralDrift: report.structuralDrift,
          checks: report.checks,
          findings: report.findings,
          recommendedNextActions: report.recommendedNextActions,
          runId,
          workspaceId: workspace.workspaceId,
          reportPath: reportJsonPath,
          reportArchiveLocation: archivedReport.location,
          reportMarkdownArchiveLocation: archivedReportMarkdown.location
        },
        repo: currentManifest.source.repo,
        organizationId: deriveOrganizationId(currentManifest.source.repo),
        tags: ["architecture_review", "task"],
        createdAt: reviewCompletedAtIso,
        updatedAt: reviewCompletedAtIso
      })
    );

    const phaseStatus =
      report.verdict === "pass"
        ? "passed"
        : report.verdict === "fail"
          ? "failed"
          : "escalated";
    await repository.savePhaseRecord(
      createPhaseRecord({
        id: `${taskId}:phase:architecture_review`,
        taskId,
        phase: "architecture_review",
        status: phaseStatus,
        actor: "reviewer",
        summary: report.summary,
        details: {
          workspaceId: workspace.workspaceId,
          verdict: report.verdict,
          structuralDrift: report.structuralDrift,
          checks: report.checks,
          findings: report.findings,
          ...(reviewTokenBudget ? { tokenBudget: reviewTokenBudget } : {}),
          reportArchiveLocation: archivedReport.location,
          reportMarkdownArchiveLocation: archivedReportMarkdown.location,
          ...(approvedRequest
            ? { approvalRequestId: approvedRequest.requestId }
            : {})
        },
        createdAt: reviewCompletedAtIso
      })
    );
    await repository.saveEvidenceRecord(
      createEvidenceRecord({
        recordId: `${taskId}:architecture-review:${runId}:json`,
        taskId,
        kind: "file_artifact",
        title: "Architecture review verdict",
        location: archivedReport.location,
        metadata: {
          runId,
          workspaceId: workspace.workspaceId,
          verdict: report.verdict,
          summary: report.summary,
          findings: report.findings,
          ...(reviewTokenBudget ? { tokenBudget: reviewTokenBudget } : {}),
          ...buildArchivedArtifactMetadata({
            archivedArtifact: archivedReport,
            artifactClass: "review_output",
            sourceLocation: reportSourceLocation,
            sourcePath: reportJsonPath
          })
        },
        createdAt: reviewCompletedAtIso
      })
    );
    await repository.saveEvidenceRecord(
      createEvidenceRecord({
        recordId: `${taskId}:architecture-review:${runId}:markdown`,
        taskId,
        kind: "file_artifact",
        title: "Architecture review report",
        location: archivedReportMarkdown.location,
        metadata: {
          runId,
          workspaceId: workspace.workspaceId,
          verdict: report.verdict,
          summary: report.summary,
          ...(reviewTokenBudget ? { tokenBudget: reviewTokenBudget } : {}),
          ...buildArchivedArtifactMetadata({
            archivedArtifact: archivedReportMarkdown,
            artifactClass: "review_output",
            sourceLocation: reportMarkdownSourceLocation,
            sourcePath: reportMarkdownPath
          })
        },
        createdAt: reviewCompletedAtIso
      })
    );

    if (report.verdict === "pass") {
      await recordRunEvent({
        repository,
        logger: runLogger,
        eventId: nextEventId(
          "architecture_review",
          EventCodes.PHASE_PASSED
        ),
        taskId,
        runId,
        phase: "architecture_review",
        level: "info",
        code: EventCodes.PHASE_PASSED,
        message: "Architecture review passed and validation may proceed.",
        durationMs: getDurationMs(reviewStartedAt, reviewCompletedAt),
        data: {
          actor: "reviewer",
          workspaceId: workspace.workspaceId,
          verdict: report.verdict,
          ...(reviewTokenBudget ? { tokenBudget: reviewTokenBudget } : {}),
          reportArchiveLocation: archivedReport.location,
          reportMarkdownArchiveLocation: archivedReportMarkdown.location
        },
        createdAt: reviewCompletedAtIso
      });
      await persistTrackedRun({
        lastHeartbeatAt: reviewCompletedAtIso,
        metadata: {
          currentPhase: "architecture_review",
          workspaceId: workspace.workspaceId,
          verdict: report.verdict,
          reportArchiveLocation: archivedReport.location,
          reportMarkdownArchiveLocation: archivedReportMarkdown.location
        }
      });

      const blockedAt = clock();
      const blockedAtIso = asIsoTimestamp(blockedAt);
      await recordRunEvent({
        repository,
        logger: runLogger,
        eventId: nextEventId(
          "architecture_review",
          EventCodes.PIPELINE_BLOCKED
        ),
        taskId,
        runId,
        phase: "architecture_review",
        level: "warn",
        code: EventCodes.PIPELINE_BLOCKED,
        message:
          "Architecture review completed and the task is ready for validation.",
        durationMs: getDurationMs(runStartedAt, blockedAt),
        data: {
          nextPhase: "validation",
          nextAction: "await_validation",
          workspaceId: workspace.workspaceId,
          verdict: report.verdict,
          reportArchiveLocation: archivedReport.location,
          reportMarkdownArchiveLocation: archivedReportMarkdown.location
        },
        createdAt: blockedAtIso
      });

      currentManifest = patchManifest(currentManifest, {
        currentPhase: "architecture_review",
        lifecycleStatus: "blocked",
        updatedAt: blockedAtIso
      });
      await repository.updateManifest(currentManifest);
      await persistTrackedRun({
        status: "blocked",
        lastHeartbeatAt: blockedAtIso,
        completedAt: blockedAtIso,
        metadata: {
          currentPhase: "architecture_review",
          nextAction: "await_validation",
          workspaceId: workspace.workspaceId,
          verdict: report.verdict,
          reportArchiveLocation: archivedReport.location,
          reportMarkdownArchiveLocation: archivedReportMarkdown.location
        }
      });

      return {
        runId,
        manifest: currentManifest,
        workspace,
        report,
        reportPath: reportJsonPath,
        nextAction: "await_validation",
        concurrencyDecision,
        ...(dispatchResult !== null
          ? { openClawDispatchResult: dispatchResult }
          : {})
      };
    }

    const verdictEventCode =
      report.verdict === "escalate"
        ? EventCodes.PHASE_ESCALATED
        : EventCodes.PHASE_BLOCKED;
    const verdictMessage =
      report.verdict === "escalate"
        ? "Architecture review escalated for human follow-up before validation."
        : "Architecture review failed; validation is blocked until the drift is addressed.";
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("architecture_review", verdictEventCode),
      taskId,
      runId,
      phase: "architecture_review",
      level: "warn",
      code: verdictEventCode,
      message: verdictMessage,
      failureClass: "review_failure",
      durationMs: getDurationMs(reviewStartedAt, reviewCompletedAt),
      data: {
        actor: "reviewer",
        workspaceId: workspace.workspaceId,
        verdict: report.verdict,
        structuralDrift: report.structuralDrift,
        findings: report.findings,
        reportArchiveLocation: archivedReport.location,
        reportMarkdownArchiveLocation: archivedReportMarkdown.location
      },
      createdAt: reviewCompletedAtIso
    });

    const blockedAt = clock();
    const blockedAtIso = asIsoTimestamp(blockedAt);
    const reviewApprovalRequest = createApprovalRequest({
      requestId: `${taskId}:approval:architecture_review:${runId}`,
      taskId,
      runId,
      phase: "architecture_review",
      dryRun: currentManifest.dryRun,
      approvalMode: currentManifest.approvalMode,
      status: "pending",
      riskClass: currentManifest.riskClass,
      summary:
        report.verdict === "escalate"
          ? "Architecture review escalated and requires human approval to continue to validation."
          : "Architecture review failed. Human approval is required to override the verdict and continue to validation.",
      requestedCapabilities: currentManifest.requestedCapabilities,
      allowedPaths: validatedPolicySnapshot.allowedPaths,
      blockedPhases: ["validation", "scm"],
      policyReasons: [
        `Architecture review verdict: ${report.verdict}`,
        report.summary,
        ...report.recommendedNextActions
      ],
      requestedBy: "architecture-review",
      createdAt: blockedAtIso,
      updatedAt: blockedAtIso
    });
    await repository.saveApprovalRequest(reviewApprovalRequest);
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId(
        "architecture_review",
        EventCodes.PIPELINE_BLOCKED
      ),
      taskId,
      runId,
      phase: "architecture_review",
      level: "warn",
      code: EventCodes.PIPELINE_BLOCKED,
      message:
        report.verdict === "escalate"
          ? "Architecture review blocked the pipeline pending human judgment."
          : "Architecture review blocked the pipeline pending implementation rework.",
      failureClass: "review_failure",
      durationMs: getDurationMs(runStartedAt, blockedAt),
      data: {
        nextAction: "await_human_review",
        workspaceId: workspace.workspaceId,
        verdict: report.verdict,
        structuralDrift: report.structuralDrift,
        approvalRequestId: reviewApprovalRequest.requestId,
        reportArchiveLocation: archivedReport.location,
        reportMarkdownArchiveLocation: archivedReportMarkdown.location
      },
      createdAt: blockedAtIso
    });

    currentManifest = patchManifest(currentManifest, {
      currentPhase: "architecture_review",
      lifecycleStatus: "blocked",
      updatedAt: blockedAtIso
    });
    await repository.updateManifest(currentManifest);
    await persistTrackedRun({
      status: "blocked",
      lastHeartbeatAt: blockedAtIso,
      completedAt: blockedAtIso,
      metadata: {
        currentPhase: "architecture_review",
        nextAction: "await_human_review",
        workspaceId: workspace.workspaceId,
        verdict: report.verdict,
        approvalRequestId: reviewApprovalRequest.requestId,
        reportArchiveLocation: archivedReport.location,
        reportMarkdownArchiveLocation: archivedReportMarkdown.location
      }
    });

    return {
      runId,
      manifest: currentManifest,
      workspace,
      report,
      reportPath: reportJsonPath,
      nextAction: "await_human_review",
      concurrencyDecision,
      approvalRequest: reviewApprovalRequest,
      ...(dispatchResult !== null
        ? { openClawDispatchResult: dispatchResult }
        : {})
    };
  } catch (error) {
    let pipelineFailure = normalizePipelineFailure(
      error,
      "architecture_review",
      taskId,
      runId
    );

    if (error instanceof SyntaxError) {
      pipelineFailure = new PlanningPipelineFailure({
        message: `Architecture review output for ${taskId} was not valid JSON.`,
        failureClass: "review_failure",
        phase: "architecture_review",
        code: "ARCHITECTURE_REVIEW_OUTPUT_INVALID",
        details: {
          cause: serializeError(error)
        },
        cause: error,
        taskId,
        runId
      });
    }

    const failedAt = clock();
    const failedAtIso = asIsoTimestamp(failedAt);
    currentManifest = patchManifest(currentManifest, {
      currentPhase: "architecture_review",
      lifecycleStatus: "failed",
      updatedAt: failedAtIso
    });

    try {
      currentManifest = await persistPhaseFailure({
        repository,
        snapshot,
        manifest: currentManifest,
        phase: "architecture_review",
        runId,
        failure: pipelineFailure,
        runLogger,
        nextEventId,
        runStartedAt,
        failedAt,
        failedAtIso,
        persistTrackedRun
      });
    } catch (persistenceError) {
      runLogger.error(
        "Failed to persist architecture review phase failure evidence.",
        {
          runId,
          taskId,
          failureClass: pipelineFailure.failureClass,
          code: pipelineFailure.code,
          persistenceError: serializeError(persistenceError)
        }
      );
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

function readArchitectHandoffMarkdown(
  snapshot: import("@reddwarf/evidence").PersistedTaskSnapshot
): string | null {
  const architectMemory = snapshot.memoryRecords.find(
    (memory) => memory.key === "architect.handoff"
  );

  if (!architectMemory || typeof architectMemory.value !== "object") {
    return null;
  }

  const value = architectMemory.value as Record<string, unknown>;
  if (typeof value.summary !== "string") {
    return null;
  }

  const sections: string[] = [`# Architecture Plan`, "", value.summary];

  if (Array.isArray(value.affectedAreas) && value.affectedAreas.length > 0) {
    sections.push(
      "",
      "## Affected Areas",
      "",
      ...(value.affectedAreas as string[]).map((item) => `- ${item}`)
    );
  }

  if (Array.isArray(value.assumptions) && value.assumptions.length > 0) {
    sections.push(
      "",
      "## Assumptions",
      "",
      ...(value.assumptions as string[]).map((item) => `- ${item}`)
    );
  }

  if (Array.isArray(value.constraints) && value.constraints.length > 0) {
    sections.push(
      "",
      "## Constraints",
      "",
      ...(value.constraints as string[]).map((item) => `- ${item}`)
    );
  }

  if (
    Array.isArray(value.testExpectations) &&
    value.testExpectations.length > 0
  ) {
    sections.push(
      "",
      "## Test Expectations",
      "",
      ...(value.testExpectations as string[]).map((item) => `- ${item}`)
    );
  }

  return sections.join("\n");
}
