export type KnowledgeSourceScope = "project" | "organization" | "external";
export type KnowledgeSourceProvenance = "human_curated" | "external_retrieval";

export interface KnowledgeSource {
  sourceUri: string;
  title: string;
  content: string;
  key: string;
  scope: KnowledgeSourceScope;
  provenance: KnowledgeSourceProvenance;
  repo?: string | null;
  organizationId?: string | null;
  tags: string[];
}

export interface KnowledgeSourceQuery {
  tags?: string[];
  scope?: KnowledgeSourceScope;
}

export interface KnowledgeIngestionAdapter {
  listSources(query?: KnowledgeSourceQuery): Promise<KnowledgeSource[]>;
  fetchSource(sourceUri: string): Promise<KnowledgeSource | null>;
}

export class FixtureKnowledgeIngestionAdapter implements KnowledgeIngestionAdapter {
  private readonly sources: Map<string, KnowledgeSource>;

  constructor(sources: KnowledgeSource[]) {
    this.sources = new Map(sources.map((s) => [s.sourceUri, s]));
  }

  async listSources(query: KnowledgeSourceQuery = {}): Promise<KnowledgeSource[]> {
    return [...this.sources.values()]
      .filter((s) => (query.scope !== undefined ? s.scope === query.scope : true))
      .filter((s) =>
        query.tags && query.tags.length > 0
          ? query.tags.every((tag) => s.tags.includes(tag))
          : true
      );
  }

  async fetchSource(sourceUri: string): Promise<KnowledgeSource | null> {
    return this.sources.get(sourceUri) ?? null;
  }
}
