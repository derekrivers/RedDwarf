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
 *   5. Operator dashboard — Vite dev server for the browser SPA
 *   6. Polling daemon — watches GitHub for ai-eligible issues (optional)
 *
 * Required environment (in .env or exported):
 *   GITHUB_TOKEN        — GitHub PAT with repo scope
 *   REDDWARF_MODEL_PROVIDER — anthropic or openai (default: anthropic)
 *   ANTHROPIC_API_KEY   — required when REDDWARF_MODEL_PROVIDER=anthropic
 *   OPENAI_API_KEY      — required when REDDWARF_MODEL_PROVIDER=openai
 *
 * Optional environment:
 *   REDDWARF_POLL_REPOS       — deprecated bootstrap seed for poll repos when the DB repo list is empty
 *   REDDWARF_POLL_INTERVAL_MS — polling interval in ms (default: 30000)
 *   REDDWARF_API_PORT         — operator API port (default: 8080)
 *   REDDWARF_DASHBOARD_PORT   — dashboard dev-server port (default: 5173)
 *   REDDWARF_SKIP_DASHBOARD   — set to "true" to skip the dashboard dev server
 *   REDDWARF_SKIP_OPENCLAW    — set to "true" to skip OpenClaw startup
 *   HOST_DATABASE_URL         — Postgres connection string
 *
 * Usage:
 *   corepack pnpm start
 *   REDDWARF_POLL_REPOS=owner/repo corepack pnpm start
 *
 * Press Ctrl+C to shut down gracefully.
 */

import { execFileSync, execSync, spawn } from "node:child_process";
import { readdir, stat, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import pg from "pg";
import {
  V1MutationDisabledError,
  createGitHubIssuesAdapter,
  createRestGitHubAdapter
} from "../packages/integrations/dist/index.js";

import {
  applyOperatorRuntimeConfig,
  connectionString,
  postgresPoolConfig,
  repoRoot,
  scriptsDir,
  createScriptLogger,
  ensureRepoSecretsFile,
  formatError,
  loadRepoEnv,
  openClawConfigRuntimePath,
  refreshDerivedConfig,
  resolveModelProviderEnv,
  resolveOpenClawConfig
} from "./lib/config.mjs";

const { Client } = pg;
const { log, logError } = createScriptLogger("stack");

const COMPOSE_FILE = join(repoRoot, "infra", "docker", "docker-compose.yml");
const POLL_INTERVAL_MS = 2_000;
const MAX_WAIT_MS = 60_000;
const WORKSPACE_MAX_AGE_MS = 24 * 60 * 60_000;
const OPENCLAW_WAIT_MAX_MS = 60_000;
const OPENCLAW_POLL_INTERVAL_MS = 2_000;

await loadRepoEnv();
refreshDerivedConfig();
await applyOperatorRuntimeConfig({ log });

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
const dashboardPort = parseInt(
  process.env.REDDWARF_DASHBOARD_PORT ?? "5173",
  10
);
const skipDashboard = process.env.REDDWARF_SKIP_DASHBOARD === "true";
const skipOpenClaw = process.env.REDDWARF_SKIP_OPENCLAW === "true";
const operatorApiToken = (process.env.REDDWARF_OPERATOR_TOKEN ?? "").trim();
const dryRun = process.env.REDDWARF_DRY_RUN === "true";

if (operatorApiToken.length === 0) {
  logError("REDDWARF_OPERATOR_TOKEN is required before the operator API can start.");
  process.exit(1);
}

const github = createRestGitHubAdapter();
let githubIssuesAdapter = null;
try {
  githubIssuesAdapter = createGitHubIssuesAdapter();
} catch (error) {
  if (!(error instanceof V1MutationDisabledError)) {
    throw error;
  }
  log("GitHub sub-issue creation disabled; project approvals will fall back to Postgres-only mode.");
}

if (dryRun) {
  log("[DRY RUN MODE] SCM and follow-up GitHub mutations will be suppressed.");
}

function hasUnresolvedOpenClawPlaceholder(input) {
  return /\$\{(?:OPENCLAW_|REDDWARF_)[A-Z0-9_]+\}/.test(input);
}

async function assertResolvedOpenClawRuntimeConfig() {
  const config = await readFile(openClawConfigRuntimePath, "utf8");

  if (hasUnresolvedOpenClawPlaceholder(config)) {
    throw new Error(
      `Resolved OpenClaw runtime config still contains placeholders: ${openClawConfigRuntimePath}`
    );
  }
}

async function waitForOpenClawGateway(hostPort) {
  const deadline = Date.now() + OPENCLAW_WAIT_MAX_MS;
  let lastError = "OpenClaw gateway did not respond yet.";
  const url = `http://127.0.0.1:${hostPort}/health`;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = `OpenClaw /health returned ${response.status}.`;
    } catch (error) {
      lastError = formatError(error);
    }

    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, OPENCLAW_POLL_INTERVAL_MS)
    );
  }

  throw new Error(lastError);
}

