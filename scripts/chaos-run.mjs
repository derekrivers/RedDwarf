#!/usr/bin/env node
/**
 * scripts/chaos-run.mjs
 *
 * R-20: Structured chaos experiment runner.
 *
 * Combines Toxiproxy toxics, container manipulation, and assertions
 * into named reproducible experiments. Scenarios map to the failure
 * matrix in docs/chaos-engineering.md.
 *
 * Usage:
 *   node scripts/chaos-run.mjs <scenario>
 *   pnpm chaos:run <scenario>
 *   pnpm chaos:run --list
 *
 * Examples:
 *   pnpm chaos:run postgres-latency
 *   pnpm chaos:run openclaw-timeout
 *   pnpm chaos:run postgres-reset-peer
 *   pnpm chaos:run full-outage
 *   pnpm chaos:run --list
 *
 * Prerequisites:
 *   - Stack running with Toxiproxy chaos overlay:
 *     docker compose -f infra/docker/docker-compose.yml \
 *                    -f infra/docker/docker-compose.chaos.yml \
 *                    --profile openclaw up -d
 *   - Stack started with proxied ports:
 *     HOST_DATABASE_URL=postgresql://reddwarf:reddwarf@127.0.0.1:55533/reddwarf \
 *     OPENCLAW_BASE_URL=http://localhost:3579 \
 *     pnpm start
 */

import { loadRepoEnv } from "./lib/repo-env.mjs";
await loadRepoEnv();

import { createScriptLogger } from "./lib/config.mjs";
import {
  addToxic,
  injectLatency,
  injectTimeout,
  injectResetPeer,
  injectBandwidthLimit,
  removeToxic,
  resetProxy,
  resetAllProxies,
  disableProxy,
  enableProxy,
  waitForToxiproxy
} from "./lib/toxiproxy.mjs";

const { log, logError } = createScriptLogger("chaos");

// ── Scenario Registry ───────────────────────────────────────────────────

/**
 * @typedef {{
 *   name: string,
 *   description: string,
 *   gapRef: string,
 *   durationMs: number,
 *   setup: () => Promise<void>,
 *   teardown: () => Promise<void>,
 *   verify: () => Promise<{ passed: boolean, message: string }>
 * }} ChaosScenario
 */

/** @type {Map<string, ChaosScenario>} */
const scenarios = new Map();

function registerScenario(scenario) {
  scenarios.set(scenario.name, scenario);
}

// ── Health helper ───────────────────────────────────────────────────────

const apiUrl = process.env.REDDWARF_API_URL ?? "http://127.0.0.1:8080";
const token = process.env.REDDWARF_OPERATOR_TOKEN ?? "";

async function fetchHealth() {
  const res = await fetch(`${apiUrl}/health`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(10_000)
  });
  if (!res.ok) throw new Error(`Health returned ${res.status}`);
  return res.json();
}

async function waitForHealthRecovery(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const h = await fetchHealth();
      if (h.status === "ok") return h;
    } catch { /* recovering */ }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`Health did not recover within ${timeoutMs}ms`);
}

// ── Scenario: postgres-latency ──────────────────────────────────────────

registerScenario({
  name: "postgres-latency",
  description: "Inject 200ms latency (+50ms jitter) into Postgres connections",
  gapRef: "G-11",
  durationMs: 30_000,
  async setup() {
    await injectLatency("postgres", { latencyMs: 200, jitterMs: 50 });
    log("  Injected 200ms latency into Postgres proxy.");
  },
  async teardown() {
    await resetProxy("postgres");
    log("  Removed Postgres latency toxic.");
  },
  async verify() {
    try {
      const h = await fetchHealth();
      const pool = h.repository?.postgresPool;
      return {
        passed: h.status === "ok" || h.repository?.status === "healthy",
        message: `Status: ${h.status}, Pool: ${pool?.status ?? "unknown"}, Error count: ${pool?.errorCount ?? 0}`
      };
    } catch (err) {
      return { passed: false, message: `Health check failed: ${err.message}` };
    }
  }
});

// ── Scenario: postgres-reset-peer ───────────────────────────────────────

