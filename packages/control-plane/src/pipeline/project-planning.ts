import { randomUUID } from "node:crypto";
import {
  asIsoTimestamp,
  projectSpecSchema,
  ticketSpecSchema,
  type ComplexityClassification,
  type PlanningTaskInput,
  type ProjectPlanningResult,
  type ProjectSpec,
  type TicketSpec
} from "@reddwarf/contracts";
import {
  createEvidenceRecord,
  createMemoryRecord,
  deriveOrganizationId
} from "@reddwarf/evidence";
import {
  classifyRisk
} from "@reddwarf/policy";
import {
  createArchitectHandoffAwaiter
} from "../live-workflow.js";
import { defaultLogger } from "../logger.js";
import {
  createPhaseRecord,
  getDurationMs,
  patchManifest,
  recordRunEvent,
  taskManifestSchema,
  heartbeatTrackedRun
} from "./shared.js";
import {
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
  dispatchHollyProjectPhase
} from "./prompts.js";

export interface ProjectPlanningInput {
  planningInput: PlanningTaskInput;
  complexityClassification: ComplexityClassification;
}

export interface ProjectPlanningPipelineResult {
  projectSpec: ProjectSpec;
  ticketSpecs: TicketSpec[];
  projectPlanningResult: ProjectPlanningResult;
  hollyHandoffMarkdown: string;
}

/**
 * Run the project-mode planning pipeline. Dispatches Holly in project mode,
 * parses the handoff into a ProjectSpec + TicketSpec[], and persists both to Postgres.
 *
 * Returns the ProjectSpec and TicketSpecs on success.
 * If Holly requests clarification, sets project status to clarification_pending and returns.
 */
