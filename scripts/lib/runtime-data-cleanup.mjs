/**
 * scripts/lib/runtime-data-cleanup.mjs
 *
 * Shared cleanup helpers for the repo's runtime-data tree.
 *
 * runtime-data/ holds ephemeral and semi-durable state:
 *   - workspaces/                  per-task checked-out repos + artifacts (cleared at 24h by start-stack)
 *   - evidence/                    archived phase outputs referenced from Postgres (age-based cleanup)
 *   - openclaw-home/               gateway home; accumulates openclaw.json.bak* and .clobbered.*
 *   - openclaw-home.backup.X/      ad-hoc directory snapshots from past troubleshooting
 *
 * These helpers clean up the non-workspace cruft (P1, P2 from the runtime-data
 * audit) and enforce the evidence retention policy (P3) from the boot path.
 * They are also used by cleanup-evidence.mjs so CLI and boot flow share the
 * same walk.
 */

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

function noopLogger() {
  return { log() {}, error() {} };
}

function toBytes(files, bytes) {
  return {
    removed: files,
    bytesFreed: bytes,
    mb: (bytes / (1024 * 1024)).toFixed(2)
  };
}

/**
 * Remove openclaw.json backup artifacts that the gateway accumulates:
 *   - openclaw-home/openclaw.json.bak, .bak.1 … .bak.N    (rotating backups, not read by any code)
 *   - openclaw-home/openclaw.json.clobbered.<ISO>         (overwrite-collision snapshots)
 *   - runtime-data/openclaw-home.backup.<unixtime>/       (ad-hoc directory snapshots at the parent level)
 *
 * Files and directories older than maxAgeMs (by mtime) are removed. Live
 * openclaw.json itself and everything else in openclaw-home/ is left alone.
 *
 * @param {object} options
 * @param {string} options.openClawHomeDir - Absolute path to runtime-data/openclaw-home.
 * @param {string} options.runtimeDataRoot - Absolute path to runtime-data/ (for the sibling .backup.* dirs).
 * @param {number} options.maxAgeMs        - Remove entries older than this many ms. Pass 0 to remove all matching entries regardless of age.
 * @param {boolean} [options.dryRun]       - When true, log what would be removed but make no changes.
 * @param {{ log(msg: string): void, error(msg: string): void }} [options.logger]
 * @returns {Promise<{ removed: number, bytesFreed: number, mb: string }>}
 */
export async function pruneOpenClawHomeBackups({
  openClawHomeDir,
  runtimeDataRoot,
  maxAgeMs,
  dryRun = false,
  logger
}) {
  const { log } = logger ?? noopLogger();
  const now = Date.now();
  let files = 0;
  let bytes = 0;

  const homeEntries = await readdir(openClawHomeDir).catch(() => []);
  for (const entry of homeEntries) {
    if (!entry.startsWith("openclaw.json.bak") && !entry.startsWith("openclaw.json.clobbered.")) {
      continue;
    }
    const entryPath = join(openClawHomeDir, entry);
    try {
      const info = await stat(entryPath);
      if (!info.isFile()) {
        continue;
      }
      if (now - info.mtimeMs <= maxAgeMs) {
        continue;
      }
      bytes += info.size;
      if (dryRun) {
        log(`  Would remove stale OpenClaw backup file: ${entry}`);
      } else {
        await rm(entryPath, { force: true });
        log(`  Removed stale OpenClaw backup file: ${entry}`);
      }
      files += 1;
    } catch {
      // Ignore entries we can't stat or remove — cleanup is best-effort.
    }
  }

  const rootEntries = await readdir(runtimeDataRoot).catch(() => []);
  for (const entry of rootEntries) {
    if (!entry.startsWith("openclaw-home.backup.")) {
      continue;
    }
    const entryPath = join(runtimeDataRoot, entry);
    try {
      const info = await stat(entryPath);
      if (!info.isDirectory()) {
        continue;
      }
      if (now - info.mtimeMs <= maxAgeMs) {
        continue;
      }
      const dirBytes = await estimateDirectoryBytes(entryPath, log);
      if (dryRun) {
        log(`  Would remove stale OpenClaw home backup directory: ${entry}`);
      } else {
        await rm(entryPath, { recursive: true, force: true });
        log(`  Removed stale OpenClaw home backup directory: ${entry}`);
      }
      files += 1;
      bytes += dirBytes;
    } catch {
      // best-effort
    }
  }

  return toBytes(files, bytes);
}

