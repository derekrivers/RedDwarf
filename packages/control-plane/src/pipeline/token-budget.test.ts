import { describe, expect, it } from "vitest";
import type { TokenBudgetResult } from "@reddwarf/contracts";
import {
  attachActualTokenUsage,
  resolveCostBudgetUsd,
  summarizeRunTokenUsage
} from "./token-budget.js";

function baseResult(): TokenBudgetResult {
  return {
    phase: "development",
    estimatedTokens: 1000,
    budgetLimit: 5000,
    withinBudget: true,
    overageAction: "warn"
  } as TokenBudgetResult;
}

describe("attachActualTokenUsage (Feature 180 cost)", () => {
  it("attaches costUsd derived from the model + token counts", () => {
    const result = attachActualTokenUsage(
      baseResult(),
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
        model: "claude-sonnet-4-6"
      },
      { costBudgetUsd: null }
    );
    expect(result.actualInputTokens).toBe(1_000_000);
    expect(result.model).toBe("claude-sonnet-4-6");
    // 1M input at $3 = $3
    expect(result.costUsd).toBeCloseTo(3, 6);
    expect(result.costBudgetUsd).toBeUndefined();
    expect(result.withinCostBudget).toBeUndefined();
  });

  it("records withinCostBudget=true when cost is under the budget", () => {
    const result = attachActualTokenUsage(
      baseResult(),
      { inputTokens: 1_000_000, outputTokens: 0, model: "claude-sonnet-4-6" },
      { costBudgetUsd: 5 }
    );
    expect(result.withinCostBudget).toBe(true);
    expect(result.costBudgetUsd).toBe(5);
  });

  it("records withinCostBudget=false when cost exceeds the budget", () => {
    const result = attachActualTokenUsage(
      baseResult(),
      {
        inputTokens: 2_000_000,
        outputTokens: 2_000_000,
        model: "claude-opus-4-7"
      },
      { costBudgetUsd: 10 }
    );
    // 2M input at $15 + 2M output at $75 = $180
    expect(result.costUsd).toBeCloseTo(180, 4);
    expect(result.withinCostBudget).toBe(false);
  });

  it("falls back to the generic pricing entry when the model is unknown", () => {
    const result = attachActualTokenUsage(
      baseResult(),
      { inputTokens: 1_000_000, outputTokens: 0, model: "unknown-frontier" },
      { costBudgetUsd: null }
    );
    // FALLBACK pricing: $5 per 1M input
    expect(result.costUsd).toBeCloseTo(5, 6);
  });

  it("still populates costUsd when no model is supplied (using fallback rate)", () => {
    const result = attachActualTokenUsage(
      baseResult(),
      { inputTokens: 1_000_000, outputTokens: 0 },
      { costBudgetUsd: null }
    );
    expect(result.costUsd).toBeCloseTo(5, 6);
    expect(result.model).toBeUndefined();
  });

  it("preserves existing fields when no usage is supplied", () => {
    const result = attachActualTokenUsage(baseResult(), null);
    expect(result.costUsd).toBeUndefined();
    expect(result.actualInputTokens).toBeUndefined();
  });
});

describe("resolveCostBudgetUsd", () => {
  it("returns null when the env var is unset", () => {
    expect(resolveCostBudgetUsd({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("parses a positive numeric value", () => {
    expect(
      resolveCostBudgetUsd({
        REDDWARF_COST_BUDGET_PER_TASK_USD: "2.50"
      } as NodeJS.ProcessEnv)
    ).toBe(2.5);
  });

  it("returns null for non-numeric or non-positive values", () => {
    expect(
      resolveCostBudgetUsd({
        REDDWARF_COST_BUDGET_PER_TASK_USD: "nope"
      } as NodeJS.ProcessEnv)
    ).toBeNull();
    expect(
      resolveCostBudgetUsd({
        REDDWARF_COST_BUDGET_PER_TASK_USD: "-1"
      } as NodeJS.ProcessEnv)
    ).toBeNull();
  });
});

describe("summarizeRunTokenUsage (Feature 180 cost)", () => {
  it("sums costUsd across phases and flags cost-budget exceedance", () => {
    const events = [
      {
        phase: "development" as const,
        data: {
          tokenBudget: attachActualTokenUsage(
            baseResult(),
            {
              inputTokens: 1_000_000,
              outputTokens: 0,
              model: "claude-sonnet-4-6"
            },
            { costBudgetUsd: 5 }
          )
        }
      },
      {
        phase: "validation" as const,
        data: {
          tokenBudget: attachActualTokenUsage(
            { ...baseResult(), phase: "validation" },
            {
              inputTokens: 10_000_000,
              outputTokens: 0,
              model: "claude-opus-4-7"
            },
            { costBudgetUsd: 5 }
          )
        }
      }
    ];
    const summary = summarizeRunTokenUsage(events);
    // $3 (sonnet 1M input) + $150 (opus 10M input)
    expect(summary.totalCostUsd).toBeCloseTo(153, 4);
    expect(summary.anyCostBudgetExceeded).toBe(true);
  });

  it("reports zero cost when no phases had pricing info", () => {
    const summary = summarizeRunTokenUsage([
      { phase: "planning" as const, data: { tokenBudget: baseResult() } }
    ]);
    expect(summary.totalCostUsd).toBe(0);
    expect(summary.anyCostBudgetExceeded).toBe(false);
  });
});
