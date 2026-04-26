import { z } from "zod";
import {
  isoDateTimeSchema,
  eventLevelSchema,
  openClawModelProviderSchema
} from "./enums.js";
import { tokenBudgetOverageActionSchema } from "./planning.js";

const discordIdSchema = z.string().min(1);
const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const nullablePositiveIntegerSchema = z.number().int().positive().nullable();
const nullableNonEmptyStringSchema = z.string().min(1).nullable();

export const operatorConfigValueSchemas = {
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
  REDDWARF_MODEL_PROVIDER: openClawModelProviderSchema,
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
  REDDWARF_TOKEN_BUDGET_OVERAGE_ACTION: tokenBudgetOverageActionSchema,
  // M25 F-189: hidden global kill-switch for Project Mode auto-merge. When
  // false the evaluator (F-194) treats every project as opt-out regardless
  // of the per-project flag. Default false so the feature is dark on
  // existing deployments until an operator explicitly enables it.
  REDDWARF_PROJECT_AUTOMERGE_ENABLED: z.boolean()
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

export const operatorConfigDefaults: {
  [K in OperatorConfigKey]: OperatorConfigValue<K>;
} = {
  REDDWARF_POLL_INTERVAL_MS: 30000,
  REDDWARF_DISPATCH_INTERVAL_MS: 15000,
  REDDWARF_API_PORT: 8080,
  REDDWARF_API_URL: "http://127.0.0.1:8080",
  REDDWARF_LOG_LEVEL: "info",
  REDDWARF_SKIP_OPENCLAW: false,
  REDDWARF_DRY_RUN: false,
  REDDWARF_OPENCLAW_BROWSER_ENABLED: true,
  REDDWARF_OPENCLAW_DISCORD_ENABLED: false,
  REDDWARF_OPENCLAW_DISCORD_DM_POLICY: "pairing",
  REDDWARF_OPENCLAW_DISCORD_GROUP_POLICY: "allowlist",
  REDDWARF_OPENCLAW_DISCORD_GUILD_IDS: [],
  REDDWARF_OPENCLAW_DISCORD_REQUIRE_MENTION: true,
  REDDWARF_OPENCLAW_DISCORD_NOTIFICATIONS_ENABLED: false,
  REDDWARF_OPENCLAW_DISCORD_STREAMING: "partial",
  REDDWARF_OPENCLAW_DISCORD_HISTORY_LIMIT: 24,
  REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_ENABLED: true,
  REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_INTERVAL_MS: null,
  REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_MIN_UPDATE_INTERVAL_MS: null,
  REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_HEALTHY_TEXT: null,
  REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_DEGRADED_TEXT: null,
  REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_EXHAUSTED_TEXT: null,
  REDDWARF_OPENCLAW_DISCORD_EXEC_APPROVALS_ENABLED: false,
  REDDWARF_OPENCLAW_DISCORD_APPROVER_IDS: [],
  REDDWARF_OPENCLAW_DISCORD_EXEC_APPROVAL_TARGET: "channel",
  REDDWARF_OPENCLAW_DISCORD_ACCENT_COLOR: "#d7263d",
  REDDWARF_MODEL_PROVIDER: "anthropic",
  REDDWARF_DB_POOL_MAX: 10,
  REDDWARF_DB_POOL_CONNECTION_TIMEOUT_MS: 5000,
  REDDWARF_DB_POOL_IDLE_TIMEOUT_MS: 30000,
  REDDWARF_DB_POOL_QUERY_TIMEOUT_MS: 15000,
  REDDWARF_DB_POOL_STATEMENT_TIMEOUT_MS: 15000,
  REDDWARF_DB_POOL_MAX_LIFETIME_SECONDS: 300,
  REDDWARF_MAX_RETRIES_ARCHITECT: 2,
  REDDWARF_MAX_RETRIES_DEVELOPER: 1,
  REDDWARF_MAX_RETRIES_VALIDATOR: 1,
  REDDWARF_MAX_RETRIES_REVIEWER: 1,
  REDDWARF_MAX_RETRIES_SCM: 1,
  REDDWARF_TOKEN_BUDGET_ARCHITECT: 80000,
  REDDWARF_TOKEN_BUDGET_DEVELOPER: 120000,
  REDDWARF_TOKEN_BUDGET_VALIDATOR: 40000,
  REDDWARF_TOKEN_BUDGET_REVIEWER: 60000,
  REDDWARF_TOKEN_BUDGET_SCM: 40000,
  REDDWARF_TOKEN_BUDGET_OVERAGE_ACTION: "warn",
  REDDWARF_PROJECT_AUTOMERGE_ENABLED: false
};

export const operatorConfigDescriptions: Record<OperatorConfigKey, string> = {
  REDDWARF_POLL_INTERVAL_MS: "Polling interval in milliseconds.",
  REDDWARF_DISPATCH_INTERVAL_MS:
    "Ready-task dispatch loop interval in milliseconds.",
  REDDWARF_API_PORT: "Operator API port.",
  REDDWARF_API_URL: "Optional full base URL override for the operator API.",
  REDDWARF_LOG_LEVEL: "Structured runtime log level.",
  REDDWARF_SKIP_OPENCLAW: "Skip OpenClaw startup when true.",
  REDDWARF_DRY_RUN:
    "Suppress SCM and follow-up GitHub mutations while keeping pipeline execution.",
  REDDWARF_OPENCLAW_BROWSER_ENABLED:
    "Enable OpenClaw's built-in browser integration.",
  REDDWARF_OPENCLAW_DISCORD_ENABLED:
    "Emit a native Discord channel block into the generated OpenClaw config.",
  REDDWARF_OPENCLAW_DISCORD_DM_POLICY:
    "Direct-message policy for OpenClaw's native Discord bridge.",
  REDDWARF_OPENCLAW_DISCORD_GROUP_POLICY:
    "Server policy for OpenClaw's native Discord bridge.",
  REDDWARF_OPENCLAW_DISCORD_GUILD_IDS:
    "Allowed Discord guild ids when Discord mode is enabled.",
  REDDWARF_OPENCLAW_DISCORD_REQUIRE_MENTION:
    "Require explicit mentions inside allowed Discord servers.",
  REDDWARF_OPENCLAW_DISCORD_NOTIFICATIONS_ENABLED:
    "Enable Discord streaming history, UI styling, and presence updates.",
  REDDWARF_OPENCLAW_DISCORD_STREAMING:
    "Discord streaming mode for native OpenClaw replies.",
  REDDWARF_OPENCLAW_DISCORD_HISTORY_LIMIT:
    "Recent Discord message history count to retain.",
  REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_ENABLED:
    "Enable OpenClaw's automatic Discord presence updates.",
  REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_INTERVAL_MS:
    "Optional override for the Discord presence refresh cadence.",
  REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_MIN_UPDATE_INTERVAL_MS:
    "Optional minimum interval between Discord presence updates.",
  REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_HEALTHY_TEXT:
    "Optional custom healthy-status presence text.",
  REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_DEGRADED_TEXT:
    "Optional custom degraded-status presence text.",
  REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_EXHAUSTED_TEXT:
    "Optional custom exhausted-status presence text.",
  REDDWARF_OPENCLAW_DISCORD_EXEC_APPROVALS_ENABLED:
    "Enable native OpenClaw approval prompts in Discord.",
  REDDWARF_OPENCLAW_DISCORD_APPROVER_IDS:
    "Discord user ids allowed to resolve native OpenClaw approval prompts.",
  REDDWARF_OPENCLAW_DISCORD_EXEC_APPROVAL_TARGET:
    "Where OpenClaw posts approval prompts: dm, channel, or both.",
  REDDWARF_OPENCLAW_DISCORD_ACCENT_COLOR:
    "Accent color for native Discord components and cards.",
  REDDWARF_MODEL_PROVIDER:
    "LLM provider used for RedDwarf planning and generated OpenClaw agent model bindings.",
  REDDWARF_DB_POOL_MAX: "Maximum Postgres connections in the shared pool.",
  REDDWARF_DB_POOL_CONNECTION_TIMEOUT_MS:
    "Fail Postgres connection attempts after this many milliseconds.",
  REDDWARF_DB_POOL_IDLE_TIMEOUT_MS:
    "Evict idle Postgres clients after this many milliseconds.",
  REDDWARF_DB_POOL_QUERY_TIMEOUT_MS:
    "Fail Postgres queries after this many milliseconds.",
  REDDWARF_DB_POOL_STATEMENT_TIMEOUT_MS:
    "Ask Postgres to cancel statements that exceed this runtime.",
  REDDWARF_DB_POOL_MAX_LIFETIME_SECONDS:
    "Recycle Postgres clients after this lifetime in seconds.",
  REDDWARF_MAX_RETRIES_ARCHITECT: "Planning retry budget alias.",
  REDDWARF_MAX_RETRIES_DEVELOPER: "Development retry budget alias.",
  REDDWARF_MAX_RETRIES_VALIDATOR: "Validation retry budget alias.",
  REDDWARF_MAX_RETRIES_REVIEWER:
    "Architecture-review retry budget alias.",
  REDDWARF_MAX_RETRIES_SCM: "SCM retry budget.",
  REDDWARF_TOKEN_BUDGET_ARCHITECT: "Planning token budget.",
  REDDWARF_TOKEN_BUDGET_DEVELOPER: "Development token budget.",
  REDDWARF_TOKEN_BUDGET_VALIDATOR: "Validation token budget.",
  REDDWARF_TOKEN_BUDGET_REVIEWER: "Architecture-review token budget.",
  REDDWARF_TOKEN_BUDGET_SCM: "SCM token budget.",
  REDDWARF_TOKEN_BUDGET_OVERAGE_ACTION:
    "Budget overage behavior: warn or block.",
  REDDWARF_PROJECT_AUTOMERGE_ENABLED:
    "Hidden global kill-switch for Project Mode auto-merge of sub-ticket PRs. Per-project opt-in is also required."
};

export function parseOperatorConfigValue<K extends OperatorConfigKey>(
  key: K,
  value: unknown
): OperatorConfigValue<K> {
  return operatorConfigValueSchemas[key].parse(value) as OperatorConfigValue<K>;
}

export function parseOperatorConfigEnvValue<K extends OperatorConfigKey>(
  key: K,
  rawValue: string | undefined
): OperatorConfigValue<K> {
  if (rawValue === undefined || rawValue.trim().length === 0) {
    const defaultValue = operatorConfigDefaults[key];
    return parseOperatorConfigValue(key, defaultValue) as OperatorConfigValue<K>;
  }

  if (
    key === "REDDWARF_OPENCLAW_DISCORD_GUILD_IDS" ||
    key === "REDDWARF_OPENCLAW_DISCORD_APPROVER_IDS"
  ) {
    return parseOperatorConfigValue(
      key,
      rawValue
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    );
  }

  if (
    key === "REDDWARF_SKIP_OPENCLAW" ||
    key === "REDDWARF_DRY_RUN" ||
    key === "REDDWARF_OPENCLAW_BROWSER_ENABLED" ||
    key === "REDDWARF_OPENCLAW_DISCORD_ENABLED" ||
    key === "REDDWARF_OPENCLAW_DISCORD_REQUIRE_MENTION" ||
    key === "REDDWARF_OPENCLAW_DISCORD_NOTIFICATIONS_ENABLED" ||
    key === "REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_ENABLED" ||
    key === "REDDWARF_OPENCLAW_DISCORD_EXEC_APPROVALS_ENABLED" ||
    key === "REDDWARF_PROJECT_AUTOMERGE_ENABLED"
  ) {
    return parseOperatorConfigValue(
      key,
      /^(true|1|yes)$/i.test(rawValue.trim())
    );
  }

  if (
    key === "REDDWARF_POLL_INTERVAL_MS" ||
    key === "REDDWARF_DISPATCH_INTERVAL_MS" ||
    key === "REDDWARF_API_PORT" ||
    key === "REDDWARF_DB_POOL_MAX" ||
    key === "REDDWARF_DB_POOL_CONNECTION_TIMEOUT_MS" ||
    key === "REDDWARF_DB_POOL_IDLE_TIMEOUT_MS" ||
    key === "REDDWARF_DB_POOL_QUERY_TIMEOUT_MS" ||
    key === "REDDWARF_DB_POOL_STATEMENT_TIMEOUT_MS" ||
    key === "REDDWARF_DB_POOL_MAX_LIFETIME_SECONDS" ||
    key === "REDDWARF_MAX_RETRIES_ARCHITECT" ||
    key === "REDDWARF_MAX_RETRIES_DEVELOPER" ||
    key === "REDDWARF_MAX_RETRIES_VALIDATOR" ||
    key === "REDDWARF_MAX_RETRIES_REVIEWER" ||
    key === "REDDWARF_MAX_RETRIES_SCM" ||
    key === "REDDWARF_TOKEN_BUDGET_ARCHITECT" ||
    key === "REDDWARF_TOKEN_BUDGET_DEVELOPER" ||
    key === "REDDWARF_TOKEN_BUDGET_VALIDATOR" ||
    key === "REDDWARF_TOKEN_BUDGET_REVIEWER" ||
    key === "REDDWARF_TOKEN_BUDGET_SCM" ||
    key === "REDDWARF_OPENCLAW_DISCORD_HISTORY_LIMIT"
  ) {
    return parseOperatorConfigValue(key, Number.parseInt(rawValue, 10));
  }

  if (
    key === "REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_INTERVAL_MS" ||
    key === "REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_MIN_UPDATE_INTERVAL_MS"
  ) {
    return parseOperatorConfigValue(
      key,
      rawValue.trim().length === 0 ? null : Number.parseInt(rawValue, 10)
    );
  }

  if (
    key === "REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_HEALTHY_TEXT" ||
    key === "REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_DEGRADED_TEXT" ||
    key === "REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_EXHAUSTED_TEXT"
  ) {
    return parseOperatorConfigValue(
      key,
      rawValue.trim().length === 0 ? null : rawValue
    );
  }

  return parseOperatorConfigValue(key, rawValue);
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

export const operatorConfigFieldSchema = z.object({
  key: operatorConfigKeySchema,
  value: z.unknown(),
  defaultValue: z.unknown(),
  description: z.string().min(1),
  updatedAt: isoDateTimeSchema.nullable(),
  source: z.enum(["default", "env", "database"])
});

export const operatorConfigResponseSchema = z.object({
  config: z.array(operatorConfigFieldSchema),
  total: z.number().int().min(0)
});

export const operatorConfigUpdateEntrySchema = z
  .object({
    key: operatorConfigKeySchema,
    value: z.unknown()
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

export const operatorConfigUpdateRequestSchema = z.object({
  entries: z.array(operatorConfigUpdateEntrySchema).min(1)
});

const jsonSchemaTypeByKey: Record<OperatorConfigKey, unknown> = {
  REDDWARF_POLL_INTERVAL_MS: { type: "integer", minimum: 1 },
  REDDWARF_DISPATCH_INTERVAL_MS: { type: "integer", minimum: 1 },
  REDDWARF_API_PORT: { type: "integer", minimum: 1 },
  REDDWARF_API_URL: { type: "string", format: "uri" },
  REDDWARF_LOG_LEVEL: { type: "string", enum: ["debug", "info", "warn", "error"] },
  REDDWARF_SKIP_OPENCLAW: { type: "boolean" },
  REDDWARF_DRY_RUN: { type: "boolean" },
  REDDWARF_OPENCLAW_BROWSER_ENABLED: { type: "boolean" },
  REDDWARF_OPENCLAW_DISCORD_ENABLED: { type: "boolean" },
  REDDWARF_OPENCLAW_DISCORD_DM_POLICY: {
    type: "string",
    enum: ["pairing", "allow", "deny"]
  },
  REDDWARF_OPENCLAW_DISCORD_GROUP_POLICY: {
    type: "string",
    enum: ["allowlist", "allow", "deny"]
  },
  REDDWARF_OPENCLAW_DISCORD_GUILD_IDS: {
    type: "array",
    items: { type: "string" }
  },
  REDDWARF_OPENCLAW_DISCORD_REQUIRE_MENTION: { type: "boolean" },
  REDDWARF_OPENCLAW_DISCORD_NOTIFICATIONS_ENABLED: { type: "boolean" },
  REDDWARF_OPENCLAW_DISCORD_STREAMING: {
    type: "string",
    enum: ["off", "partial", "full"]
  },
  REDDWARF_OPENCLAW_DISCORD_HISTORY_LIMIT: { type: "integer", minimum: 1 },
  REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_ENABLED: { type: "boolean" },
  REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_INTERVAL_MS: {
    anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }]
  },
  REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_MIN_UPDATE_INTERVAL_MS: {
    anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }]
  },
  REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_HEALTHY_TEXT: {
    anyOf: [{ type: "string", minLength: 1 }, { type: "null" }]
  },
  REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_DEGRADED_TEXT: {
    anyOf: [{ type: "string", minLength: 1 }, { type: "null" }]
  },
  REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_EXHAUSTED_TEXT: {
    anyOf: [{ type: "string", minLength: 1 }, { type: "null" }]
  },
  REDDWARF_OPENCLAW_DISCORD_EXEC_APPROVALS_ENABLED: { type: "boolean" },
  REDDWARF_OPENCLAW_DISCORD_APPROVER_IDS: {
    type: "array",
    items: { type: "string" }
  },
  REDDWARF_OPENCLAW_DISCORD_EXEC_APPROVAL_TARGET: {
    type: "string",
    enum: ["dm", "channel", "both"]
  },
  REDDWARF_OPENCLAW_DISCORD_ACCENT_COLOR: {
    type: "string",
    pattern: "^#[0-9a-fA-F]{6}$"
  },
  REDDWARF_MODEL_PROVIDER: {
    type: "string",
    enum: ["anthropic", "openai", "openai-codex"]
  },
  REDDWARF_DB_POOL_MAX: { type: "integer", minimum: 1 },
  REDDWARF_DB_POOL_CONNECTION_TIMEOUT_MS: { type: "integer", minimum: 1 },
  REDDWARF_DB_POOL_IDLE_TIMEOUT_MS: { type: "integer", minimum: 1 },
  REDDWARF_DB_POOL_QUERY_TIMEOUT_MS: { type: "integer", minimum: 1 },
  REDDWARF_DB_POOL_STATEMENT_TIMEOUT_MS: { type: "integer", minimum: 1 },
  REDDWARF_DB_POOL_MAX_LIFETIME_SECONDS: { type: "integer", minimum: 1 },
  REDDWARF_MAX_RETRIES_ARCHITECT: { type: "integer", minimum: 0 },
  REDDWARF_MAX_RETRIES_DEVELOPER: { type: "integer", minimum: 0 },
  REDDWARF_MAX_RETRIES_VALIDATOR: { type: "integer", minimum: 0 },
  REDDWARF_MAX_RETRIES_REVIEWER: { type: "integer", minimum: 0 },
  REDDWARF_MAX_RETRIES_SCM: { type: "integer", minimum: 0 },
  REDDWARF_TOKEN_BUDGET_ARCHITECT: { type: "integer", minimum: 1 },
  REDDWARF_TOKEN_BUDGET_DEVELOPER: { type: "integer", minimum: 1 },
  REDDWARF_TOKEN_BUDGET_VALIDATOR: { type: "integer", minimum: 1 },
  REDDWARF_TOKEN_BUDGET_REVIEWER: { type: "integer", minimum: 1 },
  REDDWARF_TOKEN_BUDGET_SCM: { type: "integer", minimum: 1 },
  REDDWARF_TOKEN_BUDGET_OVERAGE_ACTION: {
    type: "string",
    enum: ["warn", "block"]
  },
  REDDWARF_PROJECT_AUTOMERGE_ENABLED: { type: "boolean" }
};

