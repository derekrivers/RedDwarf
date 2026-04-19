import { describe, expect, it } from "vitest";
import {
  FixtureGitHubAdapter,
  type GitHubIssueCandidate
} from "./github.js";
import {
  FixtureIntakeAdapter,
  GitHubIntakeAdapter,
  buildIntakeTaskId,
  makeFixtureCandidate,
  parseIntakeTaskId,
  type IntakeAdapter,
  type IntakeCandidate
} from "./index.js";

const githubCandidate: GitHubIssueCandidate = {
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
    "- src/feature-x.ts"
  ].join("\n"),
  labels: ["ai-eligible", "priority:60"],
  url: "https://github.com/acme/platform/issues/42",
  state: "open",
  author: "dev",
  baseBranch: "main"
};

describe("buildIntakeTaskId / parseIntakeTaskId", () => {
  it("round-trips a provider/repo/externalId triple", () => {
    const id = buildIntakeTaskId({
      provider: "github",
      repo: "acme/platform",
      externalId: 42
    });
    expect(id).toBe("github:acme/platform#42");
    expect(parseIntakeTaskId(id)).toEqual({
      provider: "github",
      repo: "acme/platform",
      externalId: "42"
    });
  });

  it("returns null for malformed ids", () => {
    expect(parseIntakeTaskId("nope")).toBeNull();
    expect(parseIntakeTaskId(":missing-provider#1")).toBeNull();
    expect(parseIntakeTaskId("github:no-issue")).toBeNull();
  });
});

describe("GitHubIntakeAdapter", () => {
  function makeAdapter() {
    const github = new FixtureGitHubAdapter({ candidates: [githubCandidate] });
    return new GitHubIntakeAdapter(github);
  }

  it("reports the github provider id", () => {
    expect(makeAdapter().provider).toBe("github");
  });

  it("translates GitHubIssueCandidate to IntakeCandidate on discoverCandidates", async () => {
    const adapter = makeAdapter();
    const results = await adapter.discoverCandidates({ repo: "acme/platform" });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "github:acme/platform#42",
      provider: "github",
      repo: "acme/platform",
      title: "Implement feature X",
      state: "open",
      author: "dev"
    });
    expect(results[0]!.metadata["issueNumber"]).toBe(42);
    expect(results[0]!.metadata["baseBranch"]).toBe("main");
  });

  it("fetches a single canonical task by intake id", async () => {
    const candidate = await makeAdapter().fetchCanonicalTask(
      "github:acme/platform#42"
    );
    expect(candidate.title).toBe("Implement feature X");
  });

  it("rejects an intake id from another provider", async () => {
    await expect(
      makeAdapter().fetchCanonicalTask("linear:acme/platform#42")
    ).rejects.toThrow(/cannot resolve intake id/);
  });

  it("converts an IntakeCandidate back into a PlanningTaskInput via convertToPlanningInput", async () => {
    const adapter = makeAdapter();
    const intakeCandidate = (await adapter.discoverCandidates({
      repo: "acme/platform"
    }))[0]!;
    const planningInput = await adapter.toPlanningTaskInput(intakeCandidate);
    expect(planningInput.source).toMatchObject({
      provider: "github",
      repo: "acme/platform",
      issueNumber: 42
    });
    expect(planningInput.acceptanceCriteria).toContain("Feature X is implemented");
  });

  it("markProcessed is a no-op in v1 — does not throw, leaves no observable state", async () => {
    await expect(
      makeAdapter().markProcessed("github:acme/platform#42", { status: "queued" })
    ).resolves.toBeUndefined();
  });
});

describe("FixtureIntakeAdapter", () => {
  it("seeds + filters candidates by repo, label, state and limit", async () => {
    const adapter = new FixtureIntakeAdapter({
      candidates: [
        makeFixtureCandidate({
          repo: "acme/repo",
          externalId: 1,
          title: "open ai-eligible",
          labels: ["ai-eligible"],
          state: "open"
        }),
        makeFixtureCandidate({
          repo: "acme/repo",
          externalId: 2,
          title: "closed",
          labels: ["ai-eligible"],
          state: "closed"
        }),
        makeFixtureCandidate({
          repo: "acme/repo",
          externalId: 3,
          title: "wrong label",
          labels: ["something-else"],
          state: "open"
        }),
        makeFixtureCandidate({
          repo: "other/repo",
          externalId: 4,
          title: "wrong repo",
          labels: ["ai-eligible"],
          state: "open"
        })
      ]
    });
    const results = await adapter.discoverCandidates({
      repo: "acme/repo",
      labels: ["ai-eligible"],
      states: ["open"]
    });
    expect(results.map((r) => r.title)).toEqual(["open ai-eligible"]);
  });

  it("recordedOutcomes captures markProcessed calls", async () => {
    const candidate = makeFixtureCandidate({
      repo: "acme/repo",
      externalId: 1,
      title: "Test"
    });
    const adapter = new FixtureIntakeAdapter({ candidates: [candidate] });
    await adapter.markProcessed(candidate.id, {
      status: "completed",
      reason: "merged"
    });
    expect(adapter.recordedOutcomes()).toEqual([
      { id: candidate.id, outcome: { status: "completed", reason: "merged" } }
    ]);
  });

  it("addCandidate lets a test seed a candidate after construction", async () => {
    const adapter = new FixtureIntakeAdapter();
    const candidate = makeFixtureCandidate({
      repo: "acme/repo",
      externalId: 99,
      title: "Late binding"
    });
    adapter.addCandidate(candidate);
    expect(await adapter.fetchCanonicalTask(candidate.id)).toBe(candidate);
  });
});

describe("IntakeAdapter contract — both implementations behave identically for shared methods", () => {
  it("discoverCandidates filters by repo on both adapters", async () => {
    const githubAdapter: IntakeAdapter = new GitHubIntakeAdapter(
      new FixtureGitHubAdapter({ candidates: [githubCandidate] })
    );
    const sharedShape: IntakeCandidate = {
      id: "fixture:acme/platform#42",
      provider: "fixture",
      repo: "acme/platform",
      title: "Mirror of github candidate",
      body: "",
      labels: ["ai-eligible"],
      state: "open",
      url: "https://example.invalid/42",
      author: null,
      metadata: { issueNumber: 42 }
    };
    const fixtureAdapter: IntakeAdapter = new FixtureIntakeAdapter({
      candidates: [sharedShape]
    });
    const githubResults = await githubAdapter.discoverCandidates({
      repo: "acme/platform"
    });
    const fixtureResults = await fixtureAdapter.discoverCandidates({
      repo: "acme/platform"
    });
    expect(githubResults).toHaveLength(1);
    expect(fixtureResults).toHaveLength(1);
  });
});
