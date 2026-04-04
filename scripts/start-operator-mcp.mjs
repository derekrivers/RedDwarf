#!/usr/bin/env node

import { appendFileSync, mkdirSync } from "node:fs";
import { runOperatorMcpStdioServer } from "../packages/control-plane/dist/index.js";
import { loadRepoEnv } from "./lib/repo-env.mjs";

const startMs = Date.now();
const logPath = "/tmp/reddwarf-mcp-diag.log";
try { mkdirSync("/tmp", { recursive: true }); } catch {}

const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stderr.write(`[reddwarf-mcp] ${msg}\n`);
  try { appendFileSync(logPath, line); } catch {}
};

log(`startup pid=${process.pid} token=${process.env.REDDWARF_OPERATOR_TOKEN ? "set" : "MISSING"} url=${process.env.REDDWARF_API_URL ?? "MISSING"}`);

try {
  await loadRepoEnv();
  log(`ready (+${Date.now() - startMs}ms)`);
  await runOperatorMcpStdioServer();
  log(`exited (+${Date.now() - startMs}ms)`);
} catch (error) {
  log(`fatal: ${error?.message ?? error}`);
  process.exitCode = 1;
}
