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
import { readdir, stat, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadRepoEnv } from "./lib/repo-env.mjs";

const __scriptdir = dirname(fileURLToPath(import.meta.url));
await loadRepoEnv();

import {
  connectionString,
  postgresPoolConfig,
  repoRoot,
  createScriptLogger,
  formatError,
  refreshDerivedConfig
} from "./lib/config.mjs";

refreshDerivedConfig();

const { Client } = pg;
const { log, logError } = createScriptLogger("teardown");

const COMPOSE_FILE = join(repoRoot, "infra", "docker", "docker-compose.yml");
const WORKSPACE_MAX_AGE_MS = 24 * 60 * 60_000;
const DOCKER_WAIT_MAX_MS = 20_000;
const DOCKER_WAIT_INTERVAL_MS = 1_000;

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
  volumesDestroyed: false,
  dockerServicesSeen: [],
  openClawRuntimeConfigResolved: null
};

function listComposeServices() {
  try {
    const output = execSync(
      `docker compose -f "${COMPOSE_FILE}" --profile openclaw ps --format json 2>/dev/null`,
      { encoding: "utf8", cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();

    if (!output) {
      return [];
    }

    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function waitForComposeDown() {
  const deadline = Date.now() + DOCKER_WAIT_MAX_MS;

  while (Date.now() < deadline) {
    if (listComposeServices().length === 0) {
      return true;
    }

    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, DOCKER_WAIT_INTERVAL_MS)
    );
  }

  return listComposeServices().length === 0;
}

function hasUnresolvedOpenClawPlaceholder(input) {
  return /\$\{(?:OPENCLAW_|REDDWARF_)[A-Z0-9_]+\}/.test(input);
}

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

    const repository = createPostgresPlanningRepository(connectionString, postgresPoolConfig);
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
  const runningServices = listComposeServices();
  summary.dockerServicesSeen = runningServices.map((service) => ({
    service: service.Service ?? service.Name ?? "unknown",
    state: service.State ?? "unknown",
    health: service.Health ?? null
  }));

  if (dryRun) {
    log(`  Would stop ${runningServices.length} container(s).`);
    for (const service of summary.dockerServicesSeen) {
      log(
        `    - ${service.service} (${service.state}${service.health ? `, health=${service.health}` : ""})`
      );
    }
  } else {
    const downCmd = destroyVolumes
      ? `docker compose -f "${COMPOSE_FILE}" --profile openclaw down -v`
      : `docker compose -f "${COMPOSE_FILE}" --profile openclaw down`;
    execSync(downCmd, { stdio: "inherit", cwd: repoRoot });
    summary.servicesDown = await waitForComposeDown();
    summary.volumesDestroyed = destroyVolumes;
    if (summary.servicesDown && destroyVolumes) {
      log("  Services stopped and volumes removed.");
    } else if (summary.servicesDown) {
      log("  Services stopped. Database volume preserved.");
    } else {
      logError("  Docker Compose returned, but some services still appear to be running.");
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
  const runtimeConfigPath = join(openClawHome, "openclaw.json");
  try {
    const runtimeConfig = await readFile(runtimeConfigPath, "utf8");
    summary.openClawRuntimeConfigResolved = !hasUnresolvedOpenClawPlaceholder(
      runtimeConfig
    );
    log(
      `  Runtime config status: ${
        summary.openClawRuntimeConfigResolved
          ? "resolved values present"
          : "contains unresolved placeholders"
      }.`
    );
  } catch {
    log("  No runtime openclaw.json found.");
  }

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

  // Reset device pairing state to prevent stale token mismatches on next boot
  const devicesDir = join(openClawHome, "devices");
  try {
    if (dryRun) {
      log("  Would reset device pairing state (paired.json, pending.json).");
    } else {
      await mkdir(devicesDir, { recursive: true });
      await writeFile(join(devicesDir, "paired.json"), "{}", "utf8");
      await writeFile(join(devicesDir, "pending.json"), "{}", "utf8");
      log("  Device pairing state reset.");
    }
  } catch {
    log("  Device pairing directory not found — nothing to reset.");
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
if (summary.dockerServicesSeen.length > 0) {
  log(
    `  Compose services seen: ${summary.dockerServicesSeen
      .map((service) => `${service.service}=${service.state}`)
      .join(", ")}`
  );
}
log(`  Workspaces removed:    ${summary.workspacesRemoved}`);
log(`  Evidence removed:      ${cleanEvidence ? summary.evidenceRemoved : "skipped"}`);
log(`  Volumes destroyed:     ${summary.volumesDestroyed ? "YES — database state deleted" : "no — database preserved"}`);
if (summary.openClawRuntimeConfigResolved !== null) {
  log(
    `  OpenClaw config:       ${
      summary.openClawRuntimeConfigResolved
        ? "resolved runtime file preserved"
        : "runtime file still has placeholders"
    }`
  );
}
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
