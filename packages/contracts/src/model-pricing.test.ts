import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_PRICING,
  FALLBACK_PRICING,
  computeCostUsd,
  parseModelPricingEnv,
  resolveModelPricing
} from "./model-pricing.js";

describe("resolveModelPricing", () => {
  it("returns the exact match when present", () => {
    expect(resolveModelPricing(DEFAULT_MODEL_PRICING, "claude-opus-4-7")).toBe(
      DEFAULT_MODEL_PRICING["claude-opus-4-7"]
    );
  });

  it("matches a prefix when there is no exact hit", () => {
    expect(resolveModelPricing(DEFAULT_MODEL_PRICING, "claude-opus")).toBe(
      DEFAULT_MODEL_PRICING["claude-opus-4-7"]
    );
  });

  it("returns the fallback when no model is supplied", () => {
    expect(resolveModelPricing(DEFAULT_MODEL_PRICING, null)).toBe(FALLBACK_PRICING);
  });

  it("returns the fallback when the model is unknown", () => {
    expect(resolveModelPricing(DEFAULT_MODEL_PRICING, "llama-9")).toBe(FALLBACK_PRICING);
  });
});

describe("computeCostUsd", () => {
  it("prices input + output tokens at the model's list rate", () => {
    const cost = computeCostUsd(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, model: "claude-sonnet-4-6" }
    );
    // 1M input at $3 + 1M output at $15 = $18
    expect(cost).toBeCloseTo(18, 6);
  });

  it("uses the cached rate when the model exposes one", () => {
    const cost = computeCostUsd(
      {
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 1_000_000,
        model: "claude-opus-4-7"
      }
    );
    expect(cost).toBeCloseTo(1.5, 6);
  });

  it("falls back to the input rate for cached tokens when no cache rate is published", () => {
    const cost = computeCostUsd(
      { inputTokens: 0, outputTokens: 0, cachedTokens: 1_000_000, model: "gpt-5" }
    );
    // gpt-5 has no cachedPer1M → uses inputPer1M = 10
    expect(cost).toBeCloseTo(10, 6);
  });

  it("returns zero for a zero-usage record", () => {
    expect(
      computeCostUsd({ inputTokens: 0, outputTokens: 0, model: "gpt-5" })
    ).toBe(0);
  });

  it("falls back to the generic rate when the model is unknown", () => {
    const cost = computeCostUsd(
      { inputTokens: 1_000_000, outputTokens: 0, model: "llama-9" }
    );
    // FALLBACK_PRICING.inputPer1M = 5
    expect(cost).toBeCloseTo(5, 6);
  });
});

describe("parseModelPricingEnv", () => {
  it("returns defaults when the env var is empty", () => {
    expect(parseModelPricingEnv(undefined)).toBe(DEFAULT_MODEL_PRICING);
    expect(parseModelPricingEnv("")).toBe(DEFAULT_MODEL_PRICING);
  });

  it("merges a valid JSON override on top of the defaults", () => {
    const parsed = parseModelPricingEnv(
      '{"custom-model":{"inputPer1M":1,"outputPer1M":2}}'
    );
    expect(parsed["custom-model"]).toEqual({ inputPer1M: 1, outputPer1M: 2 });
    // Defaults are preserved
    expect(parsed["claude-opus-4-7"]).toBeDefined();
  });

  it("falls back to defaults when the JSON is malformed", () => {
    expect(parseModelPricingEnv("{not: json")).toBe(DEFAULT_MODEL_PRICING);
  });
});
