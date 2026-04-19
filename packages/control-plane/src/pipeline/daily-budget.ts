import {
  tokenBudgetResultSchema,
  type RunEvent
} from "@reddwarf/contracts";
import type { PlanningRepository } from "@reddwarf/evidence";
import type { PlanningPipelineLogger } from "../logger.js";
import { EventCodes } from "./types.js";

// Feature 183 — Org-level daily autonomy budget.
//
// Sums today's TOKEN_USAGE_RECORDED events across every task to give the
// dispatcher a cheap "should I start another task?" decision. Both a raw
// token cap and a USD cap are supported; hitting either cap gates new
// dispatches until the next reset boundary.
//
// v1 scope:
//   • Reset boundary is 00:00 UTC. Arbitrary TZ support is a follow-up.
//   • Gate is a read-model computed at dispatch time from run events; no
//     counter table or caching is required.
//   • Already-running phases are not cancelled when the cap is hit — only
//     *new* dispatches are queued. That matches "queued rather than started"
//     in the spec and avoids killing mid-run work.

export interface DailyBudgetConfig {
  tokenBudget: number | null;
  costBudgetUsd: number | null;
  resetTz: string;
}

export interface DailyBudgetStatus {
  windowStart: string;
  windowEnd: string;
  tokensUsed: number;
  costUsdUsed: number;
  tokenBudget: number | null;
  costBudgetUsd: number | null;
  tokensRemaining: number | null;
  costUsdRemaining: number | null;
  tokenBudgetExhausted: boolean;
  costBudgetExhausted: boolean;
  exhausted: boolean;
}

function parsePositiveNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function resolveDailyBudgetConfig(
  env: NodeJS.ProcessEnv = process.env
): DailyBudgetConfig {
  const rawTz = env["REDDWARF_BUDGET_RESET_TZ"]?.trim();
  return {
    tokenBudget: parsePositiveNumber(env["REDDWARF_DAILY_TOKEN_BUDGET"]),
    costBudgetUsd: parsePositiveNumber(env["REDDWARF_DAILY_COST_BUDGET_USD"]),
    resetTz: rawTz && rawTz.length > 0 ? rawTz : "UTC"
  };
}

/**
 * Start-of-today in UTC. Arbitrary `REDDWARF_BUDGET_RESET_TZ` values are
 * accepted in the config but v1 always resets at 00:00 UTC to keep the
 * compute path free of Intl/timezone edge cases. The dashboard / CLI can
 * label the value with the configured TZ string for operator clarity.
 */
export function computeWindowStart(now: Date): Date {
  const utc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  return utc;
}

export function computeDailyBudgetStatus(input: {
  events: readonly RunEvent[];
  config: DailyBudgetConfig;
  now: Date;
}): DailyBudgetStatus {
  const windowStart = computeWindowStart(input.now);
  const windowStartIso = windowStart.toISOString();
  const windowEndIso = input.now.toISOString();

  let tokensUsed = 0;
  let costUsdUsed = 0;
  for (const event of input.events) {
    if (event.code !== EventCodes.TOKEN_USAGE_RECORDED) continue;
    if (event.createdAt < windowStartIso) continue;
    if (event.createdAt > windowEndIso) continue;
    const parsed = tokenBudgetResultSchema.safeParse(
      event.data["tokenBudget"]
    );
    if (!parsed.success) continue;
    tokensUsed +=
      (parsed.data.actualInputTokens ?? 0) +
      (parsed.data.actualOutputTokens ?? 0);
    costUsdUsed += parsed.data.costUsd ?? 0;
  }

  const tokenBudgetExhausted =
    input.config.tokenBudget !== null && tokensUsed >= input.config.tokenBudget;
  const costBudgetExhausted =
    input.config.costBudgetUsd !== null &&
    costUsdUsed >= input.config.costBudgetUsd;

  return {
    windowStart: windowStartIso,
    windowEnd: windowEndIso,
    tokensUsed,
    costUsdUsed: Math.round(costUsdUsed * 1_000_000) / 1_000_000,
    tokenBudget: input.config.tokenBudget,
    costBudgetUsd: input.config.costBudgetUsd,
    tokensRemaining:
      input.config.tokenBudget === null
        ? null
        : Math.max(0, input.config.tokenBudget - tokensUsed),
    costUsdRemaining:
      input.config.costBudgetUsd === null
        ? null
        : Math.max(
            0,
            Math.round(
              (input.config.costBudgetUsd - costUsdUsed) * 1_000_000
            ) / 1_000_000
          ),
    tokenBudgetExhausted,
    costBudgetExhausted,
    exhausted: tokenBudgetExhausted || costBudgetExhausted
  };
}

/**
 * Dispatcher gate. Reads today's run events, computes the status, and
 * returns whether a new task dispatch is allowed. Logs a structured warning
 * on exhaustion; the caller decides whether to queue or skip the task.
 */
export async function checkDailyBudgetGate(input: {
  repository: PlanningRepository;
  logger?: PlanningPipelineLogger | undefined;
  config?: DailyBudgetConfig;
  now?: Date;
}): Promise<{ allowed: boolean; status: DailyBudgetStatus }> {
  const config = input.config ?? resolveDailyBudgetConfig();
  const now = input.now ?? new Date();

  if (config.tokenBudget === null && config.costBudgetUsd === null) {
    // No budget configured — always allowed. Still return a status with null
    // budgets so callers can surface that fact.
    return {
      allowed: true,
      status: computeDailyBudgetStatus({ events: [], config, now })
    };
  }

  const events = await input.repository.listRunEventsByCodeSince(
    EventCodes.TOKEN_USAGE_RECORDED,
    computeWindowStart(now).toISOString()
  );
  const status = computeDailyBudgetStatus({ events, config, now });

  if (status.exhausted) {
    input.logger?.warn?.("daily_budget.exhausted", {
      tokensUsed: status.tokensUsed,
      costUsdUsed: status.costUsdUsed,
      tokenBudget: status.tokenBudget,
      costBudgetUsd: status.costBudgetUsd
    });
  }

  return { allowed: !status.exhausted, status };
}
