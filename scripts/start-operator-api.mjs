#!/usr/bin/env node
// start-operator-api.mjs — starts the operator HTTP API backed by Postgres
// Usage: node scripts/start-operator-api.mjs [port]
//
// Default port: 8080
// Default DB:   postgresql://reddwarf:reddwarf@127.0.0.1:55432/reddwarf
//               (override with HOST_DATABASE_URL env var)

import { createOperatorApiServer } from "./packages/control-plane/dist/index.js";
import { createPostgresPlanningRepository } from "./packages/evidence/dist/index.js";

const port = parseInt(process.argv[2] ?? "8080", 10);
const connectionString =
  process.env.HOST_DATABASE_URL ??
  "postgresql://reddwarf:reddwarf@127.0.0.1:55432/reddwarf";

const repository = createPostgresPlanningRepository(connectionString);
const server = createOperatorApiServer({ port }, { repository });

await server.start();
console.log(`Operator API listening on http://127.0.0.1:${server.port}`);
console.log(`  GET  http://127.0.0.1:${server.port}/approvals`);
console.log(`  GET  http://127.0.0.1:${server.port}/blocked`);
console.log(`  GET  http://127.0.0.1:${server.port}/runs`);
console.log("Press Ctrl+C to stop.");

process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await server.stop();
  await repository.close();
  process.exit(0);
});