/**
 * Walk an evidence root and return per-directory age/size info plus an actionable
 * delete set. Used by both the boot-time cleanup in start-stack and the manual
 * cleanup-evidence CLI, so the two paths agree on what is eligible.
 *
 * @param {object} options
 * @param {string} options.evidenceRoot
 * @param {number} options.maxAgeDays
 * @returns {Promise<{
 *   kept: { name: string, ageDays: number }[],
 *   eligible: { name: string, ageDays: number, bytes: number, path: string }[]
 * }>}
 */
export async function scanEvidenceDirectories({ evidenceRoot, maxAgeDays }) {
  const cutoffMs = Date.now() - maxAgeDays * MS_PER_DAY;
  const kept = [];
  const eligible = [];

  let entries;
  try {
    entries = await readdir(evidenceRoot, { withFileTypes: true });
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return { kept, eligible };
    }
    throw err;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryPath = join(evidenceRoot, entry.name);
    let dirStat;
    try {
      dirStat = await stat(entryPath);
    } catch {
      continue;
    }
    const ageDays = (Date.now() - dirStat.mtimeMs) / MS_PER_DAY;

    if (dirStat.mtimeMs >= cutoffMs) {
      kept.push({ name: entry.name, ageDays });
      continue;
    }

    const bytes = await estimateDirectoryBytes(entryPath);
    eligible.push({ name: entry.name, ageDays, bytes, path: entryPath });
  }

  return { kept, eligible };
}

/**
 * Delete evidence directories older than maxAgeDays. Thin wrapper around
 * scanEvidenceDirectories for the boot-time path; the manual CLI continues
 * to own its own per-entry logging in cleanup-evidence.mjs.
 *
 * @param {object} options
 * @param {string} options.evidenceRoot
 * @param {number} options.maxAgeDays
 * @param {boolean} [options.dryRun]
 * @param {{ log(msg: string): void, error(msg: string): void }} [options.logger]
 * @returns {Promise<{ removed: number, bytesFreed: number, mb: string, failures: number }>}
 */
export async function pruneStaleEvidence({ evidenceRoot, maxAgeDays, dryRun = false, logger }) {
  const { log, error } = logger ?? noopLogger();
  const { eligible } = await scanEvidenceDirectories({ evidenceRoot, maxAgeDays });

  let removed = 0;
  let bytes = 0;
  let failures = 0;

  for (const entry of eligible) {
    const sizeMb = (entry.bytes / 1024 / 1024).toFixed(2);
    if (dryRun) {
      log(`  Would remove stale evidence: ${entry.name} (${entry.ageDays.toFixed(1)}d old, ${sizeMb} MB)`);
      removed += 1;
      bytes += entry.bytes;
      continue;
    }
    try {
      await rm(entry.path, { recursive: true, force: true });
      removed += 1;
      bytes += entry.bytes;
      log(`  Removed stale evidence: ${entry.name} (${entry.ageDays.toFixed(1)}d old, ${sizeMb} MB)`);
    } catch (err) {
      failures += 1;
      error(`  Failed to remove ${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { ...toBytes(removed, bytes), failures };
}

async function estimateDirectoryBytes(dirPath, log) {
  let total = 0;
  let children;
  try {
    children = await readdir(dirPath, { recursive: true });
  } catch {
    return 0;
  }
  for (const child of children) {
    try {
      const info = await stat(join(dirPath, child));
      if (info.isFile()) total += info.size;
    } catch (err) {
      log?.(`  WARN: could not stat ${join(dirPath, child)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return total;
}
