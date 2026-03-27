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
import { join } from "node:path";
import pg from "pg";
import { connectionString, repoRoot, scriptsDir, createScriptLogger, formatError } from "./lib/config.mjs";

const { Client } = pg;

const COMPOSE_FILE = join(repoRoot, "infra", "docker", "docker-compose.yml");
const POLL_INTERVAL_MS = 2_000;
const MAX_WAIT_MS = 60_000;

const { log, logError } = createScriptLogger("setup");

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

log("──────────────────────────────────────────────────────────────────");
log("Setup complete. The RedDwarf stack is running and ready.");
log("");
log("Next steps:");
log("  corepack pnpm verify:postgres        — confirm the planning pipeline works");
log("  corepack pnpm verify:all             — run all feature verification scripts");
log("──────────────────────────────────────────────────────────────────");