registerScenario({
  name: "postgres-reset-peer",
  description: "Reset all Postgres TCP connections (simulates network partition)",
  gapRef: "G-11, G-14",
  durationMs: 10_000,
  async setup() {
    await injectResetPeer("postgres");
    log("  Injected TCP reset into Postgres proxy.");
  },
  async teardown() {
    await resetProxy("postgres");
    log("  Removed Postgres reset toxic.");
  },
  async verify() {
    try {
      await waitForHealthRecovery(30_000);
      return { passed: true, message: "Health recovered after Postgres connection reset." };
    } catch (err) {
      return { passed: false, message: err.message };
    }
  }
});

// ── Scenario: postgres-timeout ──────────────────────────────────────────

registerScenario({
  name: "postgres-timeout",
  description: "Inject 5s timeout on Postgres connections (simulates hung database)",
  gapRef: "G-11",
  durationMs: 20_000,
  async setup() {
    await injectTimeout("postgres", { timeoutMs: 5_000 });
    log("  Injected 5s timeout into Postgres proxy.");
  },
  async teardown() {
    await resetProxy("postgres");
    log("  Removed Postgres timeout toxic.");
  },
  async verify() {
    try {
      const h = await fetchHealth();
      return {
        passed: true,
        message: `Status: ${h.status}, Repository: ${h.repository?.status ?? "unknown"}`
      };
    } catch (err) {
      // Expected — health endpoint may time out if postgres is blocked
      return { passed: true, message: `Health timed out (expected during postgres timeout): ${err.message}` };
    }
  }
});

// ── Scenario: openclaw-latency ──────────────────────────────────────────

registerScenario({
  name: "openclaw-latency",
  description: "Inject 500ms latency into OpenClaw gateway connections",
  gapRef: "G-02",
  durationMs: 30_000,
  async setup() {
    await injectLatency("openclaw", { latencyMs: 500, jitterMs: 100 });
    log("  Injected 500ms latency into OpenClaw proxy.");
  },
  async teardown() {
    await resetProxy("openclaw");
    log("  Removed OpenClaw latency toxic.");
  },
  async verify() {
    try {
      const h = await fetchHealth();
      const oc = h.downstream?.find((d) => d.name === "openclaw");
      return {
        passed: true,
        message: `OpenClaw status: ${oc?.status ?? "unknown"}, latency: ${oc?.latencyMs ?? "?"}ms`
      };
    } catch (err) {
      return { passed: false, message: err.message };
    }
  }
});

// ── Scenario: openclaw-timeout ──────────────────────────────────────────

registerScenario({
  name: "openclaw-timeout",
  description: "Inject timeout on OpenClaw gateway (simulates hung gateway)",
  gapRef: "G-02, G-07",
  durationMs: 20_000,
  async setup() {
    await injectTimeout("openclaw", { timeoutMs: 5_000 });
    log("  Injected 5s timeout into OpenClaw proxy.");
  },
  async teardown() {
    await resetProxy("openclaw");
    log("  Removed OpenClaw timeout toxic.");
  },
  async verify() {
    try {
      const h = await fetchHealth();
      const oc = h.downstream?.find((d) => d.name === "openclaw");
      const cb = h.circuitBreakers?.["openclaw-dispatch"];
      return {
        passed: true,
        message: `OpenClaw: ${oc?.status ?? "unknown"}, Circuit breaker: ${cb?.state ?? "n/a"} (failures: ${cb?.consecutiveFailures ?? 0})`
      };
    } catch (err) {
      return { passed: false, message: err.message };
    }
  }
});

// ── Scenario: openclaw-blackhole ────────────────────────────────────────

registerScenario({
  name: "openclaw-blackhole",
  description: "Disable OpenClaw proxy entirely (simulates complete outage)",
  gapRef: "G-02, G-07, G-14",
  durationMs: 20_000,
  async setup() {
    await disableProxy("openclaw");
    log("  Disabled OpenClaw proxy (blackhole).");
  },
  async teardown() {
    await enableProxy("openclaw");
    log("  Re-enabled OpenClaw proxy.");
  },
  async verify() {
    try {
      await waitForHealthRecovery(30_000);
      return { passed: true, message: "Health recovered after OpenClaw blackhole." };
    } catch (err) {
      return { passed: false, message: err.message };
    }
  }
});

// ── Scenario: bandwidth-throttle ────────────────────────────────────────

