import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DeterministicPlanningAgent,
  PlanningPipelineFailure,
  assertPhaseLifecycleTransition,
  assertTaskLifecycleTransition,
  createBufferedPlanningLogger,
  createRuntimeInstructionArtifacts,
  createRuntimeInstructionLayer,
  createWorkspaceContextBundle,
  destroyTaskWorkspace,
  provisionTaskWorkspace,
  runPlanningPipeline
} from "@reddwarf/control-plane";
import { InMemoryPlanningRepository, createPipelineRun } from "@reddwarf/evidence";
import type { PlanningTaskInput } from "@reddwarf/contracts";

const eligibleInput: PlanningTaskInput = {
  source: {
    provider: "github",
    repo: "acme/platform",
    issueNumber: 99,
    issueUrl: "https://github.com/acme/platform/issues/99"
  },
  title: "Plan a docs-safe change",
  summary: "Plan a deterministic docs-safe change for the platform repository with durable evidence output.",
  priority: 1,
  labels: ["ai-eligible"],
  acceptanceCriteria: ["A planning spec exists", "Policy output is archived"],
  affectedPaths: ["docs/guide.md"],
  requestedCapabilities: ["can_plan", "can_archive_evidence"],
  metadata: {}
};

describe("control-plane", () => {
  it("rejects illegal lifecycle transitions", () => {
    expect(() => assertTaskLifecycleTransition("ready", "completed")).toThrow();
    expect(() => assertPhaseLifecycleTransition("passed", "running")).toThrow();
  });

  it("completes the planning pipeline and records structured observability output", async () => {
    const repository = new InMemoryPlanningRepository();
    const bufferedLogger = createBufferedPlanningLogger();
    const result = await runPlanningPipeline(eligibleInput, {
      repository,
      planner: new DeterministicPlanningAgent(),
      logger: bufferedLogger.logger,
      clock: () => new Date("2026-03-25T18:00:00.000Z"),
      idGenerator: () => "run-001"
    });

    expect(result.nextAction).toBe("complete");
    expect(result.manifest.lifecycleStatus).toBe("completed");
    expect(result.concurrencyDecision.action).toBe("start");
    expect(repository.phaseRecords.map((record) => record.phase)).toEqual([
      "intake",
      "eligibility",
      "planning",
      "policy_gate",
      "archive"
    ]);
    expect(repository.phaseRecords.some((record) => record.phase === "development")).toBe(false);

    const bundle = createWorkspaceContextBundle({
      manifest: result.manifest,
      spec: result.spec!,
      policySnapshot: result.policySnapshot!
    });
    const runtimeInstructionLayer = createRuntimeInstructionLayer(bundle);
    const runtimeInstructionArtifacts = createRuntimeInstructionArtifacts(runtimeInstructionLayer);
    const runSummary = await repository.getRunSummary(result.manifest.taskId, result.runId);
    const taskMemory = await repository.listMemoryRecords({ taskId: result.manifest.taskId, scope: "task" });
    const pipelineRuns = await repository.listPipelineRuns({ taskId: result.manifest.taskId });

    expect(bundle.allowedPaths).toEqual(["docs/guide.md"]);
    expect(runtimeInstructionLayer.files.map((file) => file.relativePath)).toContain("SOUL.md");
    expect(runtimeInstructionLayer.canonicalSources).toContain("standards/engineering.md");
    expect(runtimeInstructionArtifacts.soulMd).toContain("RedDwarf Runtime Soul");
    expect(runtimeInstructionArtifacts.toolsMd).toContain("can_plan");
    expect(runtimeInstructionArtifacts.taskSkillMd).toContain(".context/task.json");
    expect(runSummary?.status).toBe("completed");
    expect(runSummary?.phaseDurations.planning).toBe(0);
    expect(runSummary?.eventCounts.info).toBeGreaterThanOrEqual(6);
    expect(taskMemory).toHaveLength(1);
    expect(taskMemory[0]?.key).toBe("planning.brief");
    expect(pipelineRuns).toHaveLength(1);
    expect(pipelineRuns[0]?.status).toBe("completed");
    expect(bufferedLogger.records.some((record) => record.bindings.runId === result.runId)).toBe(true);
    expect(
      bufferedLogger.records.some(
        (record) => record.bindings.code === "PIPELINE_COMPLETED" && record.level === "info"
      )
    ).toBe(true);
  });

  it("provisions and destroys a managed workspace with manifest and evidence updates", async () => {
    const repository = new InMemoryPlanningRepository();
    const tempRoot = await mkdtemp(join(tmpdir(), "reddwarf-managed-workspace-"));
    const planningResult = await runPlanningPipeline(eligibleInput, {
      repository,
      planner: new DeterministicPlanningAgent(),
      clock: () => new Date("2026-03-25T18:00:00.000Z"),
      idGenerator: () => "run-workspace"
    });

    try {
      const snapshot = await repository.getTaskSnapshot(planningResult.manifest.taskId);
      const provisioned = await provisionTaskWorkspace({
        snapshot,
        repository,
        targetRoot: tempRoot,
        workspaceId: "workspace-001",
        clock: () => new Date("2026-03-25T18:05:00.000Z")
      });
      const descriptor = JSON.parse(await readFile(provisioned.workspace.stateFile, "utf8"));

      expect(provisioned.manifest.workspaceId).toBe("workspace-001");
      expect(descriptor.status).toBe("provisioned");
      expect(descriptor.toolPolicy.mode).toBe("planning_only");
      expect(provisioned.workspace.descriptor.credentialPolicy.mode).toBe("none");
      expect(repository.evidenceRecords.some((record) => record.recordId.endsWith(":provisioned"))).toBe(true);

      const destroyed = await destroyTaskWorkspace({
        manifest: provisioned.manifest,
        repository,
        targetRoot: tempRoot,
        clock: () => new Date("2026-03-25T18:10:00.000Z")
      });

      expect(destroyed.manifest.workspaceId).toBeNull();
      expect(destroyed.workspace.removed).toBe(true);
      expect(destroyed.workspace.descriptor?.status).toBe("destroyed");
      expect(repository.evidenceRecords.some((record) => record.recordId.endsWith(":destroyed"))).toBe(true);
      await expect(access(provisioned.workspace.workspaceRoot)).rejects.toThrow();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("blocks ineligible tasks before planning and persists a blocked run summary", async () => {
    const repository = new InMemoryPlanningRepository();
    const result = await runPlanningPipeline(
      {
        ...eligibleInput,
        labels: []
      },
      {
        repository,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-25T18:00:00.000Z"),
        idGenerator: () => "run-002"
      }
    );
    const runSummary = await repository.getRunSummary(result.manifest.taskId, result.runId);
    const pipelineRuns = await repository.listPipelineRuns({ taskId: result.manifest.taskId });

    expect(result.nextAction).toBe("task_blocked");
    expect(result.manifest.currentPhase).toBe("eligibility");
    expect(repository.planningSpecs.size).toBe(0);
    expect(runSummary?.status).toBe("blocked");
    expect(runSummary?.failureClass).toBe("policy_violation");
    expect(pipelineRuns[0]?.status).toBe("blocked");
  });

  it("archives planning output but escalates future execution for code-writing tasks", async () => {
    const repository = new InMemoryPlanningRepository();
    const result = await runPlanningPipeline(
      {
        ...eligibleInput,
        requestedCapabilities: ["can_write_code"],
        affectedPaths: ["src/app.ts"]
      },
      {
        repository,
        planner: new DeterministicPlanningAgent(),
        clock: () => new Date("2026-03-25T18:00:00.000Z"),
        idGenerator: () => "run-003"
      }
    );
    const runSummary = await repository.getRunSummary(result.manifest.taskId, result.runId);

    expect(result.nextAction).toBe("await_human");
    expect(result.policySnapshot?.approvalMode).toBe("human_signoff_required");
    expect(repository.phaseRecords.find((record) => record.phase === "policy_gate")?.status).toBe(
      "escalated"
    );
    expect(runSummary?.eventCounts.warn).toBeGreaterThanOrEqual(1);
  });

  it("blocks a fresh overlapping run for the same task source", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.savePipelineRun(
      createPipelineRun({
        runId: "run-active",
        taskId: "acme-platform-99",
        concurrencyKey: "github:acme/platform:99",
        strategy: "serialize",
        status: "active",
        startedAt: "2026-03-25T17:59:00.000Z",
        lastHeartbeatAt: "2026-03-25T18:00:00.000Z",
        metadata: {}
      })
    );

    const result = await runPlanningPipeline(eligibleInput, {
      repository,
      planner: new DeterministicPlanningAgent(),
      clock: () => new Date("2026-03-25T18:00:05.000Z"),
      idGenerator: () => "run-blocked"
    });
    const runSummary = await repository.getRunSummary(result.manifest.taskId, result.runId);
    const pipelineRuns = await repository.listPipelineRuns({ concurrencyKey: "github:acme/platform:99" });

    expect(result.nextAction).toBe("task_blocked");
    expect(result.concurrencyDecision.action).toBe("block");
    expect(result.concurrencyDecision.blockedByRunId).toBe("run-active");
    expect(runSummary?.status).toBe("blocked");
    expect(runSummary?.failureClass).toBe("execution_loop");
    expect(pipelineRuns.map((run) => run.status)).toContain("blocked");
    expect(repository.planningSpecs.size).toBe(0);
  });

  it("marks stale overlapping runs and proceeds with a new planning run", async () => {
    const repository = new InMemoryPlanningRepository();
    await repository.savePipelineRun(
      createPipelineRun({
        runId: "run-stale",
        taskId: "acme-platform-99",
        concurrencyKey: "github:acme/platform:99",
        strategy: "serialize",
        status: "active",
        startedAt: "2026-03-25T17:45:00.000Z",
        lastHeartbeatAt: "2026-03-25T17:45:00.000Z",
        metadata: {}
      })
    );

    const result = await runPlanningPipeline(eligibleInput, {
      repository,
      planner: new DeterministicPlanningAgent(),
      clock: () => new Date("2026-03-25T18:00:00.000Z"),
      idGenerator: () => "run-005",
      concurrency: {
        staleAfterMs: 60_000
      }
    });
    const runSummary = await repository.getRunSummary(result.manifest.taskId, result.runId);
    const pipelineRuns = await repository.listPipelineRuns({ concurrencyKey: "github:acme/platform:99" });
    const staleRun = pipelineRuns.find((run) => run.runId === "run-stale");
    const activeRun = pipelineRuns.find((run) => run.runId === "run-005");

    expect(result.nextAction).toBe("complete");
    expect(result.concurrencyDecision.action).toBe("start");
    expect(result.concurrencyDecision.staleRunIds).toEqual(["run-stale"]);
    expect(staleRun?.status).toBe("stale");
    expect(staleRun?.staleAt).toBe("2026-03-25T18:00:00.000Z");
    expect(activeRun?.status).toBe("completed");
    expect(runSummary?.status).toBe("completed");
  });

  it("persists a failed run with planning failure metadata", async () => {
    const repository = new InMemoryPlanningRepository();
    const bufferedLogger = createBufferedPlanningLogger();

    await expect(
      runPlanningPipeline(eligibleInput, {
        repository,
        planner: {
          async createSpec() {
            throw new Error("Planner exploded.");
          }
        },
        logger: bufferedLogger.logger,
        clock: () => new Date("2026-03-25T18:00:00.000Z"),
        idGenerator: () => "run-004"
      })
    ).rejects.toBeInstanceOf(PlanningPipelineFailure);

    const manifest = await repository.getManifest("acme-platform-99");
    const runSummary = await repository.getRunSummary("acme-platform-99", "run-004");
    const pipelineRuns = await repository.listPipelineRuns({ taskId: "acme-platform-99" });

    expect(manifest?.lifecycleStatus).toBe("failed");
    expect(runSummary?.status).toBe("failed");
    expect(runSummary?.failureClass).toBe("planning_failure");
    expect(pipelineRuns.find((run) => run.runId === "run-004")?.status).toBe("failed");
    expect(bufferedLogger.records.some((record) => record.level === "error")).toBe(true);
  });
});
