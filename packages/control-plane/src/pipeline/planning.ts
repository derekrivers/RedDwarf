import { randomUUID } from "node:crypto";
import {
  asIsoTimestamp,
  type EligibilityRejectionReasonCode,
  planningSpecSchema,
  planningTaskInputSchema,
  type PlanningTaskInput
} from "@reddwarf/contracts";
import {
  createApprovalRequest,
  createEvidenceRecord,
  createEligibilityRejection,
  createMemoryRecord,
  createPipelineRun,
  deriveOrganizationId
} from "@reddwarf/evidence";
import {
  assertPhaseExecutable,
  DEFAULT_PLANNING_SYSTEM_PROMPT,
  buildPlanningPromptSource
} from "@reddwarf/execution-plane";
import { DeterministicPreScreeningAgent } from "@reddwarf/execution-plane";
import {
  assessEligibility,
  buildPolicySnapshot,
  classifyRisk,
  getPolicyVersion,
  resolveApprovalMode
} from "@reddwarf/policy";
import {
  createArchitectHandoffAwaiter
} from "../live-workflow.js";
import { defaultLogger } from "../logger.js";
import {
  createApprovalRequestSummary,
  createConcurrencyDecision,
  createPhaseRecord,
  createSourceConcurrencyKey,
  createTaskConcurrencyKey,
  createTaskId,
  defaultStaleAfterMsForPhase,
  getDurationMs,
  patchManifest,
  readConfiguredBaseBranch,
  recordRunEvent,
  taskManifestSchema
} from "./shared.js";
import {
  createPhaseRunContext
} from "./context.js";
import {
  type EventCodes as _EventCodes,
  EventCodes,
  type PlanningPipelineDependencies,
  type PlanningPipelineResult,
  PlanningPipelineFailure,
  PHASE_HEARTBEAT_INTERVAL_MS
} from "./types.js";
import {
  normalizePipelineFailure
} from "./failure.js";
import {
  dispatchHollyArchitectPhase
} from "./prompts.js";
import { capturePromptSnapshot } from "./prompt-registry.js";
import {
  enforceTokenBudget,
  recordActualTokenUsage
} from "./token-budget.js";
import {
  heartbeatTrackedRun,
  waitWithHeartbeat
} from "./shared.js";

function mapEligibilityReason(
  reason: string
): { reasonCode: EligibilityRejectionReasonCode; reasonDetail: string } {
  if (reason.includes("ai-eligible") || reason.includes("ai-ready")) {
    return {
      reasonCode: "label-missing",
      reasonDetail: reason
    };
  }

  return {
    reasonCode: "under-specified",
    reasonDetail: reason
  };
}

function mapPreScreenFindingKind(
  kind: "under_specified" | "duplicate" | "out_of_scope"
): EligibilityRejectionReasonCode {
  switch (kind) {
    case "duplicate":
      return "duplicate";
    case "out_of_scope":
      return "out-of-scope";
    case "under_specified":
      return "under-specified";
  }
}

