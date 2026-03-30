import { describe, expect, it } from "vitest";
import { FixtureKnowledgeIngestionAdapter } from "./knowledge.js";
import type { KnowledgeSource } from "./knowledge.js";

const source: KnowledgeSource = {
  sourceUri: "doc://acme/readme",
  title: "README",
  content: "Project overview content.",
  key: "acme-readme",
  scope: "project",
  provenance: "human_curated",
  tags: ["setup", "onboarding"]
};

describe("FixtureKnowledgeIngestionAdapter", () => {
  it("fetchSource returns a registered source by URI", async () => {
    const adapter = new FixtureKnowledgeIngestionAdapter([source]);
    const result = await adapter.fetchSource("doc://acme/readme");
    expect(result?.title).toBe("README");
  });

  it("fetchSource returns null for an unknown URI", async () => {
    const adapter = new FixtureKnowledgeIngestionAdapter([source]);
    const result = await adapter.fetchSource("doc://unknown");
    expect(result).toBeNull();
  });

  it("listSources returns all sources with no filter", async () => {
    const adapter = new FixtureKnowledgeIngestionAdapter([source]);
    const results = await adapter.listSources();
    expect(results).toHaveLength(1);
  });

  it("listSources filters by scope", async () => {
    const adapter = new FixtureKnowledgeIngestionAdapter([source]);
    const orgResults = await adapter.listSources({ scope: "organization" });
    expect(orgResults).toHaveLength(0);
    const projectResults = await adapter.listSources({ scope: "project" });
    expect(projectResults).toHaveLength(1);
  });

  it("listSources filters by tags", async () => {
    const adapter = new FixtureKnowledgeIngestionAdapter([source]);
    const found = await adapter.listSources({ tags: ["setup"] });
    expect(found).toHaveLength(1);
    const notFound = await adapter.listSources({ tags: ["missing-tag"] });
    expect(notFound).toHaveLength(0);
  });
});