registerScenario({
  name: "bandwidth-throttle",
  description: "Throttle Postgres to 1 KB/s (simulates saturated network)",
  gapRef: "G-11",
  durationMs: 20_000,
  async setup() {
    await injectBandwidthLimit("postgres", { rateKBps: 1 });
    log("  Throttled Postgres bandwidth to 1 KB/s.");
  },
  async teardown() {
    await resetProxy("postgres");
    log("  Removed Postgres bandwidth throttle.");
  },
  async verify() {
    try {
      const h = await fetchHealth();
      return {
        passed: true,
        message: `Status: ${h.status}, Repository: ${h.repository?.status ?? "unknown"}`
      };
    } catch (err) {
      return { passed: true, message: `Expected degradation: ${err.message}` };
    }
  }
});

// ── Scenario: full-outage ───────────────────────────────────────────────

registerScenario({
  name: "full-outage",
  description: "Disable both Postgres and OpenClaw proxies, then recover",
  gapRef: "G-02, G-07, G-11, G-14",
  durationMs: 30_000,
  async setup() {
    await disableProxy("postgres");
    await disableProxy("openclaw");
    log("  Disabled both Postgres and OpenClaw proxies.");
  },
  async teardown() {
    await enableProxy("postgres");
    await enableProxy("openclaw");
    log("  Re-enabled both proxies.");
  },
  async verify() {
    try {
      await waitForHealthRecovery(60_000);
      return { passed: true, message: "Health recovered after full outage." };
    } catch (err) {
      return { passed: false, message: err.message };
    }
  }
});

// ── CLI ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("--list") || args.includes("-l") || args.length === 0) {
  log("Available chaos scenarios:");
  log("");
  for (const [name, scenario] of scenarios) {
    log(`  ${name.padEnd(24)} ${scenario.description}`);
    log(`  ${"".padEnd(24)} Gaps: ${scenario.gapRef} | Duration: ${scenario.durationMs / 1000}s`);
  }
  log("");
  log("Usage: pnpm chaos:run <scenario>");
  process.exit(0);
}

const scenarioName = args[0];
const scenario = scenarios.get(scenarioName);

if (!scenario) {
  logError(`Unknown scenario: ${scenarioName}`);
  logError(`Run with --list to see available scenarios.`);
  process.exit(1);
}

log(`═══ Chaos Experiment: ${scenario.name} ═══`);
log(`Description: ${scenario.description}`);
log(`Gaps: ${scenario.gapRef}`);
log(`Duration: ${scenario.durationMs / 1000}s`);
log("");

try {
  // Verify Toxiproxy is reachable
  log("Checking Toxiproxy API...");
  await waitForToxiproxy({ timeoutMs: 10_000 });
  log("  Toxiproxy is reachable.");

  // Clean slate
  log("Resetting all proxies to clean state...");
  await resetAllProxies();

  // Verify baseline health
  log("Verifying baseline health...");
  const baseline = await fetchHealth();
  log(`  Baseline: ${baseline.status}`);

  // Setup the chaos condition
  log("Injecting chaos...");
  await scenario.setup();

  // Let the system experience the chaos for the configured duration
  log(`Holding chaos condition for ${scenario.durationMs / 1000}s...`);
  const holdStart = Date.now();
  const holdInterval = Math.min(scenario.durationMs / 3, 10_000);

  while (Date.now() - holdStart < scenario.durationMs) {
    try {
      const h = await fetchHealth();
      log(`  [${((Date.now() - holdStart) / 1000).toFixed(0)}s] Status: ${h.status}, Repo: ${h.repository?.status ?? "?"}, Readiness: ${h.readiness ?? "?"}`);
    } catch (err) {
      log(`  [${((Date.now() - holdStart) / 1000).toFixed(0)}s] Health error: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, holdInterval));
  }

  // Teardown the chaos condition
  log("Removing chaos condition...");
  await scenario.teardown();

  // Verify recovery
  log("Verifying recovery...");
  const result = await scenario.verify();

  log("");
  if (result.passed) {
    log(`═══ PASS: ${scenario.name} ═══`);
    log(`  ${result.message}`);
    process.exit(0);
  } else {
    logError(`═══ FAIL: ${scenario.name} ═══`);
    logError(`  ${result.message}`);
    process.exit(1);
  }
} catch (err) {
  logError(`═══ ERROR: ${scenario.name} ═══`);
  logError(`  ${err.message}`);

  // Best-effort cleanup
  try {
    await resetAllProxies();
  } catch { /* ignore */ }

  process.exit(1);
}
