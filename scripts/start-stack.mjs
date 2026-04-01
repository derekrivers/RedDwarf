#!/usr/bin/env node
/**
 * scripts/start-stack.mjs
 *
 * Boots the full RedDwarf stack in a single process:
 *
 *   1. Infrastructure — Docker Compose (Postgres + OpenClaw), migrations, health check
 *   2. Stale-run sweep — marks orphaned active pipeline runs from prior crashes
 *   3. Stale workspace cleanup — removes workspace directories older than 24h
 *   4. Operator API — HTTP server for approvals, evidence, and monitoring
 *   5. Polling daemon — watches GitHub for ai-eligible issues (optional)
 *
 * Required environment (in .env or exported):
 *   GITHUB_TOKEN        — GitHub PAT with repo scope
 *   ANTHROPIC_API_KEY   — Anthropic API key for LLM planning
 *
 * Optional environment:
 *   REDDWARF_POLL_REPOS       — comma-separated owner/repo list to poll (enables polling)
 *   REDDWARF_POLL_INTERVAL_MS — polling interval in ms (default: 30000)
 *   REDDWARF_API_PORT         — operator API port (default: 8080)
 *   REDDWARF_SKIP_OPENCLAW    — set to "true" to skip OpenClaw startup
 *   HOST_DATABASE_URL         — Postgres connection string
 *
 * Usage:
 *   corepack pnpm start
 *   REDDWARF_POLL_REPOS=owner/repo corepack pnpm start
 *
 * Press Ctrl+C to shut down gracefully.
 */

