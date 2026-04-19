import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadPlaybooks,
  resolvePlaybookForLabels
} from "./playbook-loader.js";
import type { Playbook } from "@reddwarf/contracts";

const VALID_PLAYBOOK = {
  id: "docs-update",
  name: "Documentation update",
  description: "Edit Markdown only.",
  matchLabels: ["docs", "documentation"],
  riskClass: "low",
  allowedPaths: ["docs/**", "*.md"],
  requiredCapabilities: ["can_write_code", "can_open_pr"],
  architectHints: ["Restrict the diff to .md files."],
  validatorRules: ["No non-doc files in the diff."],
  reviewerRubric: ["Skimmable and accurate."]
};

describe("loadPlaybooks", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "reddwarf-playbooks-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("loads valid playbooks from a directory", async () => {
    await writeFile(
      join(tempDir, "docs-update.json"),
      JSON.stringify(VALID_PLAYBOOK)
    );
    const result = await loadPlaybooks({ rootDir: tempDir });
    expect(result.playbooks).toHaveLength(1);
    expect(result.playbooks[0]!.id).toBe("docs-update");
    expect(result.errors).toEqual([]);
    expect(result.rootDir).toBe(tempDir);
  });

  it("collects an error per malformed JSON file but keeps loading the rest", async () => {
    await writeFile(
      join(tempDir, "good.json"),
      JSON.stringify({ ...VALID_PLAYBOOK, id: "good" })
    );
    await writeFile(join(tempDir, "broken.json"), "not json");
    const result = await loadPlaybooks({ rootDir: tempDir });
    expect(result.playbooks.map((p) => p.id)).toEqual(["good"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.file).toBe("broken.json");
    expect(result.errors[0]!.reason).toContain("JSON parse error");
  });

  it("rejects entries that fail schema validation", async () => {
    await writeFile(
      join(tempDir, "bad.json"),
      JSON.stringify({ ...VALID_PLAYBOOK, id: "BAD ID WITH SPACES" })
    );
    const result = await loadPlaybooks({ rootDir: tempDir });
    expect(result.playbooks).toEqual([]);
    expect(result.errors[0]!.reason).toContain("Schema validation failed");
  });

  it("flags duplicate ids and drops the later occurrence", async () => {
    await writeFile(
      join(tempDir, "a.json"),
      JSON.stringify({ ...VALID_PLAYBOOK, id: "dup" })
    );
    await writeFile(
      join(tempDir, "b.json"),
      JSON.stringify({ ...VALID_PLAYBOOK, id: "dup" })
    );
    const result = await loadPlaybooks({ rootDir: tempDir });
    expect(result.playbooks).toHaveLength(1);
    expect(result.errors[0]!.reason).toContain("Duplicate playbook id");
  });

  it("skips non-JSON files quietly", async () => {
    await writeFile(
      join(tempDir, "good.json"),
      JSON.stringify({ ...VALID_PLAYBOOK, id: "good" })
    );
    await writeFile(join(tempDir, "README.md"), "# notes");
    const result = await loadPlaybooks({ rootDir: tempDir });
    expect(result.playbooks).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });

  it("returns an empty result when the directory does not exist", async () => {
    const result = await loadPlaybooks({
      rootDir: join(tempDir, "does-not-exist")
    });
    expect(result.playbooks).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});

describe("resolvePlaybookForLabels", () => {
  const docs: Playbook = {
    ...VALID_PLAYBOOK,
    id: "docs-update",
    matchLabels: ["docs", "documentation"]
  } as Playbook;
  const deps: Playbook = {
    ...VALID_PLAYBOOK,
    id: "dependency-bump",
    matchLabels: ["dependencies", "dependency-bump"]
  } as Playbook;

  it("returns the matching playbook", () => {
    expect(resolvePlaybookForLabels([docs, deps], ["docs"])?.id).toBe(
      "docs-update"
    );
    expect(
      resolvePlaybookForLabels([docs, deps], ["dependency-bump"])?.id
    ).toBe("dependency-bump");
  });

  it("matches case-insensitively", () => {
    expect(
      resolvePlaybookForLabels([docs, deps], ["DEPENDENCIES"])?.id
    ).toBe("dependency-bump");
  });

  it("returns null when no label matches the catalogue", () => {
    expect(resolvePlaybookForLabels([docs, deps], ["bug"])).toBeNull();
  });

  it("returns null when labels are empty", () => {
    expect(resolvePlaybookForLabels([docs, deps], [])).toBeNull();
  });

  it("returns null when the catalogue is empty", () => {
    expect(resolvePlaybookForLabels([], ["docs"])).toBeNull();
  });

  it("breaks ties by alphabetic playbook id", () => {
    const both: Playbook = {
      ...VALID_PLAYBOOK,
      id: "alpha-first",
      matchLabels: ["docs"]
    } as Playbook;
    const winner = resolvePlaybookForLabels([docs, both], ["docs"]);
    expect(winner?.id).toBe("alpha-first");
  });
});
