import {
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

export interface RunTokenUsageSummary {
  byPhase: Partial<Record<TaskPhase, TokenBudgetResult>>;
  totalEstimatedTokens: number;
  totalActualInputTokens: number;
  totalActualOutputTokens: number;
  totalActualTokens: number;
  anyPhaseExceeded: boolean;
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

export function attachActualTokenUsage(
  result: TokenBudgetResult,
  usage?: TokenUsage | null
): TokenBudgetResult {
  if (!usage) {
    return result;
  }

  return tokenBudgetResultSchema.parse({
    ...result,
    actualInputTokens: usage.inputTokens,
    actualOutputTokens: usage.outputTokens
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
  let anyPhaseExceeded = false;

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
    if (!parsed.data.withinBudget) {
      anyPhaseExceeded = true;
    }
  }

  return {
    byPhase,
    totalEstimatedTokens,
    totalActualInputTokens,
    totalActualOutputTokens,
    totalActualTokens: totalActualInputTokens + totalActualOutputTokens,
    anyPhaseExceeded
  };
}
