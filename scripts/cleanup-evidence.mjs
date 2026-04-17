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

import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { repoRoot, createScriptLogger, formatError } from "./lib/config.mjs";
import { scanEvidenceDirectories } from "./lib/runtime-data-cleanup.mjs";

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

const cutoffDate = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1_000);

const { log } = createScriptLogger("cleanup-evidence");

// ── Walk evidence root ─────────────────────────────────────────────────────

log(`Evidence root: ${evidenceRoot}`);
log(`Retention threshold: ${maxAgeDays} days (cutoff: ${cutoffDate.toISOString()})`);
log(`Mode: ${deleteMode ? "DELETE" : "dry-run (pass --delete to actually remove files)"}`);
log("");

let scanned;
try {
  scanned = await scanEvidenceDirectories({ evidenceRoot, maxAgeDays });
} catch (err) {
  process.stderr.write(`[cleanup-evidence] ERROR: ${formatError(err)}\n`);
  process.exit(1);
}

if (scanned.kept.length === 0 && scanned.eligible.length === 0) {
  log("Evidence root is empty or missing. Nothing to clean up.");
  process.exit(0);
}

const totalDirs = scanned.kept.length + scanned.eligible.length;
log(`Found ${totalDirs} task evidence director${totalDirs === 1 ? "y" : "ies"}.`);
log("");

for (const keep of scanned.kept) {
  log(`  KEEP  ${keep.name}  (${keep.ageDays.toFixed(1)}d old)`);
}

let deletedCount = 0;
let deletedBytes = 0;
let eligibleBytes = 0;
const errors = [];

for (const entry of scanned.eligible) {
  eligibleBytes += entry.bytes;
  const sizeMb = (entry.bytes / (1024 * 1024)).toFixed(2);

  if (deleteMode) {
    try {
      await rm(entry.path, { recursive: true, force: true });
      deletedCount += 1;
      deletedBytes += entry.bytes;
      log(`  DELETE ${entry.name}  (${entry.ageDays.toFixed(1)}d old, ${sizeMb} MB) — removed`);
    } catch (err) {
      const message = formatError(err);
      errors.push({ name: entry.name, message });
      log(`  DELETE ${entry.name}  (${entry.ageDays.toFixed(1)}d old, ${sizeMb} MB) — FAILED: ${message}`);
    }
  } else {
    log(`  WOULD DELETE  ${entry.name}  (${entry.ageDays.toFixed(1)}d old, ${sizeMb} MB)`);
  }
}

log("");
log("─────────────────────────────────────────────────────────────────");

if (deleteMode) {
  const deletedMb = (deletedBytes / (1024 * 1024)).toFixed(2);
  log(`Deleted ${deletedCount} of ${scanned.eligible.length} eligible director${scanned.eligible.length === 1 ? "y" : "ies"} (${deletedMb} MB freed).`);
  if (errors.length > 0) {
    log(`${errors.length} deletion${errors.length === 1 ? "" : "s"} failed — check output above.`);
    process.exit(1);
  }
} else {
  const eligibleMb = (eligibleBytes / (1024 * 1024)).toFixed(2);
  log(`Dry run: ${scanned.eligible.length} director${scanned.eligible.length === 1 ? "y" : "ies"} eligible for deletion (~${eligibleMb} MB).`);
  log("Pass --delete to remove them.");
}
