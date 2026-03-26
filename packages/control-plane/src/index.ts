import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import pino from "pino";
import type { DestinationStream, Logger as PinoLogger } from "pino";
import {
  asIsoTimestamp,
  capabilities,
  concurrencyDecisionSchema,
  phaseRecordSchema,
  planningSpecSchema,
  planningTaskInputSchema,
  runtimeInstructionLayerSchema,
  taskManifestSchema,
  workspaceContextBundleSchema,
  type Capability,
  type ConcurrencyDecision,
  type ConcurrencyStrategy,
  type FailureClass,
  type PhaseLifecycleStatus,
  type PhaseRecord,
  type PipelineRun,
  type PlanningSpec,
  type PlanningTaskInput,
  type PolicySnapshot,
  type RuntimeInstructionLayer,
  type RunEvent,
  type TaskLifecycleStatus,
  type TaskManifest,
  type TaskPhase,
  type WorkspaceContextBundle
} from "@reddwarf/contracts";
import {
  createEvidenceRecord,
  createMemoryRecord,
  createPipelineRun,
  createRunEvent,
  deriveOrganizationId,
  type PersistedTaskSnapshot,
  type PlanningRepository
} from "@reddwarf/evidence";
import { agentDefinitions, assertPhaseExecutable } from "@reddwarf/execution-plane";
import {
  assessEligibility,
  buildPolicySnapshot,
  classifyRisk,
  getPolicyVersion,
  resolveApprovalMode
} from "@reddwarf/policy";

const taskLifecycleTransitions: Record<TaskLifecycleStatus, TaskLifecycleStatus[]> = {
  draft: ["ready", "cancelled"],
  ready: ["active", "cancelled"],
  active: ["blocked", "completed", "failed", "cancelled"],
  blocked: ["active", "failed", "cancelled", "completed"],
  completed: [],
  failed: ["draft", "cancelled"],
  cancelled: []
};

const phaseLifecycleTransitions: Record<PhaseLifecycleStatus, PhaseLifecycleStatus[]> = {
  pending: ["running", "skipped"],
  running: ["passed", "failed", "escalated", "skipped"],
  passed: [],
  failed: [],
  escalated: ["running", "skipped"],
  skipped: []
};

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

export interface PlanningPipelineLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child?(bindings: Record<string, unknown>): PlanningPipelineLogger;
}

export interface PlanningLogRecord {
  level: RunEvent["level"];
  message: string;
  bindings: Record<string, unknown>;
}

export interface PlanningDraft {
  summary: string;
  assumptions: string[];
  affectedAreas: string[];
  constraints: string[];
  testExpectations: string[];
}

export interface PlanningAgent {
  createSpec(
    input: PlanningTaskInput,
    context: { manifest: TaskManifest; runId: string }
  ): Promise<PlanningDraft>;
}

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
  nextAction: "complete" | "await_human" | "task_blocked";
  concurrencyDecision: ConcurrencyDecision;
}

export interface WorkspaceContextArtifacts {
  taskJson: string;
  specMarkdown: string;
  policySnapshotJson: string;
  allowedPathsJson: string;
  acceptanceCriteriaJson: string;
}

export interface RuntimeInstructionArtifacts {
  soulMd: string;
  agentsMd: string;
  toolsMd: string;
  taskSkillMd: string;
}

export interface MaterializedRuntimeInstructionFiles {
  soulMd: string;
  agentsMd: string;
  toolsMd: string;
  taskSkillMd: string;
}

export interface MaterializedWorkspaceContext {
  workspaceId: string;
  workspaceRoot: string;
  contextDir: string;
  files: {
    taskJson: string;
    specMarkdown: string;
    policySnapshotJson: string;
    allowedPathsJson: string;
    acceptanceCriteriaJson: string;
  };
  instructions: {
    canonicalSources: string[];
    taskContractFiles: string[];
    files: MaterializedRuntimeInstructionFiles;
  };
}

export interface PinoPlanningLoggerOptions {
  level?: RunEvent["level"];
  baseBindings?: Record<string, unknown>;
  destination?: DestinationStream;
}

export interface BufferedPlanningLogger {
  logger: PlanningPipelineLogger;
  records: PlanningLogRecord[];
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
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "PlanningPipelineFailure";
    this.failureClass = input.failureClass;
    this.phase = input.phase;
    this.code = input.code;
    this.details = input.details ?? {};
    this.taskId = input.taskId ?? null;
    this.runId = input.runId ?? null;
  }
}

