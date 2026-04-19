import type {
  AgentQualityMetrics,
  AgentQualityMetricsQuery,
  FailureClassRow,
  FailureClass,
  PhaseLatencyRow,
  PhaseOutcomeRow,
  PhaseRecord,
  RunEvent,
  TaskManifest,
  TaskPhase
} from "@reddwarf/contracts";

// Feature 179 — Agent quality telemetry aggregates.
//
// Pure aggregation helper that turns existing `phase_records`, `run_events`,
// and `task_manifests` into the outcome / latency / failure-class rows
// surfaced by GET /metrics/agents. Both the in-memory and Postgres repository
// implementations funnel their data through here so the shape of the result
// stays identical regardless of backend — Postgres may pre-filter with SQL
// but the bucketing and percentile math happens here.

interface ComputeInput {
  query: AgentQualityMetricsQuery;
  phaseRecords: readonly PhaseRecord[];
  runEvents: readonly RunEvent[];
  manifestsByTaskId: ReadonlyMap<string, TaskManifest>;
}

const PHASE_DURATION_EVENT_CODES = new Set<string>([
  "PHASE_PASSED",
  "PHASE_FAILED",
  "PHASE_ESCALATED",
  "PIPELINE_COMPLETED"
]);

const UNKNOWN_POLICY_VERSION = "unversioned";

function withinWindow(
  createdAt: string,
  since: string | undefined,
  until: string | undefined
): boolean {
  if (since && createdAt < since) return false;
  if (until && createdAt > until) return false;
  return true;
}

function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  // Nearest-rank, inclusive of bounds.
  const rank = Math.ceil(p * sortedAsc.length);
  const index = Math.max(1, Math.min(sortedAsc.length, rank)) - 1;
  return sortedAsc[index]!;
}

function bucketKey(phase: TaskPhase, policyVersion: string): string {
  return `${phase}\u0001${policyVersion}`;
}

function resolvePolicyVersion(
  taskId: string,
  manifests: ReadonlyMap<string, TaskManifest>
): string {
  const manifest = manifests.get(taskId);
  return manifest?.policyVersion ?? UNKNOWN_POLICY_VERSION;
}

function sortByPhaseThenPolicy<
  T extends { phase: TaskPhase; policyVersion: string }
>(rows: T[]): T[] {
  return rows.sort((a, b) => {
    if (a.phase !== b.phase) return a.phase.localeCompare(b.phase);
    return a.policyVersion.localeCompare(b.policyVersion);
  });
}

export function computeAgentQualityMetrics(
  input: ComputeInput
): AgentQualityMetrics {
  const { query, phaseRecords, runEvents, manifestsByTaskId } = input;
  const since = query.since;
  const until = query.until;

  // ── Phase outcomes ─────────────────────────────────────────────────────
  const outcomeBuckets = new Map<
    string,
    { phase: TaskPhase; policyVersion: string; passed: number; failed: number; escalated: number }
  >();
  for (const record of phaseRecords) {
    if (!withinWindow(record.createdAt, since, until)) continue;
    const policyVersion = resolvePolicyVersion(record.taskId, manifestsByTaskId);
    const key = bucketKey(record.phase, policyVersion);
    const bucket =
      outcomeBuckets.get(key) ??
      { phase: record.phase, policyVersion, passed: 0, failed: 0, escalated: 0 };
    if (record.status === "passed") bucket.passed += 1;
    else if (record.status === "failed") bucket.failed += 1;
    else if (record.status === "escalated") bucket.escalated += 1;
    outcomeBuckets.set(key, bucket);
  }
  const phaseOutcomes: PhaseOutcomeRow[] = sortByPhaseThenPolicy(
    [...outcomeBuckets.values()].map((b) => {
      const total = b.passed + b.failed + b.escalated;
      const passRate = total === 0 ? 0 : b.passed / total;
      return { ...b, total, passRate };
    })
  );

  // ── Phase latencies (from run_events carrying durationMs) ───────────────
  const latencySamples = new Map<
    string,
    { phase: TaskPhase; policyVersion: string; durations: number[] }
  >();
  for (const event of runEvents) {
    if (!withinWindow(event.createdAt, since, until)) continue;
    if (event.durationMs === null || event.durationMs === undefined) continue;
    if (!PHASE_DURATION_EVENT_CODES.has(event.code)) continue;
    const policyVersion = resolvePolicyVersion(event.taskId, manifestsByTaskId);
    const key = bucketKey(event.phase, policyVersion);
    const bucket =
      latencySamples.get(key) ??
      { phase: event.phase, policyVersion, durations: [] };
    bucket.durations.push(event.durationMs);
    latencySamples.set(key, bucket);
  }
  const phaseLatencies: PhaseLatencyRow[] = sortByPhaseThenPolicy(
    [...latencySamples.values()].map((b) => {
      const sorted = [...b.durations].sort((a, c) => a - c);
      const sum = sorted.reduce((acc, n) => acc + n, 0);
      return {
        phase: b.phase,
        policyVersion: b.policyVersion,
        sampleCount: sorted.length,
        meanMs: sorted.length === 0 ? 0 : sum / sorted.length,
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95)
      };
    })
  );

  // ── Failure class distribution ─────────────────────────────────────────
  const failureBuckets = new Map<
    string,
    { failureClass: FailureClass; phase: TaskPhase; count: number }
  >();
  for (const event of runEvents) {
    if (!withinWindow(event.createdAt, since, until)) continue;
    if (!event.failureClass) continue;
    const key = `${event.failureClass}\u0001${event.phase}`;
    const bucket =
      failureBuckets.get(key) ??
      { failureClass: event.failureClass, phase: event.phase, count: 0 };
    bucket.count += 1;
    failureBuckets.set(key, bucket);
  }
  const failureClasses: FailureClassRow[] = [...failureBuckets.values()].sort(
    (a, b) => b.count - a.count || a.failureClass.localeCompare(b.failureClass)
  );

  return {
    phaseOutcomes,
    phaseLatencies,
    failureClasses,
    window: {
      since: since ?? null,
      until: until ?? null
    }
  };
}
