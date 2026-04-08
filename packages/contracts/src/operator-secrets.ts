import { z } from "zod";
import { isoDateTimeSchema } from "./enums.js";

export const operatorSecretMetadata = {
  GITHUB_TOKEN: {
    description: "GitHub personal access token used for polling, intake, publishing, and cleanup.",
    restartRequired: false
  },
  ANTHROPIC_API_KEY: {
    description: "Anthropic API key used when REDDWARF_MODEL_PROVIDER=anthropic.",
    restartRequired: false
  },
  OPENAI_API_KEY: {
    description: "OpenAI API key used when REDDWARF_MODEL_PROVIDER=openai.",
    restartRequired: false
  },
  OPENCLAW_HOOK_TOKEN: {
    description: "Bearer token RedDwarf uses to dispatch work into the OpenClaw gateway.",
    restartRequired: true
  },
  OPENCLAW_GATEWAY_TOKEN: {
    description: "Browser auth token for the OpenClaw Control UI.",
    restartRequired: true
  },
  OPENCLAW_DISCORD_BOT_TOKEN: {
    description: "Discord bot token used by OpenClaw's native Discord bridge.",
    restartRequired: true
  },
  REDDWARF_OPERATOR_TOKEN: {
    description: "Bearer token required for protected RedDwarf operator API routes.",
    restartRequired: true
  }
} as const;

export const operatorSecretKeys = Object.keys(operatorSecretMetadata) as [
  keyof typeof operatorSecretMetadata,
  ...(keyof typeof operatorSecretMetadata)[]
];

export const operatorSecretKeySchema = z.enum(operatorSecretKeys);

export type OperatorSecretKey = z.infer<typeof operatorSecretKeySchema>;

export const operatorSecretRotationRequestSchema = z.object({
  value: z
    .string()
    .min(1)
    .refine((value) => !/[\r\n]/.test(value), {
      message: "Secret values must be single-line strings."
    })
});

export const operatorSecretRotationResponseSchema = z.object({
  key: operatorSecretKeySchema,
  rotatedAt: isoDateTimeSchema,
  restartRequired: z.boolean(),
  notes: z.array(z.string())
});

export type OperatorSecretRotationRequest = z.infer<
  typeof operatorSecretRotationRequestSchema
>;
export type OperatorSecretRotationResponse = z.infer<
  typeof operatorSecretRotationResponseSchema
>;
