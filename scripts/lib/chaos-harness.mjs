/**
 * scripts/lib/chaos-harness.mjs
 *
 * Shared test harness for chaos engineering integration tests (R-14 through R-16).
 * Provides helpers for starting/stopping the stack, inserting test data,
 * waiting for pipeline state transitions, and asserting outcomes.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createScriptLogger, formatError } from "./config.mjs";

const execFileAsync = promisify(execFile);
const { Client } = pg;

const __libdir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__libdir, "../..");
const composeFile = resolve(repoRoot, "infra/docker/docker-compose.yml");
const chaosComposeFile = resolve(repoRoot, "infra/docker/docker-compose.chaos.yml");

/**
 * @param {string} tag
 * @returns {{ log: (msg: string) => void, logError: (msg: string) => void }}
 */
export function createChaosLogger(tag) {
  return createScriptLogger(`chaos:${tag}`);
}

/**
 * Start the RedDwarf stack as a child process and wait for the operator API.
 *
 * @param {{ env?: Record<string, string>, timeoutMs?: number, log?: (msg: string) => void }} [opts]
 * @returns {Promise<{ proc: import("node:child_process").ChildProcess, pid: number, output: string[] }>}
 */
export async function startStack(opts) {
  const log = opts?.log ?? console.log;
  const env = { ...process.env, ...opts?.env };
  const timeoutMs = opts?.timeoutMs ?? 120_000;

  const proc = spawn("node", [resolve(repoRoot, "scripts/start-stack.mjs")], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const output = [];
  proc.stdout.on("data", (chunk) => output.push(chunk.toString()));
  proc.stderr.on("data", (chunk) => output.push(chunk.toString()));

  // Wait for the operator API to start listening
  const ready = await new Promise((resolveReady, reject) => {
    const deadline = setTimeout(() => {
      reject(new Error(`Stack did not start within ${timeoutMs}ms.\nOutput:\n${output.join("")}`));
    }, timeoutMs);

    const checkOutput = () => {
      const combined = output.join("");
      if (combined.includes("Operator API listening on")) {
        clearTimeout(deadline);
        resolveReady(true);
      }
    };
    proc.stdout.on("data", checkOutput);
    proc.stderr.on("data", checkOutput);

    proc.on("exit", (code) => {
      clearTimeout(deadline);
      if (!ready) {
        reject(new Error(`Stack exited with code ${code} before becoming ready.\nOutput:\n${output.join("")}`));
      }
    });
  });

  log(`Stack started (PID ${proc.pid})`);
  return { proc, pid: proc.pid, output };
}

/**
 * Stop a running stack process.
 * @param {import("node:child_process").ChildProcess} proc
 * @param {{ signal?: string, timeoutMs?: number }} [opts]
 */
export async function stopStack(proc, opts) {
  if (!proc || proc.killed || proc.exitCode !== null) return;
  const signal = opts?.signal ?? "SIGTERM";
  const timeoutMs = opts?.timeoutMs ?? 10_000;

  proc.kill(signal);
  await new Promise((resolve) => {
    const deadline = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    proc.on("exit", () => {
      clearTimeout(deadline);
      resolve();
    });
  });
}

/**
 * Wait for the operator API health endpoint to return ok.
 * @param {{ apiUrl?: string, token?: string, timeoutMs?: number, intervalMs?: number }} [opts]
 */
export async function waitForHealthy(opts) {
  const apiUrl = opts?.apiUrl ?? "http://127.0.0.1:8080";
  const token = opts?.token ?? process.env.REDDWARF_OPERATOR_TOKEN ?? "";
  const deadline = Date.now() + (opts?.timeoutMs ?? 60_000);
  const interval = opts?.intervalMs ?? 2_000;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${apiUrl}/health`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000)
      });
      if (res.ok) {
        const body = await res.json();
        if (body.status === "ok") return body;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Health endpoint at ${apiUrl}/health not healthy within ${opts?.timeoutMs ?? 60_000}ms`);
}

/**
 * Insert a fake active pipeline run and manifest for testing stale-run detection.
 *
 * @param {{ taskId: string, runId: string, repo: string, issueNumber: number, minutesOld?: number, connectionString?: string }} input
 */
