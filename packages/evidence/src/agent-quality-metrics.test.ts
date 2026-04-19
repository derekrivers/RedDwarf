import { describe, expect, it } from "vitest";
import type {
  PhaseRecord,
  RunEvent,
  TaskManifest
} from "@reddwarf/contracts";
import { computeAgentQualityMetrics } from "./agent-quality-metrics.js";

function makePhase(overrides: Partial<PhaseRecord>): PhaseRecord {
  return {
    recordId: `${overrides.taskId ?? "t"}:phase:${overrides.phase ?? "planning"}`,
    taskId: "t",
    phase: "planning",
    status: "passed",
    actor: "holly",
    summary: "done",
    details: {},
    createdAt: "2026-04-19T10:00:00.000Z",
    ...overrides
  } as PhaseRecord;
}

function makeEvent(overrides: Partial<RunEvent> = {}): RunEvent {
  const base: RunEvent = {
    eventId: `${overrides.taskId ?? "t"}:evt:${Math.random()}`,
    taskId: "t",
    runId: "r",
    phase: "planning",
    level: "info",
    code: "PHASE_PASSED",
    message: "",
    data: {},
    createdAt: "2026-04-19T10:00:00.000Z"
  } as RunEvent;
  return { ...base, ...overrides } as RunEvent;
}

function makeManifest(
  taskId: string,
  policyVersion: string
): TaskManifest {
  return {
    taskId,
    source: { provider: "github", repo: "acme/repo", issueNumber: 1 },
    title: "t",
    summary: "s",
    priority: 1,
    dryRun: false,
    riskClass: "medium",
    approvalMode: "review_required",
    currentPhase: "development",
    lifecycleStatus: "active",
    assignedAgentType: "developer",
    requestedCapabilities: [],
    retryCount: 0,
    evidenceLinks: [],
    workspaceId: null,
    branchName: null,
    prNumber: null,
    policyVersion,
    createdAt: "2026-04-19T09:00:00.000Z",
    updatedAt: "2026-04-19T10:00:00.000Z"
  } as TaskManifest;
}

describe("computeAgentQualityMetrics", () => {
  it("buckets phase outcomes by (phase, policyVersion) with pass rate", () => {
    const manifests = new Map([
      ["task-a", makeManifest("task-a", "v14")],
      ["task-b", makeManifest("task-b", "v14")],
      ["task-c", makeManifest("task-c", "v15")]
    ]);
    const phaseRecords: PhaseRecord[] = [
      makePhase({ taskId: "task-a", phase: "planning", status: "passed" }),
      makePhase({ taskId: "task-b", phase: "planning", status: "failed" }),
      makePhase({ taskId: "task-c", phase: "planning", status: "passed" })
    ];
    const metrics = computeAgentQualityMetrics({
      query: {},
      phaseRecords,
      runEvents: [],
      manifestsByTaskId: manifests
    });
    expect(metrics.phaseOutcomes).toHaveLength(2);
    const v14 = metrics.phaseOutcomes.find((r) => r.policyVersion === "v14")!;
    expect(v14.passed).toBe(1);
    expect(v14.failed).toBe(1);
    expect(v14.total).toBe(2);
    expect(v14.passRate).toBe(0.5);
    const v15 = metrics.phaseOutcomes.find((r) => r.policyVersion === "v15")!;
    expect(v15.passRate).toBe(1);
  });

  it("honours since/until window on phase_records.createdAt", () => {
    const manifests = new Map([["t", makeManifest("t", "v14")]]);
    const phaseRecords: PhaseRecord[] = [
      makePhase({ taskId: "t", createdAt: "2026-04-01T00:00:00.000Z" }),
      makePhase({ taskId: "t", createdAt: "2026-04-15T00:00:00.000Z" }),
      makePhase({ taskId: "t", createdAt: "2026-04-30T00:00:00.000Z" })
    ];
    const metrics = computeAgentQualityMetrics({
      query: {
        since: "2026-04-10T00:00:00.000Z",
        until: "2026-04-20T00:00:00.000Z"
      },
      phaseRecords,
      runEvents: [],
      manifestsByTaskId: manifests
    });
    expect(metrics.phaseOutcomes[0]!.total).toBe(1);
    expect(metrics.window.since).toBe("2026-04-10T00:00:00.000Z");
  });

  it("computes mean / p50 / p95 phase latency from PHASE_PASSED events", () => {
    const manifests = new Map([["t", makeManifest("t", "v14")]]);
    const durations = [100, 200, 300, 400, 500];
    const runEvents: RunEvent[] = durations.map((d) =>
      makeEvent({ durationMs: d, code: "PHASE_PASSED" })
    );
    // Add a non-duration event and a non-matching code; both should be ignored.
    runEvents.push(makeEvent({ code: "PHASE_PASSED" }));
    runEvents.push(makeEvent({ durationMs: 9999, code: "APPROVAL_REQUESTED" }));
    const metrics = computeAgentQualityMetrics({
      query: {},
      phaseRecords: [],
      runEvents,
      manifestsByTaskId: manifests
    });
    const row = metrics.phaseLatencies[0]!;
    expect(row.sampleCount).toBe(5);
    expect(row.meanMs).toBe(300);
    expect(row.p50Ms).toBe(300);
    expect(row.p95Ms).toBe(500);
  });

  it("counts failure classes per phase and sorts by descending frequency", () => {
    const manifests = new Map([["t", makeManifest("t", "v14")]]);
    const runEvents: RunEvent[] = [
      makeEvent({ failureClass: "validation_failure", phase: "validation" }),
      makeEvent({ failureClass: "validation_failure", phase: "validation" }),
      makeEvent({ failureClass: "planning_failure", phase: "planning" }),
      makeEvent({})
    ];
    const metrics = computeAgentQualityMetrics({
      query: {},
      phaseRecords: [],
      runEvents,
      manifestsByTaskId: manifests
    });
    expect(metrics.failureClasses).toHaveLength(2);
    expect(metrics.failureClasses[0]).toMatchObject({
      failureClass: "validation_failure",
      phase: "validation",
      count: 2
    });
    expect(metrics.failureClasses[1]!.count).toBe(1);
  });

  it("falls back to 'unversioned' when a manifest is missing", () => {
    const phaseRecords: PhaseRecord[] = [
      makePhase({ taskId: "orphan", phase: "planning", status: "passed" })
    ];
    const metrics = computeAgentQualityMetrics({
      query: {},
      phaseRecords,
      runEvents: [],
      manifestsByTaskId: new Map()
    });
    expect(metrics.phaseOutcomes[0]!.policyVersion).toBe("unversioned");
  });

  it("produces empty arrays when no data matches", () => {
    const metrics = computeAgentQualityMetrics({
      query: {},
      phaseRecords: [],
      runEvents: [],
      manifestsByTaskId: new Map()
    });
    expect(metrics.phaseOutcomes).toEqual([]);
    expect(metrics.phaseLatencies).toEqual([]);
    expect(metrics.failureClasses).toEqual([]);
    expect(metrics.window).toEqual({ since: null, until: null });
  });
});
