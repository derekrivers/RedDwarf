import { z } from "zod";

// Feature 180 — USD cost attribution.
//
// Lightweight pricing table keyed by model identifier, plus a `computeCostUsd`
// helper that turns a token-usage record into a USD amount. Per-model pricing
// is configurable via the `REDDWARF_MODEL_PRICING_JSON` environment variable
// (the same shape as `defaultModelPricing` below). Missing entries fall back
// to a conservative default so cost tracking never throws — it may undercount
// if a model is unknown.
//
// Rates are expressed as USD per 1 million tokens for readability.

export const modelPricingEntrySchema = z.object({
  inputPer1M: z.number().nonnegative(),
  outputPer1M: z.number().nonnegative(),
  /** Optional reduced rate for cache-read tokens (Anthropic prompt caching). */
  cachedPer1M: z.number().nonnegative().optional()
});

export const modelPricingTableSchema = z.record(modelPricingEntrySchema);

export type ModelPricingEntry = z.infer<typeof modelPricingEntrySchema>;
export type ModelPricingTable = z.infer<typeof modelPricingTableSchema>;

// Default pricing reflects mid-2026 public Anthropic + OpenAI list rates. If
// your deployment uses a different tier, override via the env var; never edit
// the defaults to match a specific contract because they're the read-only
// fallback that runs when the override is absent.
export const DEFAULT_MODEL_PRICING: ModelPricingTable = {
  "claude-opus-4-7": {
    inputPer1M: 15,
    outputPer1M: 75,
    cachedPer1M: 1.5
  },
  "claude-sonnet-4-6": {
    inputPer1M: 3,
    outputPer1M: 15,
    cachedPer1M: 0.3
  },
  "claude-haiku-4-5": {
    inputPer1M: 1,
    outputPer1M: 5,
    cachedPer1M: 0.1
  },
  "gpt-5": {
    inputPer1M: 10,
    outputPer1M: 30
  },
  "gpt-5.4": {
    inputPer1M: 5,
    outputPer1M: 15
  },
  "gpt-4o": {
    inputPer1M: 2.5,
    outputPer1M: 10
  },
  "gpt-4o-mini": {
    inputPer1M: 0.15,
    outputPer1M: 0.6
  }
};

/** Conservative fallback applied when no entry matches a model id. */
export const FALLBACK_PRICING: ModelPricingEntry = {
  inputPer1M: 5,
  outputPer1M: 15
};

export interface ComputeCostUsdInput {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedTokens?: number | null;
  model?: string | null;
}

export function resolveModelPricing(
  pricing: ModelPricingTable,
  model: string | null | undefined
): ModelPricingEntry {
  if (!model) return FALLBACK_PRICING;
  const entry = pricing[model];
  if (entry) return entry;
  // Allow abbreviated lookups: "claude-opus" matches "claude-opus-4-7".
  const normalized = model.toLowerCase();
  for (const key of Object.keys(pricing)) {
    if (key.toLowerCase().startsWith(normalized)) {
      return pricing[key]!;
    }
  }
  return FALLBACK_PRICING;
}

export function computeCostUsd(
  usage: ComputeCostUsdInput,
  pricing: ModelPricingTable = DEFAULT_MODEL_PRICING
): number {
  const entry = resolveModelPricing(pricing, usage.model ?? null);
  const input = Math.max(0, usage.inputTokens ?? 0);
  const output = Math.max(0, usage.outputTokens ?? 0);
  const cached = Math.max(0, usage.cachedTokens ?? 0);
  // Round to the millionth of a dollar so summing many small runs doesn't
  // accumulate float noise in the persisted JSON.
  const raw =
    (input * entry.inputPer1M + output * entry.outputPer1M) / 1_000_000 +
    (cached * (entry.cachedPer1M ?? entry.inputPer1M)) / 1_000_000;
  return Math.round(raw * 1_000_000) / 1_000_000;
}

export function parseModelPricingEnv(
  raw: string | undefined
): ModelPricingTable {
  if (!raw || raw.trim().length === 0) {
    return DEFAULT_MODEL_PRICING;
  }
  try {
    const parsed = JSON.parse(raw);
    const table = modelPricingTableSchema.parse(parsed);
    return { ...DEFAULT_MODEL_PRICING, ...table };
  } catch {
    return DEFAULT_MODEL_PRICING;
  }
}

export function resolveModelPricingFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ModelPricingTable {
  return parseModelPricingEnv(env["REDDWARF_MODEL_PRICING_JSON"]);
}
