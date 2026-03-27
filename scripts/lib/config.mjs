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
