#!/usr/bin/env node
// shadow-run.mjs — Feature 182 (M24).
//
// Replays the deterministic policy layer against the last N archived task
// manifests + planning specs and diffs the result against the recorded policy
// snapshot. Answers "if we were to re-decide these tasks with the current
// pack, what would change?" without spending any LLM tokens or touching
// GitHub.
//
// Scope (v1):
//   • Policy-layer only — no LLM architect re-run.
//   • Read-only — no DB writes, no GitHub calls, no OpenClaw sessions.
//
// Usage:
//   node scripts/shadow-run.mjs [--replay-last <N>] [--output-dir <path>]
//
// Default N is 20. Reports are written as shadow-run.md and shadow-run.json
// under --output-dir (default: artifacts/shadow-run/<ISO>).

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildShadowRunInput,
  formatShadowRunJson,
  formatShadowRunMarkdown,
  replayShadowRun,
  summarizeShadowRun
} from "../packages/control-plane/dist/index.js";
import { createPostgresPlanningRepository } from "../packages/evidence/dist/index.js";
import { connectionString, postgresPoolConfig } from "./lib/config.mjs";

function parseArgs(argv) {
  const args = { replayLast: 20, outputDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--replay-last" || arg === "-n") {
      args.replayLast = Number.parseInt(argv[i + 1] ?? "", 10);
      if (!Number.isFinite(args.replayLast) || args.replayLast <= 0) {
        throw new Error(`--replay-last must be a positive integer (got "${argv[i + 1]}")`);
      }
      i += 1;
    } else if (arg === "--output-dir" || arg === "-o") {
      args.outputDir = argv[i + 1];
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(
    `shadow-run.mjs — replay the current policy layer against archived tasks

Usage:
  node scripts/shadow-run.mjs [--replay-last <N>] [--output-dir <path>]

Options:
  --replay-last, -n   Number of recent tasks to replay (default: 20).
  --output-dir,  -o   Directory for the markdown + json reports
                      (default: artifacts/shadow-run/<ISO timestamp>).
  --help, -h          Show this message.

Exits non-zero if replay fails. Exit code 0 regardless of whether any
decisions changed — parse the JSON report for CI gating.`
  );
}

function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString();
  const outputDir = resolve(
    args.outputDir ?? `artifacts/shadow-run/${isoStamp()}`
  );

  const repository = createPostgresPlanningRepository(
    connectionString,
    postgresPoolConfig
  );

  const fixtures = [];
  const skipped = [];
  try {
    // listTaskManifests returns newest-first; cap at repo's shared limit.
    const manifests = await repository.listTaskManifests({
      limit: Math.min(args.replayLast, 100)
    });
    if (manifests.length === 0) {
      console.log("No archived task manifests found. Nothing to replay.");
      return;
    }

    for (const manifest of manifests) {
      const [planningSpec, archivedPolicySnapshot] = await Promise.all([
        repository.getPlanningSpec(manifest.taskId),
        repository.getPolicySnapshot(manifest.taskId)
      ]);
      if (!planningSpec || !archivedPolicySnapshot) {
        skipped.push({
          taskId: manifest.taskId,
          reason: !planningSpec ? "missing planning_spec" : "missing policy_snapshot"
        });
        continue;
      }
      fixtures.push({
        manifest,
        planningSpec,
        archivedPolicySnapshot,
        archivedApprovalMode: manifest.approvalMode,
        archivedRiskClass: manifest.riskClass
      });
    }
  } finally {
    if (repository.close) await repository.close();
  }

  const diffs = fixtures.map((f) => replayShadowRun(buildShadowRunInput(f)));
  const summary = summarizeShadowRun(diffs, stamp);

  await mkdir(outputDir, { recursive: true });
  const markdownPath = resolve(outputDir, "shadow-run.md");
  const jsonPath = resolve(outputDir, "shadow-run.json");
  await writeFile(markdownPath, formatShadowRunMarkdown(diffs, summary), "utf8");
  await writeFile(
    jsonPath,
    formatShadowRunJson(diffs, summary) + "\n",
    "utf8"
  );

  console.log(`Replayed ${summary.totalReplayed} task(s).`);
  console.log(`  Changed: ${summary.changed}`);
  console.log(`  Eligibility changed: ${summary.eligibilityChanged}`);
  console.log(`  Risk class changed:  ${summary.riskClassChanged}`);
  console.log(`  Approval mode changed: ${summary.approvalModeChanged}`);
  console.log(`  Policy snapshot changed: ${summary.snapshotChanged}`);
  if (skipped.length > 0) {
    console.log(`  Skipped (missing data): ${skipped.length}`);
    for (const entry of skipped) {
      console.log(`    - ${entry.taskId}: ${entry.reason}`);
    }
  }
  console.log(`Reports written to:`);
  console.log(`  ${markdownPath}`);
  console.log(`  ${jsonPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
