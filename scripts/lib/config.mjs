/**
 * scripts/lib/config.mjs
 *
 * Shared script configuration for connection strings, workspace root,
 * repo root path, and formatted logging helpers.
 *
 * Import from any script:
 *   import { connectionString, repoRoot, createScriptLogger, formatError } from "./lib/config.mjs";
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import pg from "pg";
import {
  ensureRepoSecretsFile,
  loadRepoEnv as loadSharedRepoEnv,
  repoRoot as sharedRepoRoot,
  repoSecretsPath
} from "./repo-env.mjs";

// ── Paths ────────────────────────────────────────────────────────────────────

const __libdir = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the repository root directory. */
export const repoRoot = sharedRepoRoot;

/** Absolute path to the scripts directory. */
export const scriptsDir = resolve(__libdir, "..");
export { repoSecretsPath, ensureRepoSecretsFile };

// ── Database ─────────────────────────────────────────────────────────────────

/** Default Postgres connection string used by all scripts. */
export const DEFAULT_CONNECTION_STRING =
  "postgresql://reddwarf:reddwarf@127.0.0.1:55532/reddwarf";

const { Client } = pg;

export async function loadRepoEnv() {
  await loadSharedRepoEnv();
}

function readPositiveIntegerEnvWithFallback(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolve the Postgres connection string from environment variables
 * with a sensible local-development default.
 */
export function resolveConnectionString() {
  return (
    process.env.HOST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    DEFAULT_CONNECTION_STRING
  );
}

export function resolvePostgresPoolConfig() {
  return {
    max: readPositiveIntegerEnvWithFallback("REDDWARF_DB_POOL_MAX", 10),
    connectionTimeoutMillis: readPositiveIntegerEnvWithFallback(
      "REDDWARF_DB_POOL_CONNECTION_TIMEOUT_MS",
      5_000
    ),
    idleTimeoutMillis: readPositiveIntegerEnvWithFallback(
      "REDDWARF_DB_POOL_IDLE_TIMEOUT_MS",
      30_000
    ),
    queryTimeoutMillis: readPositiveIntegerEnvWithFallback(
      "REDDWARF_DB_POOL_QUERY_TIMEOUT_MS",
      15_000
    ),
    statementTimeoutMillis: readPositiveIntegerEnvWithFallback(
      "REDDWARF_DB_POOL_STATEMENT_TIMEOUT_MS",
      15_000
    ),
    maxLifetimeSeconds: readPositiveIntegerEnvWithFallback(
      "REDDWARF_DB_POOL_MAX_LIFETIME_SECONDS",
      300
    )
  };
}

export let connectionString = resolveConnectionString();
export let postgresPoolConfig = resolvePostgresPoolConfig();

export function refreshDerivedConfig() {
  connectionString = resolveConnectionString();
  postgresPoolConfig = resolvePostgresPoolConfig();

  return {
    connectionString,
    postgresPoolConfig
  };
}

export async function applyOperatorRuntimeConfig(options = {}) {
  const {
    connectionString: bootstrapConnectionString = resolveConnectionString(),
    connectionTimeoutMillis = 2_000,
    log
  } = options;

  const {
    operatorConfigEntrySchema,
    serializeOperatorConfigValue
  } = await import("../../packages/contracts/dist/index.js");
  const client = new Client({
    connectionString: bootstrapConnectionString,
    connectionTimeoutMillis
  });

  try {
    await client.connect();
    const result = await client.query(
      "SELECT key, value, updated_at FROM operator_config ORDER BY key ASC"
    );

    for (const row of result.rows) {
      const entry = operatorConfigEntrySchema.parse({
        key: row.key,
        value: row.value,
        updatedAt: new Date(row.updated_at).toISOString()
      });
      process.env[entry.key] = serializeOperatorConfigValue(
        entry.key,
        entry.value
      );
    }

    refreshDerivedConfig();
    if (typeof log === "function" && result.rows.length > 0) {
      log(`Applied ${result.rows.length} operator config override(s) from Postgres.`);
    }
    return result.rows.length;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : null;

    if (
      message.includes('relation "operator_config" does not exist') ||
      message.includes("relation \"operator_config\" does not exist")
    ) {
      if (typeof log === "function") {
        log("Operator config table not found yet; using .env runtime values.");
      }
      refreshDerivedConfig();
      return 0;
    }

    if (
      code === "ECONNREFUSED" ||
      code === "ENOTFOUND" ||
      code === "ETIMEDOUT" ||
      message.includes("ECONNREFUSED") ||
      message.includes("connect ETIMEDOUT") ||
      message.includes("Connection terminated unexpectedly")
    ) {
      if (typeof log === "function") {
        log(
          "Operator config database is not reachable yet; using .env runtime values for bootstrap."
        );
      }
      refreshDerivedConfig();
      return 0;
    }

    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

// ── Evidence ─────────────────────────────────────────────────────────────────

/** Default host-side evidence root directory. */
export const defaultEvidenceRoot = resolve(
  repoRoot,
  process.env.REDDWARF_HOST_EVIDENCE_ROOT ?? "runtime-data/evidence"
);

// ── Logging ──────────────────────────────────────────────────────────────────

/**
 * Create a logger pair bound to a script name prefix.
 *
 * @param {string} name — label used in the `[name]` prefix
 * @returns {{ log: (msg: string) => void, logError: (msg: string) => void }}
 */
export function createScriptLogger(name) {
  return {
    log(message) {
      process.stdout.write(`[${name}] ${message}\n`);
    },
    logError(message) {
      process.stderr.write(`[${name}] ERROR: ${message}\n`);
    }
  };
}

// ── OpenClaw config ─────────────────────────────────────────────────────

/** Path to the OpenClaw config template. */
export const openClawConfigTemplatePath = resolve(repoRoot, "infra", "docker", "openclaw.json");

/** Path to the resolved OpenClaw runtime config (host-mounted into the container). */
export const openClawConfigRuntimePath = resolve(repoRoot, "runtime-data", "openclaw-home", "openclaw.json");

/** Path to the OpenClaw exec approvals runtime config (host-mounted into the container). */
export const openClawExecApprovalsRuntimePath = resolve(
  repoRoot,
  "runtime-data",
  "openclaw-home",
  "exec-approvals.json"
);

function readBooleanEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function readListEnv(name) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return [];
  }

  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function readPositiveIntegerEnv(name) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readOneOfEnv(name, allowed) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  const value = raw.trim();
  return allowed.includes(value) ? value : undefined;
}

/**
 * Build the `agents.defaults.compaction` block from REDDWARF_OPENCLAW_COMPACTION_*
 * env vars. Returns null when the mode is unset, so the generator skips the
 * block entirely.
 *
 * Recommended production posture:
 *   REDDWARF_OPENCLAW_COMPACTION_MODE=safeguard
 *   REDDWARF_OPENCLAW_COMPACTION_IDENTIFIER_POLICY=strict
 */
export function buildCompactionConfigFromEnv() {
  const mode = readOneOfEnv("REDDWARF_OPENCLAW_COMPACTION_MODE", [
    "default",
    "safeguard"
  ]);
  const identifierPolicy = readOneOfEnv(
    "REDDWARF_OPENCLAW_COMPACTION_IDENTIFIER_POLICY",
    ["strict", "custom", "off"]
  );
  const timeoutSeconds = readPositiveIntegerEnv(
    "REDDWARF_OPENCLAW_COMPACTION_TIMEOUT_SECONDS"
  );
  const notifyUserRaw = process.env.REDDWARF_OPENCLAW_COMPACTION_NOTIFY_USER;
  const memoryFlushEnabled =
    process.env.REDDWARF_OPENCLAW_COMPACTION_MEMORY_FLUSH_ENABLED;
  const memoryFlushThreshold = readPositiveIntegerEnv(
    "REDDWARF_OPENCLAW_COMPACTION_MEMORY_FLUSH_SOFT_THRESHOLD_TOKENS"
  );

  const config = {};
  if (mode) {
    config.mode = mode;
  }
  if (identifierPolicy) {
    config.identifierPolicy = identifierPolicy;
  }
  if (timeoutSeconds !== undefined) {
    config.timeoutSeconds = timeoutSeconds;
  }
  if (notifyUserRaw !== undefined && notifyUserRaw.trim().length > 0) {
    config.notifyUser = readBooleanEnv(
      "REDDWARF_OPENCLAW_COMPACTION_NOTIFY_USER"
    );
  }
  if (
    memoryFlushEnabled !== undefined &&
    memoryFlushEnabled.trim().length > 0
  ) {
    config.memoryFlush = {
      enabled: readBooleanEnv(
        "REDDWARF_OPENCLAW_COMPACTION_MEMORY_FLUSH_ENABLED"
      ),
      ...(memoryFlushThreshold !== undefined
        ? { softThresholdTokens: memoryFlushThreshold }
        : {})
    };
  }

  return Object.keys(config).length > 0 ? config : null;
}

export function buildContextLimitsConfigFromEnv() {
  const memoryGetMaxChars = readPositiveIntegerEnv(
    "REDDWARF_OPENCLAW_CONTEXT_MEMORY_GET_MAX_CHARS"
  );
  const toolResultMaxChars = readPositiveIntegerEnv(
    "REDDWARF_OPENCLAW_CONTEXT_TOOL_RESULT_MAX_CHARS"
  );
  const postCompactionMaxChars = readPositiveIntegerEnv(
    "REDDWARF_OPENCLAW_CONTEXT_POST_COMPACTION_MAX_CHARS"
  );

  const config = {};
  if (memoryGetMaxChars !== undefined) {
    config.memoryGetMaxChars = memoryGetMaxChars;
  }
  if (toolResultMaxChars !== undefined) {
    config.toolResultMaxChars = toolResultMaxChars;
  }
  if (postCompactionMaxChars !== undefined) {
    config.postCompactionMaxChars = postCompactionMaxChars;
  }

  return Object.keys(config).length > 0 ? config : null;
}

export function buildBootstrapConfigFromEnv() {
  const maxChars = readPositiveIntegerEnv(
    "REDDWARF_OPENCLAW_BOOTSTRAP_MAX_CHARS"
  );
  const totalMaxChars = readPositiveIntegerEnv(
    "REDDWARF_OPENCLAW_BOOTSTRAP_TOTAL_MAX_CHARS"
  );
  const promptTruncationWarning = readOneOfEnv(
    "REDDWARF_OPENCLAW_BOOTSTRAP_PROMPT_TRUNCATION_WARNING",
    ["off", "once", "always"]
  );

  const config = {};
  if (maxChars !== undefined) {
    config.maxChars = maxChars;
  }
  if (totalMaxChars !== undefined) {
    config.totalMaxChars = totalMaxChars;
  }
  if (promptTruncationWarning) {
    config.promptTruncationWarning = promptTruncationWarning;
  }

  return Object.keys(config).length > 0 ? config : null;
}

/**
 * Build the `agents.defaults.heartbeat` block from
 * REDDWARF_OPENCLAW_GATEWAY_HEARTBEAT_INTERVAL (and optional
 * REDDWARF_OPENCLAW_GATEWAY_HEARTBEAT_PROMPT). The interval uses OpenClaw
 * duration syntax (e.g. `30m`, `5m`, `0m` to disable). When the env var is
 * unset, this returns `null` so the generator falls back to its built-in
 * default of `{ every: "0m" }` (disabled).
 */
export function buildHeartbeatConfigFromEnv() {
  const intervalRaw =
    process.env.REDDWARF_OPENCLAW_GATEWAY_HEARTBEAT_INTERVAL;
  const promptRaw = process.env.REDDWARF_OPENCLAW_GATEWAY_HEARTBEAT_PROMPT;

  const interval =
    intervalRaw !== undefined && intervalRaw.trim().length > 0
      ? intervalRaw.trim()
      : undefined;
  const prompt =
    promptRaw !== undefined && promptRaw.trim().length > 0
      ? promptRaw
      : undefined;

  if (interval === undefined && prompt === undefined) {
    return null;
  }

  const config = {};
  if (interval !== undefined) {
    config.every = interval;
  }
  if (prompt !== undefined) {
    config.prompt = prompt;
  }
  return config;
}

/**
 * Build the `tools.loopDetection` block from REDDWARF_OPENCLAW_LOOP_DETECTION_*
 * env vars. Set REDDWARF_OPENCLAW_LOOP_DETECTION_ENABLED=true to opt in; all
 * detectors default on when the feature is enabled unless individually
 * disabled.
 */
export function buildLoopDetectionConfigFromEnv() {
  const enabledRaw = process.env.REDDWARF_OPENCLAW_LOOP_DETECTION_ENABLED;
  if (enabledRaw === undefined || enabledRaw.trim().length === 0) {
    return null;
  }

  const enabled = readBooleanEnv("REDDWARF_OPENCLAW_LOOP_DETECTION_ENABLED");
  const warningThreshold = readPositiveIntegerEnv(
    "REDDWARF_OPENCLAW_LOOP_DETECTION_WARNING_THRESHOLD"
  );
  const criticalThreshold = readPositiveIntegerEnv(
    "REDDWARF_OPENCLAW_LOOP_DETECTION_CRITICAL_THRESHOLD"
  );
  const genericRepeatRaw =
    process.env.REDDWARF_OPENCLAW_LOOP_DETECTION_GENERIC_REPEAT;
  const knownPollNoProgressRaw =
    process.env.REDDWARF_OPENCLAW_LOOP_DETECTION_KNOWN_POLL_NO_PROGRESS;
  const pingPongRaw = process.env.REDDWARF_OPENCLAW_LOOP_DETECTION_PING_PONG;

  const config = { enabled };
  if (warningThreshold !== undefined) {
    config.warningThreshold = warningThreshold;
  }
  if (criticalThreshold !== undefined) {
    config.criticalThreshold = criticalThreshold;
  }

  const detectors = {};
  if (genericRepeatRaw !== undefined && genericRepeatRaw.trim().length > 0) {
    detectors.genericRepeat = readBooleanEnv(
      "REDDWARF_OPENCLAW_LOOP_DETECTION_GENERIC_REPEAT"
    );
  }
  if (
    knownPollNoProgressRaw !== undefined &&
    knownPollNoProgressRaw.trim().length > 0
  ) {
    detectors.knownPollNoProgress = readBooleanEnv(
      "REDDWARF_OPENCLAW_LOOP_DETECTION_KNOWN_POLL_NO_PROGRESS"
    );
  }
  if (pingPongRaw !== undefined && pingPongRaw.trim().length > 0) {
    detectors.pingPong = readBooleanEnv(
      "REDDWARF_OPENCLAW_LOOP_DETECTION_PING_PONG"
    );
  }
  if (Object.keys(detectors).length > 0) {
    config.detectors = detectors;
  }

  return config;
}

export function resolveModelProviderEnv() {
  const canonical = process.env.REDDWARF_MODEL_PROVIDER?.trim();
  const legacy = process.env.REDDWARF_OPENCLAW_MODEL_PROVIDER?.trim();

  if (
    canonical &&
    legacy &&
    canonical.length > 0 &&
    legacy.length > 0 &&
    canonical !== legacy
  ) {
    throw new Error(
      "REDDWARF_MODEL_PROVIDER and REDDWARF_OPENCLAW_MODEL_PROVIDER disagree. " +
        "Use REDDWARF_MODEL_PROVIDER as the canonical provider config key."
    );
  }

  const provider = canonical && canonical.length > 0 ? canonical : legacy;
  const resolved = provider && provider.length > 0 ? provider : "anthropic";

  if (
    resolved !== "anthropic" &&
    resolved !== "openai" &&
    resolved !== "openai-codex"
  ) {
    throw new Error(
      `Invalid REDDWARF_MODEL_PROVIDER value "${resolved}". Expected "anthropic", "openai", or "openai-codex".`
    );
  }

  return resolved;
}

/**
 * Decide which direct-API keys the OpenClaw container should be given based
 * on the active provider posture. F-157 required the gateway's process
 * environment to carry only the *active* model API key, and never the
 * inactive one. The compose file previously forwarded both unconditionally,
 * regressing F-157 — this helper restores the intended scoping.
 *
 * Rules:
 *   - provider = anthropic                → Anthropic key only
 *   - provider = openai                   → OpenAI key only
 *   - provider = openai-codex             → neither key (Codex uses OAuth
 *                                            via per-role auth-profiles.json)
 *   - failover enabled                    → both keys, because a failover
 *                                            chain's alternate provider
 *                                            needs its key to succeed. This
 *                                            is explicit opt-in via
 *                                            REDDWARF_MODEL_FAILOVER_ENABLED
 *                                            and is documented as billing-
 *                                            material in .env.example.
 *
 * Returns the scoped values to inject. The caller is responsible for
 * setting them on process.env before spawning docker compose.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ anthropic: string, openai: string, provider: string, failoverEnabled: boolean }}
 */
export function resolveOpenClawApiKeyScope(env = process.env) {
  const provider = (env.REDDWARF_MODEL_PROVIDER ?? "anthropic")
    .trim()
    .toLowerCase() || "anthropic";
  const failoverEnabled = env.REDDWARF_MODEL_FAILOVER_ENABLED === "true";

  const rawAnthropic = env.ANTHROPIC_API_KEY ?? "";
  const rawOpenAI = env.OPENAI_API_KEY ?? "";

  if (failoverEnabled) {
    return {
      anthropic: rawAnthropic,
      openai: rawOpenAI,
      provider,
      failoverEnabled
    };
  }

  if (provider === "anthropic") {
    return { anthropic: rawAnthropic, openai: "", provider, failoverEnabled };
  }

  if (provider === "openai") {
    return { anthropic: "", openai: rawOpenAI, provider, failoverEnabled };
  }

  // provider === "openai-codex" (validated above). Neither direct key is
  // injected; the container authenticates via the Codex OAuth profiles
  // mounted at runtime-data/workspaces/.agents/<role>/agent/auth-profiles.json.
  return { anthropic: "", openai: "", provider, failoverEnabled };
}

/**
 * Apply the scoped API keys to process.env under the proxy var names the
 * compose file references (OPENCLAW_ANTHROPIC_API_KEY,
 * OPENCLAW_OPENAI_API_KEY). Must be called before `docker compose up` so
 * the compose variable substitution picks up the scoped values.
 *
 * Logs which keys were injected and why so the operator can verify the
 * posture at boot time.
 *
 * @param {{ log?: (msg: string) => void }} [options]
 */
export function applyOpenClawApiKeyScope(options = {}) {
  const scope = resolveOpenClawApiKeyScope();
  process.env.OPENCLAW_ANTHROPIC_API_KEY = scope.anthropic;
  process.env.OPENCLAW_OPENAI_API_KEY = scope.openai;

  const log = options.log;
  if (!log) return;

  const summary = [
    `provider=${scope.provider}`,
    `failover=${scope.failoverEnabled ? "on" : "off"}`,
    `anthropic=${scope.anthropic.length > 0 ? "injected" : "absent"}`,
    `openai=${scope.openai.length > 0 ? "injected" : "absent"}`
  ].join(" ");
  log(`OpenClaw container API key scope (F-157): ${summary}`);
}

async function readJsonFileIfExists(path) {
  const { readFile } = await import("node:fs/promises");

  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : null;

    if (code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function normalizeExecApprovalObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * Generate the OpenClaw runtime config from the shared control-plane
 * generator so env-driven features stay typed instead of relying on
 * string-only template substitution.
 *
 * @param {{ log?: (msg: string) => void }} [options]
 */
export async function resolveOpenClawConfig(options) {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { generateOpenClawConfig, serializeOpenClawConfig } = await import(
    "../../packages/control-plane/dist/index.js"
  );
  const discordEnabled = readBooleanEnv("REDDWARF_OPENCLAW_DISCORD_ENABLED");
  const discordGuildIds = readListEnv("REDDWARF_OPENCLAW_DISCORD_GUILD_IDS");
  const discordRequireMention = readBooleanEnv(
    "REDDWARF_OPENCLAW_DISCORD_REQUIRE_MENTION",
    true
  );
  const discordNotificationsEnabled = readBooleanEnv(
    "REDDWARF_OPENCLAW_DISCORD_NOTIFICATIONS_ENABLED"
  );
  const discordExecApprovalsEnabled = readBooleanEnv(
    "REDDWARF_OPENCLAW_DISCORD_EXEC_APPROVALS_ENABLED"
  );
  const discordApproverIds = readListEnv(
    "REDDWARF_OPENCLAW_DISCORD_APPROVER_IDS"
  );

  const compactionConfig = buildCompactionConfigFromEnv();
  const contextLimitsConfig = buildContextLimitsConfigFromEnv();
  const bootstrapConfig = buildBootstrapConfigFromEnv();
  const loopDetectionConfig = buildLoopDetectionConfigFromEnv();
  const heartbeatConfig = buildHeartbeatConfigFromEnv();
  const config = generateOpenClawConfig({
    workspaceRoot: (
      process.env.REDDWARF_WORKSPACE_ROOT ?? "/var/lib/reddwarf/workspaces"
    ).replace(/\\/g, "/"),
    policyRoot: process.env.REDDWARF_POLICY_ROOT ?? "/opt/reddwarf",
    gatewayAuthToken: process.env.OPENCLAW_GATEWAY_TOKEN,
    hookToken: process.env.OPENCLAW_HOOK_TOKEN,
    operatorApiToken: process.env.REDDWARF_OPERATOR_TOKEN,
    operatorApiBaseUrl: process.env.REDDWARF_OPENCLAW_OPERATOR_API_URL,
    browser: {
      enabled: readBooleanEnv("REDDWARF_OPENCLAW_BROWSER_ENABLED", true)
    },
    modelProvider: resolveModelProviderEnv(),
    enableModelFailover: readBooleanEnv("REDDWARF_MODEL_FAILOVER_ENABLED"),
    enableAgentToAgent: readBooleanEnv("REDDWARF_OPENCLAW_AGENT_TO_AGENT_ENABLED"),
    ...(compactionConfig ? { compaction: compactionConfig } : {}),
    ...(contextLimitsConfig ? { contextLimits: contextLimitsConfig } : {}),
    ...(bootstrapConfig ? { bootstrap: bootstrapConfig } : {}),
    ...(loopDetectionConfig ? { loopDetection: loopDetectionConfig } : {}),
    ...(heartbeatConfig ? { heartbeat: heartbeatConfig } : {}),
    ...(discordEnabled
      ? {
          discord: {
            enabled: true,
            token:
              process.env.OPENCLAW_DISCORD_BOT_TOKEN ??
              process.env.DISCORD_BOT_TOKEN ??
              "",
            dmPolicy:
              process.env.REDDWARF_OPENCLAW_DISCORD_DM_POLICY ?? "pairing",
            groupPolicy:
              process.env.REDDWARF_OPENCLAW_DISCORD_GROUP_POLICY ?? "allowlist",
            ...(discordApproverIds.length > 0
              ? { allowFrom: discordApproverIds }
              : {}),
            ...(discordNotificationsEnabled
              ? {
                  streaming:
                    process.env.REDDWARF_OPENCLAW_DISCORD_STREAMING ??
                    "partial",
                  historyLimit:
                    readPositiveIntegerEnv(
                      "REDDWARF_OPENCLAW_DISCORD_HISTORY_LIMIT"
                    ) ?? 24,
                  autoPresence: {
                    enabled: readBooleanEnv(
                      "REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_ENABLED",
                      true
                    ),
                    ...(readPositiveIntegerEnv(
                      "REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_INTERVAL_MS"
                    )
                      ? {
                          intervalMs: readPositiveIntegerEnv(
                            "REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_INTERVAL_MS"
                          )
                        }
                      : {}),
                    ...(readPositiveIntegerEnv(
                      "REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_MIN_UPDATE_INTERVAL_MS"
                    )
                      ? {
                          minUpdateIntervalMs: readPositiveIntegerEnv(
                            "REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_MIN_UPDATE_INTERVAL_MS"
                          )
                        }
                      : {}),
                    ...(process.env.REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_HEALTHY_TEXT
                      ? {
                          healthyText:
                            process.env.REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_HEALTHY_TEXT
                        }
                      : {}),
                    ...(process.env.REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_DEGRADED_TEXT
                      ? {
                          degradedText:
                            process.env.REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_DEGRADED_TEXT
                        }
                      : {}),
                    ...(process.env.REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_EXHAUSTED_TEXT
                      ? {
                          exhaustedText:
                            process.env.REDDWARF_OPENCLAW_DISCORD_AUTO_PRESENCE_EXHAUSTED_TEXT
                        }
                      : {})
                  },
                  ui: {
                    components: {
                      accentColor:
                        process.env.REDDWARF_OPENCLAW_DISCORD_ACCENT_COLOR ??
                        "#d7263d"
                    }
                  }
                }
              : {}),
            ...(discordExecApprovalsEnabled || discordApproverIds.length > 0
              ? {
                  execApprovals: {
                    enabled: true,
                    approvers: discordApproverIds,
                    target:
                      process.env.REDDWARF_OPENCLAW_DISCORD_EXEC_APPROVAL_TARGET ??
                      "channel"
                  }
                }
              : {}),
            ...(discordGuildIds.length > 0
              ? {
                  guilds: Object.fromEntries(
                    discordGuildIds.map((guildId) => [
                      guildId,
                      {
                        enabled: true,
                        requireMention: discordRequireMention
                      }
                    ])
                  )
                }
              : {}),
            commands: {
              native: true
            }
          }
        }
      : {})
  });
  const resolved = serializeOpenClawConfig(config);
  const openClawHomeDir = resolve(repoRoot, "runtime-data", "openclaw-home");
  await mkdir(openClawHomeDir, { recursive: true });
  await writeFile(openClawConfigRuntimePath, resolved, "utf8");
  options?.log?.("OpenClaw config resolved and written to runtime-data/openclaw-home/openclaw.json");

  const trustedAutomationEnabled = readBooleanEnv(
    "REDDWARF_OPENCLAW_TRUSTED_AUTOMATION"
  );
  const existingExecApprovals = normalizeExecApprovalObject(
    await readJsonFileIfExists(openClawExecApprovalsRuntimePath)
  );
  const socketConfig = normalizeExecApprovalObject(existingExecApprovals.socket);
  const execApprovalsConfig = {
    version:
      typeof existingExecApprovals.version === "number"
        ? existingExecApprovals.version
        : 1,
    ...(Object.keys(socketConfig).length > 0 ? { socket: socketConfig } : {}),
    defaults: trustedAutomationEnabled
      ? {
          security: "full",
          ask: "off"
        }
      : normalizeExecApprovalObject(existingExecApprovals.defaults),
    agents: normalizeExecApprovalObject(existingExecApprovals.agents)
  };

  await writeFile(
    openClawExecApprovalsRuntimePath,
    JSON.stringify(execApprovalsConfig, null, 2),
    "utf8"
  );
  options?.log?.(
    trustedAutomationEnabled
      ? "OpenClaw exec approvals resolved for trusted automation."
      : "OpenClaw exec approvals preserved in interactive mode."
  );
}

// ── Error formatting ─────────────────────────────────────────────────────────

/**
 * Extract a human-readable message from an unknown thrown value.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function formatError(err) {
  return err instanceof Error ? err.message : String(err);
}
