import assert from "node:assert/strict";
import {
  DeterministicPlanningAgent,
  ingestKnowledgeSources,
  runPlanningPipeline
} from "../packages/control-plane/dist/index.js";
import { PostgresPlanningRepository, deriveOrganizationId } from "../packages/evidence/dist/index.js";
import { FixtureKnowledgeIngestionAdapter } from "../packages/integrations/dist/index.js";
import { connectionString } from "./lib/config.mjs";

const unique = Date.now();
const repo = `acme-knowledge-${unique}/platform-${unique}`;
const organizationId = deriveOrganizationId(repo);
const repository = new PostgresPlanningRepository({ connectionString });

const sources = [
  {
    sourceUri: `file://docs/adr/001-use-postgres-${unique}.md`,
    title: "ADR 001: Use PostgreSQL for persistence",
    content:
      "We adopt PostgreSQL as the primary persistence layer for all task and evidence data. This decision was made to leverage JSONB support, strong consistency guarantees, and mature operational tooling.",
    key: `adr.001-use-postgres-${unique}`,
    scope: "project",
    provenance: "human_curated",
    repo,
    organizationId,
    tags: ["adr", "architecture", "postgres"]
  },
  {
    sourceUri: `file://docs/adr/002-typescript-strict-${unique}.md`,
    title: "ADR 002: TypeScript Strict Mode",
    content:
      "All TypeScript code must use strict mode with exactOptionalPropertyTypes enabled. This prevents a class of runtime errors caused by undefined/null mismatches.",
    key: `adr.002-typescript-strict-${unique}`,
    scope: "project",
    provenance: "human_curated",
    repo,
    organizationId,
    tags: ["adr", "architecture", "typescript"]
  },
  {
    sourceUri: `file://standards/engineering-${unique}.md`,
    title: "Engineering Standards",
    content:
      "Code must pass lint, typecheck, and all tests before merging. Feature branches must be scoped to a single concern. PRs require at least one human review for high-risk changes.",
    key: `standard.engineering-${unique}`,
    scope: "organization",
    provenance: "human_curated",
    repo: null,
    organizationId,
    tags: ["standard", "engineering", "process"]
  },
  {
    sourceUri: `https://www.typescriptlang.org/docs/handbook/utility-types-${unique}.html`,
    title: "TypeScript Utility Types Reference",
    content:
      "Partial<T> makes all properties optional. Required<T> makes all properties required. Readonly<T> prevents mutation. Record<K,T> maps keys to values.",
    key: `docs.typescript.utility-types-${unique}`,
    scope: "external",
    provenance: "external_retrieval",
    repo,
    organizationId,
    sourceUri: `https://www.typescriptlang.org/docs/handbook/utility-types-${unique}.html`,
    tags: ["typescript", "reference", "external"]
  }
];

try {
  const adapter = new FixtureKnowledgeIngestionAdapter(sources);

  // 1. Ingest all sources
  const allResult = await ingestKnowledgeSources(
    {},
    {
      repository,
      knowledgeAdapter: adapter,
      clock: () => new Date("2026-03-26T13:00:00.000Z")
    }
  );

  assert.equal(allResult.total, 4, "All 4 sources should be ingested");
  assert.ok(
    allResult.ingested.every((r) => r.memoryId.startsWith("knowledge:")),
    "Every ingested record should have a knowledge: prefixed memoryId"
  );

  // 2. Verify idempotency: re-ingest the same sources
  const idempotentResult = await ingestKnowledgeSources(
    {},
    { repository, knowledgeAdapter: adapter }
  );
  assert.equal(idempotentResult.total, 4, "Re-ingestion should process all sources again");

  // 3. Ingest only by specific sourceUri
  const singleResult = await ingestKnowledgeSources(
    { sourceUris: [sources[0].sourceUri] },
    { repository, knowledgeAdapter: adapter }
  );
  assert.equal(singleResult.total, 1);
  assert.equal(singleResult.ingested[0].key, sources[0].key);

  // 4. Ingest by tag filter
  const tagResult = await ingestKnowledgeSources(
    { tags: ["adr"] },
    { repository, knowledgeAdapter: adapter }
  );
  assert.equal(tagResult.total, 2, "Two ADR sources should match the 'adr' tag");

  // 5. Ingest by scope filter
  const scopeResult = await ingestKnowledgeSources(
    { scope: "external" },
    { repository, knowledgeAdapter: adapter }
  );
  assert.equal(scopeResult.total, 1, "One external source should exist");
  assert.equal(scopeResult.ingested[0].scope, "external");

  // 6. Run planning pipeline and verify ingested memory appears in getMemoryContext
  const planResult = await runPlanningPipeline(
    {
      source: {
        provider: "github",
        repo,
        issueNumber: unique,
        issueUrl: `https://github.com/${repo}/issues/${unique}`
      },
      title: "Verify knowledge ingestion context injection",
      summary:
        "Run the planning pipeline after ingesting ADRs and standards to verify that the memory context includes project, organization, and external knowledge records.",
      priority: 1,
      labels: ["ai-eligible"],
      acceptanceCriteria: [
        "Ingested ADRs appear in project memory",
        "Standards appear in organization memory",
        "External docs appear in external memory"
      ],
      affectedPaths: ["docs/adr/001-use-postgres.md"],
      requestedCapabilities: ["can_plan", "can_archive_evidence"],
      metadata: {}
    },
    {
      repository,
      planner: new DeterministicPlanningAgent(),
      clock: () => new Date("2026-03-26T13:05:00.000Z"),
      idGenerator: () => `knowledge-plan-${unique}`
    }
  );

  const memoryContext = await repository.getMemoryContext({
    taskId: planResult.manifest.taskId,
    repo,
    organizationId
  });

  // Task memory from planning pipeline
  assert.equal(
    memoryContext.taskMemory.length,
    1,
    "Planning pipeline should create one task memory record"
  );
  assert.equal(memoryContext.taskMemory[0].key, "planning.brief");

  // Project memory: two ADRs
  const projectAdrKeys = memoryContext.projectMemory
    .filter((r) => r.tags.includes("adr"))
    .map((r) => r.key);
  assert.ok(
    projectAdrKeys.length >= 2,
    `Expected at least 2 project ADR records, got ${projectAdrKeys.length}`
  );

  // Organization memory: engineering standard
  const orgStandards = memoryContext.organizationMemory.filter((r) =>
    r.tags.includes("standard")
  );
  assert.ok(
    orgStandards.length >= 1,
    "Engineering standard should appear in organization memory"
  );

  // External memory: TypeScript utility types
  const externalDocs = memoryContext.externalMemory.filter((r) =>
    r.tags.includes("external")
  );
  assert.ok(
    externalDocs.length >= 1,
    "External TypeScript reference should appear in external memory"
  );

  console.log(
    JSON.stringify(
      {
        taskId: planResult.manifest.taskId,
        ingestedTotal: allResult.total,
        taskMemoryCount: memoryContext.taskMemory.length,
        projectMemoryCount: memoryContext.projectMemory.length,
        organizationMemoryCount: memoryContext.organizationMemory.length,
        externalMemoryCount: memoryContext.externalMemory.length,
        projectAdrKeys,
        organizationId
      },
      null,
      2
    )
  );
} finally {
  await repository.close();
}