function readPendingOpenClawPairingSummary() {
  try {
    const output = execSync(
      `docker compose -f "${COMPOSE_FILE}" --profile openclaw exec -T openclaw sh -lc 'node dist/index.js devices list'`,
      { encoding: "utf8", cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] }
    );

    if (!/Pending \((?!0\))/m.test(output) || !/\boperator\b/m.test(output)) {
      return null;
    }

    const requestMatch = output.match(
      /│\s*([0-9a-f-]{36})\s*│[^\n]*│\s*operator\s*│/i
    );

    return {
      requestId: requestMatch?.[1] ?? null
    };
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Phase 1 — Infrastructure
// ══════════════════════════════════════════════════════════════════════════

log("Phase 1: Starting infrastructure...");
await ensureRepoSecretsFile();

// ── 1a: Resolve OpenClaw config template ──────────────────────────────

if (!skipOpenClaw) {
  try {
    await resolveOpenClawConfig({ log });
    await assertResolvedOpenClawRuntimeConfig();
  } catch (err) {
    logError(`Failed to resolve OpenClaw config: ${formatError(err)}`);
    logError(
      "OpenClaw startup cannot continue safely with an unresolved runtime config. Rebuild the repo outputs and retry."
    );
    process.exit(1);
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

// ── 1b: Docker Compose (Postgres first; OpenClaw after operator API) ─────────────────

log("Starting Docker Compose Postgres service...");
try {
  const composeCmd = `docker compose -f "${COMPOSE_FILE}" up -d postgres`;
  execSync(composeCmd, { stdio: "inherit", cwd: repoRoot });
  log("Postgres service started.");
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

// ── 1e: Track OpenClaw startup status ─────────────────────────────────

let openClawAvailable = false;
let openClawStatusSummary = skipOpenClaw
  ? "disabled by REDDWARF_SKIP_OPENCLAW"
  : "pending startup";
let openClawPairingRequestId = null;

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
const { createGitHubIssuePollingCursor, createPostgresPlanningRepository } =
  await import("../packages/evidence/dist/index.js");
const { createHttpOpenClawDispatchAdapter, createAcpxOpenClawDispatchAdapter, HttpOpenClawTaskFlowAdapter } =
  await import("../packages/integrations/dist/index.js");
const { createPlanningAgentForModelProvider } =
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

// ── 2c: Scrub stale secret lease files from surviving workspaces ─────────

try {
  const entries = await readdir(workspaceRoot).catch(() => []);
  let scrubCount = 0;

  for (const entry of entries) {
    const secretEnvPath = join(
      workspaceRoot,
      entry,
      ".workspace",
      "credentials",
      "secret-env.json"
    );
    try {
      await stat(secretEnvPath);
      await rm(secretEnvPath, { force: true });
      scrubCount++;
      log(`  Scrubbed stale secret lease: ${entry}/secret-env.json`);
    } catch {
      // File does not exist — nothing to scrub
    }
  }

  if (scrubCount > 0) {
    log(
      `Scrubbed ${scrubCount} stale secret lease file(s) from surviving workspaces.`
    );
  }
} catch (err) {
  log(`Secret lease cleanup skipped: ${formatError(err)}`);
}

// ══════════════════════════════════════════════════════════════════════════
// Phase 3 — Start services
// ══════════════════════════════════════════════════════════════════════════

log("Phase 3: Starting services...");

// Phase 3a: Shared adapters
const workspaceTargetRoot = resolve(repoRoot, "runtime-data", "workspaces");
const evidenceRoot = resolve(repoRoot, "runtime-data", "evidence");
const dispatchIntervalMs = parseInt(
  process.env.REDDWARF_DISPATCH_INTERVAL_MS ?? "15000",
  10
);

if (pollRepos.length > 0) {
  log(
    "Seeding poll repos from REDDWARF_POLL_REPOS for backward compatibility. Prefer POST /repos for ongoing management."
  );

  for (const repo of pollRepos) {
    const existingCursor = await repository.getGitHubIssuePollingCursor(repo);
    if (existingCursor) {
      continue;
    }

    await repository.saveGitHubIssuePollingCursor(
      createGitHubIssuePollingCursor({
        repo,
        updatedAt: new Date().toISOString()
      })
    );
  }
}

// Phase 3b: Ready-task dispatcher (auto-dispatch after approval)

let dispatcher = null;
let dispatchDeps = null;
let taskFlowAdapter = null;

if (!skipOpenClaw) {
  // Feature 154: Use ACPX session binding when enabled; fall back to HTTP hook dispatch.
  const openClawDispatch =
    process.env.REDDWARF_ACPX_DISPATCH_ENABLED === "true"
      ? createAcpxOpenClawDispatchAdapter()
      : createHttpOpenClawDispatchAdapter();

  // Feature 150: Create Task Flow adapter when enabled.
  taskFlowAdapter =
    process.env.REDDWARF_TASKFLOW_ENABLED === "true"
      ? new HttpOpenClawTaskFlowAdapter()
      : null;

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
const modelProvider = resolveModelProviderEnv();
const planner = createPlanningAgentForModelProvider(modelProvider);

daemon = createGitHubIssuePollingDaemon(
  {
    intervalMs: pollIntervalMs,
    repositories: [],
    dryRun,
    runOnStart: true
  },
  {
    repository,
    github,
    planner,
    ...(dispatchDeps
      ? {
          openClawDispatch: dispatchDeps.openClawDispatch,
          architectTargetRoot: workspaceTargetRoot
        }
      : {}),
    logger: runtimeLogger
  }
);

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
    githubWriter: github,
    githubRepoDiscovery: github,
    ...(githubIssuesAdapter ? { githubIssuesAdapter } : {}),
    ...(planner ? { planner } : {}),
    ...(dispatcher ? { dispatcher } : {}),
    ...(daemon ? { pollingDaemon: daemon } : {}),
    ...(dispatchDeps ? { dispatchDependencies: dispatchDeps } : {}),
    ...(taskFlowAdapter ? { taskFlowAdapter } : {})
  }
);
await server.start();
log(`Operator API listening on http://127.0.0.1:${server.port}`);

if (!skipOpenClaw) {
  log("Starting OpenClaw after operator API is ready...");
  try {
    execSync(`docker compose -f "${COMPOSE_FILE}" --profile openclaw up -d openclaw`, {
      stdio: "inherit",
      cwd: repoRoot
    });
    await waitForOpenClawGateway(process.env.OPENCLAW_HOST_PORT ?? "3578");
    openClawAvailable = true;
    openClawStatusSummary = `running (port ${process.env.OPENCLAW_HOST_PORT ?? "3578"})`;
    const pairingSummary = readPendingOpenClawPairingSummary();
    if (pairingSummary?.requestId) {
      openClawPairingRequestId = pairingSummary.requestId;
      log(
        `OpenClaw gateway is healthy, but an operator pairing approval is pending (${pairingSummary.requestId}).`
      );
    } else {
      log("OpenClaw gateway is healthy.");
    }
  } catch (err) {
    openClawStatusSummary = `unavailable (${formatError(err)})`;
    log(
      `OpenClaw not available — deterministic fallback will be used. (${formatError(err)})`
    );
  }
}

let shuttingDown = false;
let dashboardProcess = null;
let periodicSweepTimer = null;

if (!skipDashboard) {
  const corepackCommand = process.platform === "win32" ? "corepack.cmd" : "corepack";
  const dashboardArgs = [
    "pnpm",
    "--filter",
    "@reddwarf/dashboard",
    "dev",
    "--",
    "--host",
    "127.0.0.1",
    "--port",
    String(dashboardPort)
  ];

  log(`Starting operator dashboard on http://127.0.0.1:${dashboardPort}...`);
  dashboardProcess = spawn(corepackCommand, dashboardArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      REDDWARF_DASHBOARD_ORIGIN:
        process.env.REDDWARF_DASHBOARD_ORIGIN ??
        `http://127.0.0.1:${dashboardPort}`
    },
    stdio: "inherit"
  });
} else {
  log("Operator dashboard not started - disabled by REDDWARF_SKIP_DASHBOARD.");
}

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
  const configuredPollRepos = await repository.listGitHubIssuePollingCursors();
  log(
    `Starting polling daemon for ${
      configuredPollRepos.length > 0
        ? configuredPollRepos.map((entry) => entry.repo).join(", ")
        : "DB-managed repo list (currently empty)"
    } (every ${pollIntervalMs / 1_000}s)...`
  );
  await daemon.start();
  if (daemon.health.startupStatus === "degraded") {
    log("Polling daemon started in degraded mode; inspect /health and runtime logs for the startup failure.");
  } else {
    log("Polling daemon started.");
  }
} else {
  log("Polling daemon not started.");
}

