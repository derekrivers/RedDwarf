import { describe, expect, it } from "vitest";
import {
  DeterministicPlanningAgent,
  ingestKnowledgeSources,
  runPlanningPipeline
} from "@reddwarf/control-plane";
import {
  FixtureKnowledgeIngestionAdapter
} from "@reddwarf/integrations";
import {
  InMemoryPlanningRepository
} from "@reddwarf/evidence";
import type { PlanningTaskInput } from "@reddwarf/contracts";

const eligibleInput: PlanningTaskInput = {
  source: {
    provider: "github",
    repo: "acme/platform",
    issueNumber: 99,
    issueUrl: "https://github.com/acme/platform/issues/99"
  },
  title: "Plan a docs-safe change",
  summary:
    "Plan a deterministic docs-safe change for the platform repository with durable evidence output.",
  priority: 1,
  labels: ["ai-eligible"],
  acceptanceCriteria: ["A planning spec exists", "Policy output is archived"],
  affectedPaths: ["docs/guide.md"],
  requestedCapabilities: ["can_plan", "can_archive_evidence"],
  metadata: {}
};

describe("knowledge ingestion pipeline", () => {
  const adrSource = {
    sourceUri: "file://docs/adr/001-use-postgres.md",
    title: "ADR 001: Use PostgreSQL for persistence",
    content:
      "We adopt PostgreSQL as the primary persistence layer for all task and evidence data.",
    key: "adr.001-use-postgres",
    scope: "project" as const,
    provenance: "human_curated" as const,
    repo: "acme/platform",
    organizationId: "acme",
    tags: ["adr", "architecture", "postgres"]
  };

  const standardSource = {
    sourceUri: "file://standards/typescript-patterns.md",
    title: "TypeScript Engineering Standards",
    content: "Prefer `exactOptionalPropertyTypes` and strict null checks.",
    key: "standard.typescript-patterns",
    scope: "organization" as const,
    provenance: "human_curated" as const,
    repo: null,
    organizationId: "acme",
    tags: ["standard", "typescript", "engineering"]
  };

  const externalSource = {
    sourceUri: "https://www.typescriptlang.org/docs/handbook/utility-types.html",
    title: "TypeScript Utility Types Reference",
    content: "Partial<T>, Required<T>, Readonly<T>, Record<K,T>...",
    key: "docs.typescript.utility-types",
    scope: "external" as const,
    provenance: "external_retrieval" as const,
    repo: "acme/platform",
    organizationId: "acme",
    tags: ["typescript", "reference", "external"]
  };

  it("ingests all sources from the adapter into the repository", async () => {
    const repository = new InMemoryPlanningRepository();
    const adapter = new FixtureKnowledgeIngestionAdapter([
      adrSource,
      standardSource,
      externalSource
    ]);

    const result = await ingestKnowledgeSources(
      {},
      {
        repository,
        knowledgeAdapter: adapter,
        clock: () => new Date("2026-03-26T13:00:00.000Z")
      }
    );

    expect(result.total).toBe(3);
    expect(result.ingested.map((r) => r.key)).toEqual(
      expect.arrayContaining([
        "adr.001-use-postgres",
        "standard.typescript-patterns",
        "docs.typescript.utility-types"
      ])
    );

    const projectRecords = await repository.listMemoryRecords({
      scope: "project",
      repo: "acme/platform"
    });
    expect(projectRecords).toHaveLength(1);
    expect(projectRecords[0]?.key).toBe("adr.001-use-postgres");

    const orgRecords = await repository.listMemoryRecords({
      scope: "organization",
      organizationId: "acme"
    });
    expect(orgRecords.some((r) => r.key === "standard.typescript-patterns")).toBe(
      true
    );

    const externalRecords = await repository.listMemoryRecords({
      scope: "external"
    });
    expect(externalRecords).toHaveLength(1);
    expect(externalRecords[0]?.sourceUri).toBe(
      "https://www.typescriptlang.org/docs/handbook/utility-types.html"
    );
  });

  it("ingests only sources matching requested sourceUris", async () => {
    const repository = new InMemoryPlanningRepository();
    const adapter = new FixtureKnowledgeIngestionAdapter([
      adrSource,
      standardSource,
      externalSource
    ]);

    const result = await ingestKnowledgeSources(
      { sourceUris: [adrSource.sourceUri] },
      { repository, knowledgeAdapter: adapter }
    );

    expect(result.total).toBe(1);
    expect(result.ingested[0]?.key).toBe("adr.001-use-postgres");
    expect(await repository.listMemoryRecords({ scope: "external" })).toHaveLength(
      0
    );
  });

  it("filters sources by tag when no sourceUris are provided", async () => {
    const repository = new InMemoryPlanningRepository();
    const adapter = new FixtureKnowledgeIngestionAdapter([
      adrSource,
      standardSource,
      externalSource
    ]);

    const result = await ingestKnowledgeSources(
      { tags: ["typescript"] },
      { repository, knowledgeAdapter: adapter }
    );

    expect(result.total).toBe(2);
    expect(result.ingested.map((r) => r.key)).toEqual(
      expect.arrayContaining([
        "standard.typescript-patterns",
        "docs.typescript.utility-types"
      ])
    );
  });

  it("filters sources by scope when no sourceUris are provided", async () => {
    const repository = new InMemoryPlanningRepository();
    const adapter = new FixtureKnowledgeIngestionAdapter([
      adrSource,
      standardSource,
      externalSource
    ]);

    const result = await ingestKnowledgeSources(
      { scope: "organization" },
      { repository, knowledgeAdapter: adapter }
    );

    expect(result.total).toBe(1);
    expect(result.ingested[0]?.scope).toBe("organization");
  });

  it("is idempotent: re-ingesting the same source upserts the record", async () => {
    const repository = new InMemoryPlanningRepository();
    const adapter = new FixtureKnowledgeIngestionAdapter([adrSource]);

    await ingestKnowledgeSources({}, { repository, knowledgeAdapter: adapter });
    await ingestKnowledgeSources({}, { repository, knowledgeAdapter: adapter });

    const records = await repository.listMemoryRecords({ scope: "project" });
    expect(records).toHaveLength(1);
  });

  it("ingested external sources appear in getMemoryContext", async () => {
    const repository = new InMemoryPlanningRepository();
    const adapter = new FixtureKnowledgeIngestionAdapter([
      adrSource,
      standardSource,
      externalSource
    ]);

    await ingestKnowledgeSources({}, { repository, knowledgeAdapter: adapter });

    const planResult = await runPlanningPipeline(eligibleInput, {
      repository,
      planner: new DeterministicPlanningAgent(),
      clock: () => new Date("2026-03-26T13:00:00.000Z"),
      idGenerator: () => "ki-run-001"
    });

    const context = await repository.getMemoryContext({
      taskId: planResult.manifest.taskId,
      repo: "acme/platform",
      organizationId: "acme"
    });

    expect(context.projectMemory.some((r) => r.key === "adr.001-use-postgres")).toBe(
      true
    );
    expect(
      context.organizationMemory.some(
        (r) => r.key === "standard.typescript-patterns"
      )
    ).toBe(true);
    expect(
      context.externalMemory.some(
        (r) => r.key === "docs.typescript.utility-types"
      )
    ).toBe(true);
  });
});
