import { describe, expect, it } from "vitest";
import {
  InMemoryPlanningRepository,
  buildMemoryContextForRepository,
  createMemoryRecord,
  createPipelineRun,
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
});

