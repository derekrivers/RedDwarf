import assert from "node:assert/strict";
import { DeterministicPlanningAgent, runPlanningPipeline } from "../packages/control-plane/dist/index.js";
import {
import { connectionString } from "./lib/config.mjs";
  PostgresPlanningRepository,
  createMemoryRecord,
  deriveOrganizationId
} from "../packages/evidence/dist/index.js";

const repository = new PostgresPlanningRepository({ connectionString });
const unique = Date.now();
const repo = `acme-${unique}/platform-${unique}`;
const organizationId = deriveOrganizationId(repo);

try {
  const result = await runPlanningPipeline(
    {
      source: {
        provider: "github",
        repo,
        issueNumber: unique,
        issueUrl: `https://github.com/${repo}/issues/${unique}`
      },
      title: "Verify partitioned memory persistence",
      summary:
        "Run the planning pipeline, store project, organization, and external memory records, and verify that the scoped memory context is queryable from Postgres.",
      priority: 1,
      labels: ["ai-eligible"],
      acceptanceCriteria: ["Task memory is created", "Scoped memory context can be read"],
      affectedPaths: ["docs/memory-verification.md"],
      requestedCapabilities: ["can_plan", "can_archive_evidence"],
      metadata: {}
    },
    {
      repository,
      planner: new DeterministicPlanningAgent()
    }
  );

  await repository.saveMemoryRecord(
    createMemoryRecord({
      memoryId: `${result.manifest.taskId}:project:test-command`,
      scope: "project",
      provenance: "human_curated",
      key: "repo.testing-command",
      title: "Primary test command",
      value: { command: "corepack pnpm test" },
      repo,
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
      repo,
      organizationId,
      sourceUri: "https://www.typescriptlang.org/docs/",
      tags: ["typescript"],
      createdAt: result.manifest.updatedAt,
      updatedAt: result.manifest.updatedAt
    })
  );

  const snapshot = await repository.getTaskSnapshot(result.manifest.taskId);
  const memoryContext = await repository.getMemoryContext({
    taskId: result.manifest.taskId,
    repo,
    organizationId
  });

  assert.equal(snapshot.memoryRecords.length, 1, "Expected the planning pipeline to create task memory.");
  assert.equal(snapshot.memoryRecords[0]?.key, "planning.brief");
  assert.equal(memoryContext.taskMemory.length, 1);
  assert.equal(memoryContext.projectMemory.length, 1);
  assert.equal(memoryContext.organizationMemory.length, 1);
  assert.equal(memoryContext.externalMemory.length, 1);

  console.log(
    JSON.stringify(
      {
        taskId: result.manifest.taskId,
        runId: result.runId,
        taskMemoryCount: memoryContext.taskMemory.length,
        projectMemoryCount: memoryContext.projectMemory.length,
        organizationMemoryCount: memoryContext.organizationMemory.length,
        externalMemoryCount: memoryContext.externalMemory.length,
        organizationId
      },
      null,
      2
    )
  );
} finally {
  await repository.close();
}