import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readdir, stat, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// ── Load .env from repo root ──────────────────────────────────────────────
const __scriptdir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__scriptdir, "..", ".env");
try {
  const envContent = readFileSync(envPath, "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex < 1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
} catch {
  // .env is optional
}

import {
  connectionString,
  postgresPoolConfig,
  repoRoot,
  scriptsDir,
  createScriptLogger,
  formatError,
  resolveOpenClawConfig
} from "./lib/config.mjs";

const { Client } = pg;
const { log, logError } = createScriptLogger("stack");

const COMPOSE_FILE = join(repoRoot, "infra", "docker", "docker-compose.yml");
const POLL_INTERVAL_MS = 2_000;
const MAX_WAIT_MS = 60_000;
const WORKSPACE_MAX_AGE_MS = 24 * 60 * 60_000;

// ── Configuration ─────────────────────────────────────────────────────────

const apiPort = parseInt(process.env.REDDWARF_API_PORT ?? "8080", 10);
const pollRepos = (process.env.REDDWARF_POLL_REPOS ?? "")
  .split(",")
  .map((r) => r.trim())
  .filter((r) => r.length > 0);
const pollIntervalMs = parseInt(
  process.env.REDDWARF_POLL_INTERVAL_MS ?? "30000",
  10
);
const skipOpenClaw = process.env.REDDWARF_SKIP_OPENCLAW === "true";
const operatorApiToken = (process.env.REDDWARF_OPERATOR_TOKEN ?? "").trim();
const dryRun = process.env.REDDWARF_DRY_RUN === "true";

if (operatorApiToken.length === 0) {
  logError("REDDWARF_OPERATOR_TOKEN is required before the operator API can start.");
  process.exit(1);
}

if (dryRun) {
  log("[DRY RUN MODE] SCM and follow-up GitHub mutations will be suppressed.");
}

// ══════════════════════════════════════════════════════════════════════════
// Phase 1 — Infrastructure
// ══════════════════════════════════════════════════════════════════════════

log("Phase 1: Starting infrastructure...");

// ── 1a: Resolve OpenClaw config template ──────────────────────────────

if (!skipOpenClaw) {
  try {
    await resolveOpenClawConfig({ log });
  } catch (err) {
    logError(`Failed to resolve OpenClaw config: ${formatError(err)}`);
    logError("OpenClaw will fall back to the template with unresolved placeholders.");
  }
}

// ── 1a2: Reset OpenClaw device pairing state ─────────────────────────
// Stale device tokens from previous sessions cause "pairing required" errors.
// Reset them before Docker starts so the Control UI can pair cleanly.

if (!skipOpenClaw) {
  const devicesDir = resolve(repoRoot, "runtime-data", "openclaw-home", "devices");
  const { writeFile, mkdir } = await import("node:fs/promises");
  try {
    await mkdir(devicesDir, { recursive: true });
    await writeFile(join(devicesDir, "paired.json"), "{}", "utf8");
    await writeFile(join(devicesDir, "pending.json"), "{}", "utf8");
    log("OpenClaw device pairing state reset.");
  } catch (err) {
    log(`Device state reset skipped: ${formatError(err)}`);
  }
}

// ── 1b: Docker Compose (Postgres + optional OpenClaw) ─────────────────

log("Starting Docker Compose stack...");
try {
  const composeCmd = skipOpenClaw
    ? `docker compose -f "${COMPOSE_FILE}" up -d`
    : `docker compose -f "${COMPOSE_FILE}" --profile openclaw up -d`;
  execSync(composeCmd, { stdio: "inherit", cwd: repoRoot });
  log("Docker Compose stack started.");
} catch (err) {
  logError(`Docker Compose failed: ${formatError(err)}`);
  logError("Ensure Docker Desktop (or Docker Engine) is running.");
  process.exit(1);
}

// ── 1b: Wait for Postgres ─────────────────────────────────────────────

log(`Waiting for Postgres (up to ${MAX_WAIT_MS / 1_000}s)...`);
const deadline = Date.now() + MAX_WAIT_MS;
let connected = false;

while (Date.now() < deadline) {
  const client = new Client({ connectionString, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    await client.end();
    connected = true;
    break;
  } catch {
    await client.end().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

if (!connected) {
  logError(`Postgres did not become reachable within ${MAX_WAIT_MS / 1_000}s.`);
  process.exit(1);
}
log("Postgres is reachable.");

// ── 1c: Apply database migrations ─────────────────────────────────────

log("Applying database migrations...");
try {
  execFileSync(process.execPath, [join(scriptsDir, "apply-sql-migrations.mjs")], {
    stdio: "inherit",
    env: process.env,
    cwd: repoRoot
  });
  log("Migrations applied.");
} catch (err) {
  logError(`Migration failed: ${formatError(err)}`);
  process.exit(1);
}

// ── 1d: Health check ──────────────────────────────────────────────────

log("Running health check...");
const healthClient = new Client({ connectionString, connectionTimeoutMillis: 5_000 });
try {
  await healthClient.connect();
  const result = await healthClient.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
  );
  await healthClient.end();
  log(`Health check passed. ${result.rows.length} public table(s).`);
} catch (err) {
  logError(`Health check failed: ${formatError(err)}`);
  process.exit(1);
}

// ── 1e: Check OpenClaw ────────────────────────────────────────────────

let openClawAvailable = false;
if (!skipOpenClaw) {
  log("Checking OpenClaw gateway...");
  try {
    const status = execSync(
      `docker compose -f "${COMPOSE_FILE}" ps --format json openclaw 2>/dev/null`,
      { encoding: "utf8", cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    if (status) {
      const parsed = JSON.parse(status);
      if (parsed.State === "running") {
        openClawAvailable = true;
        log("OpenClaw gateway is running.");
      } else {
        log(`OpenClaw container is ${parsed.State}.`);
      }
    }
  } catch {
    log("OpenClaw not available — deterministic fallback will be used.");
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Phase 2 — Stale-run sweep and workspace cleanup
// ══════════════════════════════════════════════════════════════════════════

log("Phase 2: Housekeeping...");

// Import control-plane and evidence after build is confirmed
const {
  createOperatorApiServer,
  createGitHubIssuePollingDaemon,
  createReadyTaskDispatcher,
  createGitHubWorkspaceRepoBootstrapper,
  createDeveloperHandoffAwaiter,
  createGitWorkspaceCommitPublisher,
  createPinoPlanningLogger,
  sweepStaleRuns,
  DeterministicDeveloperAgent,
  DeterministicValidationAgent,
  DeterministicScmAgent
} = await import("../packages/control-plane/dist/index.js");
const { createPostgresPlanningRepository } =
  await import("../packages/evidence/dist/index.js");
const { createRestGitHubAdapter, createHttpOpenClawDispatchAdapter } =
  await import("../packages/integrations/dist/index.js");
const { createPlanningAgent } =
  await import("../packages/execution-plane/dist/index.js");

const repository = createPostgresPlanningRepository(
  connectionString,
  postgresPoolConfig
);
const runtimeLogger = createPinoPlanningLogger({
  baseBindings: { surface: "runtime" }
});

// ── 2a: Sweep stale pipeline runs ─────────────────────────────────────

try {
  const sweepResult = await sweepStaleRuns(repository);
  if (sweepResult.sweptRunIds.length > 0) {
    log(`Swept ${sweepResult.sweptRunIds.length} stale run(s): ${sweepResult.sweptRunIds.join(", ")}`);
  } else {
    log("No stale pipeline runs found.");
  }
} catch (err) {
  logError(`Stale-run sweep failed (non-fatal): ${formatError(err)}`);
}

// ── 2b: Clean up old workspace directories ────────────────────────────

const workspaceRoot = resolve(repoRoot, "runtime-data", "workspaces");
try {
  const entries = await readdir(workspaceRoot).catch(() => []);
  let removedCount = 0;
  const now = Date.now();

  for (const entry of entries) {
    const entryPath = join(workspaceRoot, entry);
    try {
      const info = await stat(entryPath);
      if (info.isDirectory() && now - info.mtimeMs > WORKSPACE_MAX_AGE_MS) {
        await rm(entryPath, { recursive: true, force: true });
        removedCount++;
        log(`  Removed stale workspace: ${entry}`);
      }
    } catch {
      // Skip entries that cannot be stat'd
    }
  }

  if (removedCount > 0) {
    log(`Cleaned up ${removedCount} stale workspace(s).`);
  } else {
    log("No stale workspaces found.");
  }
} catch (err) {
  log(`Workspace cleanup skipped: ${formatError(err)}`);
}

// ══════════════════════════════════════════════════════════════════════════
// Phase 3 — Start services
// ══════════════════════════════════════════════════════════════════════════

log("Phase 3: Starting services...");

// Phase 3a: Shared adapters

const github = createRestGitHubAdapter();
const workspaceTargetRoot = resolve(repoRoot, "runtime-data", "workspaces");
const evidenceRoot = resolve(repoRoot, "runtime-data", "evidence");
const dispatchIntervalMs = parseInt(
  process.env.REDDWARF_DISPATCH_INTERVAL_MS ?? "15000",
  10
);

// Phase 3b: Ready-task dispatcher (auto-dispatch after approval)

let dispatcher = null;
let dispatchDeps = null;

if (openClawAvailable) {
  const openClawDispatch = createHttpOpenClawDispatchAdapter();

  dispatchDeps = {
    developer: new DeterministicDeveloperAgent(),
    validator: new DeterministicValidationAgent(),
    scm: new DeterministicScmAgent(),
    github,
    openClawDispatch,
    workspaceRepoBootstrapper: createGitHubWorkspaceRepoBootstrapper(),
    openClawCompletionAwaiter: createDeveloperHandoffAwaiter(),
    workspaceCommitPublisher: createGitWorkspaceCommitPublisher()
  };

  dispatcher = createReadyTaskDispatcher(
    {
      intervalMs: dispatchIntervalMs,
      targetRoot: workspaceTargetRoot,
      evidenceRoot,
      runOnStart: false
    },
    { repository, ...dispatchDeps, logger: runtimeLogger }
  );
}

// Phase 3c: Polling daemon (optional)

let daemon = null;
let planner = null;

if (pollRepos.length > 0) {
  planner = createPlanningAgent({ type: "anthropic" });

  daemon = createGitHubIssuePollingDaemon(
    {
      intervalMs: pollIntervalMs,
      repositories: pollRepos.map((repo) => ({ repo, labels: ["ai-eligible"] })),
      dryRun,
      runOnStart: true
    },
    { repository, github, planner, logger: runtimeLogger }
  );
}

// Phase 3d: Operator API

const server = createOperatorApiServer(
  {
    port: apiPort,
    authToken: operatorApiToken,
    managedTargetRoot: workspaceTargetRoot,
    managedEvidenceRoot: evidenceRoot
  },
    {
      repository,
      defaultPlanningDryRun: dryRun,
      ...(planner ? { planner } : {}),
      ...(dispatcher ? { dispatcher } : {}),
      ...(daemon ? { pollingDaemon: daemon } : {}),
      ...(dispatchDeps ? { dispatchDependencies: dispatchDeps } : {})
  }
);
await server.start();
log(`Operator API listening on http://127.0.0.1:${server.port}`);

if (dispatcher) {
  log(`Starting ready-task dispatcher (every ${dispatchIntervalMs / 1_000}s)...`);
  await dispatcher.start();
  if (dispatcher.health.startupStatus === "degraded") {
    log("Ready-task dispatcher started in degraded mode; inspect /health and runtime logs for the startup failure.");
  } else {
    log("Ready-task dispatcher started.");
  }
} else {
  log("Ready-task dispatcher not started - OpenClaw not available.");
}

if (daemon) {
  log(`Starting polling daemon for ${pollRepos.join(", ")} (every ${pollIntervalMs / 1_000}s)...`);
  await daemon.start();
  if (daemon.health.startupStatus === "degraded") {
    log("Polling daemon started in degraded mode; inspect /health and runtime logs for the startup failure.");
  } else {
    log("Polling daemon started.");
  }
} else {
  log("Polling daemon not started - set REDDWARF_POLL_REPOS to enable.");
}

// Ready
// ══════════════════════════════════════════════════════════════════════════

log("");
log("══════════════════════════════════════════════════════════════════");
log("  RedDwarf stack is live.");
log("══════════════════════════════════════════════════════════════════");
log("");
log(`  Postgres:     running (port ${process.env.POSTGRES_HOST_PORT ?? "55532"})`);
log(`  OpenClaw:     ${openClawAvailable ? "running (port " + (process.env.OPENCLAW_HOST_PORT ?? "3578") + ")" : "not running (deterministic fallback)"}`);
log(`  Operator API: http://127.0.0.1:${server.port}`);
log("  Operator Auth: Authorization: Bearer <REDDWARF_OPERATOR_TOKEN>");
log(`  Dispatcher:   ${dispatcher ? "running (every " + (dispatchIntervalMs / 1_000) + "s)" : "disabled (requires OpenClaw)"}`);
log(`  Polling:      ${daemon ? pollRepos.join(", ") + " every " + (pollIntervalMs / 1_000) + "s" : "disabled"}`);
log("");
log("  Endpoints:");
log(`    GET  http://127.0.0.1:${server.port}/health`);
log(`    GET  http://127.0.0.1:${server.port}/blocked`);
log(`    GET  http://127.0.0.1:${server.port}/approvals`);
log(`    GET  http://127.0.0.1:${server.port}/runs`);
if (dispatcher) {
  log(`    POST http://127.0.0.1:${server.port}/tasks/:taskId/dispatch`);
}
log("");
log("  Press Ctrl+C to shut down gracefully.");
log("══════════════════════════════════════════════════════════════════");

// ── Graceful shutdown ─────────────────────────────────────────────────

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  log("");
  log("Shutting down...");

  if (daemon) {
    await daemon.stop();
    log("  Polling daemon stopped.");
  }

  if (dispatcher) {
    await dispatcher.stop();
    log("  Ready-task dispatcher stopped.");
  }

  await server.stop();
  log("  Operator API stopped.");

  await repository.close();
  log("  Database pool closed.");

  log("Shutdown complete.");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
