import {
  openClawModelProviderSchema,
  type OpenClawAgentRole,
  type OpenClawModelBinding,
  type OpenClawModelProvider
} from "@reddwarf/contracts";

export const MODEL_PROVIDER_ROLE_MAP = {
  anthropic: {
    coordinator: "anthropic/claude-sonnet-4-6",
    analyst: "anthropic/claude-opus-4-6",
    reviewer: "anthropic/claude-sonnet-4-6",
    validator: "anthropic/claude-sonnet-4-6",
    developer: "anthropic/claude-sonnet-4-6"
  },
  openai: {
    coordinator: "openai/gpt-5",
    analyst: "openai/gpt-5.4",
    reviewer: "openai/gpt-5",
    validator: "openai/gpt-5",
    developer: "openai/gpt-5.4"
  },
  "openai-codex": {
    coordinator: "openai-codex/gpt-5.5",
    analyst: "openai-codex/gpt-5.5",
    reviewer: "openai-codex/gpt-5.5",
    validator: "openai-codex/gpt-5.5",
    developer: "openai-codex/gpt-5.5"
  }
} as const satisfies Record<
  OpenClawModelProvider,
  Record<OpenClawAgentRole, string>
>;

/**
 * Cross-provider failover chains for each agent role.
 * When model failover is enabled, OpenClaw automatically rotates to the
 * next model in the chain on transient provider errors (429, 500, 503).
 * The failover model is always from the alternate provider.
 */
export const MODEL_FAILOVER_MAP: Record<
  OpenClawModelProvider,
  Record<OpenClawAgentRole, string>
> = {
  anthropic: {
    coordinator: "openai/gpt-5",
    analyst: "openai/gpt-5.4",
    reviewer: "openai/gpt-5",
    validator: "openai/gpt-5",
    developer: "openai/gpt-5.4"
  },
  openai: {
    coordinator: "anthropic/claude-sonnet-4-6",
    analyst: "anthropic/claude-opus-4-6",
    reviewer: "anthropic/claude-sonnet-4-6",
    validator: "anthropic/claude-sonnet-4-6",
    developer: "anthropic/claude-sonnet-4-6"
  },
  // Codex subscription has no separate API billing path, so the failover target
  // is the direct OpenAI API (requires OPENAI_API_KEY to actually activate).
  "openai-codex": {
    coordinator: "openai/gpt-5",
    analyst: "openai/gpt-5.4",
    reviewer: "openai/gpt-5",
    validator: "openai/gpt-5",
    developer: "openai/gpt-5.4"
  }
};

export function resolveOpenClawModelProvider(
  value: unknown,
  fallback: OpenClawModelProvider = "anthropic"
): OpenClawModelProvider {
  const candidate =
    typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : fallback;
  return openClawModelProviderSchema.parse(candidate);
}

export function createOpenClawModelBinding(
  role: OpenClawAgentRole,
  provider: OpenClawModelProvider
): OpenClawModelBinding {
  return {
    provider,
    model: MODEL_PROVIDER_ROLE_MAP[provider][role]
  };
}
