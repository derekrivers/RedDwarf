import {
  computeCostUsd,
  type ModelPricingTable,
  resolveModelPricingFromEnv,
  type PlanningSpec,
  tokenBudgetResultSchema,
  type TaskManifest,
  type TaskPhase,
  type TokenBudgetOverageAction,
  type TokenBudgetResult,
  type TokenUsage
} from "@reddwarf/contracts";
import { createEvidenceRecord } from "@reddwarf/evidence";
import type { PlanningRepository } from "@reddwarf/evidence";
import type { PlanningPipelineLogger } from "../logger.js";
import { createPhaseRecord, recordRunEvent } from "./shared.js";
import { EventCodes, PlanningPipelineFailure } from "./types.js";

export interface TokenBudgetConfig {
  limits: Partial<Record<TaskPhase, number>>;
  overageAction: TokenBudgetOverageAction;
}

export interface PhaseComplexityProfile {
  level: "standard" | "elevated" | "high";
  score: number;
  budgetMultiplier: number;
  timeoutMultiplier: number;
  reasons: string[];
}

export interface RunTokenUsageSummary {
  byPhase: Partial<Record<TaskPhase, TokenBudgetResult>>;
  totalEstimatedTokens: number;
  totalActualInputTokens: number;
  totalActualOutputTokens: number;
  totalActualTokens: number;
  /** Feature 180 — summed USD cost across phases that reported one. */
  totalCostUsd: number;
  anyPhaseExceeded: boolean;
  /** Feature 180 — true when any phase reports costUsd > costBudgetUsd. */
  anyCostBudgetExceeded: boolean;
}

const phaseBudgetEnvNames: Record<TaskPhase, readonly string[]> = {
  intake: [],
  eligibility: [],
  planning: ["REDDWARF_TOKEN_BUDGET_PLANNING", "REDDWARF_TOKEN_BUDGET_ARCHITECT"],
  policy_gate: [],
  development: ["REDDWARF_TOKEN_BUDGET_DEVELOPMENT", "REDDWARF_TOKEN_BUDGET_DEVELOPER"],
  architecture_review: [
    "REDDWARF_TOKEN_BUDGET_ARCHITECTURE_REVIEW",
    "REDDWARF_TOKEN_BUDGET_REVIEWER"
  ],
  validation: ["REDDWARF_TOKEN_BUDGET_VALIDATION", "REDDWARF_TOKEN_BUDGET_VALIDATOR"],
  review: [],
  scm: ["REDDWARF_TOKEN_BUDGET_SCM"],
  archive: []
};

