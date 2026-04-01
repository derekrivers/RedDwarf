import { describe, expect, it } from "vitest";
import {
  InMemoryPlanningRepository,
  buildMemoryContextForRepository,
  createMemoryRecord,
  createOperatorConfigEntry,
  createPipelineRun,
  createPromptSnapshot,
  deriveOrganizationId
} from "@reddwarf/evidence";

const timestamp = "2026-03-25T20:20:00.000Z";

describe("evidence memory partitions", () => {
  it("stores and queries partitioned memory records and pipeline runs", async () => {
    const repository = new InMemoryPlanningRepository();

    await repository.saveMemoryRecord(
      createMemoryRecord({
        memoryId: "task-memory-1",
        taskId: "acme-platform-42",
        scope: "task",
        provenance: "pipeline_derived",
        key: "planning.brief",
        title: "Planning brief",
        value: { summary: "Plan the docs-only backlog." },
        repo: "acme/platform",
        organizationId: "acme",
        tags: ["planning", "task"],
        createdAt: timestamp,
        updatedAt: timestamp
      })
    );
    await repository.saveMemoryRecord(
      createMemoryRecord({
        memoryId: "project-memory-1",
        scope: "project",
        provenance: "human_curated",
        key: "repo.testing-command",
        title: "Primary test command",
        value: { command: "corepack pnpm test" },
        repo: "acme/platform",
        organizationId: "acme",
        tags: ["testing"],
        createdAt: timestamp,
        updatedAt: timestamp
      })
    );
    await repository.saveMemoryRecord(
      createMemoryRecord({
        memoryId: "org-memory-1",
        scope: "organization",
        provenance: "human_curated",
        key: "policy.pr-template",
        title: "Standard PR template",
        value: { path: "standards/pr-template.md" },
        organizationId: "acme",
        tags: ["policy"],
        createdAt: timestamp,
        updatedAt: timestamp
      })
    );
    await repository.saveMemoryRecord(
      createMemoryRecord({
        memoryId: "external-memory-1",
        scope: "external",
        provenance: "external_retrieval",
        key: "docs.typescript.release-notes",
        title: "TypeScript release notes",
        value: { section: "5.8" },
        repo: "acme/platform",
        organizationId: "acme",
        sourceUri: "https://www.typescriptlang.org/docs/",
        tags: ["typescript"],
        createdAt: timestamp,
        updatedAt: timestamp
      })
    );
    await repository.savePipelineRun(
      createPipelineRun({
        runId: "run-active",
        taskId: "acme-platform-42",
        concurrencyKey: "github:acme/platform:42",
        strategy: "serialize",
        status: "active",
        startedAt: timestamp,
        lastHeartbeatAt: timestamp,
        metadata: {}
      })
    );

    const taskRecords = await repository.listMemoryRecords({ taskId: "acme-platform-42", scope: "task" });
    const context = await buildMemoryContextForRepository(repository, {
      taskId: "acme-platform-42",
      repo: "acme/platform",
      organizationId: deriveOrganizationId("acme/platform")
    });
    const activeRuns = await repository.listPipelineRuns({
      concurrencyKey: "github:acme/platform:42",
      statuses: ["active"]
    });

    expect(taskRecords).toHaveLength(1);
    expect(context.taskMemory).toHaveLength(1);
    expect(context.projectMemory).toHaveLength(1);
    expect(context.organizationMemory).toHaveLength(1);
    expect(context.externalMemory).toHaveLength(1);
    expect(activeRuns).toHaveLength(1);
  });


  it("reports in-memory repository health without a Postgres pool", async () => {
    const repository = new InMemoryPlanningRepository();

    await expect(repository.getRepositoryHealth()).resolves.toEqual({
      storage: "in_memory",
      status: "healthy",
      postgresPool: null
    });
  });

  it("stores and lists GitHub issue polling cursors", async () => {
    const repository = new InMemoryPlanningRepository();

    await repository.saveGitHubIssuePollingCursor({
      repo: "acme/platform",
      lastSeenIssueNumber: 88,
      lastSeenUpdatedAt: timestamp,
      lastPollStartedAt: timestamp,
      lastPollCompletedAt: timestamp,
      lastPollStatus: "succeeded",
      lastPollError: null,
      updatedAt: timestamp
    });

    await expect(repository.getGitHubIssuePollingCursor("acme/platform")).resolves.toMatchObject({
      repo: "acme/platform",
      lastSeenIssueNumber: 88,
      lastPollStatus: "succeeded"
    });
    await expect(repository.listGitHubIssuePollingCursors()).resolves.toEqual([
      {
        repo: "acme/platform",
        lastSeenIssueNumber: 88,
        lastSeenUpdatedAt: timestamp,
        lastPollStartedAt: timestamp,
        lastPollCompletedAt: timestamp,
        lastPollStatus: "succeeded",
        lastPollError: null,
        updatedAt: timestamp
      }
    ]);
  });

  it("stores and lists operator config entries", async () => {
    const repository = new InMemoryPlanningRepository();

    await repository.saveOperatorConfigEntry(
      createOperatorConfigEntry({
        key: "REDDWARF_POLL_INTERVAL_MS",
        value: 45000,
        updatedAt: timestamp
      })
    );
    await repository.saveOperatorConfigEntry(
      createOperatorConfigEntry({
        key: "REDDWARF_SKIP_OPENCLAW",
        value: true,
        updatedAt: "2026-03-25T20:21:00.000Z"
      })
    );

    await expect(
      repository.getOperatorConfigEntry("REDDWARF_POLL_INTERVAL_MS")
    ).resolves.toEqual({
      key: "REDDWARF_POLL_INTERVAL_MS",
      value: 45000,
      updatedAt: timestamp
    });
    await expect(repository.listOperatorConfigEntries()).resolves.toEqual([
      {
        key: "REDDWARF_POLL_INTERVAL_MS",
        value: 45000,
        updatedAt: timestamp
      },
      {
        key: "REDDWARF_SKIP_OPENCLAW",
        value: true,
        updatedAt: "2026-03-25T20:21:00.000Z"
      }
    ]);
  });

  it("stores and deletes GitHub polling cursors", async () => {
    const repository = new InMemoryPlanningRepository();

    await repository.saveGitHubIssuePollingCursor({
      repo: "acme/platform",
      lastSeenIssueNumber: null,
      lastSeenUpdatedAt: null,
      lastPollStartedAt: null,
      lastPollCompletedAt: null,
      lastPollStatus: null,
      lastPollError: null,
      updatedAt: timestamp
    });

    await expect(repository.deleteGitHubIssuePollingCursor("acme/platform")).resolves.toBe(
      true
    );
    await expect(repository.deleteGitHubIssuePollingCursor("acme/platform")).resolves.toBe(
      false
    );
  });

  it("filters task manifests and pipeline runs by repository metadata", async () => {
    const repository = new InMemoryPlanningRepository();

    await repository.saveManifest({
      taskId: "acme-platform-1",
      source: { provider: "github", repo: "acme/platform", issueNumber: 1 },
      title: "Platform task",
      summary: "A task for the platform repo.",
      priority: 1,
      dryRun: false,
      riskClass: "low",
      approvalMode: "auto",
      currentPhase: "planning",
      lifecycleStatus: "active",
      assignedAgentType: "architect",
      requestedCapabilities: ["can_plan"],
      retryCount: 0,
      evidenceLinks: [],
      workspaceId: null,
      branchName: null,
      prNumber: null,
      policyVersion: "v1",
      createdAt: timestamp,
      updatedAt: timestamp
    });
    await repository.saveManifest({
      taskId: "acme-api-2",
      source: { provider: "github", repo: "acme/api", issueNumber: 2 },
      title: "API task",
      summary: "A task for the api repo.",
      priority: 1,
      dryRun: false,
      riskClass: "low",
      approvalMode: "auto",
      currentPhase: "planning",
      lifecycleStatus: "blocked",
      assignedAgentType: "architect",
      requestedCapabilities: ["can_plan"],
      retryCount: 0,
      evidenceLinks: [],
      workspaceId: null,
      branchName: null,
      prNumber: null,
      policyVersion: "v1",
      createdAt: timestamp,
      updatedAt: "2026-03-25T20:25:00.000Z"
    });
    await repository.savePipelineRun(
      createPipelineRun({
        runId: "run-platform",
        taskId: "acme-platform-1",
        concurrencyKey: "github:acme/platform:1",
        strategy: "serialize",
        status: "active",
        startedAt: timestamp
      })
    );
    await repository.savePipelineRun(
      createPipelineRun({
        runId: "run-api",
        taskId: "acme-api-2",
        concurrencyKey: "github:acme/api:2",
        strategy: "serialize",
        status: "blocked",
        startedAt: "2026-03-25T20:25:00.000Z"
      })
    );

    await expect(
      repository.listTaskManifests({ repo: "acme/api", lifecycleStatuses: ["blocked"] })
    ).resolves.toMatchObject([{ taskId: "acme-api-2" }]);
    await expect(
      repository.listPipelineRuns({ repo: "acme/platform", statuses: ["active"] })
    ).resolves.toMatchObject([{ runId: "run-platform", taskId: "acme-platform-1" }]);
  });

  it("deduplicates prompt snapshots by phase and prompt hash", async () => {
    const repository = new InMemoryPlanningRepository();

    const first = await repository.savePromptSnapshot(
      createPromptSnapshot({
        snapshotId: "prompt-1",
        phase: "planning",
        promptHash: "deadbeefdeadbeef",
        promptPath:
          "packages/control-plane/src/pipeline/prompts.ts#buildOpenClawArchitectPrompt",
        capturedAt: timestamp
      })
    );
    const second = await repository.savePromptSnapshot(
      createPromptSnapshot({
        snapshotId: "prompt-2",
        phase: "planning",
        promptHash: "deadbeefdeadbeef",
        promptPath:
          "packages/control-plane/src/pipeline/prompts.ts#buildOpenClawArchitectPrompt",
        capturedAt: "2026-03-25T20:21:00.000Z"
      })
    );

    expect(second.snapshotId).toBe(first.snapshotId);
    await expect(repository.listPromptSnapshots()).resolves.toHaveLength(1);
    await expect(repository.getPromptSnapshot(first.snapshotId)).resolves.toEqual(
      first
    );
  });
  it("detects persisted planning specs by GitHub source for polling dedupe", async () => {
    const repository = new InMemoryPlanningRepository();

    await repository.saveManifest({
      taskId: "acme-platform-77",
      source: {
        provider: "github",
        repo: "acme/platform",
        issueNumber: 77,
        issueUrl: "https://github.com/acme/platform/issues/77"
      },
      title: "Poll issue 77",
      summary: "A planning task created from the polling daemon.",
      priority: 7,
      dryRun: false,
      riskClass: "low",
      approvalMode: "auto",
      currentPhase: "planning",
      lifecycleStatus: "active",
      assignedAgentType: "architect",
      requestedCapabilities: ["can_plan", "can_archive_evidence"],
      retryCount: 0,
      evidenceLinks: [],
      workspaceId: null,
      branchName: null,
      prNumber: null,
      policyVersion: "v1",
      createdAt: timestamp,
      updatedAt: timestamp
    });
    await repository.savePlanningSpec({
      specId: "acme-platform-77:planning-spec",
      taskId: "acme-platform-77",
      summary: "Existing planning spec",
      assumptions: ["Existing spec should suppress duplicate polling intake."],
      affectedAreas: ["docs/polling.md"],
      constraints: ["Do not create duplicate planning specs for the same issue."],
      acceptanceCriteria: ["Polling dedupes by source issue."],
      testExpectations: ["Repository source lookup returns true."],
      recommendedAgentType: "architect",
      riskClass: "low",
      confidenceLevel: "high",
      confidenceReason: "The fixture models a previously accepted planning task.",
      createdAt: timestamp
    });

    await expect(
      repository.hasPlanningSpecForSource({
        provider: "github",
        repo: "acme/platform",
        issueNumber: 77,
        issueUrl: "https://github.com/acme/platform/issues/77"
      })
    ).resolves.toBe(true);
    await expect(
      repository.hasPlanningSpecForSource({
        provider: "github",
        repo: "acme/platform",
        issueNumber: 78,
        issueUrl: "https://github.com/acme/platform/issues/78"
      })
    ).resolves.toBe(false);
  });

  it("claims active runs atomically in memory, retiring stale overlaps and blocking fresh ones", async () => {
    const repository = new InMemoryPlanningRepository();
    const concurrencyKey = "github:acme/platform:55";

    await repository.savePipelineRun(
      createPipelineRun({
        runId: "run-stale",
        taskId: "task-55",
        concurrencyKey,
        strategy: "serialize",
        status: "active",
        startedAt: "2026-03-25T18:00:00.000Z",
        lastHeartbeatAt: "2026-03-25T18:00:00.000Z"
      })
    );

    const firstClaim = await repository.claimPipelineRun({
      run: createPipelineRun({
        runId: "run-fresh",
        taskId: "task-55",
        concurrencyKey,
        strategy: "serialize",
        status: "active",
        startedAt: "2026-03-25T18:05:00.000Z",
        lastHeartbeatAt: "2026-03-25T18:05:00.000Z"
      }),
      staleAfterMs: 60_000
    });

    const secondClaim = await repository.claimPipelineRun({
      run: createPipelineRun({
        runId: "run-blocked",
        taskId: "task-55",
        concurrencyKey,
        strategy: "serialize",
        status: "active",
        startedAt: "2026-03-25T18:05:30.000Z",
        lastHeartbeatAt: "2026-03-25T18:05:30.000Z"
      }),
      staleAfterMs: 60_000
    });

    await expect(repository.getPipelineRun("run-stale")).resolves.toMatchObject({
      status: "stale",
      staleAt: "2026-03-25T18:05:00.000Z"
    });
    await expect(repository.getPipelineRun("run-fresh")).resolves.toMatchObject({
      status: "active"
    });
    await expect(repository.getPipelineRun("run-blocked")).resolves.toBeNull();
    expect(firstClaim.staleRunIds).toEqual(["run-stale"]);
    expect(firstClaim.blockedByRun).toBeNull();
    expect(secondClaim.staleRunIds).toEqual([]);
    expect(secondClaim.blockedByRun?.runId).toBe("run-fresh");
  });
});