export async function runProjectPlanningPhase(
  input: PlanningTaskInput,
  classification: ComplexityClassification,
  deps: PlanningPipelineDependencies & {
    taskId: string;
    runId: string;
    manifest: import("@reddwarf/contracts").TaskManifest;
    clock: () => Date;
    idGenerator: () => string;
    nextEventId: (phase: import("@reddwarf/contracts").TaskPhase, code: string) => string;
    persistTrackedRun: (metadata: Record<string, unknown>) => Promise<void>;
  }
): Promise<ProjectPlanningPipelineResult> {
  const {
    repository,
    taskId,
    runId,
    manifest,
    clock,
    idGenerator,
    nextEventId
  } = deps;

  const runLogger = deps.logger ?? defaultLogger;
  const planningStartedAt = clock();
  const planningStartedAtIso = asIsoTimestamp(planningStartedAt);

  if (!deps.openClawDispatch || !deps.architectTargetRoot) {
    throw new Error("Project-mode planning requires OpenClaw dispatch. Direct mode is not supported for project planning.");
  }

  const projectResult = await dispatchHollyProjectPhase({
    input,
    manifest,
    runId,
    taskId,
    architectTargetRoot: deps.architectTargetRoot,
    openClawDispatch: deps.openClawDispatch,
    openClawArchitectAgentId: deps.openClawArchitectAgentId ?? "reddwarf-analyst",
    openClawArchitectAwaiter:
      deps.openClawArchitectAwaiter ??
      createArchitectHandoffAwaiter({
        handoffFileName: "project-architect-handoff.md",
        requiredHeadings: [
          "# Project Architecture Handoff",
          "## Project Title",
          "## Project Summary",
          "## Tickets"
        ],
        ...(deps.timing?.openClawCompletionTimeoutMs !== undefined
          ? { timeoutMs: deps.timing.openClawCompletionTimeoutMs }
          : {}),
        ...(deps.timing?.heartbeatIntervalMs !== undefined
          ? { heartbeatIntervalMs: deps.timing.heartbeatIntervalMs }
          : {})
      }),
    repository,
    logger: runLogger,
    clock,
    idGenerator,
    nextEventId,
    ...(deps.workspaceRepoBootstrapper !== undefined
      ? { workspaceRepoBootstrapper: deps.workspaceRepoBootstrapper }
      : {}),
    onHeartbeat: async () => {
      await deps.persistTrackedRun({
        phase: "planning",
        mode: "project"
      });
    },
    heartbeatIntervalMs:
      deps.timing?.heartbeatIntervalMs ?? PHASE_HEARTBEAT_INTERVAL_MS,
    ...(deps.runtimeConfig !== undefined
      ? { runtimeConfig: deps.runtimeConfig }
      : {})
  });

  const { result: planningResult, hollyHandoffMarkdown } = projectResult;
  const planningCompletedAt = clock();
  const planningCompletedAtIso = asIsoTimestamp(planningCompletedAt);

  const projectId = `project:${taskId}`;

  if (planningResult.outcome === "clarification_needed") {
    const projectSpec = projectSpecSchema.parse({
      projectId,
      sourceIssueId: manifest.source.issueNumber?.toString() ?? null,
      sourceRepo: manifest.source.repo,
      title: manifest.title,
      summary: input.summary,
      projectSize: classification.size,
      status: "clarification_pending",
      complexityClassification: classification,
      clarificationQuestions: planningResult.clarification.questions,
      clarificationRequestedAt: planningCompletedAtIso,
      createdAt: planningCompletedAtIso,
      updatedAt: planningCompletedAtIso
    });

    await repository.saveProjectSpec(projectSpec);

    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("planning", EventCodes.PHASE_ESCALATED),
      taskId,
      runId,
      phase: "planning",
      level: "warn",
      code: EventCodes.PHASE_ESCALATED,
      message: `Project planning requires clarification. ${planningResult.clarification.questions.length} question(s) pending.`,
      durationMs: getDurationMs(planningStartedAt, planningCompletedAt),
      data: {
        mode: "project",
        outcome: "clarification_needed",
        questions: planningResult.clarification.questions,
        projectId
      },
      createdAt: planningCompletedAtIso
    });

    return {
      projectSpec,
      ticketSpecs: [],
      projectPlanningResult: planningResult,
      hollyHandoffMarkdown
    };
  }

  const draft = planningResult.draft;

  const projectSpec = projectSpecSchema.parse({
    projectId,
    sourceIssueId: manifest.source.issueNumber?.toString() ?? null,
    sourceRepo: manifest.source.repo,
    title: draft.title,
    summary: draft.summary,
    projectSize: classification.size,
    status: "pending_approval",
    complexityClassification: classification,
    createdAt: planningCompletedAtIso,
    updatedAt: planningCompletedAtIso
  });

  const ticketSpecs: TicketSpec[] = draft.tickets.map((ticket, index) => {
    const ticketId = `${projectId}:ticket:${index + 1}`;

    const resolvedDependsOn = ticket.dependsOn
      .map((depTitle) => {
        const depIndex = draft.tickets.findIndex((t) => t.title === depTitle);
        return depIndex >= 0 ? `${projectId}:ticket:${depIndex + 1}` : depTitle;
      });

    return ticketSpecSchema.parse({
      ticketId,
      projectId,
      title: ticket.title,
      description: ticket.description,
      acceptanceCriteria: ticket.acceptanceCriteria,
      dependsOn: resolvedDependsOn,
      status: "pending",
      complexityClass: ticket.complexityClass === "high" ? "high" : ticket.complexityClass === "low" ? "low" : "medium",
      riskClass: ticket.complexityClass === "high" ? "high" : ticket.complexityClass === "low" ? "low" : "medium",
      createdAt: planningCompletedAtIso,
      updatedAt: planningCompletedAtIso
    });
  });

  // Persist project spec and all tickets atomically in a single transaction
  await repository.runInTransaction(async (txRepo) => {
    await txRepo.saveProjectSpec(projectSpec);
    for (const ticket of ticketSpecs) {
      await txRepo.saveTicketSpec(ticket);
    }
  });

  await repository.savePhaseRecord(
    createPhaseRecord({
      id: `${taskId}:phase:project-planning`,
      taskId,
      phase: "planning",
      status: "passed",
      actor: "architect",
      summary: `Project plan generated: ${ticketSpecs.length} tickets.`,
      details: {
        mode: "project",
        projectId,
        projectSize: classification.size,
        ticketCount: ticketSpecs.length,
        confidenceLevel: draft.confidence.level,
        confidenceReason: draft.confidence.reason
      },
      createdAt: planningCompletedAtIso
    })
  );

  await repository.saveEvidenceRecord(
    createEvidenceRecord({
      recordId: `${taskId}:project-spec`,
      taskId,
      kind: "planning_spec",
      title: "Project specification",
      metadata: {
        phase: "planning" as const,
        mode: "project",
        projectId,
        projectSize: classification.size,
        ticketCount: ticketSpecs.length,
        confidenceLevel: draft.confidence.level,
        confidenceReason: draft.confidence.reason
      },
      createdAt: planningCompletedAtIso
    })
  );

  await repository.saveEvidenceRecord(
    createEvidenceRecord({
      recordId: `${taskId}:project-architect-handoff`,
      taskId,
      kind: "file_artifact",
      title: "Holly project architect handoff",
      metadata: {
        phase: "planning" as const,
        source: "openclaw:reddwarf-analyst",
        mode: "project",
        contentLength: hollyHandoffMarkdown.length
      },
      createdAt: planningCompletedAtIso
    })
  );

  await repository.saveMemoryRecord(
    createMemoryRecord({
      memoryId: `${taskId}:memory:task:project-architect-handoff`,
      taskId,
      scope: "task",
      provenance: "pipeline_derived",
      key: "architect.project_handoff",
      title: "Holly project architect handoff",
      value: {
        projectId,
        title: draft.title,
        summary: draft.summary,
        ticketCount: ticketSpecs.length,
        tickets: ticketSpecs.map((t) => ({
          ticketId: t.ticketId,
          title: t.title,
          dependsOn: t.dependsOn
        })),
        source: "openclaw:reddwarf-analyst"
      },
      repo: input.source.repo,
      organizationId: deriveOrganizationId(input.source.repo),
      tags: ["planning", "architect", "project"],
      createdAt: planningCompletedAtIso,
      updatedAt: planningCompletedAtIso
    })
  );

  await recordRunEvent({
    repository,
    logger: runLogger,
    eventId: nextEventId("planning", EventCodes.PHASE_PASSED),
    taskId,
    runId,
    phase: "planning",
    level: "info",
    code: EventCodes.PHASE_PASSED,
    message: `Project plan generated with ${ticketSpecs.length} tickets. Awaiting approval.`,
    durationMs: getDurationMs(planningStartedAt, planningCompletedAt),
    data: {
      mode: "project",
      outcome: "project_spec",
      projectId,
      projectSize: classification.size,
      ticketCount: ticketSpecs.length,
      confidenceLevel: draft.confidence.level,
      confidenceReason: draft.confidence.reason
    },
    createdAt: planningCompletedAtIso
  });

  return {
    projectSpec,
    ticketSpecs,
    projectPlanningResult: planningResult,
    hollyHandoffMarkdown
  };
}
