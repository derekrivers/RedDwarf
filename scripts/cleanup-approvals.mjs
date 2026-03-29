/**
 * cleanup-approvals.mjs
 *
 * Approval-request cleanup utility.
 *
 * This script removes approval rows from Postgres so the operator approvals
 * endpoint can be cleaned down without touching the rest of the task history.
 *
 * Safety defaults:
 *   - Dry-run by default.
 *   - Only resolved approval rows are targeted by default.
 *   - Deleting pending approvals requires an explicit flag because it can
 *     orphan blocked manifests that still need a decision.
 *
 * Usage:
 *   node scripts/cleanup-approvals.mjs [options]
 */

import pg from "pg";
import {
  connectionString,
  createScriptLogger,
  formatError,
  postgresPoolConfig
} from "./lib/config.mjs";

const { Pool } = pg;

const args = process.argv.slice(2);

if (args.includes("--help")) {
  process.stdout.write(
    `
Usage: node scripts/cleanup-approvals.mjs [options]

Options:
  --task-id <taskId>          Only target approvals for one task
  --statuses <csv>            Filter by approval statuses (for example: approved,rejected)
  --older-than-days <n>       Only target approvals updated more than N days ago
  --include-pending           Include pending approvals in the candidate set
  --include-nonterminal-manifests
                              Include approvals for ready, active, or blocked manifests
  --allow-pending-delete      Required before any pending approvals can be deleted
  --delete                    Actually delete matching approvals (default: dry-run only)
  --help                      Show this message and exit

Behavior:
  By default, the script only targets resolved approvals for terminal manifests
  (completed, failed, cancelled).
  This keeps the operator approvals history tidy without pruning in-flight task state.

Examples:
  node scripts/cleanup-approvals.mjs
  node scripts/cleanup-approvals.mjs --older-than-days 14
  node scripts/cleanup-approvals.mjs --statuses approved,rejected --delete
  node scripts/cleanup-approvals.mjs --task-id derekrivers-firstvoyage-22 --include-nonterminal-manifests --delete
  node scripts/cleanup-approvals.mjs --include-pending --include-nonterminal-manifests --allow-pending-delete --delete
`.trimStart()
  );
  process.exit(0);
}

