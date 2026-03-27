/**
 * cleanup-evidence.mjs
 *
 * Evidence volume retention policy and cleanup script.
 *
 * RedDwarf archives task evidence (handoffs, validation logs, validation
 * reports, SCM diff summaries) into the evidence root before destroying
 * managed workspaces. These files accumulate indefinitely.
 *
 * This script implements a configurable age-threshold retention policy:
 *   - Walk the evidence root directory.
 *   - Identify task-scoped subdirectories older than --max-age-days.
 *   - In dry-run mode (default): print what would be deleted.
 *   - In --delete mode: remove the directories and report totals.
 *
 * Usage:
 *   node scripts/cleanup-evidence.mjs [options]
 *
 * Options:
 *   --evidence-root <path>   Path to the evidence root directory.
 *                            Defaults to runtime-data/evidence (host-side default).
 *   --max-age-days <n>       Delete evidence directories older than N days.
 *                            Defaults to 30.
 *   --delete                 Actually delete files. Without this flag the
 *                            script runs in dry-run mode and only reports.
 *   --help                   Show this usage message and exit.
 *
 * Example:
 *   # Preview what would be cleaned up (older than 14 days):
 *   node scripts/cleanup-evidence.mjs --max-age-days 14
 *
 *   # Actually delete evidence older than 30 days:
 *   node scripts/cleanup-evidence.mjs --max-age-days 30 --delete
 */

import { readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { repoRoot, createScriptLogger, formatError } from "./lib/config.mjs";

// ── Parse CLI arguments ────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("--help")) {
  process.stdout.write(`
Usage: node scripts/cleanup-evidence.mjs [options]

Options:
  --evidence-root <path>   Path to the evidence root directory (default: runtime-data/evidence)
  --max-age-days <n>       Age threshold in days — directories older than this are eligible (default: 30)
  --delete                 Actually delete eligible directories (default: dry-run only)
  --help                   Show this message and exit

Examples:
  node scripts/cleanup-evidence.mjs
  node scripts/cleanup-evidence.mjs --max-age-days 14
  node scripts/cleanup-evidence.mjs --max-age-days 30 --delete
  node scripts/cleanup-evidence.mjs --evidence-root /var/lib/reddwarf/evidence --max-age-days 7 --delete
`.trimStart());
  process.exit(0);
}

function parseArgValue(flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

const evidenceRootArg = parseArgValue("--evidence-root");
const maxAgeDaysArg = parseArgValue("--max-age-days");
const deleteMode = args.includes("--delete");

const evidenceRoot = resolve(
  repoRoot,
  evidenceRootArg ?? process.env["REDDWARF_HOST_EVIDENCE_ROOT"] ?? "runtime-data/evidence"
);
const maxAgeDays = maxAgeDaysArg !== undefined ? Number(maxAgeDaysArg) : 30;

if (Number.isNaN(maxAgeDays) || maxAgeDays < 0) {
  process.stderr.write(`[cleanup-evidence] ERROR: --max-age-days must be a non-negative number (got: ${maxAgeDaysArg})\n`);
  process.exit(1);
}

const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1_000;
const cutoffDate = new Date(Date.now() - maxAgeMs);

const { log } = createScriptLogger("cleanup-evidence");

// ── Walk evidence root ─────────────────────────────────────────────────────

log(`Evidence root: ${evidenceRoot}`);
log(`Retention threshold: ${maxAgeDays} days (cutoff: ${cutoffDate.toISOString()})`);
log(`Mode: ${deleteMode ? "DELETE" : "dry-run (pass --delete to actually remove files)"}`);
log("");

let entries;
try {
  entries = await readdir(evidenceRoot, { withFileTypes: true });
} catch (err) {
  if (err instanceof Error && "code" in err && err.code === "ENOENT") {
    log(`Evidence root does not exist: ${evidenceRoot}`);
    log("Nothing to clean up.");
    process.exit(0);
  }
  throw err;
}

const taskDirs = entries.filter((e) => e.isDirectory());

if (taskDirs.length === 0) {
  log("Evidence root is empty. Nothing to clean up.");
  process.exit(0);
}

log(`Found ${taskDirs.length} task evidence director${taskDirs.length === 1 ? "y" : "ies"}.`);
log("");

let eligibleCount = 0;
let eligibleBytes = 0;
let deletedCount = 0;
let deletedBytes = 0;
const errors = [];

for (const entry of taskDirs) {
  const dirPath = join(evidenceRoot, entry.name);
  const dirStat = await stat(dirPath);
  const ageMs = Date.now() - dirStat.mtimeMs;
  const ageDays = ageMs / (24 * 60 * 60 * 1_000);

  if (dirStat.mtimeMs >= cutoffDate.getTime()) {
    // Within retention window — keep it
    log(`  KEEP  ${entry.name}  (${ageDays.toFixed(1)}d old)`);
    continue;
  }

  // Estimate directory size by walking one level deep
  let dirBytes = 0;
  try {
    const children = await readdir(dirPath, { recursive: true });
    for (const child of children) {
      try {
        const childStat = await stat(join(dirPath, child));
        if (childStat.isFile()) dirBytes += childStat.size;
      } catch {
        // skip unreadable entries
      }
    }
  } catch {
    // skip if we can't read
  }

  eligibleCount += 1;
  eligibleBytes += dirBytes;

  const sizeMb = (dirBytes / (1024 * 1024)).toFixed(2);

  if (deleteMode) {
    try {
      await rm(dirPath, { recursive: true, force: true });
      deletedCount += 1;
      deletedBytes += dirBytes;
      log(`  DELETE ${entry.name}  (${ageDays.toFixed(1)}d old, ${sizeMb} MB) — removed`);
    } catch (err) {
      const message = formatError(err);
      errors.push({ name: entry.name, message });
      log(`  DELETE ${entry.name}  (${ageDays.toFixed(1)}d old, ${sizeMb} MB) — FAILED: ${message}`);
    }
  } else {
    log(`  WOULD DELETE  ${entry.name}  (${ageDays.toFixed(1)}d old, ${sizeMb} MB)`);
  }
}

log("");
log("─────────────────────────────────────────────────────────────────");

if (deleteMode) {
  const deletedMb = (deletedBytes / (1024 * 1024)).toFixed(2);
  log(`Deleted ${deletedCount} of ${eligibleCount} eligible director${eligibleCount === 1 ? "y" : "ies"} (${deletedMb} MB freed).`);
  if (errors.length > 0) {
    log(`${errors.length} deletion${errors.length === 1 ? "" : "s"} failed — check output above.`);
    process.exit(1);
  }
} else {
  const eligibleMb = (eligibleBytes / (1024 * 1024)).toFixed(2);
  log(`Dry run: ${eligibleCount} director${eligibleCount === 1 ? "y" : "ies"} eligible for deletion (~${eligibleMb} MB).`);
  log("Pass --delete to remove them.");
}
