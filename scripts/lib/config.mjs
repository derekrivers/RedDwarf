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

  if (resolved !== "anthropic" && resolved !== "openai") {
    throw new Error(
      `Invalid REDDWARF_MODEL_PROVIDER value "${resolved}". Expected "anthropic" or "openai".`
    );
  }

  return resolved;
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