const defaultLogger: PlanningPipelineLogger = {
  info() {},
  warn() {},
  error() {},
  child() {
    return defaultLogger;
  }
};

const taskContractRelativePaths = [
  ".context/task.json",
  ".context/spec.md",
  ".context/policy_snapshot.json",
  ".context/allowed_paths.json",
  ".context/acceptance_criteria.json"
] as const;

const runtimeInstructionRelativePaths = {
  soulMd: "SOUL.md",
  agentsMd: "AGENTS.md",
  toolsMd: "TOOLS.md",
  taskSkillMd: "skills/reddwarf-task/SKILL.md"
} as const;

const agentInstructionPathByType: Partial<Record<TaskManifest["assignedAgentType"], string>> = {
  architect: "agents/architect.md",
  developer: "agents/developer.md"
};

const capabilityGuidance: Record<Capability, string> = {
  can_plan: "Inspect task context, policy inputs, and mounted standards to produce deterministic planning output.",
  can_write_code: "Write or modify product code only after the development phase is enabled and policy grants it.",
  can_run_tests: "Run validation commands only when the validation phase and policy both allow test execution.",
  can_open_pr: "Create branches, commits, or pull requests only behind explicit SCM approval gates.",
  can_modify_schema: "Change schemas or migrations only with explicit approval for sensitive surfaces.",
  can_touch_sensitive_paths: "Touch restricted repo areas only after path-level approval is granted.",
  can_use_secrets: "Use scoped credentials only when a secrets adapter has injected them for this task.",
  can_review: "Review generated work and compare it to requirements when the review phase is enabled.",
  can_archive_evidence: "Persist structured logs, specs, diffs, and verification output as durable evidence."
};

export function createPinoPlanningLogger(options: PinoPlanningLoggerOptions = {}): PlanningPipelineLogger {
  const logger = pino(
    {
      name: "reddwarf.control-plane",
      level: options.level ?? (process.env.REDDWARF_LOG_LEVEL as RunEvent["level"] | undefined) ?? "info",
      base: {
        service: "reddwarf-control-plane",
        ...(options.baseBindings ?? {})
      }
    },
    options.destination
  );

  return wrapPinoLogger(logger);
}

export function createBufferedPlanningLogger(): BufferedPlanningLogger {
  const records: PlanningLogRecord[] = [];

  const createLogger = (bindings: Record<string, unknown>): PlanningPipelineLogger => ({
    info(message, context) {
      records.push({
        level: "info",
        message,
        bindings: {
          ...bindings,
          ...(context ?? {})
        }
      });
    },
    warn(message, context) {
      records.push({
        level: "warn",
        message,
        bindings: {
          ...bindings,
          ...(context ?? {})
        }
      });
    },
    error(message, context) {
      records.push({
        level: "error",
        message,
        bindings: {
          ...bindings,
          ...(context ?? {})
        }
      });
    },
    child(childBindings) {
      return createLogger({
        ...bindings,
        ...childBindings
      });
    }
  });

  return {
    logger: createLogger({}),
    records
  };
}

export function assertTaskLifecycleTransition(
  from: TaskLifecycleStatus,
  to: TaskLifecycleStatus
): void {
  if (!taskLifecycleTransitions[from].includes(to)) {
    throw new Error(`Illegal task lifecycle transition from ${from} to ${to}.`);
  }
}

export function assertPhaseLifecycleTransition(
  from: PhaseLifecycleStatus,
  to: PhaseLifecycleStatus
): void {
  if (!phaseLifecycleTransitions[from].includes(to)) {
    throw new Error(`Illegal phase lifecycle transition from ${from} to ${to}.`);
  }
}
export function createWorkspaceContextBundle(input: {
  manifest: TaskManifest;
  spec: PlanningSpec;
  policySnapshot: PolicySnapshot;
}): WorkspaceContextBundle {
  return workspaceContextBundleSchema.parse({
    manifest: input.manifest,
    spec: input.spec,
    policySnapshot: input.policySnapshot,
    acceptanceCriteria: input.spec.acceptanceCriteria,
    allowedPaths: input.policySnapshot.allowedPaths
  });
}

