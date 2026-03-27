#!/usr/bin/env node
// query-evidence.mjs — inspect the most recent planning run in Postgres
// Usage: node scripts/query-evidence.mjs [task-id]
//
// Without a task-id argument, prints the most recent planning spec.
// With a task-id argument, prints phase records and run events for that task.

import pg from "pg";

const { Client } = pg;

const connectionString =
  process.env.HOST_DATABASE_URL ??
  "postgresql://reddwarf:reddwarf@127.0.0.1:55432/reddwarf";

const taskIdArg = process.argv[2];

const client = new Client({ connectionString });

try {
  await client.connect();

  if (!taskIdArg) {
    // Show most recent planning spec
    const specResult = await client.query(`
      SELECT task_id, summary, assumptions, affected_areas, created_at
      FROM planning_specs
      ORDER BY created_at DESC
      LIMIT 1
    `);

    if (specResult.rows.length === 0) {
      console.log("No planning specs found. Run demo-run.mjs first.");
      process.exit(0);
    }

    const spec = specResult.rows[0];
    console.log("=== Most recent planning spec ===");
    console.log("Task ID:       ", spec.task_id);
    console.log("Created at:    ", spec.created_at);
    console.log("Summary:       ", spec.summary ?? "(none)");
    console.log(
      "Assumptions:   ",
      Array.isArray(spec.assumptions)
        ? spec.assumptions.join(", ")
        : spec.assumptions ?? "(none)"
    );
    console.log(
      "Affected areas:",
      Array.isArray(spec.affected_areas)
        ? spec.affected_areas.join(", ")
        : spec.affected_areas ?? "(none)"
    );
    console.log(
      "\nTo see phase records and run events:\n  node scripts/query-evidence.mjs",
      spec.task_id
    );
  } else {
    // Show phase records and run events for given task
    const phaseResult = await client.query(
      `
      SELECT phase, status, actor, summary, created_at
      FROM phase_records
      WHERE task_id = $1
      ORDER BY created_at
    `,
      [taskIdArg]
    );

    console.log(`=== Phase records for ${taskIdArg} ===`);
    if (phaseResult.rows.length === 0) {
      console.log("(none)");
    } else {
      for (const row of phaseResult.rows) {
        console.log(`  ${row.phase.padEnd(16)} ${row.status.padEnd(10)} ${row.summary}`);
      }
    }

    const eventResult = await client.query(
      `
      SELECT run_id, phase, level, message, created_at
      FROM run_events
      WHERE task_id = $1
      ORDER BY created_at
    `,
      [taskIdArg]
    );

    console.log(`\n=== Run events for ${taskIdArg} ===`);
    if (eventResult.rows.length === 0) {
      console.log("(none)");
    } else {
      for (const row of eventResult.rows) {
        console.log(
          `  [${row.level.padEnd(5)}] ${row.phase.padEnd(16)} ${row.message}`
        );
      }
    }
  }
} finally {
  await client.end();
}