// Ready
// ══════════════════════════════════════════════════════════════════════════

log("");
log("══════════════════════════════════════════════════════════════════");
log("  RedDwarf stack is live.");
log("══════════════════════════════════════════════════════════════════");
log("");
log(`  Postgres:     running (port ${process.env.POSTGRES_HOST_PORT ?? "55532"})`);
log(
  `  OpenClaw:     ${
    openClawAvailable
      ? openClawStatusSummary
      : `${openClawStatusSummary} (deterministic fallback)`
  }`
);
log(`  Operator API: http://127.0.0.1:${server.port}`);
log(
  `  Dashboard:    ${
    skipDashboard
      ? "disabled by REDDWARF_SKIP_DASHBOARD"
      : `http://127.0.0.1:${dashboardPort}`
  }`
);
log("  Operator Auth: Authorization: Bearer <REDDWARF_OPERATOR_TOKEN>");
log(`  Dispatcher:   ${dispatcher ? "running (every " + (dispatchIntervalMs / 1_000) + "s)" : "disabled (requires OpenClaw)"}`);
const configuredPollRepos = daemon
  ? (await repository.listGitHubIssuePollingCursors()).map((entry) => entry.repo)
  : [];
log(
  `  Polling:      ${
    daemon
      ? `${
          configuredPollRepos.length > 0
            ? configuredPollRepos.join(", ")
            : "DB-managed repo list (currently empty)"
        } every ${pollIntervalMs / 1_000}s`
      : "disabled"
  }`
);
log("");
log("  Endpoints:");
log(`    GET  http://127.0.0.1:${server.port}/health`);
log(`    GET  http://127.0.0.1:${server.port}/blocked`);
log(`    GET  http://127.0.0.1:${server.port}/approvals`);
log(`    GET  http://127.0.0.1:${server.port}/runs`);
if (!skipDashboard) {
  log(`    UI   http://127.0.0.1:${dashboardPort}`);
}
if (dispatcher) {
  log(`    POST http://127.0.0.1:${server.port}/tasks/:taskId/dispatch`);
}
if (openClawPairingRequestId) {
  log("");
  log("  OpenClaw pairing:");
  log(
    `    docker compose -f infra/docker/docker-compose.yml --profile openclaw exec -T openclaw sh -lc 'node dist/index.js devices approve ${openClawPairingRequestId}'`
  );
}
log("");
log("  Press Ctrl+C to shut down gracefully.");
log("══════════════════════════════════════════════════════════════════");