export function createWorkspaceContextBundleFromSnapshot(
  snapshot: PersistedTaskSnapshot
): WorkspaceContextBundle {
  if (!snapshot.manifest) {
    throw new Error("Cannot materialize workspace context without a task manifest.");
  }

  if (!snapshot.spec) {
    throw new Error(`Cannot materialize workspace context for ${snapshot.manifest.taskId} without a planning spec.`);
  }

  if (!snapshot.policySnapshot) {
    throw new Error(
      `Cannot materialize workspace context for ${snapshot.manifest.taskId} without a persisted policy snapshot.`
    );
  }

  return createWorkspaceContextBundle({
    manifest: snapshot.manifest,
    spec: snapshot.spec,
    policySnapshot: snapshot.policySnapshot
  });
}

export function renderPlanningSpecMarkdown(bundle: WorkspaceContextBundle): string {
  return [
    "# Planning Spec",
    "",
    `- Task ID: ${bundle.manifest.taskId}`,
    `- Source Repo: ${bundle.manifest.source.repo}`,
    `- Risk Class: ${bundle.manifest.riskClass}`,
    `- Approval Mode: ${bundle.policySnapshot.approvalMode}`,
    "",
    "## Summary",
    "",
    bundle.spec.summary,
    "",
    "## Assumptions",
    "",
    ...bundle.spec.assumptions.map((item) => `- ${item}`),
    "",
    "## Affected Areas",
    "",
    ...bundle.spec.affectedAreas.map((item) => `- ${item}`),
    "",
    "## Constraints",
    "",
    ...bundle.spec.constraints.map((item) => `- ${item}`),
    "",
    "## Acceptance Criteria",
    "",
    ...bundle.spec.acceptanceCriteria.map((item) => `- ${item}`),
    "",
    "## Test Expectations",
    "",
    ...bundle.spec.testExpectations.map((item) => `- ${item}`),
    "",
    "## Policy Reasons",
    "",
    ...bundle.policySnapshot.reasons.map((item) => `- ${item}`),
    ""
  ].join("\n");
}

export function createWorkspaceContextArtifacts(
  bundleInput: WorkspaceContextBundle
): WorkspaceContextArtifacts {
  const bundle = workspaceContextBundleSchema.parse(bundleInput);

  return {
    taskJson: `${JSON.stringify(bundle.manifest, null, 2)}\n`,
    specMarkdown: renderPlanningSpecMarkdown(bundle),
    policySnapshotJson: `${JSON.stringify(bundle.policySnapshot, null, 2)}\n`,
    allowedPathsJson: `${JSON.stringify(bundle.allowedPaths, null, 2)}\n`,
    acceptanceCriteriaJson: `${JSON.stringify(bundle.acceptanceCriteria, null, 2)}\n`
  };
}

export function createRuntimeInstructionLayer(
  bundleInput: WorkspaceContextBundle
): RuntimeInstructionLayer {
  const bundle = workspaceContextBundleSchema.parse(bundleInput);
  const canonicalSources = buildCanonicalSources(bundle);

  return runtimeInstructionLayerSchema.parse({
    taskId: bundle.manifest.taskId,
    assignedAgentType: bundle.manifest.assignedAgentType,
    recommendedAgentType: bundle.spec.recommendedAgentType,
    approvalMode: bundle.policySnapshot.approvalMode,
    allowedCapabilities: bundle.policySnapshot.allowedCapabilities,
    blockedPhases: bundle.policySnapshot.blockedPhases,
    canonicalSources,
    contextFiles: [...taskContractRelativePaths],
    files: [
      {
        relativePath: runtimeInstructionRelativePaths.soulMd,
        description: "Workspace operating posture and source hierarchy.",
        content: renderRuntimeSoulMarkdown(bundle, canonicalSources)
      },
      {
        relativePath: runtimeInstructionRelativePaths.agentsMd,
        description: "Runtime agent roster and task routing guidance.",
        content: renderRuntimeAgentsMarkdown(bundle)
      },
      {
        relativePath: runtimeInstructionRelativePaths.toolsMd,
        description: "Capability, path, and escalation guardrails for the workspace.",
        content: renderRuntimeToolsMarkdown(bundle)
      },
      {
        relativePath: runtimeInstructionRelativePaths.taskSkillMd,
        description: "Task-scoped skill that tells agents how to use the context bundle and policy pack.",
        content: renderRuntimeTaskSkillMarkdown(bundle, canonicalSources)
      }
    ]
  });
}