function parseBudgetLimit(
  phase: TaskPhase,
  env: NodeJS.ProcessEnv
): number | undefined {
  for (const envName of phaseBudgetEnvNames[phase]) {
    const raw = env[envName]?.trim();
    if (!raw) {
      continue;
    }

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return undefined;
}

export function resolveTokenBudgetConfig(
  env: NodeJS.ProcessEnv = process.env
): TokenBudgetConfig {
  const rawAction = env["REDDWARF_TOKEN_BUDGET_OVERAGE_ACTION"]?.trim().toLowerCase();
  const overageAction: TokenBudgetOverageAction =
    rawAction === "block" ? "block" : "warn";
  const planning = parseBudgetLimit("planning", env);
  const development = parseBudgetLimit("development", env);
  const architectureReview = parseBudgetLimit("architecture_review", env);
  const validation = parseBudgetLimit("validation", env);
  const scm = parseBudgetLimit("scm", env);

  return {
    limits: {
      ...(planning !== undefined ? { planning } : {}),
      ...(development !== undefined ? { development } : {}),
      ...(architectureReview !== undefined
        ? { architecture_review: architectureReview }
        : {}),
      ...(validation !== undefined ? { validation } : {}),
      ...(scm !== undefined ? { scm } : {})
    },
    overageAction
  };
}

export function buildDevelopmentComplexityProfile(
  manifest: TaskManifest,
  spec: PlanningSpec
): PhaseComplexityProfile {
  let score = 0;
  const reasons: string[] = [];

  if (spec.acceptanceCriteria.length >= 8) {
    score += 2;
    reasons.push(`acceptance criteria: ${spec.acceptanceCriteria.length}`);
  } else if (spec.acceptanceCriteria.length >= 5) {
    score += 1;
    reasons.push(`acceptance criteria: ${spec.acceptanceCriteria.length}`);
  }

  if (spec.affectedAreas.length >= 5) {
    score += 2;
    reasons.push(`affected areas: ${spec.affectedAreas.length}`);
  } else if (spec.affectedAreas.length >= 3) {
    score += 1;
    reasons.push(`affected areas: ${spec.affectedAreas.length}`);
  }

  if (spec.testExpectations.length >= 4) {
    score += 1;
    reasons.push(`test expectations: ${spec.testExpectations.length}`);
  }

  if (manifest.requestedCapabilities.length >= 3) {
    score += 1;
    reasons.push(`requested capabilities: ${manifest.requestedCapabilities.length}`);
  }

  if (spec.riskClass === "high") {
    score += 2;
    reasons.push("risk class: high");
  } else if (spec.riskClass === "medium") {
    score += 1;
    reasons.push("risk class: medium");
  }

  if (spec.confidenceLevel === "low") {
    score += 1;
    reasons.push("planner confidence: low");
  }

  // Single-file frontend scaffolding tasks (e.g. a self-contained HTML game)
  // concentrate all implementation into one large file write. These are
  // systematically underscored by the area-count heuristic because there is
  // only one affected area, yet the actual work volume is high. Bump the
  // score so the timeout and token budget reflect the real write pressure.
  if (
    spec.affectedAreas.length === 1 &&
    /\.(html?|tsx|jsx|vue|svelte)$/i.test(spec.affectedAreas[0]!) &&
    spec.acceptanceCriteria.length >= 3
  ) {
    score += 2;
    reasons.push("single-file frontend scaffolding");
  }

  if (score >= 6) {
    return {
      level: "high",
      score,
      budgetMultiplier: 2,
      timeoutMultiplier: 2,
      reasons
    };
  }

  if (score >= 3) {
    return {
      level: "elevated",
      score,
      budgetMultiplier: 1.5,
      timeoutMultiplier: 1.5,
      reasons
    };
  }

  return {
    level: "standard",
    score,
    budgetMultiplier: 1,
    timeoutMultiplier: 1,
    reasons
  };
}

export function scaleTokenBudgetConfig(
  config: TokenBudgetConfig,
  phase: TaskPhase,
  multiplier: number
): TokenBudgetConfig {
  const currentLimit = config.limits[phase];
  if (currentLimit === undefined || currentLimit === 0 || multiplier === 1) {
    return config;
  }

  return {
    ...config,
    limits: {
      ...config.limits,
      [phase]: Math.ceil(currentLimit * multiplier)
    }
  };
}

export function scaleTimeoutBudgetMs(
  timeoutMs: number,
  multiplier: number
): number {
  return Math.ceil(timeoutMs * multiplier);
}

export function estimateTokens(value: unknown): number {
  const serialized =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return Math.ceil(serialized.length / 4);
}

export function checkTokenBudget(
  phase: TaskPhase,
  value: unknown,
  config: TokenBudgetConfig
): TokenBudgetResult {
  const budgetLimit = config.limits[phase] ?? 0;
  const estimatedTokens = estimateTokens(value);
  return tokenBudgetResultSchema.parse({
    phase,
    estimatedTokens,
    budgetLimit,
    withinBudget: budgetLimit === 0 || estimatedTokens <= budgetLimit,
    overageAction: config.overageAction
  });
}

// Feature 180: budget is read once per call at the env (null = unlimited).
export function resolveCostBudgetUsd(
  env: NodeJS.ProcessEnv = process.env
): number | null {
  const raw = env["REDDWARF_COST_BUDGET_PER_TASK_USD"]?.trim();
  if (!raw) return null;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function attachActualTokenUsage(
  result: TokenBudgetResult,
  usage?: TokenUsage | null,
  options?: {
    pricing?: ModelPricingTable;
    costBudgetUsd?: number | null;
  }
): TokenBudgetResult {
  if (!usage) {
    return result;
  }

  const pricing = options?.pricing ?? resolveModelPricingFromEnv();
  const costUsd = computeCostUsd(
    {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedTokens: usage.cachedTokens ?? null,
      model: usage.model ?? null
    },
    pricing
  );

  const costBudgetUsd =
    options?.costBudgetUsd !== undefined
      ? options.costBudgetUsd
      : resolveCostBudgetUsd();

  return tokenBudgetResultSchema.parse({
    ...result,
    actualInputTokens: usage.inputTokens,
    actualOutputTokens: usage.outputTokens,
    ...(usage.cachedTokens !== undefined
      ? { actualCachedTokens: usage.cachedTokens }
      : {}),
    ...(usage.model !== undefined ? { model: usage.model } : {}),
    costUsd,
    ...(costBudgetUsd !== null
      ? {
          costBudgetUsd,
          withinCostBudget: costUsd <= costBudgetUsd
        }
      : {})
  });
}

export async function enforceTokenBudget(input: {
  repository: PlanningRepository;
  logger: PlanningPipelineLogger;
  nextEventId: (phase: TaskPhase, code: string) => string;
  manifest: TaskManifest;
  runId: string;
  phase: TaskPhase;
  actor: string;
  contextValue: unknown;
  checkedAt: string;
  detailLabel: string;
  eventData?: Record<string, unknown>;
  config?: TokenBudgetConfig;
}): Promise<TokenBudgetResult> {
  const result = checkTokenBudget(
    input.phase,
    input.contextValue,
    input.config ?? resolveTokenBudgetConfig()
  );

  await input.repository.saveEvidenceRecord(
    createEvidenceRecord({
      recordId: `${input.manifest.taskId}:token-budget:${input.phase}:${input.runId}`,
      taskId: input.manifest.taskId,
      kind: "gate_decision",
      title: `${input.detailLabel} token budget check`,
      metadata: {
        runId: input.runId,
        phase: input.phase,
        actor: input.actor,
        tokenBudget: result,
        ...(input.eventData ?? {})
      },
      createdAt: input.checkedAt
    })
  );

  if (!result.withinBudget && result.overageAction === "block") {
    await input.repository.savePhaseRecord(
      createPhaseRecord({
        id: `${input.manifest.taskId}:phase:${input.phase}:token-budget:${input.runId}`,
        taskId: input.manifest.taskId,
        phase: input.phase,
        status: "escalated",
        actor: input.actor,
        summary: `${input.detailLabel} exceeded its token budget and was blocked before dispatch.`,
        details: {
          runId: input.runId,
          tokenBudget: result,
          ...(input.eventData ?? {})
        },
        createdAt: input.checkedAt
      })
    );
  }

  await recordRunEvent({
    repository: input.repository,
    logger: input.logger,
    eventId: input.nextEventId(
      input.phase,
      result.withinBudget
        ? EventCodes.TOKEN_BUDGET_RECORDED
        : EventCodes.TOKEN_BUDGET_EXCEEDED
    ),
    taskId: input.manifest.taskId,
    runId: input.runId,
    phase: input.phase,
    level: result.withinBudget ? "info" : "warn",
    code: result.withinBudget
      ? EventCodes.TOKEN_BUDGET_RECORDED
      : EventCodes.TOKEN_BUDGET_EXCEEDED,
    message: result.withinBudget
      ? `${input.detailLabel} token budget recorded before dispatch.`
      : `${input.detailLabel} token budget exceeded before dispatch.`,
    data: {
      tokenBudget: result,
      ...(input.eventData ?? {})
    },
    createdAt: input.checkedAt
  });

  if (!result.withinBudget && result.overageAction === "block") {
    throw new PlanningPipelineFailure({
      message:
        `${input.detailLabel} exceeded its token budget: ` +
        `${result.estimatedTokens} > ${result.budgetLimit}.`,
      failureClass: "policy_violation",
      phase: input.phase,
      code: EventCodes.TOKEN_BUDGET_EXCEEDED,
      details: {
        tokenBudget: result,
        ...(input.eventData ?? {})
      },
      taskId: input.manifest.taskId,
      runId: input.runId
    });
  }

  return result;
}

export async function recordActualTokenUsage(input: {
  repository: PlanningRepository;
  logger: PlanningPipelineLogger;
  nextEventId: (phase: TaskPhase, code: string) => string;
  manifest: TaskManifest;
  runId: string;
  phase: TaskPhase;
  actor: string;
  recordedAt: string;
  priorBudget: TokenBudgetResult;
  usage?: TokenUsage | null;
  eventData?: Record<string, unknown>;
}): Promise<TokenBudgetResult> {
  const budget = attachActualTokenUsage(input.priorBudget, input.usage);

  await input.repository.saveEvidenceRecord(
    createEvidenceRecord({
      recordId: `${input.manifest.taskId}:token-usage:${input.phase}:${input.runId}`,
      taskId: input.manifest.taskId,
      kind: "gate_decision",
      title: `${input.phase} token usage`,
      metadata: {
        runId: input.runId,
        phase: input.phase,
        actor: input.actor,
        tokenBudget: budget,
        ...(input.eventData ?? {})
      },
      createdAt: input.recordedAt
    })
  );

  await recordRunEvent({
    repository: input.repository,
    logger: input.logger,
    eventId: input.nextEventId(input.phase, EventCodes.TOKEN_USAGE_RECORDED),
    taskId: input.manifest.taskId,
    runId: input.runId,
    phase: input.phase,
    level: "info",
    code: EventCodes.TOKEN_USAGE_RECORDED,
    message: `${input.phase} token usage recorded.`,
    data: {
      tokenBudget: budget,
      ...(input.eventData ?? {})
    },
    createdAt: input.recordedAt
  });

  // Feature 180: if a per-task USD budget is configured, check cumulative
  // cost across all TOKEN_USAGE_RECORDED events for this task. Fire a
  // COST_BUDGET_EXCEEDED event on overrun; the event is advisory — callers
  // decide whether to fail the phase. Keeping enforcement non-throwing here
  // avoids surprising legacy callers that don't know about cost budgets.
  if (
    budget.costBudgetUsd !== undefined &&
    budget.costBudgetUsd !== null &&
    typeof budget.costUsd === "number"
  ) {
    const priorEvents = await input.repository.listRunEvents(
      input.manifest.taskId
    );
    const accumulatedCostUsd = priorEvents.reduce((acc, event) => {
      if (event.code !== EventCodes.TOKEN_USAGE_RECORDED) return acc;
      const payload = event.data["tokenBudget"];
      const parsed = tokenBudgetResultSchema.safeParse(payload);
      if (!parsed.success) return acc;
      return acc + (parsed.data.costUsd ?? 0);
    }, 0);
    if (accumulatedCostUsd > budget.costBudgetUsd) {
      await recordRunEvent({
        repository: input.repository,
        logger: input.logger,
        eventId: input.nextEventId(
          input.phase,
          EventCodes.COST_BUDGET_EXCEEDED
        ),
        taskId: input.manifest.taskId,
        runId: input.runId,
        phase: input.phase,
        level: "warn",
        code: EventCodes.COST_BUDGET_EXCEEDED,
        message: `Task ${input.manifest.taskId} exceeded its USD cost budget: $${accumulatedCostUsd.toFixed(4)} > $${budget.costBudgetUsd.toFixed(4)}.`,
        data: {
          accumulatedCostUsd,
          costBudgetUsd: budget.costBudgetUsd,
          phase: input.phase,
          ...(input.eventData ?? {})
        },
        createdAt: input.recordedAt
      });
    }
  }

  return budget;
}

export function summarizeRunTokenUsage(events: readonly {
  phase: TaskPhase;
  data: Record<string, unknown>;
}[]): RunTokenUsageSummary {
  const byPhase: RunTokenUsageSummary["byPhase"] = {};
  let totalEstimatedTokens = 0;
  let totalActualInputTokens = 0;
  let totalActualOutputTokens = 0;
  let totalCostUsd = 0;
  let anyPhaseExceeded = false;
  let anyCostBudgetExceeded = false;

  for (const event of events) {
    const maybeBudget = event.data["tokenBudget"];
    const parsed = tokenBudgetResultSchema.safeParse(maybeBudget);
    if (!parsed.success) {
      continue;
    }

    byPhase[event.phase] = parsed.data;
    totalEstimatedTokens += parsed.data.estimatedTokens;
    totalActualInputTokens += parsed.data.actualInputTokens ?? 0;
    totalActualOutputTokens += parsed.data.actualOutputTokens ?? 0;
    totalCostUsd += parsed.data.costUsd ?? 0;
    if (!parsed.data.withinBudget) {
      anyPhaseExceeded = true;
    }
    if (parsed.data.withinCostBudget === false) {
      anyCostBudgetExceeded = true;
    }
  }

  return {
    byPhase,
    totalEstimatedTokens,
    totalActualInputTokens,
    totalActualOutputTokens,
    totalActualTokens: totalActualInputTokens + totalActualOutputTokens,
    totalCostUsd: Math.round(totalCostUsd * 1_000_000) / 1_000_000,
    anyPhaseExceeded,
    anyCostBudgetExceeded
  };
}
