/**
 * scripts/e2e-chaos-openclaw-kill.mjs
 *
 * R-16: OpenClaw container kill test.
 *
 * 1. Starts the full stack
 * 2. Confirms health is ok (downstream.openclaw = ok)
 * 3. Kills the OpenClaw container with docker kill
 * 4. Asserts the health endpoint detects OpenClaw as unreachable/degraded
 * 5. Restarts the OpenClaw container
 * 6. Asserts the health endpoint recovers to ok
 *
 * Usage:
 *   node scripts/e2e-chaos-openclaw-kill.mjs
 *   pnpm e2e:chaos:openclaw-kill
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

const { log, logError } = createChaosLogger("openclaw-kill");

let stackProc = null;
let passed = false;

/**
 * Find the OpenClaw downstream entry in health response.
 * @param {object} health
 * @returns {{ name: string, status: string, latencyMs: number, error: string | null } | undefined}
 */
function findOpenClawDownstream(health) {
  return health.downstream?.find((d) => d.name === "openclaw");
}

try {
  // ── Step 1: Start the stack ───────────────────────────────────────────
  log("Step 1: Starting the stack...");
  const stack = await startStack({ log });
  stackProc = stack.proc;

  await waitForHealthy();
  log("  Stack is healthy.");

  // ── Step 2: Verify OpenClaw is healthy ────────────────────────────────
  log("Step 2: Waiting for OpenClaw downstream to report ok...");
  // The probe cache has a 15s TTL, and OpenClaw may take time to start.
  // Poll until the downstream probe reports ok.
  const ocReadyDeadline = Date.now() + 60_000;
  let ocBefore = null;
  while (Date.now() < ocReadyDeadline) {
    try {
      const h = await fetchHealth();
      const oc = findOpenClawDownstream(h);
      if (oc && oc.status === "ok") {
        ocBefore = oc;
        break;
      }
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  assert(ocBefore !== null, "OpenClaw downstream should eventually report ok");
  log(`  OpenClaw downstream: ${ocBefore.status} (${ocBefore.latencyMs}ms)`);

  // ── Step 3: Kill the OpenClaw container ───────────────────────────────
  log("Step 3: Killing the OpenClaw container...");
  await dockerComposeBase(["kill", "openclaw"]);
  log("  OpenClaw container killed.");

  // ── Step 4: Wait for health to detect OpenClaw as unreachable ─────────
  log("Step 4: Waiting for health to detect OpenClaw failure...");
  // The probe cache has a 15s TTL, so we may need to wait up to ~20s
  let sawUnreachable = false;
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    try {
      const h = await fetchHealth();
      const oc = findOpenClawDownstream(h);
      if (oc && oc.status !== "ok") {
        sawUnreachable = true;
        log(`  Detected OpenClaw status: ${oc.status} (error: ${oc.error ?? "none"})`);
        // Also check readiness
        if (h.readiness && h.readiness !== "ok") {
          log(`  Readiness degraded to: ${h.readiness}`);
        }
        break;
      }
    } catch (err) {
      log(`  Health poll error: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }

  assert(sawUnreachable, "Health should detect OpenClaw as unreachable after container kill");

  // ── Step 5: Restart the OpenClaw container ────────────────────────────
  log("Step 5: Restarting the OpenClaw container...");
  await dockerComposeBase(["start", "openclaw"]);
  log("  OpenClaw container restarted.");

  // ── Step 6: Wait for recovery ─────────────────────────────────────────
  log("Step 6: Waiting for health to recover...");
  // OpenClaw needs time to start + probe cache needs to expire (15s TTL)
  const recoveryDeadline = Date.now() + 60_000;
  let recovered = false;

  while (Date.now() < recoveryDeadline) {
    try {
      const h = await fetchHealth();
      const oc = findOpenClawDownstream(h);
      if (oc && oc.status === "ok" && h.readiness === "ok") {
        recovered = true;
        log(`  OpenClaw recovered: ${oc.status} (${oc.latencyMs}ms), readiness: ${h.readiness}`);
        break;
      }
    } catch {
      // still recovering
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }

  assert(recovered, "Health should recover after OpenClaw container restart");

  // Verify circuit breaker is still closed (a container kill shouldn't trip it
  // unless there were active dispatches)
  const healthFinal = await fetchHealth();
  const ocBreaker = healthFinal.circuitBreakers?.["openclaw-dispatch"];
  if (ocBreaker) {
    log(`  Circuit breaker state: ${ocBreaker.state} (failures: ${ocBreaker.consecutiveFailures})`);
  }

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
  log("═══ PASS: OpenClaw container kill test completed successfully ═══");
  process.exit(0);
} else {
  logError("═══ FAIL: OpenClaw container kill test failed ═══");
  process.exit(1);
}
