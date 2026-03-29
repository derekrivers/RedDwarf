#!/usr/bin/env node
/**
 * scripts/teardown.mjs
 *
 * Safely tears down the RedDwarf stack with clear reporting at each step.
 *
 * Steps:
 *   1. Mark any active pipeline runs as stale (prevents zombie state on next boot)
 *   2. Stop Docker Compose services (Postgres + OpenClaw) gracefully
 *   3. Clean up stale workspace directories (older than threshold)
 *   4. Optionally clean up old evidence directories
 *   5. Optionally remove Docker volumes (destroys all database state)
 *
 * Usage:
 *   corepack pnpm teardown                          # safe default — stop services, clean workspaces
 *   corepack pnpm teardown -- --clean-evidence      # also remove evidence older than 30 days
 *   corepack pnpm teardown -- --clean-evidence 7    # evidence older than 7 days
 *   corepack pnpm teardown -- --destroy-volumes     # remove Docker volumes (DESTROYS DATABASE)
 *   corepack pnpm teardown -- --dry-run             # preview only, no destructive actions
 *
 * The script is always safe to re-run. If services are already stopped, it
 * skips those steps and continues.
 */

import { execSync } from "node:child_process";
import { readdir, stat, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import pg from "pg";
import {
  connectionString,
  repoRoot,
  createScriptLogger,
  formatError
} from "./lib/config.mjs";

const { Client } = pg;
const { log, logError } = createScriptLogger("teardown");

const COMPOSE_FILE = join(repoRoot, "infra", "docker", "docker-compose.yml");
const WORKSPACE_MAX_AGE_MS = 24 * 60 * 60_000;

// ── Parse arguments ───────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const destroyVolumes = args.includes("--destroy-volumes");
const cleanEvidence = args.includes("--clean-evidence");
const evidenceMaxDaysIndex = args.indexOf("--clean-evidence");
const evidenceMaxDays = evidenceMaxDaysIndex >= 0 && args[evidenceMaxDaysIndex + 1] && !args[evidenceMaxDaysIndex + 1].startsWith("--")
  ? parseInt(args[evidenceMaxDaysIndex + 1], 10)
  : 30;

if (args.includes("--help")) {
  log("Usage: corepack pnpm teardown [-- options]");
  log("");
  log("Options:");
  log("  --dry-run              Preview only — no destructive actions");
  log("  --clean-evidence [N]   Remove evidence directories older than N days (default: 30)");
  log("  --destroy-volumes      Remove Docker volumes (DESTROYS ALL DATABASE STATE)");
  log("  --help                 Show this message");
  process.exit(0);
}

if (dryRun) {
  log("DRY RUN — no destructive actions will be taken.");
  log("");
}

const summary = {
  staleRunsSwept: 0,
  servicesDown: false,
  workspacesRemoved: 0,
  evidenceRemoved: 0,
  volumesDestroyed: false
};

// ══════════════════════════════════════════════════════════════════════════
// Step 1 — Sweep stale pipeline runs
// ══════════════════════════════════════════════════════════════════════════

log("Step 1/5: Sweeping stale pipeline runs...");

let dbReachable = false;
const probeClient = new Client({ connectionString, connectionTimeoutMillis: 3_000 });
try {
  await probeClient.connect();
  await probeClient.query("SELECT 1");
  await probeClient.end();
  dbReachable = true;
} catch {
  await probeClient.end().catch(() => {});
}

if (dbReachable) {
  try {
    const { createPostgresPlanningRepository } =
      await import("../packages/evidence/dist/index.js");
    const { sweepStaleRuns } =
      await import("../packages/control-plane/dist/index.js");

    const repository = createPostgresPlanningRepository(connectionString);
    try {
      if (dryRun) {
        const activeRuns = await repository.listPipelineRuns({
          statuses: ["active"],
          limit: 100
        });
        log(`  Would sweep ${activeRuns.length} active run(s).`);
        summary.staleRunsSwept = activeRuns.length;
      } else {
        const result = await sweepStaleRuns(repository);
        summary.staleRunsSwept = result.sweptRunIds.length;
        if (result.sweptRunIds.length > 0) {
          log(`  Swept ${result.sweptRunIds.length} stale run(s): ${result.sweptRunIds.join(", ")}`);
        } else {
          log("  No active runs to sweep.");
        }
      }
    } finally {
      await repository.close();
    }
  } catch (err) {
    log(`  Sweep skipped (non-fatal): ${formatError(err)}`);
  }
} else {
  log("  Postgres not reachable — skipping stale-run sweep.");
}

// ══════════════════════════════════════════════════════════════════════════
// Step 2 — Stop Docker Compose services
// ══════════════════════════════════════════════════════════════════════════

log("Step 2/5: Stopping Docker Compose services...");

try {
  if (dryRun) {
    // Check what's running
    const ps = execSync(
      `docker compose -f "${COMPOSE_FILE}" ps --format json 2>/dev/null`,
      { encoding: "utf8", cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    const running = ps ? ps.split("\n").filter((l) => l.trim()).length : 0;
    log(`  Would stop ${running} container(s).`);
  } else {
    const downCmd = destroyVolumes
      ? `docker compose -f "${COMPOSE_FILE}" --profile openclaw down -v`
      : `docker compose -f "${COMPOSE_FILE}" --profile openclaw down`;
    execSync(downCmd, { stdio: "inherit", cwd: repoRoot });
    summary.servicesDown = true;
    summary.volumesDestroyed = destroyVolumes;
    if (destroyVolumes) {
      log("  Services stopped and volumes removed.");
    } else {
      log("  Services stopped. Database volume preserved.");
    }
  }
} catch (err) {
  // docker compose down returns non-zero if already stopped — that's fine
  const msg = formatError(err);
  if (msg.includes("no container") || msg.includes("not found")) {
    log("  Services already stopped.");
    summary.servicesDown = true;
  } else {
    logError(`  Docker Compose down failed: ${msg}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Step 3 — Clean up stale workspace directories
// ══════════════════════════════════════════════════════════════════════════

log("Step 3/5: Cleaning stale workspace directories...");

const workspaceRoot = resolve(repoRoot, "runtime-data", "workspaces");
try {
  const entries = await readdir(workspaceRoot).catch(() => []);
  const now = Date.now();

  for (const entry of entries) {
    const entryPath = join(workspaceRoot, entry);
    try {
      const info = await stat(entryPath);
      if (info.isDirectory() && now - info.mtimeMs > WORKSPACE_MAX_AGE_MS) {
        if (dryRun) {
          log(`  Would remove: ${entry}`);
        } else {
          await rm(entryPath, { recursive: true, force: true });
          log(`  Removed: ${entry}`);
        }
        summary.workspacesRemoved++;
      }
    } catch {
      // Skip entries that cannot be stat'd
    }
  }

  if (summary.workspacesRemoved === 0) {
    log("  No stale workspaces found.");
  }
} catch (err) {
  log(`  Workspace cleanup skipped: ${formatError(err)}`);
}

// ══════════════════════════════════════════════════════════════════════════
// Step 4 — Clean up old evidence directories (optional)
// ══════════════════════════════════════════════════════════════════════════

log("Step 4/5: Cleaning old evidence directories...");

if (cleanEvidence) {
  const evidenceRoot = resolve(repoRoot, "runtime-data", "evidence");
  const maxAgeMs = evidenceMaxDays * 24 * 60 * 60_000;

  try {
    const entries = await readdir(evidenceRoot).catch(() => []);
    const now = Date.now();

    for (const entry of entries) {
      const entryPath = join(evidenceRoot, entry);
      try {
        const info = await stat(entryPath);
        if (info.isDirectory() && now - info.mtimeMs > maxAgeMs) {
          if (dryRun) {
            log(`  Would remove: ${entry}`);
          } else {
            await rm(entryPath, { recursive: true, force: true });
            log(`  Removed: ${entry}`);
          }
          summary.evidenceRemoved++;
        }
      } catch {
        // Skip entries that cannot be stat'd
      }
    }

    if (summary.evidenceRemoved === 0) {
      log(`  No evidence directories older than ${evidenceMaxDays} day(s).`);
    }
  } catch (err) {
    log(`  Evidence cleanup skipped: ${formatError(err)}`);
  }
} else {
  log("  Skipped — pass --clean-evidence to enable.");
}

// ══════════════════════════════════════════════════════════════════════════
// Step 5 — OpenClaw runtime state cleanup
// ══════════════════════════════════════════════════════════════════════════

log("Step 5/5: Checking OpenClaw runtime state...");

const openClawHome = resolve(repoRoot, "runtime-data", "openclaw-home");
try {
  const entries = await readdir(openClawHome).catch(() => []);
  const clobbered = entries.filter((e) => e.includes(".clobbered."));

  if (clobbered.length > 0) {
    for (const entry of clobbered) {
      if (dryRun) {
        log(`  Would remove stale config: ${entry}`);
      } else {
        await rm(join(openClawHome, entry), { force: true });
        log(`  Removed stale config: ${entry}`);
      }
    }
  } else {
    log("  No stale OpenClaw config artifacts found.");
  }
} catch {
  log("  OpenClaw home not found — nothing to clean.");
}

// ══════════════════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════════════════

log("");
log("══════════════════════════════════════════════════════════════════");
log(`  Teardown ${dryRun ? "preview" : "complete"}.`);
log("══════════════════════════════════════════════════════════════════");
log("");
log(`  Stale runs swept:      ${summary.staleRunsSwept}`);
log(`  Services stopped:      ${summary.servicesDown ? "yes" : dryRun ? "(dry run)" : "no"}`);
log(`  Workspaces removed:    ${summary.workspacesRemoved}`);
log(`  Evidence removed:      ${cleanEvidence ? summary.evidenceRemoved : "skipped"}`);
log(`  Volumes destroyed:     ${summary.volumesDestroyed ? "YES — database state deleted" : "no — database preserved"}`);
log("");

if (!dryRun && !destroyVolumes) {
  log("  Database volume is preserved. To restart:");
  log("    corepack pnpm start");
  log("");
  log("  To fully reset (destroys all data):");
  log("    corepack pnpm teardown -- --destroy-volumes");
}

if (dryRun) {
  log("  This was a dry run. Re-run without --dry-run to execute.");
}

log("══════════════════════════════════════════════════════════════════");
