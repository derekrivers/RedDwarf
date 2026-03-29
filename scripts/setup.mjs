/**
 * setup.mjs
 *
 * Idempotent bootstrap script for a fresh RedDwarf local environment.
 *
 * Steps:
 *   1. Start the Docker Compose stack (compose:up) — safe to run if already up.
 *   2. Wait for Postgres to become reachable (up to 60s).
 *   3. Apply any pending database migrations (db:migrate).
 *   4. Confirm the stack is healthy by running a lightweight Postgres ping.
 *   5. Check OpenClaw availability.
 *   6. Clean up stale workspace directories (older than 24h by default).
 *
 * Usage:
 *   corepack pnpm build && node scripts/setup.mjs
 *
 * Environment variables (read from .env if present via Docker Compose):
 *   HOST_DATABASE_URL  — Postgres connection string from the host side
 *   DATABASE_URL       — fallback connection string
 *
 * This script is safe to re-run. If the stack is already up and all
 * migrations have been applied, it will finish quickly.
 */

import { execFileSync, execSync } from "node:child_process";
import { readdir, stat, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import pg from "pg";
import { connectionString, repoRoot, scriptsDir, createScriptLogger, formatError, resolveOpenClawConfig } from "./lib/config.mjs";

const { Client } = pg;

const COMPOSE_FILE = join(repoRoot, "infra", "docker", "docker-compose.yml");
const POLL_INTERVAL_MS = 2_000;
const MAX_WAIT_MS = 60_000;

const { log, logError } = createScriptLogger("setup");

// ── Step 0: Resolve OpenClaw config template ─────────────────────────────

try {
  await resolveOpenClawConfig({ log });
} catch {
  log("OpenClaw config resolution skipped (tokens may not be set yet).");
}

// ── Step 1: Start the Docker Compose stack ─────────────────────────────────

log("Starting Docker Compose stack (this is idempotent if already running)...");
try {
  execSync(`docker compose -f "${COMPOSE_FILE}" up -d`, {
    stdio: "inherit",
    cwd: repoRoot
  });
  log("Docker Compose stack started.");
} catch (err) {
  logError(`docker compose up failed: ${formatError(err)}`);
  logError("Ensure Docker Desktop (or Docker Engine) is running and try again.");
  process.exit(1);
}

// ── Step 2: Wait for Postgres to become reachable ─────────────────────────

log(`Waiting for Postgres at ${connectionString.replace(/:\/\/[^@]+@/, "://<credentials>@")}...`);

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
    // Not ready yet — wait and retry
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

if (!connected) {
  logError(`Postgres did not become reachable within ${MAX_WAIT_MS / 1_000}s.`);
  logError("Check that the Docker stack started correctly: docker compose -f infra/docker/docker-compose.yml logs postgres");
  process.exit(1);
}

log("Postgres is reachable.");

// ── Step 3: Apply database migrations ─────────────────────────────────────

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

// ── Step 4: Health check ───────────────────────────────────────────────────

log("Running health check...");
const healthClient = new Client({ connectionString, connectionTimeoutMillis: 5_000 });
try {
  await healthClient.connect();
  const result = await healthClient.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
  );
  const tables = result.rows.map((r) => r.table_name);
  await healthClient.end();

  log(`Health check passed. Public tables: ${tables.length > 0 ? tables.join(", ") : "(none yet)"}`);
} catch (err) {
  logError(`Health check failed: ${formatError(err)}`);
  process.exit(1);
}

// ── Step 5: Check OpenClaw availability ──────────────────────────────────

log("Checking OpenClaw gateway status...");
let openClawAvailable = false;
try {
  const openClawStatus = execSync(
    `docker compose -f "${COMPOSE_FILE}" ps --format json openclaw 2>/dev/null`,
    { encoding: "utf8", cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"] }
  ).trim();
  if (openClawStatus) {
    const parsed = JSON.parse(openClawStatus);
    if (parsed.State === "running") {
      openClawAvailable = true;
      log("OpenClaw gateway is running.");
    } else {
      log(`OpenClaw container exists but is ${parsed.State}.`);
    }
  }
} catch {
  // Container not running or not started — this is expected
}

if (!openClawAvailable) {
  log("OpenClaw gateway is not running — this is normal.");
  log("The pipeline will use deterministic agent fallbacks.");
  log("To start OpenClaw (when the image is available):");
  log("  docker compose -f infra/docker/docker-compose.yml --profile openclaw up -d");
}

// ── Step 6: Clean up stale workspace directories ─────────────────────────

const workspaceRoot = resolve(repoRoot, "runtime-data", "workspaces");
const WORKSPACE_MAX_AGE_MS = 24 * 60 * 60_000; // 24 hours

log("Scanning for stale workspace directories...");
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
    log(`Cleaned up ${removedCount} stale workspace directory(ies).`);
  } else {
    log("No stale workspace directories found.");
  }
} catch (err) {
  log(`Workspace cleanup skipped: ${formatError(err)}`);
}

log("──────────────────────────────────────────────────────────────────");
log("Setup complete. The RedDwarf stack is running and ready.");
log("");
log(`  Postgres:  running (port ${process.env.POSTGRES_HOST_PORT ?? "55532"})`);
log(`  OpenClaw:  ${openClawAvailable ? "running (port " + (process.env.OPENCLAW_HOST_PORT ?? "3578") + ")" : "not running (optional — deterministic fallback active)"}`);
log("");
log("Next steps:");
log("  corepack pnpm verify:postgres        — confirm the planning pipeline works");
log("  corepack pnpm verify:all             — run all feature verification scripts");
log("──────────────────────────────────────────────────────────────────");
