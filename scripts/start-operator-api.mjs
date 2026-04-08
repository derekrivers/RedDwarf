#!/usr/bin/env node
// start-operator-api.mjs — starts the operator HTTP API backed by Postgres
// Usage: node scripts/start-operator-api.mjs [port]
//
// Default port: 8080
// Default DB:   postgresql://reddwarf:reddwarf@127.0.0.1:55532/reddwarf
//               (override with HOST_DATABASE_URL env var)
// Required env: REDDWARF_OPERATOR_TOKEN plus the selected provider key
// (ANTHROPIC_API_KEY or OPENAI_API_KEY based on REDDWARF_MODEL_PROVIDER)

import { createOperatorApiServer } from "../packages/control-plane/dist/index.js";
import { createPlanningAgentForModelProvider } from "../packages/execution-plane/dist/index.js";
import { createPostgresPlanningRepository } from "../packages/evidence/dist/index.js";
import {
  V1MutationDisabledError,
  createGitHubIssuesAdapter,
  createRestGitHubAdapter
} from "../packages/integrations/dist/index.js";
import {
  applyOperatorRuntimeConfig,
  connectionString,
  loadRepoEnv,
  postgresPoolConfig,
  refreshDerivedConfig,
  resolveModelProviderEnv
} from "./lib/config.mjs";

await loadRepoEnv();
refreshDerivedConfig();
await applyOperatorRuntimeConfig();

const port = parseInt(process.argv[2] ?? process.env.REDDWARF_API_PORT ?? "8080", 10);
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
const modelProvider = resolveModelProviderEnv();
const planner = createPlanningAgentForModelProvider(modelProvider);

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

const github = createRestGitHubAdapter();
let githubIssuesAdapter = null;
try {
  githubIssuesAdapter = createGitHubIssuesAdapter();
} catch (error) {
  if (!(error instanceof V1MutationDisabledError)) {
    throw error;
  }
  console.log("GitHub sub-issue creation disabled; project approvals will fall back to Postgres-only mode.");
}

const server = createOperatorApiServer(
  { port, authToken: operatorApiToken },
  {
    repository,
    planner,
    defaultPlanningDryRun: dryRun,
    githubWriter: github,
    ...(githubIssuesAdapter ? { githubIssuesAdapter } : {})
  }
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
