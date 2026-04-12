/**
 * scripts/e2e-chaos-postgres-restart.mjs
 *
 * R-15: Postgres restart integration test.
 *
 * 1. Starts the full stack
 * 2. Confirms health is ok
 * 3. Restarts the postgres container
 * 4. Immediately polls health — expects degraded or transient errors
 * 5. Waits for the pool to reconnect
 * 6. Asserts health returns to ok within a reasonable window
 *
 * Usage:
 *   node scripts/e2e-chaos-postgres-restart.mjs
 *   pnpm e2e:chaos:pg-restart
 */

import { loadRepoEnv } from "./lib/repo-env.mjs";
await loadRepoEnv();

import {
  assert,
  createChaosLogger,
  dockerComposeBase,
  fetchHealth,
  startStack,
  stopStack,
  waitForHealthy
} from "./lib/chaos-harness.mjs";

const { log, logError } = createChaosLogger("pg-restart");

let stackProc = null;
let passed = false;

try {
  // ── Step 1: Start the stack ───────────────────────────────────────────
  log("Step 1: Starting the stack...");
  const stack = await startStack({ log });
  stackProc = stack.proc;

  await waitForHealthy();
  log("  Stack is healthy.");

  // ── Step 2: Verify baseline health ────────────────────────────────────
  log("Step 2: Verifying baseline health...");
  const healthBefore = await fetchHealth();
  assert(healthBefore.status === "ok", `Health should be ok, got: ${healthBefore.status}`);
  assert(
    healthBefore.repository?.status === "healthy",
    `Repository should be healthy, got: ${healthBefore.repository?.status}`
  );
  log("  Baseline health confirmed: ok.");

  // ── Step 3: Restart the Postgres container ────────────────────────────
  log("Step 3: Restarting Postgres container...");
  await dockerComposeBase(["restart", "postgres"]);
  log("  Postgres container restarted.");

  // ── Step 4: Poll health during disruption ─────────────────────────────
  log("Step 4: Polling health during postgres disruption...");
  let sawDegradedOrError = false;
  const pollStart = Date.now();
  const pollDurationMs = 5_000;

  while (Date.now() - pollStart < pollDurationMs) {
    try {
      const h = await fetchHealth();
      if (h.repository?.status !== "healthy") {
        sawDegradedOrError = true;
        log(`  Detected degraded repository status: ${h.repository?.status}`);
        break;
      }
      // Pool error count may have incremented
      if (h.repository?.postgresPool?.errorCount > 0) {
        sawDegradedOrError = true;
        log(`  Detected pool error count: ${h.repository.postgresPool.errorCount}`);
        break;
      }
    } catch (err) {
      // Health endpoint itself failing means the process also lost postgres
      sawDegradedOrError = true;
      log(`  Health endpoint error during disruption: ${err.message}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // It's possible postgres restarted so fast we didn't catch the blip.
  // That's fine — the important assertion is recovery below.
  if (!sawDegradedOrError) {
    log("  (Postgres restarted too quickly to observe degraded state — acceptable.)");
  }

  // ── Step 5: Wait for recovery ─────────────────────────────────────────
  log("Step 5: Waiting for health to recover...");
  const recoveryHealth = await waitForHealthy({ timeoutMs: 30_000 });
  assert(
    recoveryHealth.status === "ok",
    `Health should recover to ok, got: ${recoveryHealth.status}`
  );
  assert(
    recoveryHealth.repository?.status === "healthy",
    `Repository should recover to healthy, got: ${recoveryHealth.repository?.status}`
  );
  log("  Health recovered to ok.");

  // ── Step 6: Verify polling still works ────────────────────────────────
  log("Step 6: Verifying polling continues after postgres recovery...");
  const healthFinal = await fetchHealth();
  const pollingStatus = healthFinal.polling?.status;
  assert(
    pollingStatus === "healthy" || pollingStatus === "idle",
    `Polling should be healthy or idle, got: ${pollingStatus}`
  );
  log(`  Polling status: ${pollingStatus}. Recovery confirmed.`);

  passed = true;
} catch (err) {
  logError(`FAILED: ${err.message}`);
  if (err.stack) logError(err.stack);
} finally {
  try {
    if (stackProc) await stopStack(stackProc);
  } catch { /* ignore */ }
}

if (passed) {
  log("═══ PASS: Postgres restart test completed successfully ═══");
  process.exit(0);
} else {
  logError("═══ FAIL: Postgres restart test failed ═══");
  process.exit(1);
}
