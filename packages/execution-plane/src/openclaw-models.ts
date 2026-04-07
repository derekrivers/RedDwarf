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
    analyst: "openai/gpt-5",
    reviewer: "openai/gpt-5",
    validator: "openai/gpt-5",
    developer: "openai/gpt-5"
  }
} as const satisfies Record<
  OpenClawModelProvider,
  Record<OpenClawAgentRole, string>
>;

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