// ── Graceful shutdown ─────────────────────────────────────────────────

const SHUTDOWN_STEP_TIMEOUT_MS = 10_000;

/**
 * Race a promise against a deadline. If the promise doesn't resolve within
 * `ms` milliseconds, log a warning and continue.
 */
async function withDeadline(promise, label, ms = SHUTDOWN_STEP_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    await Promise.race([promise, timeout]);
  } catch (error) {
    logError(`  Shutdown step warning: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  log("");
  log("Shutting down...");

  if (periodicSweepTimer) {
    clearInterval(periodicSweepTimer);
    periodicSweepTimer = null;
    log("  Periodic sweep stopped.");
  }

  if (daemon) {
    await withDeadline(daemon.stop(), "Polling daemon stop");
    log("  Polling daemon stopped.");
  }

  if (dispatcher) {
    await withDeadline(dispatcher.stop(), "Ready-task dispatcher stop");
    log("  Ready-task dispatcher stopped.");
  }

  await withDeadline(server.stop(), "Operator API stop");
  log("  Operator API stopped.");

  if (dashboardProcess && dashboardProcess.exitCode === null) {
    dashboardProcess.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      if (dashboardProcess && dashboardProcess.exitCode === null) {
        dashboardProcess.kill("SIGKILL");
        logError("  Dashboard did not exit after SIGTERM; sent SIGKILL.");
      }
    }, 5_000);
    dashboardProcess.once("exit", () => clearTimeout(killTimer));
    log("  Operator dashboard stopped.");
  }

  await withDeadline(repository.close(), "Database pool close");
  log("  Database pool closed.");

  log("Shutdown complete.");
  process.exit(typeof exitCode === "number" ? exitCode : 0);
}

if (dashboardProcess) {
  dashboardProcess.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }

    logError(
      `Operator dashboard exited unexpectedly (${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}).`
    );
    void shutdown(1);
  });

  dashboardProcess.on("error", (error) => {
    if (shuttingDown) {
      return;
    }

    logError(`Operator dashboard failed to start: ${formatError(error)}`);
    void shutdown(1);
  });
}

// ── Periodic runtime sweep ────────────────────────────────────────────
// R-04: Run stale-run sweep on a configurable interval so orphaned runs
// are detected during runtime, not just at startup.

const periodicSweepIntervalMs = Number(
  process.env.REDDWARF_PERIODIC_SWEEP_INTERVAL_MS ?? 300_000
);
const periodicSweepEnabled =
  process.env.REDDWARF_PERIODIC_SWEEP_ENABLED !== "false";

if (periodicSweepEnabled && periodicSweepIntervalMs > 0) {
  periodicSweepTimer = setInterval(async () => {
    if (shuttingDown) return;
    try {
      const sweepResult = await sweepStaleRuns(repository);
      if (sweepResult.sweptRunIds.length > 0) {
        log(
          `[periodic-sweep] Swept ${sweepResult.sweptRunIds.length} stale run(s): ${sweepResult.sweptRunIds.join(", ")}`
        );
      }
    } catch (error) {
      logError(
        `[periodic-sweep] Sweep failed: ${formatError(error)}`
      );
    }
  }, periodicSweepIntervalMs);

  // Do not let the sweep timer keep the process alive during shutdown.
  periodicSweepTimer.unref();
  log(
    `  Periodic stale-run sweep enabled (every ${Math.round(periodicSweepIntervalMs / 1000)}s).`
  );
}

// ── Signal and error handlers ─────────────────────────────────────────

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

// R-01: Global error boundaries — catch unhandled async rejections and
// uncaught exceptions so the process logs a stack trace and shuts down
// gracefully instead of dying silently.
process.on("unhandledRejection", (reason) => {
  logError(
    `Unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`
  );
  void shutdown(1);
});

process.on("uncaughtException", (error) => {
  logError(
    `Uncaught exception: ${error.stack ?? error.message}`
  );
  void shutdown(1);
});