export function createRuntimeInstructionArtifacts(
  layerInput: RuntimeInstructionLayer
): RuntimeInstructionArtifacts {
  const layer = runtimeInstructionLayerSchema.parse(layerInput);

  return {
    soulMd: getRuntimeInstructionContent(layer, runtimeInstructionRelativePaths.soulMd),
    agentsMd: getRuntimeInstructionContent(layer, runtimeInstructionRelativePaths.agentsMd),
    toolsMd: getRuntimeInstructionContent(layer, runtimeInstructionRelativePaths.toolsMd),
    taskSkillMd: getRuntimeInstructionContent(layer, runtimeInstructionRelativePaths.taskSkillMd)
  };
}

export async function materializeWorkspaceContext(input: {
  bundle: WorkspaceContextBundle;
  targetRoot: string;
  workspaceId?: string;
}): Promise<MaterializedWorkspaceContext> {
  const bundle = workspaceContextBundleSchema.parse(input.bundle);
  const workspaceId = input.workspaceId ?? bundle.manifest.workspaceId ?? bundle.manifest.taskId;
  const workspaceRoot = resolve(input.targetRoot, workspaceId);
  const contextDir = join(workspaceRoot, ".context");
  const files = {
    taskJson: join(contextDir, "task.json"),
    specMarkdown: join(contextDir, "spec.md"),
    policySnapshotJson: join(contextDir, "policy_snapshot.json"),
    allowedPathsJson: join(contextDir, "allowed_paths.json"),
    acceptanceCriteriaJson: join(contextDir, "acceptance_criteria.json")
  };
  const materializedBundle = workspaceContextBundleSchema.parse({
    ...bundle,
    manifest: {
      ...bundle.manifest,
      workspaceId
    }
  });
  const artifacts = createWorkspaceContextArtifacts(materializedBundle);
  const runtimeInstructionLayer = createRuntimeInstructionLayer(materializedBundle);
  const runtimeInstructionArtifacts = createRuntimeInstructionArtifacts(runtimeInstructionLayer);
  const instructionFiles = {
    soulMd: join(workspaceRoot, runtimeInstructionRelativePaths.soulMd),
    agentsMd: join(workspaceRoot, runtimeInstructionRelativePaths.agentsMd),
    toolsMd: join(workspaceRoot, runtimeInstructionRelativePaths.toolsMd),
    taskSkillMd: join(workspaceRoot, ...runtimeInstructionRelativePaths.taskSkillMd.split("/"))
  };

  await mkdir(contextDir, { recursive: true });
  await mkdir(join(workspaceRoot, "skills", "reddwarf-task"), { recursive: true });
  await Promise.all([
    writeFile(files.taskJson, artifacts.taskJson, "utf8"),
    writeFile(files.specMarkdown, artifacts.specMarkdown, "utf8"),
    writeFile(files.policySnapshotJson, artifacts.policySnapshotJson, "utf8"),
    writeFile(files.allowedPathsJson, artifacts.allowedPathsJson, "utf8"),
    writeFile(files.acceptanceCriteriaJson, artifacts.acceptanceCriteriaJson, "utf8"),
    writeFile(instructionFiles.soulMd, runtimeInstructionArtifacts.soulMd, "utf8"),
    writeFile(instructionFiles.agentsMd, runtimeInstructionArtifacts.agentsMd, "utf8"),
    writeFile(instructionFiles.toolsMd, runtimeInstructionArtifacts.toolsMd, "utf8"),
    writeFile(instructionFiles.taskSkillMd, runtimeInstructionArtifacts.taskSkillMd, "utf8")
  ]);

  return {
    workspaceId,
    workspaceRoot,
    contextDir,
    files,
    instructions: {
      canonicalSources: runtimeInstructionLayer.canonicalSources,
      taskContractFiles: Object.values(files),
      files: instructionFiles
    }
  };
}

