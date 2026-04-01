#!/usr/bin/env node
// start-operator-api.mjs — starts the operator HTTP API backed by Postgres
// Usage: node scripts/start-operator-api.mjs [port]
//
// Default port: 8080
// Default DB:   postgresql://reddwarf:reddwarf@127.0.0.1:55532/reddwarf
//               (override with HOST_DATABASE_URL env var)
// Required env: REDDWARF_OPERATOR_TOKEN

import { createOperatorApiServer } from "../packages/control-plane/dist/index.js";
import { createPlanningAgent } from "../packages/execution-plane/dist/index.js";
import { createPostgresPlanningRepository } from "../packages/evidence/dist/index.js";
import { connectionString, postgresPoolConfig } from "./lib/config.mjs";

const port = parseInt(process.argv[2] ?? "8080", 10);
const operatorApiToken = (process.env.REDDWARF_OPERATOR_TOKEN ?? "").trim();
const dryRun = process.env.REDDWARF_DRY_RUN === "true";

if (operatorApiToken.length === 0) {
  console.error("REDDWARF_OPERATOR_TOKEN is required before the operator API can start.");
  process.exit(1);
}

const repository = createPostgresPlanningRepository(
  connectionString,
  postgresPoolConfig
);
const planner = createPlanningAgent({
  type: process.env.ANTHROPIC_API_KEY ? "anthropic" : "deterministic"
});

console.log("Checking Postgres readiness...");
try {
  await repository.healthcheck();
  console.log("Postgres is reachable.");
} catch (err) {
  console.error(`Postgres is not reachable at startup: ${err.message}`);
  console.error("Run `corepack pnpm run setup` to start the stack.");
  await repository.close();
  process.exit(1);
}

const server = createOperatorApiServer(
  { port, authToken: operatorApiToken },
  { repository, planner, defaultPlanningDryRun: dryRun }
);

await server.start();
console.log(`Operator API listening on http://127.0.0.1:${server.port}`);
if (dryRun) {
  console.log("  [DRY RUN MODE] Planning intake defaults to dry-run and downstream SCM mutations are suppressed.");
}
console.log("  Auth: Authorization: Bearer <REDDWARF_OPERATOR_TOKEN>");
console.log(`  GET  http://127.0.0.1:${server.port}/approvals`);
console.log(`  GET  http://127.0.0.1:${server.port}/blocked`);
console.log(`  GET  http://127.0.0.1:${server.port}/runs`);
console.log(`  POST http://127.0.0.1:${server.port}/tasks/inject`);
console.log("Press Ctrl+C to stop.");

process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await server.stop();
  await repository.close();
  process.exit(0);
});
