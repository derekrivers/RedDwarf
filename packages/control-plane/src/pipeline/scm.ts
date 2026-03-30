import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  asIsoTimestamp
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
  type GitHubAdapter
} from "@reddwarf/integrations";
import {
  archiveEvidenceArtifact,
  buildArchivedArtifactMetadata,
  createWorkspaceContextBundle,
  materializeManagedWorkspace,
  workspaceLocationPrefix
} from "../workspace.js";
import {
  AllowedPathViolationError,
  assignWorkspaceRepoRoot,
  createGitHubWorkspaceRepoBootstrapper,
  createGitWorkspaceCommitPublisher
} from "../live-workflow.js";
import {
  createConcurrencyDecision,
  createPhaseRecord,
  createSourceConcurrencyKey,
  getDurationMs,
  heartbeatTrackedRun,
  patchManifest,
  readDevelopmentCodeWriteEnabledFromSnapshot,
  readPlanningDefaultBranchFromSnapshot,
  readValidationReportPathFromSnapshot,
  readValidationSummaryFromSnapshot,
  recordRunEvent,
  requireApprovedRequest,
  requireNoFailureEscalation,
  requirePhaseSnapshot,
  resolvePhaseDependencies,
  serializeError,
  taskManifestSchema,
  taskRequestsPullRequest,
  waitWithHeartbeat,
  findApprovedFailureEscalationRequest
} from "./shared.js";
import {
  createPhaseRunContext
} from "./context.js";
import {
  EventCodes,
  PHASE_HEARTBEAT_INTERVAL_MS,
  PlanningPipelineFailure,
  type RunScmPhaseInput,
  type ScmPhaseDependencies,
  type ScmPhaseResult
} from "./types.js";
import {
  normalizePipelineFailure,
  persistConcurrencyBlock,
  persistPhaseFailure
} from "./failure.js";
import {
  renderScmDiffMarkdown,
  renderScmReportMarkdown
} from "./prompts.js";

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
  const { logger, clock, idGenerator, concurrency } = resolvePhaseDependencies("scm", dependencies);
  const heartbeatIntervalMs =
    dependencies.timing?.heartbeatIntervalMs ?? PHASE_HEARTBEAT_INTERVAL_MS;
  const workspaceRepoBootstrapper =
    dependencies.workspaceRepoBootstrapper ??
    createGitHubWorkspaceRepoBootstrapper({
      ...(dependencies.timing?.gitCommandTimeoutMs !== undefined
        ? { commandTimeoutMs: dependencies.timing.gitCommandTimeoutMs }
        : {})
    });
  const workspaceCommitPublisher =
    dependencies.workspaceCommitPublisher ??
    createGitWorkspaceCommitPublisher({
      ...(dependencies.timing?.gitCommandTimeoutMs !== undefined
        ? { commandTimeoutMs: dependencies.timing.gitCommandTimeoutMs }
        : {})
    });
  const rawSnapshot = await repository.getTaskSnapshot(taskId);
  const { snapshot, manifest: validatedManifest, spec: validatedSpec, policySnapshot: validatedPolicySnapshot } = requirePhaseSnapshot(rawSnapshot, taskId);

  if (!taskRequestsPullRequest(validatedManifest)) {
    throw new Error(
      `Task ${taskId} did not request can_open_pr and cannot enter SCM.`
    );
  }

  const approvedRequest = requireApprovedRequest(snapshot, validatedManifest, "scm");
  requireNoFailureEscalation(snapshot, taskId, "scm");
  const approvedFailureRetry = findApprovedFailureEscalationRequest(
    snapshot,
    "scm"
  );

  const lifecycleAllowsScm =
    (validatedManifest.lifecycleStatus === "blocked" &&
      ["validation", "scm"].includes(validatedManifest.currentPhase)) ||
    (validatedManifest.lifecycleStatus === "active" &&
      validatedManifest.currentPhase === "scm") ||
    (validatedManifest.lifecycleStatus === "ready" &&
      validatedManifest.currentPhase === "scm" &&
      approvedFailureRetry !== null);

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

  const developerCodeWriteEnabled =
    readDevelopmentCodeWriteEnabledFromSnapshot(snapshot);

  if (!developerCodeWriteEnabled) {
    throw new Error(
      `Task ${taskId} cannot enter SCM because the developer phase completed with code writing disabled.`
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
  const { runLogger, nextEventId, persistTrackedRun } = createPhaseRunContext({
    runId,
    taskId,
    sourceRepo: currentManifest.source.repo,
    phase: "scm",
    getTrackedRun: () => trackedRun,
    setTrackedRun: (run) => { trackedRun = run; },
    repository,
    logger
  });

  const { staleRunIds, blockedByRun } = await repository.claimPipelineRun({
    run: trackedRun,
    staleAfterMs: concurrency.staleAfterMs
  });

  if (blockedByRun) {
    concurrencyDecision = await persistConcurrencyBlock({
      repository, trackedRun, concurrencyKey,
      strategy: concurrency.strategy, taskId, runId,
      phase: "scm", runStartedAt, runStartedAtIso,
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
        eventId: nextEventId("scm", EventCodes.STALE_RUNS_DETECTED),
        taskId,
        runId,
        phase: "scm",
        level: "info",
        code: EventCodes.STALE_RUNS_DETECTED,
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
    currentManifest = patchManifest(currentManifest, {
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
      eventId: nextEventId("scm", EventCodes.PHASE_RUNNING),
      taskId,
      runId,
      phase: "scm",
      level: "info",
      code: EventCodes.PHASE_RUNNING,
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
    const scmHeartbeatMetadata = {
      workspaceId,
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
          phase: "scm",
          persistTrackedRun,
          clock,
          metadata: {
            ...scmHeartbeatMetadata,
            scmStep: "repo_bootstrap"
          }
        })
    });
    assignWorkspaceRepoRoot(workspace, repoBootstrap.repoRoot);
    currentManifest = patchManifest(currentManifest, {
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
      eventId: nextEventId("scm", EventCodes.WORKSPACE_PREPARED),
      taskId,
      runId,
      phase: "scm",
      level: "info",
      code: EventCodes.WORKSPACE_PREPARED,
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

    let publication: import("../live-workflow.js").WorkspaceCommitPublicationResult;

    try {
      publication = await waitWithHeartbeat({
        work: workspaceCommitPublisher.publish({
          manifest: currentManifest,
          workspace,
          baseBranch: draft.baseBranch,
          branchName: draft.branchName,
          allowedPaths: approvedRequest?.allowedPaths ?? validatedPolicySnapshot.allowedPaths,
          logger: runLogger
        }),
        heartbeatIntervalMs,
        onHeartbeat: () =>
          heartbeatTrackedRun({
            phase: "scm",
            persistTrackedRun,
            clock,
            metadata: {
              ...scmHeartbeatMetadata,
              scmStep: "publish",
              branchName: draft.branchName,
              baseBranch: draft.baseBranch
            }
          })
      });
    } catch (error) {
      if (error instanceof AllowedPathViolationError) {
        throw new PlanningPipelineFailure({
          message: error.message,
          failureClass: "policy_violation",
          phase: "scm",
          code: EventCodes.ALLOWED_PATHS_VIOLATED,
          details: {
            workspaceId: workspace.workspaceId,
            baseBranch: draft.baseBranch,
            branchName: draft.branchName,
            allowedPaths: error.allowedPaths,
            changedFiles: error.changedFiles,
            violatingFiles: error.violatingFiles
          },
          cause: error,
          taskId,
          runId
        });
      }

      throw error;
    }
    const branch = publication.branch;
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("scm", EventCodes.BRANCH_CREATED),
      taskId,
      runId,
      phase: "scm",
      level: "info",
      code: EventCodes.BRANCH_CREATED,
      message: `SCM branch ${branch.branchName} created with commit ${publication.commitSha}.`,
      data: {
        workspaceId: workspace.workspaceId,
        baseBranch: branch.baseBranch,
        branchName: branch.branchName,
        branchUrl: branch.url,
        branchRef: branch.ref,
        commitSha: publication.commitSha,
        changedFiles: publication.changedFiles
      },
      createdAt: scmStartedAtIso
    });
    await heartbeatTrackedRun({
      phase: "scm",
      persistTrackedRun,
      clock,
      metadata: {
        workspaceId: workspace.workspaceId,
        branchName: branch.branchName,
        commitSha: publication.commitSha
      }
    });

    const pullRequest = await github.createPullRequest({
      repo: currentManifest.source.repo,
      baseBranch: draft.baseBranch,
      headBranch: publication.branch.branchName,
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
        publication,
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
        publication,
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
    currentManifest = patchManifest(currentManifest, {
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
          commitSha: publication.commitSha,
          changedFiles: publication.changedFiles,
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
          commitSha: publication.commitSha,
          changedFiles: publication.changedFiles,
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
          commitSha: publication.commitSha,
          changedFiles: publication.changedFiles,
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
          commitSha: publication.commitSha,
          changedFiles: publication.changedFiles,
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
      eventId: nextEventId("scm", EventCodes.PULL_REQUEST_CREATED),
      taskId,
      runId,
      phase: "scm",
      level: "info",
      code: EventCodes.PULL_REQUEST_CREATED,
      message: `Pull request #${pullRequest.number} created for ${branch.branchName}.`,
      data: {
        workspaceId: workspace.workspaceId,
        branchName: branch.branchName,
        prNumber: pullRequest.number,
        pullRequestUrl: pullRequest.url,
        labels: draft.labels,
        commitSha: publication.commitSha
      },
      createdAt: scmCompletedAtIso
    });
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("scm", EventCodes.PHASE_PASSED),
      taskId,
      runId,
      phase: "scm",
      level: "info",
      code: EventCodes.PHASE_PASSED,
      message: "SCM branch and pull request created.",
      durationMs: getDurationMs(scmStartedAt, scmCompletedAt),
      data: {
        actor: "scm",
        workspaceId: workspace.workspaceId,
        branchName: branch.branchName,
        prNumber: pullRequest.number,
        reportPath,
        reportArchiveLocation: archivedScmReport.location,
        diffArchiveLocation: archivedScmDiff.location,
        commitSha: publication.commitSha
      },
      createdAt: scmCompletedAtIso
    });
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("scm", EventCodes.PIPELINE_COMPLETED),
      taskId,
      runId,
      phase: "scm",
      level: "info",
      code: EventCodes.PIPELINE_COMPLETED,
      message: "Task completed after SCM handoff.",
      durationMs: getDurationMs(runStartedAt, scmCompletedAt),
      data: {
        workspaceId: workspace.workspaceId,
        branchName: branch.branchName,
        prNumber: pullRequest.number,
        pullRequestUrl: pullRequest.url,
        commitSha: publication.commitSha,
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
        commitSha: publication.commitSha,
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
    currentManifest = patchManifest(currentManifest, {
      currentPhase: "scm",
      lifecycleStatus: "failed",
      updatedAt: failedAtIso
    });

    try {
      currentManifest = await persistPhaseFailure({
        repository, snapshot, manifest: currentManifest,
        phase: "scm", runId, failure: pipelineFailure,
        runLogger, nextEventId, runStartedAt, failedAt, failedAtIso,
        persistTrackedRun, github
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
