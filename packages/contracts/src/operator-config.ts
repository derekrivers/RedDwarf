import { z } from "zod";
import { isoDateTimeSchema, eventLevelSchema } from "./enums.js";
import { tokenBudgetOverageActionSchema } from "./planning.js";

const githubRepoRefSchema = z.string().regex(/^[^/\s]+\/[^/\s]+$/);
const discordIdSchema = z.string().min(1);
const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const nullablePositiveIntegerSchema = z.number().int().positive().nullable();
const nullableNonEmptyStringSchema = z.string().min(1).nullable();

export const operatorConfigValueSchemas = {
  REDDWARF_POLL_REPOS: z.array(githubRepoRefSchema),
  REDDWARF_POLL_INTERVAL_MS: z.number().int().positive(),
  REDDWARF_DISPATCH_INTERVAL_MS: z.number().int().positive(),
  REDDWARF_API_PORT: z.number().int().positive(),
  REDDWARF_API_URL: z.string().url(),
  REDDWARF_LOG_LEVEL: eventLevelSchema,
  REDDWARF_SKIP_OPENCLAW: z.boolean(),
  REDDWARF_DRY_RUN: z.boolean(),
  REDDWARF_OPENCLAW_BROWSER_ENABLED: z.boolean(),
  REDDWARF_OPENCLAW_DISCORD_ENABLED: z.boolean(),
  REDDWARF_OPENCLAW_DISCORD_DM_POLICY: z.enum(["pairing", "allow", "deny"]),
  REDDWARF_OPENCLAW_DISCORD_GROUP_POLICY: z.enum(["allowlist", "allow", "deny"]),
  REDDWARF_OPENCLAW_DISCORD_GUILD_IDS: z.array(discordIdSchema),
  REDDWARF_OPENCLAW_DISCORD_REQUIRE_MENTION: z.boolean(),
  REDDWARF_OPENCLAW_DISCORD_NOTIFICATIONS_ENABLED: z.boolean(),
  REDDWARF_OPENCLAW_DISCORD_STREAMING: z.enum(["off", "partial", "full"]),
  REDDWARF_OPENCLAW_DISCORD_HISTORY_LIMIT: z.number().int().positive(),
  REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_ENABLED: z.boolean(),
  REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_INTERVAL_MS:
    nullablePositiveIntegerSchema,
  REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_MIN_UPDATE_INTERVAL_MS:
    nullablePositiveIntegerSchema,
  REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_HEALTHY_TEXT:
    nullableNonEmptyStringSchema,
  REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_DEGRADED_TEXT:
    nullableNonEmptyStringSchema,
  REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_EXHAUSTED_TEXT:
    nullableNonEmptyStringSchema,
  REDDWARF_OPENCLAW_DISCORD_EXEC_APPROVALS_ENABLED: z.boolean(),
  REDDWARF_OPENCLAW_DISCORD_APPROVER_IDS: z.array(discordIdSchema),
  REDDWARF_OPENCLAW_DISCORD_EXEC_APPROVAL_TARGET: z.enum([
    "dm",
    "channel",
    "both"
  ]),
  REDDWARF_OPENCLAW_DISCORD_ACCENT_COLOR: hexColorSchema,
  REDDWARF_DB_POOL_MAX: z.number().int().positive(),
  REDDWARF_DB_POOL_CONNECTION_TIMEOUT_MS: z.number().int().positive(),
  REDDWARF_DB_POOL_IDLE_TIMEOUT_MS: z.number().int().positive(),
  REDDWARF_DB_POOL_QUERY_TIMEOUT_MS: z.number().int().positive(),
  REDDWARF_DB_POOL_STATEMENT_TIMEOUT_MS: z.number().int().positive(),
  REDDWARF_DB_POOL_MAX_LIFETIME_SECONDS: z.number().int().positive(),
  REDDWARF_MAX_RETRIES_ARCHITECT: z.number().int().min(0),
  REDDWARF_MAX_RETRIES_DEVELOPER: z.number().int().min(0),
  REDDWARF_MAX_RETRIES_VALIDATOR: z.number().int().min(0),
  REDDWARF_MAX_RETRIES_REVIEWER: z.number().int().min(0),
  REDDWARF_MAX_RETRIES_SCM: z.number().int().min(0),
  REDDWARF_TOKEN_BUDGET_ARCHITECT: z.number().int().positive(),
  REDDWARF_TOKEN_BUDGET_DEVELOPER: z.number().int().positive(),
  REDDWARF_TOKEN_BUDGET_VALIDATOR: z.number().int().positive(),
  REDDWARF_TOKEN_BUDGET_REVIEWER: z.number().int().positive(),
  REDDWARF_TOKEN_BUDGET_SCM: z.number().int().positive(),
  REDDWARF_TOKEN_BUDGET_OVERAGE_ACTION: tokenBudgetOverageActionSchema
} as const;

export const operatorConfigKeys = Object.keys(
  operatorConfigValueSchemas
) as (keyof typeof operatorConfigValueSchemas)[];

export const operatorConfigKeySchema = z.enum(
  operatorConfigKeys as [
    keyof typeof operatorConfigValueSchemas,
    ...(keyof typeof operatorConfigValueSchemas)[]
  ]
);

type OperatorConfigValueSchemaMap = typeof operatorConfigValueSchemas;
export type OperatorConfigKey = keyof OperatorConfigValueSchemaMap;
export type OperatorConfigValueMap = {
  [K in OperatorConfigKey]: z.infer<OperatorConfigValueSchemaMap[K]>;
};
export type OperatorConfigValue<K extends OperatorConfigKey = OperatorConfigKey> =
  OperatorConfigValueMap[K];

export function parseOperatorConfigValue<K extends OperatorConfigKey>(
  key: K,
  value: unknown
): OperatorConfigValue<K> {
  return operatorConfigValueSchemas[key].parse(value) as OperatorConfigValue<K>;
}

export function serializeOperatorConfigValue<K extends OperatorConfigKey>(
  key: K,
  value: OperatorConfigValue<K>
): string {
  const parsed = parseOperatorConfigValue(key, value);

  if (parsed === null) {
    return "";
  }

  if (Array.isArray(parsed)) {
    return parsed.join(",");
  }

  switch (typeof parsed) {
    case "boolean":
      return parsed ? "true" : "false";
    case "number":
      return String(parsed);
    default:
      return parsed;
  }
}

export const operatorConfigEntrySchema = z
  .object({
    key: operatorConfigKeySchema,
    value: z.unknown(),
    updatedAt: isoDateTimeSchema
  })
  .superRefine((entry, ctx) => {
    const result = operatorConfigValueSchemas[entry.key].safeParse(entry.value);

    if (result.success) {
      return;
    }

    for (const issue of result.error.issues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value", ...issue.path],
        message: issue.message
      });
    }
  });

export type OperatorConfigEntry = {
  [K in OperatorConfigKey]: {
    key: K;
    value: OperatorConfigValue<K>;
    updatedAt: string;
  };
}[OperatorConfigKey];
