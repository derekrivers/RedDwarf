import { createHash } from "node:crypto";
import {
  createMemoryRecord,
  type PlanningRepository
} from "@reddwarf/evidence";
import {
  type KnowledgeIngestionAdapter,
  type KnowledgeSource
} from "@reddwarf/integrations";

// ============================================================
// Knowledge Ingestion Pipeline
// ============================================================

export interface KnowledgeIngestionSourcesQuery {
  /** Restrict ingestion to these source URIs only. */
  sourceUris?: string[];
  /** Restrict ingestion to sources with all of these tags. */
  tags?: string[];
  /** Restrict ingestion to sources of this scope. */
  scope?: KnowledgeSource["scope"];
}

export interface KnowledgeIngestionDependencies {
  repository: PlanningRepository;
  knowledgeAdapter: KnowledgeIngestionAdapter;
  clock?: () => Date;
}

export interface KnowledgeIngestionRecord {
  memoryId: string;
  sourceUri: string;
  key: string;
  scope: string;
  provenance: string;
  tags: string[];
  title: string;
}

export interface KnowledgeIngestionResult {
  ingested: KnowledgeIngestionRecord[];
  total: number;
}

export async function ingestKnowledgeSources(
  query: KnowledgeIngestionSourcesQuery,
  deps: KnowledgeIngestionDependencies
): Promise<KnowledgeIngestionResult> {
  const {
    repository,
    knowledgeAdapter,
    clock = () => new Date()
  } = deps;

  let sources: KnowledgeSource[];

  if (query.sourceUris && query.sourceUris.length > 0) {
    const fetched = await Promise.all(
      query.sourceUris.map((uri) => knowledgeAdapter.fetchSource(uri))
    );
    sources = fetched.filter((s): s is KnowledgeSource => s !== null);
  } else {
    sources = await knowledgeAdapter.listSources({
      ...(query.tags !== undefined ? { tags: query.tags } : {}),
      ...(query.scope !== undefined ? { scope: query.scope } : {})
    });
  }

  const now = clock().toISOString();
  const ingested: KnowledgeIngestionRecord[] = [];

  for (const source of sources) {
    const memoryId = deriveKnowledgeMemoryId(source.sourceUri);
    const record = createMemoryRecord({
      memoryId,
      scope: source.scope,
      provenance: source.provenance,
      key: source.key,
      title: source.title,
      value: {
        content: source.content,
        sourceUri: source.sourceUri
      },
      repo: source.repo ?? null,
      organizationId: source.organizationId ?? null,
      sourceUri: source.sourceUri,
      tags: source.tags,
      createdAt: now,
      updatedAt: now
    });

    await repository.saveMemoryRecord(record);

    ingested.push({
      memoryId,
      sourceUri: source.sourceUri,
      key: source.key,
      scope: source.scope,
      provenance: source.provenance,
      tags: source.tags,
      title: source.title
    });
  }

  return { ingested, total: ingested.length };
}

function deriveKnowledgeMemoryId(sourceUri: string): string {
  return `knowledge:${createHash("sha256").update(sourceUri).digest("hex").slice(0, 16)}`;
}