export const operatorConfigSchemaResponseSchema = z.object({
  schema: z.object({
    type: z.literal("object"),
    additionalProperties: z.literal(false),
    properties: z.record(z.unknown()),
    defaults: z.record(z.unknown()),
    descriptions: z.record(z.string().min(1))
  })
});

export function buildOperatorConfigJsonSchema(): z.infer<
  typeof operatorConfigSchemaResponseSchema
>["schema"] {
  const properties: Record<string, unknown> = {};
  const defaults: Record<string, unknown> = {};
  const descriptions: Record<string, string> = {};

  for (const key of operatorConfigKeys) {
    properties[key] = jsonSchemaTypeByKey[key];
    defaults[key] = operatorConfigDefaults[key];
    descriptions[key] = operatorConfigDescriptions[key];
  }

  return {
    type: "object",
    additionalProperties: false,
    properties,
    defaults,
    descriptions
  };
}

export type OperatorConfigEntry = {
  [K in OperatorConfigKey]: {
    key: K;
    value: OperatorConfigValue<K>;
    updatedAt: string;
  };
}[OperatorConfigKey];

export type OperatorConfigField = z.infer<typeof operatorConfigFieldSchema>;
export type OperatorConfigResponse = z.infer<typeof operatorConfigResponseSchema>;
export type OperatorConfigUpdateRequest = z.infer<
  typeof operatorConfigUpdateRequestSchema
>;
