/**
 * verify-all.mjs
 *
 * Runs all eighteen feature verification scripts in sequence.
 * Each script is run as a separate child process so failures are isolated.
 * Exits with code 1 if any script fails; prints a summary at the end.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  "verify-knowledge-ingestion.mjs",
  "verify-packaged-policy-pack.mjs"
];

const results = [];

for (const script of scripts) {
  const label = script.replace(/\.mjs$/, "");
  process.stdout.write(`\n[verify:all] Running ${label}...\n`);
  const startMs = Date.now();

  try {
    execFileSync(process.execPath, [join(__dirname, script)], {
      stdio: "inherit",
      env: process.env
    });
    const durationMs = Date.now() - startMs;
    results.push({ script: label, status: "passed", durationMs });
    process.stdout.write(`[verify:all] ✓ ${label} (${durationMs}ms)\n`);
  } catch (err) {
    const durationMs = Date.now() - startMs;
    results.push({ script: label, status: "failed", durationMs });
    process.stderr.write(`[verify:all] ✗ ${label} FAILED (${durationMs}ms)\n`);
    if (err instanceof Error) {
      process.stderr.write(`  ${err.message}\n`);
    }
  }
}

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
