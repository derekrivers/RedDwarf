/**
 * scripts/e2e-chaos-kill-recover.mjs
 *
 * R-14: Kill-and-recover integration test.
 *
 * 1. Starts the full stack
 * 2. Inserts a fake active pipeline run (simulating an in-progress task)
 * 3. Kills the host process with SIGKILL (simulating a crash)
 * 4. Restarts the stack
 * 5. Asserts the startup sweep marks the stale run
 * 6. Asserts health is ok after recovery
 *
 * Usage:
 *   node scripts/e2e-chaos-kill-recover.mjs
 *   pnpm e2e:chaos:kill-recover
 */

import { loadRepoEnv } from "./lib/repo-env.mjs";
await loadRepoEnv();

import {
  assert,
  cleanupTestData,
  createChaosLogger,
  fetchHealth,
  insertFakeActiveRun,
  queryRunStatus,
  startStack,
  stopStack,
  waitForHealthy
} from "./lib/chaos-harness.mjs";

const { log, logError } = createChaosLogger("kill-recover");
const TASK_ID = "chaos-kill-recover-task";
const RUN_ID = "chaos-kill-recover-run";

let stackProc = null;
let passed = false;

try {
  // ── Step 1: Start the stack ───────────────────────────────────────────
  log("Step 1: Starting the stack...");
  const stack = await startStack({ log });
  stackProc = stack.proc;

  // Wait for health to be ok
  await waitForHealthy();
  log("  Stack is healthy.");

  // ── Step 2: Insert fake active run ────────────────────────────────────
  log("Step 2: Inserting fake active pipeline run...");
  await insertFakeActiveRun({
    taskId: TASK_ID,
    runId: RUN_ID,
    repo: "chaos-test/kill-recover",
    issueNumber: 1,
    minutesOld: 10
  });

  const runBefore = await queryRunStatus(RUN_ID);
  assert(runBefore !== null, "Fake run should exist in DB");
  assert(runBefore.status === "active", `Run should be active, got: ${runBefore.status}`);
  log(`  Inserted run ${RUN_ID} (status: ${runBefore.status})`);

  // ── Step 3: Kill the host process with SIGKILL ────────────────────────
  log("Step 3: Killing the stack with SIGKILL (simulating crash)...");
  await stopStack(stackProc, { signal: "SIGKILL", timeoutMs: 5_000 });
  stackProc = null;
  log("  Stack killed.");

  // Brief pause to ensure port is released
  await new Promise((r) => setTimeout(r, 2_000));

  // ── Step 4: Restart the stack ─────────────────────────────────────────
  log("Step 4: Restarting the stack...");
  const stack2 = await startStack({ log });
  stackProc = stack2.proc;

  // Wait for health to be ok
  await waitForHealthy();
  log("  Stack restarted and healthy.");

  // ── Step 5: Assert stale run was detected ─────────────────────────────
  log("Step 5: Checking that the stale run was swept...");
  const runAfter = await queryRunStatus(RUN_ID);
  assert(runAfter !== null, "Run should still exist in DB");
  assert(
    runAfter.status === "stale",
    `Run should be stale after recovery, got: ${runAfter.status}`
  );
  assert(
    runAfter.metadata?.staleDetectedBy === "startup-sweep",
    `staleDetectedBy should be 'startup-sweep', got: ${runAfter.metadata?.staleDetectedBy}`
  );
  log(`  Run ${RUN_ID} marked as stale (detected by: ${runAfter.metadata?.staleDetectedBy})`);

  // Check startup output for sweep log
  const outputText = stack2.output.join("");
  assert(
    outputText.includes("Swept 1 stale run") || outputText.includes("stale run"),
    "Stack output should mention stale run sweep"
  );
  log("  Startup output confirms sweep.");

  // ── Step 6: Assert health is ok ───────────────────────────────────────
  log("Step 6: Verifying health after recovery...");
  const health = await fetchHealth();
  assert(health.status === "ok", `Health should be ok, got: ${health.status}`);
  assert(
    health.repository?.status === "healthy",
    `Repository should be healthy, got: ${health.repository?.status}`
  );
  log("  Health is ok. All assertions passed.");

  passed = true;
} catch (err) {
  logError(`FAILED: ${err.message}`);
  if (err.stack) logError(err.stack);
} finally {
  // Clean up
  try {
    if (stackProc) await stopStack(stackProc);
  } catch { /* ignore */ }

  try {
    await cleanupTestData({ taskIds: [TASK_ID], runIds: [RUN_ID] });
    log("Test data cleaned up.");
  } catch (cleanupErr) {
    logError(`Cleanup warning: ${cleanupErr.message}`);
  }
}

if (passed) {
  log("═══ PASS: Kill-and-recover test completed successfully ═══");
  process.exit(0);
} else {
  logError("═══ FAIL: Kill-and-recover test failed ═══");
  process.exit(1);
}
