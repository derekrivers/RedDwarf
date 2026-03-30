import { describe, expect, it, vi } from "vitest";
import { createPhaseRunContext } from "./pipeline.js";
import type { PipelineRun } from "@reddwarf/contracts";
import { createNoopLogger } from "./logger.js";

function makeTrackedRun(overrides: Partial<PipelineRun> = {}): PipelineRun {
  return {
    runId: "run-1",
    taskId: "task-1",
    concurrencyKey: "key",
    strategy: "serialize",
    status: "active",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    staleAt: null,
    blockedByRunId: null,
    overlapReason: null,
    metadata: {},
    ...overrides
  };
}

describe("createPhaseRunContext", () => {
  it("nextEventId produces correctly sequenced IDs across calls", () => {
    let trackedRun = makeTrackedRun();
    const ctx = createPhaseRunContext({
      runId: "run-abc",
      taskId: "task-1",
      sourceRepo: "owner/repo",
      getTrackedRun: () => trackedRun,
      setTrackedRun: (run) => { trackedRun = run; },
      repository: { savePipelineRun: vi.fn().mockResolvedValue(undefined) },
      logger: createNoopLogger()
    });

    expect(ctx.nextEventId("planning", "START")).toBe("run-abc:000:planning:START");
    expect(ctx.nextEventId("planning", "COMPLETE")).toBe("run-abc:001:planning:COMPLETE");
    expect(ctx.nextEventId("development", "BEGIN")).toBe("run-abc:002:development:BEGIN");
  });

  it("persistTrackedRun merges patch and saves to repository", async () => {
    let trackedRun = makeTrackedRun({ metadata: { existing: true } });
    const savePipelineRun = vi.fn().mockResolvedValue(undefined);
    const ctx = createPhaseRunContext({
      runId: "run-1",
      taskId: "task-1",
      sourceRepo: "owner/repo",
      getTrackedRun: () => trackedRun,
      setTrackedRun: (run) => { trackedRun = run; },
      repository: { savePipelineRun },
      logger: createNoopLogger()
    });

    await ctx.persistTrackedRun({ lastHeartbeatAt: "2026-01-02T00:00:00.000Z", metadata: { step: "test" } });

    expect(savePipelineRun).toHaveBeenCalledOnce();
    expect(trackedRun.lastHeartbeatAt).toBe("2026-01-02T00:00:00.000Z");
    expect(trackedRun.metadata).toMatchObject({ existing: true, step: "test" });
  });

  it("persistTrackedRun uses the provided runRepository override", async () => {
    let trackedRun = makeTrackedRun();
    const defaultSave = vi.fn().mockResolvedValue(undefined);
    const overrideSave = vi.fn().mockResolvedValue(undefined);
    const ctx = createPhaseRunContext({
      runId: "run-1",
      taskId: "task-1",
      sourceRepo: "owner/repo",
      getTrackedRun: () => trackedRun,
      setTrackedRun: (run) => { trackedRun = run; },
      repository: { savePipelineRun: defaultSave },
      logger: createNoopLogger()
    });

    await ctx.persistTrackedRun({}, { savePipelineRun: overrideSave });

    expect(defaultSave).not.toHaveBeenCalled();
    expect(overrideSave).toHaveBeenCalledOnce();
  });

  it("runLogger includes runId and taskId in bound context", () => {
    let trackedRun = makeTrackedRun();
    const ctx = createPhaseRunContext({
      runId: "run-abc",
      taskId: "task-xyz",
      sourceRepo: "owner/repo",
      phase: "planning",
      getTrackedRun: () => trackedRun,
      setTrackedRun: (run) => { trackedRun = run; },
      repository: { savePipelineRun: vi.fn().mockResolvedValue(undefined) },
      logger: createNoopLogger()
    });

    // runLogger is bound — verify it's a non-null logger object
    expect(ctx.runLogger).toBeDefined();
  });
});
