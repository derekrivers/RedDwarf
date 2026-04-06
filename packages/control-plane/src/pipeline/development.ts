import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  asIsoTimestamp,
  type DevelopmentDraft
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
  assertWorkspaceRepoChangesWithinAllowedPaths,
  assignWorkspaceRepoRoot,
  createDeveloperHandoffAwaiter,
  DEFAULT_OPENCLAW_COMPLETION_TIMEOUT_MS,
  createGitHubWorkspaceRepoBootstrapper,
  enableWorkspaceCodeWriting
} from "../live-workflow.js";
import {
  createConcurrencyDecision,
  createPhaseRecord,
  createSourceConcurrencyKey,
  getDurationMs,
  heartbeatTrackedRun,
  issueWorkspaceSecretLease,
  patchManifest,
  readPlanningDefaultBranchFromSnapshot,
  recordRunEvent,
  requireApprovedRequest,
  requireNoFailureEscalation,
  requirePhaseSnapshot,
  resolvePhaseDependencies,
  resolveTaskMemoryContext,
  scrubWorkspaceSecretLeaseOnPhaseExit,
  serializeError,
  taskManifestSchema,
  waitWithHeartbeat
} from "./shared.js";
import {
  createPhaseRunContext
} from "./context.js";
import {
  EventCodes,
  PHASE_HEARTBEAT_INTERVAL_MS,
  PlanningPipelineFailure,
  type DevelopmentPhaseDependencies,
  type DevelopmentPhaseResult,
  type RunDeveloperPhaseInput
} from "./types.js";
import {
  normalizePipelineFailure,
  persistConcurrencyBlock,
  persistPhaseFailure
} from "./failure.js";
import {
  buildDevelopmentComplexityProfile,
  enforceTokenBudget,
  resolveTokenBudgetConfig,
  scaleTimeoutBudgetMs,
  scaleTokenBudgetConfig
} from "./token-budget.js";
import {
  buildOpenClawDeveloperPrompt,
  parseDevelopmentHandoffMarkdown,
  renderDevelopmentHandoffMarkdown
} from "./prompts.js";
import { capturePromptSnapshot } from "./prompt-registry.js";
import { detectArchitectAffectedPathViolations, detectPreDispatchScopeRisks } from "../scope-risks.js";
import {
  materializeWorkspaceCiTool,
  processWorkspaceCiRequests
} from "../ci-tool.js";
import { buildOpenClawIssueSessionKeyFromManifest } from "../openclaw-session-key.js";

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
  const { logger, clock, idGenerator, concurrency } = resolvePhaseDependencies("development", dependencies);
  const heartbeatIntervalMs =
    dependencies.timing?.heartbeatIntervalMs ?? PHASE_HEARTBEAT_INTERVAL_MS;
  const workspaceRepoBootstrapper =
    dependencies.workspaceRepoBootstrapper ??
    createGitHubWorkspaceRepoBootstrapper({
      ...(dependencies.timing?.gitCommandTimeoutMs !== undefined
        ? { commandTimeoutMs: dependencies.timing.gitCommandTimeoutMs }
        : {})
    });
  const rawSnapshot = await repository.getTaskSnapshot(taskId);
  const { snapshot, manifest: validatedManifest, spec: validatedSpec, policySnapshot: validatedPolicySnapshot } = requirePhaseSnapshot(rawSnapshot, taskId);
  const developmentComplexity = buildDevelopmentComplexityProfile(
    validatedManifest,
    validatedSpec
  );
  const developmentTokenBudgetConfig = scaleTokenBudgetConfig(
    resolveTokenBudgetConfig(),
    "development",
    developmentComplexity.budgetMultiplier
  );
  const openClawCompletionAwaiter =
    dependencies.openClawCompletionAwaiter ??
    createDeveloperHandoffAwaiter({
      timeoutMs: scaleTimeoutBudgetMs(
        dependencies.timing?.openClawCompletionTimeoutMs ??
          DEFAULT_OPENCLAW_COMPLETION_TIMEOUT_MS,
        developmentComplexity.timeoutMultiplier
      ),
      ...(dependencies.timing?.heartbeatIntervalMs !== undefined
        ? { heartbeatIntervalMs: dependencies.timing.heartbeatIntervalMs }
        : {}),
      ...(dependencies.timing?.toolExecutionGracePeriodMs !== undefined
        ? { toolExecutionGracePeriodMs: dependencies.timing.toolExecutionGracePeriodMs }
        : {})
    });
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
    dryRun: currentManifest.dryRun,
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
  const { runLogger, nextEventId, persistTrackedRun } = createPhaseRunContext({
    runId,
    taskId,
    sourceRepo: currentManifest.source.repo,
    phase: "development",
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
      phase: "development", runStartedAt, runStartedAtIso,
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

  function workspaceAllowsTests(currentWorkspace: MaterializedManagedWorkspace): boolean {
    return currentWorkspace.descriptor.toolPolicy.allowedCapabilities.includes(
      "can_run_tests"
    );
  }

  function handoffClaimsTestExecution(handoff: DevelopmentDraft): boolean {
    const combined = [
      handoff.summary,
      ...handoff.implementationNotes,
      ...handoff.blockedActions,
      ...handoff.nextActions
    ];

    const testContextPattern =
      /\b(vitest|jest|testing library|npm test|pnpm test|npx vitest|test suite|tests?)\b/i;
    const explicitExecutionPattern =
      /\b(all\s+\d+\s+tests?\s+passed|tests?\s+(?:passed|pass|ran|run|executed|succeeded)|(?:npm|pnpm)\s+test(?:\s+\S+)*\s+(?:passed|completed|succeeded|ran|run|executed)|vitest(?:\s+\S+)*\s+(?:passed|completed|succeeded|ran|run|executed)|jest(?:\s+\S+)*\s+(?:passed|completed|succeeded|ran|run|executed)|validated\s+by\s+running\s+tests?)\b/i;
    const deferredOrNegativePattern =
      /\b(?:did not run|didn't run|not run|not ran|have not run|haven't run|has not run|were not run|was not run|have not been run|has not been run|not executed|have not executed|have not been executed|has not been executed|were not executed|was not executed|deferred|defer|deferred to validation|validation should run|validation must run|next action|follow-up|should run|can run later|run .* later|to be run|awaiting validation|unverified|not yet verified)\b/i;

    return combined.some((entry) => {
      const text = entry.trim();
      if (!testContextPattern.test(text)) {
        return false;
      }
      if (deferredOrNegativePattern.test(text)) {
        return false;
      }
      return explicitExecutionPattern.test(text);
    });
  }

  try {
    if (staleRunIds.length > 0) {
      await recordRunEvent({
        repository,
        logger: runLogger,
        eventId: nextEventId("development", EventCodes.STALE_RUNS_DETECTED),
        taskId,
        runId,
        phase: "development",
        level: "info",
        code: EventCodes.STALE_RUNS_DETECTED,
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
    currentManifest = patchManifest(currentManifest, {
      currentPhase: "development",
      lifecycleStatus: "active",
      assignedAgentType: "developer",
      updatedAt: developmentStartedAtIso
    });
    await repository.updateManifest(currentManifest);
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("development", EventCodes.PHASE_RUNNING),
      taskId,
      runId,
      phase: "development",
      level: "info",
      code: EventCodes.PHASE_RUNNING,
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
    const scopeRiskWarnings = detectPreDispatchScopeRisks(bundle.deniedPaths);
    const baseBranch = readPlanningDefaultBranchFromSnapshot(snapshot);
    secretLease = await issueWorkspaceSecretLease({
      bundle,
      phase: "development",
      ...(dependencies.secrets ? { secrets: dependencies.secrets } : {}),
      ...(dependencies.environment
        ? { environment: dependencies.environment }
        : {})
    });
    workspace = await materializeManagedWorkspace({
      bundle,
      targetRoot: input.targetRoot,
      workspaceId:
        input.workspaceId ??
        currentManifest.workspaceId ??
        `${taskId}-workspace`,
      createdAt: developmentStartedAtIso,
      secretLease
    });
    if (dependencies.ci) {
      await materializeWorkspaceCiTool({
        workspace,
        repo: currentManifest.source.repo,
        ref: baseBranch,
        ci: dependencies.ci
      });
    }
    currentManifest = patchManifest(currentManifest, {
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

    let handoff: DevelopmentDraft;
    let dispatchResult: import("@reddwarf/integrations").OpenClawDispatchResult | null = null;
    let developmentTokenBudget: import("@reddwarf/contracts").TokenBudgetResult | null = null;
    const handoffPath = join(workspace.artifactsDir, "developer-handoff.md");
    const developmentHeartbeatMetadata = {
      workspaceId: workspace.workspaceId,
      ...(approvedRequest
        ? { approvalRequestId: approvedRequest.requestId }
        : {})
    };

    const codeWritingApproved =
      dependencies.openClawDispatch !== undefined &&
      (approvedRequest?.requestedCapabilities.includes("can_write_code") ?? false);
    if (codeWritingApproved) {
      await enableWorkspaceCodeWriting(workspace);
    }

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
      eventId: nextEventId("development", EventCodes.WORKSPACE_PROVISIONED),
      taskId,
      runId,
      phase: "development",
      level: "info",
      code: EventCodes.WORKSPACE_PROVISIONED,
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
        eventId: nextEventId("development", EventCodes.SECRET_LEASE_ISSUED),
        taskId,
        runId,
        phase: "development",
        level: "info",
        code: EventCodes.SECRET_LEASE_ISSUED,
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

    if (dependencies.openClawDispatch) {
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
            phase: "development",
            persistTrackedRun,
            clock,
            metadata: {
              ...developmentHeartbeatMetadata,
              developmentStep: "repo_bootstrap"
            }
          })
      });
      assignWorkspaceRepoRoot(workspace, repoBootstrap.repoRoot);
      const openClawAgentId = dependencies.openClawAgentId ?? "reddwarf-developer";
      const sessionKey = buildOpenClawIssueSessionKeyFromManifest(currentManifest);
      if (scopeRiskWarnings.length > 0) {
        await recordRunEvent({
          repository,
          logger: runLogger,
          eventId: nextEventId("development", EventCodes.SCOPE_RISK_DETECTED),
          taskId,
          runId,
          phase: "development",
          level: "warn",
          code: EventCodes.SCOPE_RISK_DETECTED,
          message: "Pre-dispatch scope-risk checks found likely helper-file pressure outside the approved path list.",
          data: {
            workspaceId: workspace.workspaceId,
            warnings: scopeRiskWarnings
          },
          createdAt: asIsoTimestamp(clock())
        });
      }
      if ((dependencies.architectAffectedAreas?.length ?? 0) > 0) {
        const architectViolations = detectArchitectAffectedPathViolations(
          dependencies.architectAffectedAreas ?? [],
          bundle.deniedPaths
        );
        if (architectViolations.length > 0) {
          await recordRunEvent({
            repository,
            logger: runLogger,
            eventId: nextEventId("development", EventCodes.SCOPE_RISK_DETECTED),
            taskId,
            runId,
            phase: "development",
            level: "warn",
            code: EventCodes.SCOPE_RISK_DETECTED,
            message: "Architect handoff references files inside blocked repo paths. The developer may produce a denied-path violation at publish time.",
            data: {
              workspaceId: workspace.workspaceId,
              violatingFiles: architectViolations,
              deniedPaths: bundle.deniedPaths
            },
            createdAt: asIsoTimestamp(clock())
          });
        }
      }
      const prompt = buildOpenClawDeveloperPrompt(
        bundle,
        currentManifest,
        workspace,
        dependencies.runtimeConfig,
        scopeRiskWarnings
      );
      await capturePromptSnapshot({
        repository,
        logger: runLogger,
        nextEventId,
        taskId,
        runId,
        phase: "development",
        promptPath: "packages/control-plane/src/pipeline/prompts.ts#buildOpenClawDeveloperPrompt",
        promptText: prompt,
        capturedAt: asIsoTimestamp(clock()),
        metadata: {
          mode: "openclaw",
          workspaceId: workspace.workspaceId
        }
      });
      developmentTokenBudget = await enforceTokenBudget({
        repository,
        logger: runLogger,
        nextEventId,
        manifest: currentManifest,
        runId,
        phase: "development",
        actor: "developer",
        contextValue: prompt,
        checkedAt: asIsoTimestamp(clock()),
        detailLabel: "Developer prompt",
        eventData: {
          workspaceId: workspace.workspaceId,
          mode: "openclaw",
          complexity: developmentComplexity
        },
        config: developmentTokenBudgetConfig
      });

      dispatchResult = await dependencies.openClawDispatch.dispatch({
        sessionKey,
        agentId: openClawAgentId,
        prompt,
        metadata: {
          taskId,
          runId,
          phase: "development",
          workspaceId: workspace.workspaceId
        }
      });

      await recordRunEvent({
        repository,
        logger: runLogger,
        eventId: nextEventId("development", EventCodes.OPENCLAW_DISPATCH),
        taskId,
        runId,
        phase: "development",
        level: "info",
        code: EventCodes.OPENCLAW_DISPATCH,
        message: `Dispatched to OpenClaw agent ${openClawAgentId} with session key ${sessionKey}.`,
        data: {
          sessionKey,
          agentId: openClawAgentId,
          accepted: dispatchResult.accepted,
          sessionId: dispatchResult.sessionId,
          repoRoot: repoBootstrap.repoRoot,
          baseBranch: repoBootstrap.baseBranch
        },
        createdAt: asIsoTimestamp(clock())
      });

      if (!dispatchResult.accepted) {
        throw new Error(`OpenClaw developer dispatch for ${taskId} was not accepted.`);
      }

      const completion = await openClawCompletionAwaiter.waitForCompletion({
        manifest: currentManifest,
        workspace,
        sessionKey,
        dispatchResult,
        logger: runLogger,
        onHeartbeat: () =>
          heartbeatTrackedRun({
            phase: "development",
            persistTrackedRun,
            clock,
            metadata: {
              ...developmentHeartbeatMetadata,
              sessionKey,
              openClawAgentId
            }
          }),
        heartbeatIntervalMs
      });
      assignWorkspaceRepoRoot(workspace, completion.repoRoot ?? repoBootstrap.repoRoot);
      await assertWorkspaceRepoChangesWithinAllowedPaths(workspace, runLogger);
      handoff = parseDevelopmentHandoffMarkdown(
        await readFile(completion.handoffPath, "utf8")
      );
      if (!workspaceAllowsTests(workspace) && handoffClaimsTestExecution(handoff)) {
        throw new Error(
          `Developer handoff for ${taskId} claimed test execution even though the development workspace did not allow can_run_tests.`
        );
      }
    } else {
      await recordRunEvent({
        repository,
        logger: runLogger,
        eventId: nextEventId("development", EventCodes.CODE_WRITE_DISABLED),
        taskId,
        runId,
        phase: "development",
        level: "warn",
        code: EventCodes.CODE_WRITE_DISABLED,
        message:
          "Developer workspace is ready, but product code writes remain disabled by default.",
        data: {
          workspaceId: workspace.workspaceId,
          toolPolicyMode: workspace.descriptor.toolPolicy.mode,
          requestedCapabilities: currentManifest.requestedCapabilities
        },
        createdAt: developmentStartedAtIso
      });

      developmentTokenBudget = await enforceTokenBudget({
        repository,
        logger: runLogger,
        nextEventId,
        manifest: currentManifest,
        runId,
        phase: "development",
        actor: "developer",
        contextValue: {
          bundle,
          workspaceId: workspace.workspaceId,
          codeWriteEnabled: workspace.descriptor.toolPolicy.codeWriteEnabled
        },
        checkedAt: asIsoTimestamp(clock()),
        detailLabel: "Developer handoff",
        eventData: {
          workspaceId: workspace.workspaceId,
          mode: "deterministic",
          complexity: developmentComplexity
        },
        config: developmentTokenBudgetConfig
      });
      handoff = await developer.createHandoff(bundle, {
        manifest: currentManifest,
        runId,
        workspace,
        codeWriteEnabled: workspace.descriptor.toolPolicy.codeWriteEnabled
      });

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
    }

    if (!workspaceAllowsTests(workspace) && handoffClaimsTestExecution(handoff)) {
      throw new Error(
        `Developer handoff for ${taskId} claimed test execution even though the development workspace did not allow can_run_tests.`
      );
    }

    if (dependencies.ci) {
      const ciRequests = await processWorkspaceCiRequests({
        workspace,
        repo: currentManifest.source.repo,
        defaultRef: baseBranch,
        ci: dependencies.ci
      });
      const ciRequestsRecordedAt = asIsoTimestamp(clock());
      await repository.saveMemoryRecord(
        createMemoryRecord({
          memoryId: `${taskId}:memory:task:ci:development`,
          taskId,
          scope: "task",
          provenance: "pipeline_derived",
          key: "ci.development.requests",
          title: "Developer CI tool requests",
          value: ciRequests,
          repo: currentManifest.source.repo,
          organizationId: deriveOrganizationId(currentManifest.source.repo),
          tags: ["ci", "development", "task"],
          createdAt: ciRequestsRecordedAt,
          updatedAt: ciRequestsRecordedAt
        })
      );
    }

    const developmentCompletedAt = clock();
    const developmentCompletedAtIso = asIsoTimestamp(developmentCompletedAt);
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
    await scrubWorkspaceSecretLeaseOnPhaseExit({
      repository,
      logger: runLogger,
      taskId,
      runId,
      phase: "development",
      workspace,
      clock,
      nextEventId
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
          ...(developmentTokenBudget
            ? { tokenBudget: developmentTokenBudget }
            : {}),
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
          ...(developmentTokenBudget
            ? { tokenBudget: developmentTokenBudget }
            : {}),
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
      eventId: nextEventId("development", EventCodes.PHASE_PASSED),
      taskId,
      runId,
      phase: "development",
      level: "info",
      code: EventCodes.PHASE_PASSED,
      message: "Developer handoff captured in the managed workspace.",
      durationMs: getDurationMs(developmentStartedAt, developmentCompletedAt),
      data: {
        actor: "developer",
        workspaceId: workspace.workspaceId,
        handoffPath,
        handoffArchiveLocation: archivedHandoff.location,
        codeWriteEnabled: workspace.descriptor.toolPolicy.codeWriteEnabled,
        ...(developmentTokenBudget
          ? { tokenBudget: developmentTokenBudget }
          : {})
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
      eventId: nextEventId("development", EventCodes.PIPELINE_BLOCKED),
      taskId,
      runId,
      phase: "development",
      level: "warn",
      code: EventCodes.PIPELINE_BLOCKED,
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

    currentManifest = patchManifest(currentManifest, {
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
      concurrencyDecision,
      ...(dispatchResult !== null ? { openClawDispatchResult: dispatchResult } : {})
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
          phase: "development",
          workspace,
          clock,
          nextEventId
        });
      } catch (secretScrubError) {
        scrubFailure = secretScrubError;
        runLogger.error("Failed to scrub developer workspace credentials after phase exit.", {
          runId,
          taskId,
          persistenceError: serializeError(secretScrubError)
        });
      }
    }

    let pipelineFailure = normalizePipelineFailure(
      error,
      "development",
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
      currentPhase: "development",
      lifecycleStatus: "failed",
      updatedAt: failedAtIso
    });

    try {
      currentManifest = await persistPhaseFailure({
        repository, snapshot, manifest: currentManifest,
        phase: "development", runId, failure: pipelineFailure,
        runLogger, nextEventId, runStartedAt, failedAt, failedAtIso,
        persistTrackedRun, github: dependencies.github
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