export async function runPlanningPipeline(
  rawInput: PlanningTaskInput,
  dependencies: PlanningPipelineDependencies
): Promise<PlanningPipelineResult> {
  const input = planningTaskInputSchema.parse(rawInput);
  const repository = dependencies.repository;
  const planner = dependencies.planner;
  const prescreener =
    dependencies.prescreener ?? new DeterministicPreScreeningAgent();
  const logger = dependencies.logger ?? defaultLogger;
  const clock = dependencies.clock ?? (() => new Date());
  const idGenerator = dependencies.idGenerator ?? (() => randomUUID());
  const concurrency = {
    strategy: dependencies.concurrency?.strategy ?? "serialize",
    staleAfterMs:
      dependencies.concurrency?.staleAfterMs ??
      defaultStaleAfterMsForPhase("planning")
  } satisfies Required<import("./types.js").PlanningConcurrencyOptions>;

  const runId = idGenerator();
  const runStartedAt = clock();
  const runStartedAtIso = asIsoTimestamp(runStartedAt);
  const taskId = createTaskId(input, runId);
  const concurrencyKey = createTaskConcurrencyKey(input);
  const riskClass = classifyRisk(input);
  const initialApprovalMode = resolveApprovalMode({
    phase: "development",
    riskClass,
    requestedCapabilities: input.requestedCapabilities
  });

  let activePhase: import("@reddwarf/contracts").TaskPhase = "intake";
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
    dryRun: input.dryRun,
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
    dryRun: input.dryRun,
    riskClass,
    approvalMode: initialApprovalMode,
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

  const { runLogger, nextEventId, persistTrackedRun } = createPhaseRunContext({
    runId,
    taskId,
    sourceRepo: input.source.repo,
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
    concurrencyDecision = createConcurrencyDecision({
      action: "block",
      strategy: concurrency.strategy,
      blockedByRunId: blockedByRun.runId,
      staleRunIds,
      reason: `Active overlapping run ${blockedByRun.runId} already owns ${concurrencyKey}.`
    });
    const blockedManifest = patchManifest(currentManifest, {
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
      eventId: nextEventId("intake", EventCodes.RUN_BLOCKED_BY_OVERLAP),
      taskId,
      runId,
      phase: "intake",
      level: "warn",
      code: EventCodes.RUN_BLOCKED_BY_OVERLAP,
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
      eventId: nextEventId("intake", EventCodes.PIPELINE_BLOCKED),
      taskId,
      runId,
      phase: "intake",
      level: "warn",
      code: EventCodes.PIPELINE_BLOCKED,
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
        eventId: nextEventId("intake", EventCodes.STALE_RUNS_DETECTED),
        taskId,
        runId,
        phase: "intake",
        level: "info",
        code: EventCodes.STALE_RUNS_DETECTED,
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
        metadata: {
          approvalMode: initialApprovalMode,
          riskClass,
          concurrencyDecision,
          dryRun: input.dryRun
        },
        createdAt: runStartedAtIso
      })
    );
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("intake", EventCodes.PIPELINE_STARTED),
      taskId,
      runId,
      phase: "intake",
      level: "info",
      code: EventCodes.PIPELINE_STARTED,
      message: "Planning pipeline started.",
      data: {
        approvalMode: initialApprovalMode,
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
      eventId: nextEventId("intake", EventCodes.PHASE_PASSED),
      taskId,
      runId,
      phase: "intake",
      level: "info",
      code: EventCodes.PHASE_PASSED,
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
      const blockedManifest = patchManifest(currentManifest, {
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
      for (const [index, reason] of eligibility.reasons.entries()) {
        const rejection = mapEligibilityReason(reason);
        await repository.saveEligibilityRejection(
          createEligibilityRejection({
            rejectionId: `${taskId}:eligibility:${index}`,
            taskId,
            reasonCode: rejection.reasonCode,
            reasonDetail: rejection.reasonDetail,
            policyVersion: getPolicyVersion(),
            sourceIssue: {
              source: input.source,
              title: input.title,
              summary: input.summary
            },
            dryRun: input.dryRun,
            rejectedAt: blockedAtIso
          })
        );
      }
      await recordRunEvent({
        repository,
        logger: runLogger,
        eventId: nextEventId("eligibility", EventCodes.PHASE_BLOCKED),
        taskId,
        runId,
        phase: "eligibility",
        level: "warn",
        code: EventCodes.PHASE_BLOCKED,
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
        eventId: nextEventId("eligibility", EventCodes.PIPELINE_BLOCKED),
        taskId,
        runId,
        phase: "eligibility",
        level: "warn",
        code: EventCodes.PIPELINE_BLOCKED,
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
      eventId: nextEventId("eligibility", EventCodes.PHASE_PASSED),
      taskId,
      runId,
      phase: "eligibility",
      level: "info",
      code: EventCodes.PHASE_PASSED,
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
    const hasExistingPlanningSpec = await repository.hasPlanningSpecForSource(
      input.source
    );
    const preScreenAssessment = await prescreener.assessTask(input, {
      manifest: currentManifest,
      runId,
      hasExistingPlanningSpec
    });

    if (!preScreenAssessment.accepted) {
      const blockedAt = clock();
      const blockedAtIso = asIsoTimestamp(blockedAt);
      const blockedManifest = patchManifest(currentManifest, {
        currentPhase: "planning",
        lifecycleStatus: "blocked",
        updatedAt: blockedAtIso
      });

      await repository.savePhaseRecord(
        createPhaseRecord({
          id: `${taskId}:phase:planning`,
          taskId,
          phase: "planning",
          status: "failed",
          actor: "pre-screener",
          summary: preScreenAssessment.summary,
          details: {
            findings: preScreenAssessment.findings,
            recommendedActions: preScreenAssessment.recommendedActions
          },
          createdAt: blockedAtIso
        })
      );
      await repository.saveEvidenceRecord(
        createEvidenceRecord({
          recordId: `${taskId}:gate:pre-screen`,
          taskId,
          kind: "gate_decision",
          title: "Pre-screen rejection",
          metadata: preScreenAssessment,
          createdAt: blockedAtIso
        })
      );
      for (const [index, finding] of preScreenAssessment.findings.entries()) {
        await repository.saveEligibilityRejection(
          createEligibilityRejection({
            rejectionId: `${taskId}:pre-screen:${index}`,
            taskId,
            reasonCode: mapPreScreenFindingKind(finding.kind),
            reasonDetail: finding.detail,
            policyVersion: getPolicyVersion(),
            sourceIssue: {
              source: input.source,
              title: input.title,
              summary: input.summary
            },
            dryRun: input.dryRun,
            rejectedAt: blockedAtIso
          })
        );
      }
      await repository.saveMemoryRecord(
        createMemoryRecord({
          memoryId: `${taskId}:memory:task:pre-screen`,
          taskId,
          scope: "task",
          provenance: "pipeline_derived",
          key: "planning.pre_screen",
          title: "Pre-screen decision",
          value: preScreenAssessment,
          repo: input.source.repo,
          organizationId: deriveOrganizationId(input.source.repo),
          tags: ["planning", "pre-screen", "task"],
          createdAt: blockedAtIso,
          updatedAt: blockedAtIso
        })
      );
      await recordRunEvent({
        repository,
        logger: runLogger,
        eventId: nextEventId("planning", EventCodes.PHASE_BLOCKED),
        taskId,
        runId,
        phase: "planning",
        level: "warn",
        code: EventCodes.PHASE_BLOCKED,
        message: "Task rejected by the pre-screening gate before planning.",
        failureClass: "planning_failure",
        durationMs: getDurationMs(planningStartedAt, blockedAt),
        data: {
          actor: "pre-screener",
          findings: preScreenAssessment.findings,
          recommendedActions: preScreenAssessment.recommendedActions
        },
        createdAt: blockedAtIso
      });
      await recordRunEvent({
        repository,
        logger: runLogger,
        eventId: nextEventId("planning", EventCodes.PIPELINE_BLOCKED),
        taskId,
        runId,
        phase: "planning",
        level: "warn",
        code: EventCodes.PIPELINE_BLOCKED,
        message: "Planning pipeline blocked by pre-screen findings.",
        failureClass: "planning_failure",
        durationMs: getDurationMs(runStartedAt, blockedAt),
        data: {
          findings: preScreenAssessment.findings
        },
        createdAt: blockedAtIso
      });
      await repository.updateManifest(blockedManifest);
      await persistTrackedRun({
        status: "blocked",
        lastHeartbeatAt: blockedAtIso,
        completedAt: blockedAtIso,
        metadata: {
          currentPhase: "planning",
          preScreenFindings: preScreenAssessment.findings
        }
      });
      currentManifest = blockedManifest;

      return {
        runId,
        manifest: blockedManifest,
        preScreenAssessment,
        nextAction: "task_blocked",
        concurrencyDecision
      };
    }

    let draft: import("@reddwarf/contracts").PlanningDraft;
    let hollyHandoffMarkdown: string | null = null;
    let planningTokenBudget = await enforceTokenBudget({
      repository,
      logger: runLogger,
      nextEventId,
      manifest: currentManifest,
      runId,
      phase: "planning",
      actor: "architect",
      contextValue: {
        input,
        manifest: currentManifest,
        mode:
          dependencies.openClawDispatch && dependencies.architectTargetRoot
            ? "openclaw"
            : "direct"
      },
      checkedAt: asIsoTimestamp(planningStartedAt),
      detailLabel: "Architect planning",
      eventData: {
        currentPhase: "planning"
      }
    });

    if (dependencies.openClawDispatch && dependencies.architectTargetRoot) {
      try {
        const architectResult = await dispatchHollyArchitectPhase({
          input,
          manifest: currentManifest,
          runId,
          taskId,
          architectTargetRoot: dependencies.architectTargetRoot,
          openClawDispatch: dependencies.openClawDispatch,
          openClawArchitectAgentId: dependencies.openClawArchitectAgentId ?? "reddwarf-analyst",
          openClawArchitectAwaiter:
            dependencies.openClawArchitectAwaiter ??
            createArchitectHandoffAwaiter({
              ...(dependencies.timing?.openClawCompletionTimeoutMs !== undefined
                ? { timeoutMs: dependencies.timing.openClawCompletionTimeoutMs }
                : {}),
              ...(dependencies.timing?.heartbeatIntervalMs !== undefined
                ? { heartbeatIntervalMs: dependencies.timing.heartbeatIntervalMs }
                : {})
            }),
          repository,
          logger: runLogger,
          clock,
          idGenerator,
          nextEventId,
          onHeartbeat: () =>
            heartbeatTrackedRun({
              phase: "planning",
              persistTrackedRun,
              clock,
              metadata: {
                currentPhase: "planning"
              }
            }),
          heartbeatIntervalMs:
            dependencies.timing?.heartbeatIntervalMs ?? PHASE_HEARTBEAT_INTERVAL_MS,
          ...(dependencies.runtimeConfig !== undefined
            ? { runtimeConfig: dependencies.runtimeConfig }
            : {})
        });
        draft = architectResult.draft;
        hollyHandoffMarkdown = architectResult.hollyHandoffMarkdown;
      } catch (error) {
        throw normalizePipelineFailure(error, activePhase, taskId, runId);
      }
    } else {
      try {
        await capturePromptSnapshot({
          repository,
          logger: runLogger,
          nextEventId,
          taskId,
          runId,
          phase: "planning",
          promptPath: "packages/execution-plane/src/index.ts#AnthropicPlanningAgent",
          promptText: buildPlanningPromptSource({
            systemPrompt: DEFAULT_PLANNING_SYSTEM_PROMPT,
            taskInput: input,
            context: {
              manifest: currentManifest,
              runId
            }
          }),
          capturedAt: asIsoTimestamp(clock()),
          metadata: {
            mode: "direct"
          }
        });
        draft = await planner.createSpec(input, {
          manifest: currentManifest,
          runId
        });
        planningTokenBudget = await recordActualTokenUsage({
          repository,
          logger: runLogger,
          nextEventId,
          manifest: currentManifest,
          runId,
          phase: "planning",
          actor: "architect",
          recordedAt: asIsoTimestamp(clock()),
          priorBudget: planningTokenBudget,
          usage: draft.usage ?? null,
          eventData: {
            currentPhase: "planning"
          }
        });
      } catch (error) {
        throw normalizePipelineFailure(error, activePhase, taskId, runId);
      }
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
      confidenceLevel: draft.confidence.level,
      confidenceReason: draft.confidence.reason,
      createdAt: planningCompletedAtIso
    });

    const approvalMode = resolveApprovalMode({
      phase: "development",
      riskClass,
      requestedCapabilities: input.requestedCapabilities,
      confidenceLevel: spec.confidenceLevel
    });
    currentManifest = patchManifest(currentManifest, {
      approvalMode,
      updatedAt: planningCompletedAtIso
    });
    await repository.updateManifest(currentManifest);

    await repository.savePlanningSpec(spec);
    await repository.savePhaseRecord(
      createPhaseRecord({
        id: `${taskId}:phase:planning`,
        taskId,
        phase: "planning",
        status: "passed",
        actor: "architect",
        summary: "Planning spec generated.",
        details: {
          confidenceLevel: spec.confidenceLevel,
          confidenceReason: spec.confidenceReason,
          tokenBudget: planningTokenBudget
        },
        createdAt: planningCompletedAtIso
      })
    );
    await repository.saveEvidenceRecord(
      createEvidenceRecord({
        recordId: `${taskId}:spec`,
        taskId,
        kind: "planning_spec",
        title: "Planning specification",
        metadata: {
          specId: spec.specId,
          confidenceLevel: spec.confidenceLevel,
          confidenceReason: spec.confidenceReason,
          tokenBudget: planningTokenBudget
        },
        createdAt: planningCompletedAtIso
      })
    );
    if (hollyHandoffMarkdown) {
      await repository.saveEvidenceRecord(
        createEvidenceRecord({
          recordId: `${taskId}:architect-handoff`,
          taskId,
          kind: "file_artifact",
          title: "Holly architect handoff",
          metadata: {
            source: "openclaw:reddwarf-analyst",
            contentLength: hollyHandoffMarkdown.length
          },
          createdAt: planningCompletedAtIso
        })
      );
      await repository.saveMemoryRecord(
        createMemoryRecord({
          memoryId: `${taskId}:memory:task:architect-handoff`,
          taskId,
          scope: "task",
          provenance: "pipeline_derived",
          key: "architect.handoff",
          title: "Holly architect handoff",
          value: {
            summary: draft.summary,
            affectedAreas: draft.affectedAreas,
            assumptions: draft.assumptions,
            constraints: draft.constraints,
            testExpectations: draft.testExpectations,
            source: "openclaw:reddwarf-analyst"
          },
          repo: input.source.repo,
          organizationId: deriveOrganizationId(input.source.repo),
          tags: ["planning", "architect", "task"],
          createdAt: planningCompletedAtIso,
          updatedAt: planningCompletedAtIso
        })
      );
    }
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("planning", EventCodes.PHASE_PASSED),
      taskId,
      runId,
      phase: "planning",
      level: "info",
      code: EventCodes.PHASE_PASSED,
      message: "Planning spec generated.",
      durationMs: getDurationMs(planningStartedAt, planningCompletedAt),
      data: {
        actor: "architect",
        specId: spec.specId,
        confidenceLevel: spec.confidenceLevel,
        confidenceReason: spec.confidenceReason,
        tokenBudget: planningTokenBudget,
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
    const basePolicySnapshot = buildPolicySnapshot(
      input,
      riskClass,
      approvalMode,
      draft.confidence
    );
    const policySnapshot = {
      ...basePolicySnapshot,
      allowedPaths: [...new Set([
        ...basePolicySnapshot.allowedPaths,
        ...spec.affectedAreas
      ])]
    };
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
          confidenceLevel: spec.confidenceLevel,
          confidenceReason: spec.confidenceReason,
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
    const policyStatus: import("@reddwarf/contracts").PhaseLifecycleStatus =
      approvalMode === "auto" ? "passed" : "escalated";
    const approvalRequest =
      approvalRequestId === null
        ? undefined
        : createApprovalRequest({
            requestId: approvalRequestId,
            taskId,
            runId,
            phase: "policy_gate",
            dryRun: input.dryRun,
            confidenceLevel: spec.confidenceLevel,
            confidenceReason: spec.confidenceReason,
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
          confidenceLevel: spec.confidenceLevel,
          confidenceReason: spec.confidenceReason,
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
          confidenceLevel: spec.confidenceLevel,
          confidenceReason: spec.confidenceReason,
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
            dryRun: approvalRequest.dryRun,
            confidenceLevel: approvalRequest.confidenceLevel,
            confidenceReason: approvalRequest.confidenceReason,
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
        policyStatus === "passed" ? EventCodes.PHASE_PASSED : EventCodes.PHASE_ESCALATED
      ),
      taskId,
      runId,
      phase: "policy_gate",
      level: policyStatus === "passed" ? "info" : "warn",
      code: policyStatus === "passed" ? EventCodes.PHASE_PASSED : EventCodes.PHASE_ESCALATED,
      message:
        policyStatus === "passed"
          ? "Policy gate passed for this planning run."
          : "Planning completed, but future execution requires human intervention.",
      durationMs: getDurationMs(policyStartedAt, policyCompletedAt),
      data: {
        actor: "policy",
        approvalMode,
        reasons: policySnapshot.reasons,
        confidenceLevel: spec.confidenceLevel,
        confidenceReason: spec.confidenceReason,
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
        eventId: nextEventId("policy_gate", EventCodes.APPROVAL_REQUESTED),
        taskId,
        runId,
        phase: "policy_gate",
        level: "warn",
        code: EventCodes.APPROVAL_REQUESTED,
        message: "Approval request queued for downstream execution.",
        data: {
          requestId: approvalRequest.requestId,
          approvalMode,
          confidenceLevel: approvalRequest.confidenceLevel,
          confidenceReason: approvalRequest.confidenceReason,
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
      eventId: nextEventId("archive", EventCodes.PHASE_PASSED),
      taskId,
      runId,
      phase: "archive",
      level: "info",
      code: EventCodes.PHASE_PASSED,
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
        approvalRequest ? EventCodes.PIPELINE_BLOCKED : EventCodes.PIPELINE_COMPLETED
      ),
      taskId,
      runId,
      phase: "archive",
      level: approvalRequest ? "warn" : "info",
      code: approvalRequest ? EventCodes.PIPELINE_BLOCKED : EventCodes.PIPELINE_COMPLETED,
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

    const completedManifest = patchManifest(currentManifest, {
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
      ...(hollyHandoffMarkdown ? { hollyHandoffMarkdown } : {}),
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
    const failedManifest = patchManifest(currentManifest, {
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
        eventId: nextEventId(activePhase, EventCodes.PHASE_FAILED),
        taskId,
        runId,
        phase: activePhase,
        level: "error",
        code: EventCodes.PHASE_FAILED,
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
        eventId: nextEventId(activePhase, EventCodes.PIPELINE_FAILED),
        taskId,
        runId,
        phase: activePhase,
        level: "error",
        code: EventCodes.PIPELINE_FAILED,
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
        persistenceError: (await import("./shared.js")).serializeError(persistenceError)
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
