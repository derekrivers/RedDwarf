/**
 * tests/k6-operator-api.js
 *
 * R-17: Load test suite for the operator API.
 *
 * Scenarios:
 *   1. Normal mode: sustains 50 req/s across GET /health, GET /runs, GET /tasks
 *   2. Degraded mode (optional): same load with Toxiproxy injecting 200ms Postgres latency
 *
 * Assertions:
 *   - p99 latency stays under 2s
 *   - No 5xx responses
 *   - Error rate under 1%
 *
 * Prerequisites:
 *   - k6 installed (https://k6.io/docs/getting-started/installation/)
 *   - RedDwarf stack running on localhost:8080
 *   - REDDWARF_OPERATOR_TOKEN set in environment
 *
 * Usage:
 *   # Normal mode
 *   REDDWARF_OPERATOR_TOKEN=<token> k6 run tests/k6-operator-api.js
 *
 *   # Degraded mode (start stack with Toxiproxy chaos overlay first)
 *   REDDWARF_OPERATOR_TOKEN=<token> K6_DEGRADED=true k6 run tests/k6-operator-api.js
 *
 *   # Custom target rate
 *   REDDWARF_OPERATOR_TOKEN=<token> K6_RPS=100 k6 run tests/k6-operator-api.js
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

// ── Configuration ───────────────────────────────────────────────────────

const API_URL = __ENV.REDDWARF_API_URL || "http://127.0.0.1:8080";
const TOKEN = __ENV.REDDWARF_OPERATOR_TOKEN || "";
const TARGET_RPS = parseInt(__ENV.K6_RPS || "50", 10);
const DEGRADED = __ENV.K6_DEGRADED === "true";
const DURATION = __ENV.K6_DURATION || "30s";

// ── Custom Metrics ──────────────────────────────────────────────────────

const errorRate = new Rate("errors");
const serverErrorRate = new Rate("server_errors_5xx");
const healthLatency = new Trend("health_latency", true);
const runsLatency = new Trend("runs_latency", true);
const tasksLatency = new Trend("tasks_latency", true);

// ── k6 Options ──────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    normal_load: {
      executor: "constant-arrival-rate",
      rate: TARGET_RPS,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: Math.max(TARGET_RPS * 2, 20),
      maxVUs: TARGET_RPS * 4
    }
  },
  thresholds: {
    // p99 latency under 2s
    "http_req_duration{scenario:normal_load}": ["p(99)<2000"],
    health_latency: ["p(99)<2000"],
    runs_latency: ["p(99)<2000"],
    tasks_latency: ["p(99)<2000"],
    // No 5xx errors
    server_errors_5xx: ["rate<0.001"],
    // Error rate under 1%
    errors: ["rate<0.01"]
  }
};

// ── Helpers ─────────────────────────────────────────────────────────────

const headers = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
const params = { headers, timeout: "10s" };

function pickEndpoint() {
  // Distribute requests across endpoints: 50% health, 25% runs, 25% tasks
  const roll = Math.random();
  if (roll < 0.5) return "health";
  if (roll < 0.75) return "runs";
  return "tasks";
}

// ── Default Function ────────────────────────────────────────────────────

export default function () {
  const endpoint = pickEndpoint();
  let res;

  switch (endpoint) {
    case "health":
      res = http.get(`${API_URL}/health`, params);
      healthLatency.add(res.timings.duration);
      break;
    case "runs":
      res = http.get(`${API_URL}/runs?limit=10`, params);
      runsLatency.add(res.timings.duration);
      break;
    case "tasks":
      res = http.get(`${API_URL}/tasks?limit=10`, params);
      tasksLatency.add(res.timings.duration);
      break;
  }

  const is5xx = res.status >= 500 && res.status < 600;
  const isError = res.status >= 400;

  errorRate.add(isError);
  serverErrorRate.add(is5xx);

  check(res, {
    "status is not 5xx": (r) => r.status < 500,
    "status is 2xx": (r) => r.status >= 200 && r.status < 300,
    "response time < 2s": (r) => r.timings.duration < 2000
  });
}

// ── Setup / Teardown ────────────────────────────────────────────────────

export function setup() {
  // Verify the stack is reachable before starting the load test
  const res = http.get(`${API_URL}/health`, params);
  check(res, {
    "setup: stack is reachable": (r) => r.status === 200
  });

  if (res.status !== 200) {
    throw new Error(`Stack not reachable at ${API_URL}/health — got ${res.status}`);
  }

  return {
    degraded: DEGRADED,
    targetRps: TARGET_RPS,
    apiUrl: API_URL
  };
}

export function teardown(data) {
  console.log(`Load test complete. Mode: ${data.degraded ? "DEGRADED" : "NORMAL"}, Target RPS: ${data.targetRps}`);
}
