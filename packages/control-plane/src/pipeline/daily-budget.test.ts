import { describe, expect, it } from "vitest";
import type { RunEvent, TokenBudgetResult } from "@reddwarf/contracts";
import {
  computeDailyBudgetStatus,
  computeWindowStart,
  resolveDailyBudgetConfig
} from "./daily-budget.js";
import { EventCodes } from "./types.js";

function makeEvent(overrides: Partial<RunEvent> & { cost?: number; tokensIn?: number; tokensOut?: number }): RunEvent {
  const budget: TokenBudgetResult = {
    phase: "development",
    estimatedTokens: 0,
    budgetLimit: 0,
    withinBudget: true,
    overageAction: "warn",
    actualInputTokens: overrides.tokensIn ?? 0,
    actualOutputTokens: overrides.tokensOut ?? 0,
    costUsd: overrides.cost ?? null
  } as TokenBudgetResult;
  return {
    eventId: `evt-${Math.random()}`,
    taskId: "t",
    runId: "r",
    phase: "development",
    level: "info",
    code: EventCodes.TOKEN_USAGE_RECORDED,
    message: "",
    data: { tokenBudget: budget },
    createdAt: "2026-04-19T10:00:00.000Z",
    ...overrides
  } as RunEvent;
}

describe("resolveDailyBudgetConfig", () => {
  it("returns nulls and UTC when no env vars are set", () => {
    const config = resolveDailyBudgetConfig({} as NodeJS.ProcessEnv);
    expect(config).toEqual({
      tokenBudget: null,
      costBudgetUsd: null,
      resetTz: "UTC"
    });
  });

  it("parses positive numeric env values", () => {
    const config = resolveDailyBudgetConfig({
      REDDWARF_DAILY_TOKEN_BUDGET: "1000000",
      REDDWARF_DAILY_COST_BUDGET_USD: "50.5",
      REDDWARF_BUDGET_RESET_TZ: "America/Los_Angeles"
    } as NodeJS.ProcessEnv);
    expect(config.tokenBudget).toBe(1_000_000);
    expect(config.costBudgetUsd).toBe(50.5);
    expect(config.resetTz).toBe("America/Los_Angeles");
  });

  it("treats non-numeric values as unset", () => {
    const config = resolveDailyBudgetConfig({
      REDDWARF_DAILY_TOKEN_BUDGET: "nope",
      REDDWARF_DAILY_COST_BUDGET_USD: "-5"
    } as NodeJS.ProcessEnv);
    expect(config.tokenBudget).toBeNull();
    expect(config.costBudgetUsd).toBeNull();
  });
});

describe("computeWindowStart", () => {
  it("returns 00:00 UTC of the same day regardless of the local time", () => {
    const midday = new Date("2026-04-19T12:34:56.000Z");
    expect(computeWindowStart(midday).toISOString()).toBe(
      "2026-04-19T00:00:00.000Z"
    );
  });

  it("handles the start-of-day boundary cleanly", () => {
    const midnight = new Date("2026-04-19T00:00:00.000Z");
    expect(computeWindowStart(midnight).toISOString()).toBe(
      "2026-04-19T00:00:00.000Z"
    );
  });
});

describe("computeDailyBudgetStatus", () => {
  const now = new Date("2026-04-19T12:00:00.000Z");
  const windowStart = "2026-04-19T00:00:00.000Z";

  it("sums tokens and cost from events within the window", () => {
    const status = computeDailyBudgetStatus({
      events: [
        makeEvent({ createdAt: windowStart, tokensIn: 1000, tokensOut: 500, cost: 0.1 }),
        makeEvent({ createdAt: "2026-04-19T09:00:00.000Z", tokensIn: 2000, tokensOut: 1000, cost: 0.2 }),
        // Before the window — should be ignored
        makeEvent({ createdAt: "2026-04-18T23:59:00.000Z", tokensIn: 5000, cost: 1 })
      ],
      config: { tokenBudget: 10_000, costBudgetUsd: 1, resetTz: "UTC" },
      now
    });
    expect(status.tokensUsed).toBe(4500);
    expect(status.costUsdUsed).toBeCloseTo(0.3, 6);
    expect(status.exhausted).toBe(false);
    expect(status.tokensRemaining).toBe(5500);
    expect(status.costUsdRemaining).toBeCloseTo(0.7, 6);
  });

  it("marks exhausted when the token cap is hit exactly", () => {
    const status = computeDailyBudgetStatus({
      events: [makeEvent({ createdAt: windowStart, tokensIn: 1000, tokensOut: 0 })],
      config: { tokenBudget: 1000, costBudgetUsd: null, resetTz: "UTC" },
      now
    });
    expect(status.tokenBudgetExhausted).toBe(true);
    expect(status.costBudgetExhausted).toBe(false);
    expect(status.exhausted).toBe(true);
    expect(status.tokensRemaining).toBe(0);
  });

  it("marks exhausted when the cost cap is hit", () => {
    const status = computeDailyBudgetStatus({
      events: [makeEvent({ createdAt: windowStart, cost: 10 })],
      config: { tokenBudget: null, costBudgetUsd: 5, resetTz: "UTC" },
      now
    });
    expect(status.costBudgetExhausted).toBe(true);
    expect(status.exhausted).toBe(true);
    expect(status.costUsdRemaining).toBe(0);
  });

  it("returns null remaining values when the corresponding budget is unset", () => {
    const status = computeDailyBudgetStatus({
      events: [],
      config: { tokenBudget: null, costBudgetUsd: null, resetTz: "UTC" },
      now
    });
    expect(status.tokensRemaining).toBeNull();
    expect(status.costUsdRemaining).toBeNull();
    expect(status.exhausted).toBe(false);
  });

  it("ignores events without a parsable tokenBudget payload", () => {
    const events: RunEvent[] = [
      {
        eventId: "bad",
        taskId: "t",
        runId: "r",
        phase: "development",
        level: "info",
        code: EventCodes.TOKEN_USAGE_RECORDED,
        message: "",
        data: { not: "a budget" },
        createdAt: windowStart
      } as RunEvent
    ];
    const status = computeDailyBudgetStatus({
      events,
      config: { tokenBudget: 10, costBudgetUsd: null, resetTz: "UTC" },
      now
    });
    expect(status.tokensUsed).toBe(0);
  });
});
