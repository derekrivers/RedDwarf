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
import { dirname, join, resolve } from "node:path";

// ── Paths ────────────────────────────────────────────────────────────────────

const __libdir = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the repository root directory. */
export const repoRoot = resolve(__libdir, "..", "..");

/** Absolute path to the scripts directory. */
export const scriptsDir = resolve(__libdir, "..");

// ── Database ─────────────────────────────────────────────────────────────────

/** Default Postgres connection string used by all scripts. */
export const DEFAULT_CONNECTION_STRING =
  "postgresql://reddwarf:reddwarf@127.0.0.1:55532/reddwarf";

/**
 * Resolve the Postgres connection string from environment variables
 * with a sensible local-development default.
 */
export const connectionString =
  process.env.HOST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  DEFAULT_CONNECTION_STRING;

function readPositiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const postgresPoolConfig = {
  max: readPositiveIntegerEnv("REDDWARF_DB_POOL_MAX", 10),
  connectionTimeoutMillis: readPositiveIntegerEnv(
    "REDDWARF_DB_POOL_CONNECTION_TIMEOUT_MS",
    5_000
  ),
  idleTimeoutMillis: readPositiveIntegerEnv(
    "REDDWARF_DB_POOL_IDLE_TIMEOUT_MS",
    30_000
  ),
  queryTimeoutMillis: readPositiveIntegerEnv(
    "REDDWARF_DB_POOL_QUERY_TIMEOUT_MS",
    15_000
  ),
  statementTimeoutMillis: readPositiveIntegerEnv(
    "REDDWARF_DB_POOL_STATEMENT_TIMEOUT_MS",
    15_000
  ),
  maxLifetimeSeconds: readPositiveIntegerEnv(
    "REDDWARF_DB_POOL_MAX_LIFETIME_SECONDS",
    300
  )
};

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
    workspaceRoot: resolve(
      repoRoot,
      process.env.REDDWARF_OPENCLAW_WORKSPACE_ROOT ?? "runtime-data/openclaw-workspaces"
    ),
    browser: {
      enabled: readBooleanEnv("REDDWARF_OPENCLAW_BROWSER_ENABLED", true)
    },
    ...(process.env.REDDWARF_OPENCLAW_MODEL_PROVIDER
      ? { modelProvider: process.env.REDDWARF_OPENCLAW_MODEL_PROVIDER }
      : {}),
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
  await mkdir(resolve(repoRoot, "runtime-data", "openclaw-home"), { recursive: true });
  await writeFile(openClawConfigRuntimePath, resolved, "utf8");
  options?.log?.("OpenClaw config resolved and written to runtime-data/openclaw-home/openclaw.json");
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
