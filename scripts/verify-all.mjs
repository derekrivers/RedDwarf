/**
 * verify-all.mjs
 *
 * Runs all feature verification scripts with configurable parallelism.
 * Each script is run as a separate child process so failures are isolated.
 * Exits with code 1 if any script fails; prints a summary at the end.
 *
 * Options:
 *   --concurrency <n>   Maximum number of scripts to run in parallel (default: 4).
 *   --sequential         Run scripts one at a time (equivalent to --concurrency 1).
 *   --help               Show usage and exit.
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { scriptsDir } from "./lib/config.mjs";

const args = process.argv.slice(2);

if (args.includes("--help")) {
  process.stdout.write(`
Usage: node scripts/verify-all.mjs [options]

Options:
  --concurrency <n>   Maximum parallel scripts (default: 4)
  --sequential        Run scripts one at a time (--concurrency 1)
  --help              Show this message and exit
`.trimStart());
  process.exit(0);
}

function parseArgValue(flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

const concurrencyArg = parseArgValue("--concurrency");
const sequential = args.includes("--sequential");
const concurrency = sequential
  ? 1
  : concurrencyArg !== undefined
    ? Math.max(1, Number(concurrencyArg) || 1)
    : 4;

const scripts = [
  "verify-postgres-pipeline.mjs",
  "verify-openclaw-context.mjs",
  "verify-observability.mjs",
  "verify-integrations.mjs",
  "verify-memory.mjs",
  "verify-concurrency.mjs",
  "verify-workspace-manager.mjs",
  "verify-approvals.mjs",
  "verify-development.mjs",
  "verify-validation.mjs",
  "verify-secrets.mjs",
  "verify-scm.mjs",
  "verify-evidence.mjs",
  "verify-recovery.mjs",
  "verify-operator-api.mjs",
  "verify-operator-mcp.mjs",
  "verify-submit-cli.mjs",
  "verify-knowledge-ingestion.mjs",
  "verify-packaged-policy-pack.mjs",
  "verify-bootstrap-alignment.mjs"
];

function runScript(script) {
  const label = script.replace(/\.mjs$/, "");
  const startMs = Date.now();

  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [join(scriptsDir, script)],
      { env: process.env, maxBuffer: 10 * 1024 * 1024 },
      (err) => {
        const durationMs = Date.now() - startMs;

        if (err) {
          process.stderr.write(`[verify:all] ✗ ${label} FAILED (${durationMs}ms)\n`);
          resolve({ script: label, status: "failed", durationMs });
        } else {
          process.stdout.write(`[verify:all] ✓ ${label} (${durationMs}ms)\n`);
          resolve({ script: label, status: "passed", durationMs });
        }
      }
    );

    child.stdout?.pipe(process.stdout, { end: false });
    child.stderr?.pipe(process.stderr, { end: false });
  });
}

async function runWithConcurrency(items, limit, fn) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const current = index++;
      results[current] = await fn(items[current]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

process.stdout.write(
  `[verify:all] Running ${scripts.length} scripts (concurrency: ${concurrency})\n`
);

const results = await runWithConcurrency(scripts, concurrency, runScript);

const passed = results.filter((r) => r.status === "passed");
const failed = results.filter((r) => r.status === "failed");
const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);

process.stdout.write(
  `\n[verify:all] ─────────────────────────────────────────────\n`
);
process.stdout.write(
  `[verify:all] ${passed.length}/${results.length} scripts passed (${totalMs}ms total)\n`
);

if (failed.length > 0) {
  process.stderr.write(`[verify:all] Failed scripts:\n`);
  for (const r of failed) {
    process.stderr.write(`  ✗ ${r.script}\n`);
  }
  process.exit(1);
}

process.stdout.write(`[verify:all] All verification scripts passed.\n`);