function parseArgValue(flag) {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

const taskId = parseArgValue("--task-id");
const statusesArg = parseArgValue("--statuses");
const olderThanDaysArg = parseArgValue("--older-than-days");
const includePending = args.includes("--include-pending");
const includeNonterminalManifests = args.includes(
  "--include-nonterminal-manifests"
);
const allowPendingDelete = args.includes("--allow-pending-delete");
const deleteMode = args.includes("--delete");

const validStatuses = ["pending", "approved", "rejected", "cancelled"];

const explicitStatuses = statusesArg
  ? statusesArg
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  : null;

if (explicitStatuses !== null && explicitStatuses.length === 0) {
  process.stderr.write(
    "[cleanup-approvals] ERROR: --statuses must include at least one non-empty status\n"
  );
  process.exit(1);
}

if (explicitStatuses !== null) {
  const invalidStatuses = explicitStatuses.filter(
    (status) => !validStatuses.includes(status)
  );
  if (invalidStatuses.length > 0) {
    process.stderr.write(
      `[cleanup-approvals] ERROR: invalid approval status filter(s): ${invalidStatuses.join(", ")}\n`
    );
    process.exit(1);
  }
}

const olderThanDays =
  olderThanDaysArg === undefined ? null : Number(olderThanDaysArg);

if (
  olderThanDays !== null &&
  (Number.isNaN(olderThanDays) || olderThanDays < 0)
) {
  process.stderr.write(
    `[cleanup-approvals] ERROR: --older-than-days must be a non-negative number (got: ${olderThanDaysArg})\n`
  );
  process.exit(1);
}

const targetStatuses =
  explicitStatuses ??
  (includePending ? null : ["approved", "rejected", "cancelled"]);

const pendingIsTargeted =
  targetStatuses === null || targetStatuses.includes("pending");

if (deleteMode && pendingIsTargeted && !allowPendingDelete) {
  process.stderr.write(
    "[cleanup-approvals] ERROR: deleting pending approvals can orphan blocked tasks; rerun with --allow-pending-delete if that is intentional\n"
  );
  process.exit(1);
}

const olderThanCutoff =
  olderThanDays === null
    ? null
    : new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

const { log } = createScriptLogger("cleanup-approvals");

const pool = new Pool({
  connectionString,
  ...postgresPoolConfig
});

function buildFilterClause() {
  const conditions = [];
  const values = [];

  if (taskId) {
    values.push(taskId);
    conditions.push(`ar.task_id = $${values.length}`);
  }

  if (targetStatuses !== null) {
    values.push(targetStatuses);
    conditions.push(
      `ar.status = ANY($${values.length}::approval_request_status[])`
    );
  }

  if (olderThanCutoff !== null) {
    values.push(olderThanCutoff.toISOString());
    conditions.push(`ar.updated_at < $${values.length}::timestamptz`);
  }

  if (!includeNonterminalManifests) {
    conditions.push(
      `(tm.lifecycle_status IS NULL OR tm.lifecycle_status IN ('completed', 'failed', 'cancelled'))`
    );
  }

  return {
    whereClause:
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    values
  };
}

function formatTimestamp(value) {
  if (!value) return "-";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function formatArray(value) {
  return Array.isArray(value) && value.length > 0 ? value.join(",") : "-";
}

try {
  const { whereClause, values } = buildFilterClause();

  log(`Database: ${connectionString}`);
  log(
    `Mode: ${deleteMode ? "DELETE" : "dry-run (pass --delete to actually remove rows)"}`
  );
  log(
    `Status filter: ${targetStatuses === null ? "all statuses" : targetStatuses.join(", ")}`
  );
  log(`Task filter: ${taskId ?? "all tasks"}`);
  log(
    `Age filter: ${olderThanCutoff ? `${olderThanDays} days (updated before ${olderThanCutoff.toISOString()})` : "none"}`
  );
  log(
    `Manifest filter: ${includeNonterminalManifests ? "all manifests" : "terminal manifests only (completed, failed, cancelled)"}`
  );
  log(`Pending approvals targeted: ${pendingIsTargeted ? "yes" : "no"}`);
  log("");

  const selectionSql = `
    SELECT
      ar.request_id,
      ar.task_id,
      ar.status,
      ar.phase,
      ar.summary,
      ar.updated_at,
      ar.created_at,
      tm.lifecycle_status
    FROM approval_requests ar
    LEFT JOIN task_manifests tm ON tm.task_id = ar.task_id
    ${whereClause}
    ORDER BY ar.updated_at DESC, ar.created_at DESC, ar.request_id ASC
  `;

  const candidateResult = await pool.query(selectionSql, values);
  const candidates = candidateResult.rows;

  if (candidates.length === 0) {
    log("No matching approval rows found.");
    process.exit(0);
  }

  log(
    `Found ${candidates.length} approval row${candidates.length === 1 ? "" : "s"} matching the filter.`
  );
  log("");

  const countsByStatus = new Map();
  for (const row of candidates) {
    countsByStatus.set(row.status, (countsByStatus.get(row.status) ?? 0) + 1);
  }

  for (const [status, count] of [...countsByStatus.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    log(`  ${status}: ${count}`);
  }

  log("");
  for (const row of candidates.slice(0, 20)) {
    const summary =
      typeof row.summary === "string" && row.summary.length > 96
        ? `${row.summary.slice(0, 93)}...`
        : row.summary;
    log(
      `  ${row.request_id} | task=${row.task_id} | status=${row.status} | phase=${row.phase} | manifest=${row.lifecycle_status ?? "-"} | updated=${formatTimestamp(row.updated_at)}`
    );
    log(`    ${summary}`);
  }

  if (candidates.length > 20) {
    log(
      `  ... ${candidates.length - 20} more row${candidates.length - 20 === 1 ? "" : "s"} not shown`
    );
  }

  log("");

  if (!deleteMode) {
    log("Dry run complete. Pass --delete to remove these approvals.");
    if (pendingIsTargeted) {
      log(
        "Pending approvals were included in the preview. Deleting them also requires --allow-pending-delete."
      );
    }
    process.exit(0);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const requestIds = candidates.map((row) => row.request_id);
    const deleteResult = await client.query(
      "DELETE FROM approval_requests WHERE request_id = ANY($1::text[])",
      [requestIds]
    );

    await client.query("COMMIT");

    log(
      `Deleted ${deleteResult.rowCount ?? 0} approval row${deleteResult.rowCount === 1 ? "" : "s"}.`
    );

    const taskIds = [...new Set(candidates.map((row) => row.task_id))];
    log(`Affected task count: ${taskIds.length}`);
    log(`Affected tasks: ${formatArray(taskIds.slice(0, 20))}`);
    if (taskIds.length > 20) {
      log(
        `... ${taskIds.length - 20} more task${taskIds.length - 20 === 1 ? "" : "s"} not shown`
      );
    }

    if (pendingIsTargeted) {
      log("");
      log(
        "WARNING: pending approvals were deleted. Any blocked tasks that still needed approval may now require manual cleanup."
      );
    }
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
} catch (error) {
  process.stderr.write(`[cleanup-approvals] ERROR: ${formatError(error)}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
