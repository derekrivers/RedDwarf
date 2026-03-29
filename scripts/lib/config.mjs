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

/**
 * Resolve ${VAR} placeholders in the OpenClaw config template using
 * process.env and write the result to the runtime config path.
 *
 * @param {{ log?: (msg: string) => void }} [options]
 */
export async function resolveOpenClawConfig(options) {
  const { readFile, writeFile, mkdir } = await import("node:fs/promises");
  const template = await readFile(openClawConfigTemplatePath, "utf8");
  const resolved = template.replace(/\$\{(\w+)\}/g, (_match, name) => {
    return process.env[name] ?? "";
  });
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
