import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DeterministicPlanningAgent,
  createWorkspaceContextBundleFromSnapshot,
  destroyTaskWorkspace,
  provisionTaskWorkspace,
  resolveApprovalRequest,
  runPlanningPipeline
} from "@reddwarf/control-plane";
import {
  PostgresPlanningRepository,
  createMemoryRecord,
  createPipelineRun,
  deriveOrganizationId
} from "@reddwarf/evidence";
import type { PlanningTaskInput } from "@reddwarf/contracts";

const connectionString = process.env.HOST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDatabase = connectionString ? describe : describe.skip;

describeIfDatabase("postgres planning repository", () => {
  const repository = new PostgresPlanningRepository({ connectionString: connectionString! });

  beforeAll(async () => {
    await repository.healthcheck();
  });

  afterAll(async () => {
    await repository.close();
  });

  it("persists a planning pipeline run and can provision and destroy a managed workspace", async () => {
    const issueNumber = Date.now();
    const repo = `acme-${issueNumber}/platform-${issueNumber}`;
    const input: PlanningTaskInput = {
      source: {
        provider: "github",
        repo,
        issueNumber,
        issueUrl: `https://github.com/${repo}/issues/${issueNumber}`
      },
      title: "Persist a docs-safe planning run",
      summary:
        "Persist a docs-safe planning run into Postgres and verify the durable audit, observability, memory, pipeline-run records, and managed workspace lifecycle are queryable.",
      priority: 1,
      labels: ["ai-eligible"],
      acceptanceCriteria: ["The planning spec exists", "Audit records can be queried"],
      affectedPaths: ["docs/postgres-verification.md"],
      requestedCapabilities: ["can_plan", "can_archive_evidence"],
      metadata: {}
    };

    const result = await runPlanningPipeline(input, {
      repository,
      planner: new DeterministicPlanningAgent()
    });

    const organizationId = deriveOrganizationId(input.source.repo);
    await repository.saveMemoryRecord(
      createMemoryRecord({
        memoryId: `${result.manifest.taskId}:project:test-command`,
        scope: "project",
        provenance: "human_curated",
        key: "repo.testing-command",
        title: "Primary test command",
        value: { command: "corepack pnpm test" },
        repo: input.source.repo,
        organizationId,
        tags: ["testing"],
        createdAt: result.manifest.updatedAt,
        updatedAt: result.manifest.updatedAt
      })
    );
    await repository.saveMemoryRecord(
      createMemoryRecord({
        memoryId: `${result.manifest.taskId}:organization:policy`,
        scope: "organization",
        provenance: "human_curated",
        key: "policy.approval",
        title: "Approval policy",
        value: { requiresHuman: ["can_write_code"] },
        organizationId,
        tags: ["policy"],
        createdAt: result.manifest.updatedAt,
        updatedAt: result.manifest.updatedAt
      })
    );
    await repository.saveMemoryRecord(
      createMemoryRecord({
        memoryId: `${result.manifest.taskId}:external:typescript`,
        scope: "external",
        provenance: "external_retrieval",
        key: "docs.typescript.release-notes",
        title: "TypeScript notes",
        value: { section: "5.8" },
        repo: input.source.repo,
        organizationId,
        sourceUri: "https://www.typescriptlang.org/docs/",
        tags: ["typescript"],
        createdAt: result.manifest.updatedAt,
        updatedAt: result.manifest.updatedAt
      })
    );

    const snapshot = await repository.getTaskSnapshot(result.manifest.taskId);
    const runSummary = await repository.getRunSummary(result.manifest.taskId, result.runId);
    const memoryContext = await repository.getMemoryContext({
      taskId: result.manifest.taskId,
      repo: input.source.repo,
      organizationId
    });
    const tempRoot = await mkdtemp(join(tmpdir(), "reddwarf-postgres-context-"));

    try {
      expect(snapshot.manifest?.taskId).toBe(result.manifest.taskId);
      expect(snapshot.spec?.taskId).toBe(result.manifest.taskId);
      expect(snapshot.policySnapshot?.approvalMode).toBe("auto");
      expect(snapshot.phaseRecords).toHaveLength(5);
      expect(snapshot.phaseRecords.map((record) => record.phase)).toEqual([
        "intake",
        "eligibility",
        "planning",
        "policy_gate",
        "archive"
      ]);
      expect(snapshot.evidenceRecords.length).toBeGreaterThanOrEqual(3);
      expect(snapshot.runEvents.length).toBeGreaterThanOrEqual(7);
      expect(snapshot.memoryRecords).toHaveLength(1);
      expect(snapshot.memoryRecords[0]?.key).toBe("planning.brief");
      expect(snapshot.pipelineRuns).toHaveLength(1);
      expect(snapshot.pipelineRuns[0]?.status).toBe("completed");
      expect(runSummary?.status).toBe("completed");
      expect(runSummary?.eventCounts.info).toBeGreaterThanOrEqual(6);
      expect(runSummary?.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(memoryContext.taskMemory).toHaveLength(1);
      expect(memoryContext.projectMemory).toHaveLength(1);
      expect(memoryContext.organizationMemory).toHaveLength(1);
      expect(memoryContext.externalMemory).toHaveLength(1);

      const bundle = createWorkspaceContextBundleFromSnapshot(snapshot);
      const provisioned = await provisionTaskWorkspace({
        snapshot,
        repository,
        targetRoot: tempRoot,
        workspaceId: `${result.manifest.taskId}-integration`
      });
      const descriptor = JSON.parse(await readFile(provisioned.workspace.stateFile, "utf8"));
      const policySnapshot = JSON.parse(await readFile(provisioned.workspace.files.policySnapshotJson, "utf8"));
      const soulMd = await readFile(provisioned.workspace.instructions.files.soulMd, "utf8");
      const toolsMd = await readFile(provisioned.workspace.instructions.files.toolsMd, "utf8");
      const taskSkillMd = await readFile(provisioned.workspace.instructions.files.taskSkillMd, "utf8");

      expect(bundle.allowedPaths).toEqual(["docs/postgres-verification.md"]);
      expect(policySnapshot.allowedPaths).toEqual(["docs/postgres-verification.md"]);
      expect(descriptor.status).toBe("provisioned");
      expect(soulMd).toContain(result.manifest.taskId);
      expect(toolsMd).toContain("can_archive_evidence");
      expect(taskSkillMd).toContain(".context/spec.md");

      const destroyed = await destroyTaskWorkspace({
        manifest: provisioned.manifest,
        repository,
        targetRoot: tempRoot
      });
      const persistedManifest = await repository.getManifest(result.manifest.taskId);
      const evidenceRecords = await repository.listEvidenceRecords(result.manifest.taskId);

      expect(destroyed.manifest.workspaceId).toBeNull();
      expect(destroyed.workspace.removed).toBe(true);
      expect(destroyed.workspace.descriptor?.status).toBe("destroyed");
      expect(persistedManifest?.workspaceId).toBeNull();
      expect(evidenceRecords.some((record) => record.recordId.endsWith(":provisioned"))).toBe(true);
      expect(evidenceRecords.some((record) => record.recordId.endsWith(":destroyed"))).toBe(true);
      await expect(access(provisioned.workspace.workspaceRoot)).rejects.toThrow();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("persists approval requests and decision outcomes in Postgres", async () => {
    const issueNumber = Date.now() + 1;
    const repo = `approval-${issueNumber}/platform-${issueNumber}`;
    const input: PlanningTaskInput = {
      source: {
        provider: "github",
        repo,
        issueNumber,
        issueUrl: `https://github.com/${repo}/issues/${issueNumber}`
      },
      title: "Persist a human approval workflow",
      summary:
        "Persist a planning run that requires human approval, verify the approval queue entry is durable, and confirm approval resolution updates the manifest and evidence state.",
      priority: 1,
      labels: ["ai-eligible"],
      acceptanceCriteria: ["Approval request is stored", "Approval decisions update manifest state"],
      affectedPaths: ["src/approval-flow.ts"],
      requestedCapabilities: ["can_write_code"],
      metadata: {}
    };

    const result = await runPlanningPipeline(input, {
      repository,
      planner: new DeterministicPlanningAgent(),
      clock: () => new Date("2026-03-25T18:00:00.000Z"),
      idGenerator: () => `approval-${issueNumber}`
    });
    const snapshot = await repository.getTaskSnapshot(result.manifest.taskId);
    const runSummary = await repository.getRunSummary(result.manifest.taskId, result.runId);

    expect(result.manifest.lifecycleStatus).toBe("blocked");
    expect(result.approvalRequest?.status).toBe("pending");
    expect(snapshot.approvalRequests).toHaveLength(1);
    expect(snapshot.pipelineRuns[0]?.status).toBe("blocked");
    expect(runSummary?.status).toBe("blocked");

    const resolved = await resolveApprovalRequest(
      {
        requestId: result.approvalRequest!.requestId,
        decision: "approve",
        decidedBy: "operator",
        decisionSummary: "Approved for the developer phase once it is implemented.",
        comment: "Queue is behaving as expected."
      },
      {
        repository,
        clock: () => new Date("2026-03-25T18:05:00.000Z")
      }
    );
    const persistedRequest = await repository.getApprovalRequest(result.approvalRequest!.requestId);
    const persistedManifest = await repository.getManifest(result.manifest.taskId);
    const evidenceRecords = await repository.listEvidenceRecords(result.manifest.taskId);

    expect(resolved.manifest.lifecycleStatus).toBe("ready");
    expect(persistedRequest?.status).toBe("approved");
    expect(persistedRequest?.decision).toBe("approve");
    expect(persistedManifest?.lifecycleStatus).toBe("ready");
    expect(evidenceRecords.some((record) => record.recordId.includes(":approval-decision:"))).toBe(true);
  });

  it("marks stale overlapping runs and blocks fresh overlaps in Postgres", async () => {
    const issueNumber = Date.now() + 2;
    const repo = `concurrency-${issueNumber}/platform-${issueNumber}`;
    const concurrencyKey = `github:${repo}:${issueNumber}`;
    const taskId = `${repo.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase()}-${issueNumber}`;

    await repository.savePipelineRun(
      createPipelineRun({
        runId: `stale-${issueNumber}`,
        taskId,
        concurrencyKey,
        strategy: "serialize",
        status: "active",
        startedAt: "2026-03-25T17:45:00.000Z",
        lastHeartbeatAt: "2026-03-25T17:45:00.000Z",
        metadata: {}
      })
    );

    const input: PlanningTaskInput = {
      source: {
        provider: "github",
        repo,
        issueNumber,
        issueUrl: `https://github.com/${repo}/issues/${issueNumber}`
      },
      title: "Verify concurrency controls",
      summary:
        "Verify that stale overlapping runs are retired and fresh overlaps are blocked conservatively in the Postgres-backed planning pipeline.",
      priority: 1,
      labels: ["ai-eligible"],
      acceptanceCriteria: ["Stale runs are marked", "Fresh overlaps are blocked"],
      affectedPaths: ["docs/concurrency-verification.md"],
      requestedCapabilities: ["can_plan", "can_archive_evidence"],
      metadata: {}
    };

    const staleResult = await runPlanningPipeline(input, {
      repository,
      planner: new DeterministicPlanningAgent(),
      clock: () => new Date("2026-03-25T18:00:00.000Z"),
      idGenerator: () => `fresh-${issueNumber}`,
      concurrency: {
        staleAfterMs: 60_000
      }
    });

    await repository.savePipelineRun(
      createPipelineRun({
        runId: `active-${issueNumber}`,
        taskId,
        concurrencyKey,
        strategy: "serialize",
        status: "active",
        startedAt: "2026-03-25T18:00:01.000Z",
        lastHeartbeatAt: "2026-03-25T18:00:01.000Z",
        metadata: {}
      })
    );

    const blockedResult = await runPlanningPipeline(input, {
      repository,
      planner: new DeterministicPlanningAgent(),
      clock: () => new Date("2026-03-25T18:00:05.000Z"),
      idGenerator: () => `blocked-${issueNumber}`,
      concurrency: {
        staleAfterMs: 60_000
      }
    });

    const pipelineRuns = await repository.listPipelineRuns({ concurrencyKey, limit: 10 });
    const blockedSummary = await repository.getRunSummary(taskId, `blocked-${issueNumber}`);

    expect(staleResult.concurrencyDecision.staleRunIds).toEqual([`stale-${issueNumber}`]);
    expect(blockedResult.concurrencyDecision.action).toBe("block");
    expect(blockedResult.concurrencyDecision.blockedByRunId).toBe(`active-${issueNumber}`);
    expect(blockedSummary?.status).toBe("blocked");
    expect(blockedSummary?.failureClass).toBe("execution_loop");
    expect(pipelineRuns.find((run) => run.runId === `stale-${issueNumber}`)?.status).toBe("stale");
    expect(pipelineRuns.find((run) => run.runId === `fresh-${issueNumber}`)?.status).toBe("completed");
    expect(pipelineRuns.find((run) => run.runId === `blocked-${issueNumber}`)?.status).toBe("blocked");
  });
});
