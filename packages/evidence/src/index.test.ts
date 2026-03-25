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
});