export async function insertFakeActiveRun(input) {
  const connStr = input.connectionString ?? process.env.HOST_DATABASE_URL
    ?? "postgresql://reddwarf:reddwarf@127.0.0.1:55532/reddwarf";
  const minutesOld = input.minutesOld ?? 10;
  const client = new Client({ connectionString: connStr });
  try {
    await client.connect();
    await client.query(`
      INSERT INTO task_manifests (task_id, source, title, summary, priority, risk_class, approval_mode,
        current_phase, lifecycle_status, assigned_agent_type, requested_capabilities, retry_count,
        evidence_links, workspace_id, branch_name, pr_number, policy_version, dry_run, created_at, updated_at)
      VALUES ($1, $2, 'Chaos test task', 'Inserted by chaos harness', 1, 'low', 'auto',
        'development', 'active', 'developer', '[]', 0, '[]', NULL, NULL, NULL, 'v1', false,
        NOW() - INTERVAL '${minutesOld} minutes', NOW() - INTERVAL '${minutesOld} minutes')
      ON CONFLICT (task_id) DO NOTHING
    `, [
      input.taskId,
      JSON.stringify({ provider: "github", repo: input.repo, issueNumber: input.issueNumber })
    ]);
    await client.query(`
      INSERT INTO pipeline_runs (run_id, task_id, concurrency_key, strategy, dry_run, status,
        blocked_by_run_id, overlap_reason, started_at, last_heartbeat_at, completed_at, stale_at, metadata)
      VALUES ($1, $2, $3, 'serialize', false, 'active', NULL, NULL,
        NOW() - INTERVAL '${minutesOld} minutes', NOW() - INTERVAL '${minutesOld} minutes',
        NULL, NULL, '{}')
      ON CONFLICT (run_id) DO NOTHING
    `, [
      input.runId,
      input.taskId,
      `github:${input.repo}:${input.issueNumber}`
    ]);
  } finally {
    await client.end();
  }
}

/**
 * Query the status of a pipeline run.
 * @param {string} runId
 * @param {{ connectionString?: string }} [opts]
 * @returns {Promise<{ status: string, stale_at: string | null, metadata: object } | null>}
 */
export async function queryRunStatus(runId, opts) {
  const connStr = opts?.connectionString ?? process.env.HOST_DATABASE_URL
    ?? "postgresql://reddwarf:reddwarf@127.0.0.1:55532/reddwarf";
  const client = new Client({ connectionString: connStr });
  try {
    await client.connect();
    const result = await client.query(
      "SELECT status, stale_at, metadata FROM pipeline_runs WHERE run_id = $1",
      [runId]
    );
    return result.rows[0] ?? null;
  } finally {
    await client.end();
  }
}

/**
 * Clean up test data from the database.
 * @param {{ taskIds?: string[], runIds?: string[], connectionString?: string }} input
 */
export async function cleanupTestData(input) {
  const connStr = input.connectionString ?? process.env.HOST_DATABASE_URL
    ?? "postgresql://reddwarf:reddwarf@127.0.0.1:55532/reddwarf";
  const client = new Client({ connectionString: connStr });
  try {
    await client.connect();
    if (input.runIds?.length) {
      await client.query(
        `DELETE FROM pipeline_runs WHERE run_id = ANY($1)`,
        [input.runIds]
      );
    }
    if (input.taskIds?.length) {
      await client.query(
        `DELETE FROM task_manifests WHERE task_id = ANY($1)`,
        [input.taskIds]
      );
    }
  } finally {
    await client.end();
  }
}

/**
 * Fetch operator API health.
 * @param {{ apiUrl?: string, token?: string }} [opts]
 * @returns {Promise<object>}
 */
export async function fetchHealth(opts) {
  const apiUrl = opts?.apiUrl ?? "http://127.0.0.1:8080";
  const token = opts?.token ?? process.env.REDDWARF_OPERATOR_TOKEN ?? "";
  const res = await fetch(`${apiUrl}/health`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000)
  });
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
  return res.json();
}

/**
 * Run a docker compose command against the base + chaos overlay.
 * @param {string[]} args
 * @param {{ cwd?: string }} [opts]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export async function dockerCompose(args, opts) {
  return execFileAsync("docker", [
    "compose",
    "-f", composeFile,
    "-f", chaosComposeFile,
    "--profile", "openclaw",
    ...args
  ], { cwd: opts?.cwd ?? repoRoot, timeout: 60_000 });
}

/**
 * Run a docker compose command against the base compose only (no chaos overlay).
 * @param {string[]} args
 * @param {{ cwd?: string }} [opts]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export async function dockerComposeBase(args, opts) {
  return execFileAsync("docker", [
    "compose",
    "-f", composeFile,
    "--profile", "openclaw",
    ...args
  ], { cwd: opts?.cwd ?? repoRoot, timeout: 60_000 });
}

/**
 * Assert a condition, throwing with a descriptive message on failure.
 * @param {boolean} condition
 * @param {string} message
 */
export function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
