import { describe, expect, it } from "vitest";
import { FixtureGitHubAdapter, createPlanningInputFromGitHubIssue } from "./github.js";
import { V1MutationDisabledError } from "./errors.js";
import type { GitHubIssueCandidate } from "./github.js";

const candidate: GitHubIssueCandidate = {
  repo: "acme/platform",
  issueNumber: 42,
  title: "Implement feature X",
  body: [
    "Overview of feature X.",
    "",
    "Acceptance Criteria:",
    "- Feature X is implemented",
    "- Tests pass",
    "",
    "Affected Paths:",
    "- src/feature-x.ts",
    "",
    "Requested Capabilities:",
    "- can_plan",
    "- can_write_code"
  ].join("\n"),
  labels: ["ai-eligible", "priority:60"],
  url: "https://github.com/acme/platform/issues/42",
  state: "open",
  author: "dev",
  baseBranch: "main"
};

describe("createPlanningInputFromGitHubIssue", () => {
  it("parses issue body sections into a planning input", () => {
    const input = createPlanningInputFromGitHubIssue(candidate);
    expect(input.source.issueNumber).toBe(42);
    expect(input.priority).toBe(60);
    expect(input.acceptanceCriteria).toEqual([
      "Feature X is implemented",
      "Tests pass"
    ]);
    expect(input.affectedPaths).toEqual(["src/feature-x.ts"]);
    expect(input.requestedCapabilities).toContain("can_plan");
  });

  it("uses fallback acceptance criteria when body has none", () => {
    const input = createPlanningInputFromGitHubIssue(
      { ...candidate, body: "Simple description." },
      { fallbackAcceptanceCriteria: ["Custom fallback"] }
    );
    expect(input.acceptanceCriteria).toEqual(["Custom fallback"]);
  });

  it("accepts affected areas from the GitHub issue template", () => {
    const input = createPlanningInputFromGitHubIssue({
      ...candidate,
      body: [
        "Overview of feature X.",
        "",
        "Acceptance Criteria:",
        "- Feature X is implemented",
        "- Tests pass",
        "",
        "Affected Areas:",
        "- src/feature-x.ts",
        "- tests/feature-x.test.ts"
      ].join("\n")
    });

    expect(input.affectedPaths).toEqual([
      "src/feature-x.ts",
      "tests/feature-x.test.ts"
    ]);
  });

  it("parses markdown sections that include blank lines after headings", () => {
    const input = createPlanningInputFromGitHubIssue({
      ...candidate,
      body: [
        "## Summary",
        "",
        "Build a React to-do list app called Rimmers List.",
        "",
        "## Acceptance Criteria",
        "",
        "- Create `src/main.tsx` as the application entry point.",
        "- Create `src/App.tsx` as the main Rimmers List component.",
        "",
        "## Affected Paths",
        "",
        "- src/main.tsx",
        "- src/App.tsx",
        "- src/styles.css",
        "- tests/app.test.ts"
      ].join("\n")
    });

    expect(input.acceptanceCriteria).toEqual([
      "Create `src/main.tsx` as the application entry point.",
      "Create `src/App.tsx` as the main Rimmers List component."
    ]);
    expect(input.affectedPaths).toEqual([
      "src/main.tsx",
      "src/App.tsx",
      "src/styles.css",
      "tests/app.test.ts"
    ]);
  });

  it("stops affected paths at the next markdown heading", () => {
    const input = createPlanningInputFromGitHubIssue({
      ...candidate,
      body: [
        "## Summary",
        "",
        "Build a React to-do list app called Rimmers List.",
        "",
        "## Acceptance Criteria",
        "",
        "- Create `src/main.tsx` as the application entry point.",
        "",
        "## Affected Paths",
        "",
        "- src/main.tsx",
        "- src/App.tsx",
        "",
        "## Constraints",
        "",
        "- Use React as the frontend framework.",
        "",
        "## Risk Class",
        "",
        "low"
      ].join("\n")
    });

    expect(input.affectedPaths).toEqual(["src/main.tsx", "src/App.tsx"]);
  });

  it("builds summary text from narrative sections without appending later headings", () => {
    const input = createPlanningInputFromGitHubIssue({
      ...candidate,
      body: [
        "## Summary",
        "",
        "Build a React to-do list app called Rimmers List.",
        "",
        "## Why",
        "",
        "We want a simple but realistic end-to-end feature to validate the pipeline.",
        "",
        "## Desired Outcome",
        "",
        "A user can manage tasks in a Bootstrap-styled React interface.",
        "",
        "## Acceptance Criteria",
        "",
        "- Create `src/main.tsx` as the application entry point.",
        "",
        "## Risk Class",
        "",
        "low"
      ].join("\n")
    });

    expect(input.summary).toBe(
      "Build a React to-do list app called Rimmers List. We want a simple but realistic end-to-end feature to validate the pipeline. A user can manage tasks in a Bootstrap-styled React interface."
    );
  });
});

describe("FixtureGitHubAdapter", () => {
  it("fetches a registered issue candidate", async () => {
    const adapter = new FixtureGitHubAdapter({ candidates: [candidate] });
    const result = await adapter.fetchIssueCandidate("acme/platform", 42);
    expect(result.title).toBe("Implement feature X");
  });

  it("throws for an unknown issue", async () => {
    const adapter = new FixtureGitHubAdapter({ candidates: [] });
    await expect(adapter.fetchIssueCandidate("acme/platform", 99)).rejects.toThrow();
  });

  it("throws V1MutationDisabledError for mutation operations by default", async () => {
    const adapter = new FixtureGitHubAdapter({ candidates: [candidate] });

    await expect(
      adapter.createIssue({ repo: "acme/platform", title: "New", body: "Body" })
    ).rejects.toBeInstanceOf(V1MutationDisabledError);

    await expect(
      adapter.createBranch("acme/platform", "main", "feature/test")
    ).rejects.toBeInstanceOf(V1MutationDisabledError);
  });

  it("lists candidates filtered by label", async () => {
    const adapter = new FixtureGitHubAdapter({ candidates: [candidate] });
    const found = await adapter.listIssueCandidates({
      repo: "acme/platform",
      labels: ["ai-eligible"]
    });
    expect(found).toHaveLength(1);

    const notFound = await adapter.listIssueCandidates({
      repo: "acme/platform",
      labels: ["non-existent-label"]
    });
    expect(notFound).toHaveLength(0);
  });
});