export class DeterministicPlanningAgent implements PlanningAgent {
  async createSpec(
    input: PlanningTaskInput,
    context: { manifest: TaskManifest; runId: string }
  ): Promise<PlanningDraft> {
    return {
      summary: `Plan task ${context.manifest.taskId} for ${input.source.repo}: ${input.title}`,
      assumptions: [
        "The task source is trustworthy and labels accurately reflect readiness.",
        "Human approval remains mandatory before any future code-writing or PR mutation."
      ],
      affectedAreas: input.affectedPaths.length > 0 ? input.affectedPaths : ["planning-surface-only"],
      constraints: [
        "Do not write product code in RedDwarf v1.",
        "Archive all planning outputs as durable evidence."
      ],
      testExpectations: [
        "Validate schemas for manifest, spec, and workspace context bundle.",
        "Verify policy gate output and lifecycle records for the task."
      ]
    };
  }
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

    if (isPipelineRunStale(overlap, runStartedAt, concurrency.staleAfterMs)) {
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
      message: concurrencyDecision.reason ?? "Planning pipeline blocked by an overlapping run.",
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
      draft = await planner.createSpec(input, { manifest: currentManifest, runId });
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
          approvalMode
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
    const policyStatus: PhaseLifecycleStatus = approvalMode === "auto" ? "passed" : "escalated";

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
        details: { approvalMode, reasons: policySnapshot.reasons },
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
          policySnapshot
        },
        createdAt: policyCompletedAtIso
      })
    );
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
        status: policyStatus
      },
      createdAt: policyCompletedAtIso
    });
    await persistTrackedRun({
      lastHeartbeatAt: policyCompletedAtIso,
      metadata: {
        currentPhase: "policy_gate",
        approvalMode
      }
    });

    activePhase = "archive";
    const archiveStartedAt = clock();
    const archiveCompletedAt = clock();
    const archiveCompletedAtIso = asIsoTimestamp(archiveCompletedAt);
    await repository.savePhaseRecord(
      createPhaseRecord({
        id: `${taskId}:phase:archive`,
        taskId,
        phase: "archive",
        status: "passed",
        actor: "evidence",
        summary: "Planning outputs archived.",
        createdAt: archiveCompletedAtIso
      })
    );
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
        status: "passed"
      },
      createdAt: archiveCompletedAtIso
    });
    await recordRunEvent({
      repository,
      logger: runLogger,
      eventId: nextEventId("archive", "PIPELINE_COMPLETED"),
      taskId,
      runId,
      phase: "archive",
      level: "info",
      code: "PIPELINE_COMPLETED",
      message: "Planning pipeline completed.",
      durationMs: getDurationMs(runStartedAt, archiveCompletedAt),
      data: {
        approvalMode,
        riskClass
      },
      createdAt: archiveCompletedAtIso
    });

    const completedManifest = taskManifestSchema.parse({
      ...currentManifest,
      currentPhase: "archive",
      lifecycleStatus: "completed",
      evidenceLinks: [
        `db://manifest/${taskId}`,
        `db://planning_spec/${spec.specId}`,
        `db://gate_decision/${taskId}:gate:policy`
      ],
      updatedAt: archiveCompletedAtIso
    });

    await repository.updateManifest(completedManifest);
    await persistTrackedRun({
      status: "completed",
      lastHeartbeatAt: archiveCompletedAtIso,
      completedAt: archiveCompletedAtIso,
      metadata: {
        currentPhase: "archive",
        nextAction: approvalMode === "auto" ? "complete" : "await_human"
      }
    });
    currentManifest = completedManifest;

    return {
      runId,
      manifest: completedManifest,
      spec,
      policySnapshot,
      nextAction: approvalMode === "auto" ? "complete" : "await_human",
      concurrencyDecision
    };
  } catch (error) {
    const pipelineFailure = normalizePipelineFailure(error, activePhase, taskId, runId);
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

function createConcurrencyDecision(input: ConcurrencyDecision): ConcurrencyDecision {
  return concurrencyDecisionSchema.parse(input);
}

function createTaskConcurrencyKey(input: PlanningTaskInput): string {
  const sourceIssue = input.source.issueNumber ?? input.source.issueId ?? "adhoc";
  return `${input.source.provider}:${input.source.repo}:${sourceIssue}`;
}

function isPipelineRunStale(run: PipelineRun, now: Date, staleAfterMs: number): boolean {
  return now.getTime() - new Date(run.lastHeartbeatAt).getTime() > staleAfterMs;
}

function createTaskId(input: PlanningTaskInput, runId: string): string {
  const sourceIssue = input.source.issueNumber ?? input.source.issueId ?? runId;
  const repo = input.source.repo.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
  return `${repo}-${sourceIssue}`;
}

function wrapPinoLogger(logger: PinoLogger): PlanningPipelineLogger {
  return {
    info(message, context) {
      logger.info(context ?? {}, message);
    },
    warn(message, context) {
      logger.warn(context ?? {}, message);
    },
    error(message, context) {
      logger.error(context ?? {}, message);
    },
    child(bindings) {
      return wrapPinoLogger(logger.child(bindings));
    }
  };
}
function bindPlanningLogger(
  logger: PlanningPipelineLogger,
  bindings: Record<string, unknown>
): PlanningPipelineLogger {
  if (logger.child) {
    return logger.child(bindings);
  }

  return {
    info(message, context) {
      logger.info(message, {
        ...bindings,
        ...(context ?? {})
      });
    },
    warn(message, context) {
      logger.warn(message, {
        ...bindings,
        ...(context ?? {})
      });
    },
    error(message, context) {
      logger.error(message, {
        ...bindings,
        ...(context ?? {})
      });
    },
    child(childBindings) {
      return bindPlanningLogger(logger, {
        ...bindings,
        ...childBindings
      });
    }
  };
}

function buildCanonicalSources(bundle: WorkspaceContextBundle): string[] {
  const canonicalSources = new Set<string>([
    "openclaw_ai_dev_team_v_2_architecture.md",
    "docs/implementation-map.md",
    "standards/engineering.md",
    "prompts/planning-system.md"
  ]);
  const assignedAgentSource = agentInstructionPathByType[bundle.manifest.assignedAgentType];
  const recommendedAgentSource = agentInstructionPathByType[bundle.spec.recommendedAgentType];

  if (assignedAgentSource) {
    canonicalSources.add(assignedAgentSource);
  }

  if (recommendedAgentSource) {
    canonicalSources.add(recommendedAgentSource);
  }

  return [...canonicalSources];
}

function getRuntimeInstructionContent(layer: RuntimeInstructionLayer, relativePath: string): string {
  const file = layer.files.find((entry) => entry.relativePath === relativePath);

  if (!file) {
    throw new Error(`Missing runtime instruction file ${relativePath}.`);
  }

  return file.content.endsWith("\n") ? file.content : `${file.content}\n`;
}

function renderRuntimeSoulMarkdown(
  bundle: WorkspaceContextBundle,
  canonicalSources: string[]
): string {
  return [
    "# RedDwarf Runtime Soul",
    "",
    `This workspace is provisioned for task \`${bundle.manifest.taskId}\` under policy \`${bundle.policySnapshot.policyVersion}\`.`,
    "",
    "## Task Frame",
    "",
    `- Assigned agent: \`${bundle.manifest.assignedAgentType}\``,
    `- Recommended agent: \`${bundle.spec.recommendedAgentType}\``,
    `- Workspace ID: \`${bundle.manifest.workspaceId ?? bundle.manifest.taskId}\``,
    `- Current phase in manifest: \`${bundle.manifest.currentPhase}\``,
    `- Risk class: \`${bundle.manifest.riskClass}\``,
    `- Approval mode: \`${bundle.policySnapshot.approvalMode}\``,
    "",
    "## First Reads",
    "",
    ...taskContractRelativePaths.map((path) => `- \`${path}\``),
    "",
    "## Canonical Sources",
    "",
    ...canonicalSources.map((path) => `- \`${path}\``),
    "",
    "## Guardrails",
    "",
    `- Allowed capabilities: ${formatLiteralList(bundle.policySnapshot.allowedCapabilities)}`,
    `- Allowed paths: ${formatLiteralList(bundle.allowedPaths)}`,
    `- Blocked phases in v1: ${formatLiteralList(bundle.policySnapshot.blockedPhases)}`,
    "- Escalate rather than write product code, open PRs, use secrets, or exceed the allowed path scope.",
    "- Treat `.context/` as the task contract and the policy-pack docs as the canonical source of engineering rules.",
    ""
  ].join("\n");
}

function renderRuntimeAgentsMarkdown(bundle: WorkspaceContextBundle): string {
  const enabledAgents = agentDefinitions.filter((agent) => agent.enabled).map((agent) => agent.type);

  return [
    "# Agent Instructions",
    "",
    `- Assigned agent for this task: \`${bundle.manifest.assignedAgentType}\``,
    `- Recommended agent from planning: \`${bundle.spec.recommendedAgentType}\``,
    `- Enabled autonomous agents in v1: ${formatLiteralList(enabledAgents)}`,
    "",
    ...agentDefinitions.flatMap((agent) => {
      const instructionPath = agentInstructionPathByType[agent.type];

      return [
        `## ${agent.displayName}`,
        "",
        `- Type: \`${agent.type}\``,
        `- Enabled: ${agent.enabled ? "yes" : "no"}`,
        `- Active phases: ${formatLiteralList(agent.activePhases)}`,
        `- Capabilities: ${formatLiteralList(agent.capabilities)}`,
        `- Description: ${agent.description}`,
        instructionPath
          ? `- Canonical role file: \`${instructionPath}\``
          : "- Canonical role file: no dedicated markdown asset is versioned yet; use this roster entry.",
        ""
      ];
    })
  ].join("\n");
}

function renderRuntimeToolsMarkdown(bundle: WorkspaceContextBundle): string {
  const deniedCapabilities = capabilities.filter(
    (capability) => !bundle.policySnapshot.allowedCapabilities.includes(capability)
  );
  const requestedButDenied = bundle.manifest.requestedCapabilities.filter(
    (capability) => !bundle.policySnapshot.allowedCapabilities.includes(capability)
  );

  return [
    "# Tool Contract",
    "",
    `- Requested capabilities: ${formatLiteralList(bundle.manifest.requestedCapabilities)}`,
    `- Allowed capabilities now: ${formatLiteralList(bundle.policySnapshot.allowedCapabilities)}`,
    `- Currently denied capabilities: ${formatLiteralList(deniedCapabilities)}`,
    `- Requested but denied: ${formatLiteralList(requestedButDenied)}`,
    "",
    "## Allowed Capability Guidance",
    "",
    ...bundle.policySnapshot.allowedCapabilities.flatMap((capability) => [
      `### \`${capability}\``,
      "",
      capabilityGuidance[capability],
      ""
    ]),
    "## Path Guardrails",
    "",
    ...(bundle.allowedPaths.length > 0
      ? bundle.allowedPaths.map((path) => `- \`${path}\``)
      : ["- No product-repo paths are pre-authorized. Escalate before modifying any surface."]),
    "",
    "## Blocked Phases",
    "",
    ...bundle.policySnapshot.blockedPhases.map((phase) => `- \`${phase}\``),
    "",
    "## Escalate Instead Of",
    "",
    "- writing product code",
    "- opening pull requests or mutating remote systems",
    "- using secrets or other sensitive credentials",
    "- touching paths outside the allowed scope",
    ""
  ].join("\n");
}

function renderRuntimeTaskSkillMarkdown(
  bundle: WorkspaceContextBundle,
  canonicalSources: string[]
): string {
  return [
    "# RedDwarf Task Runtime Skill",
    "",
    `Use this skill before taking action on task \`${bundle.manifest.taskId}\`.`,
    "",
    "## Workflow",
    "",
    "1. Read `.context/task.json`, `.context/spec.md`, and `.context/policy_snapshot.json` before proposing or executing work.",
    "2. Confirm that the requested action stays within the allowed capabilities and allowed paths.",
    `3. Use the assigned role instructions first: \`${agentInstructionPathByType[bundle.manifest.assignedAgentType] ?? "AGENTS.md"}\`.`,
    `4. Use the recommended role instructions from planning: \`${agentInstructionPathByType[bundle.spec.recommendedAgentType] ?? "AGENTS.md"}\`.`,
    "5. Produce evidence-friendly output that traces assumptions, affected areas, constraints, acceptance criteria, and verification intent.",
    "6. Escalate whenever the task would require code-writing, secrets, PR creation, or a blocked phase in v1.",
    "",
    "## Canonical Sources",
    "",
    ...canonicalSources.map((path) => `- \`${path}\``),
    ""
  ].join("\n");
}

function formatLiteralList(items: readonly string[]): string {
  if (items.length === 0) {
    return "none";
  }

  return items.map((item) => `\`${item}\``).join(", ");
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
    message: error instanceof Error ? error.message : `Unexpected failure while running ${phase}.`,
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
    ...(input.failureClass === undefined ? {} : { failureClass: input.failureClass }),
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
    ...(event.failureClass === undefined ? {} : { failureClass: event.failureClass }),
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

